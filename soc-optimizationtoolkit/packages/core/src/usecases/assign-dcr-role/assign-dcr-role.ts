/**
 * assign-dcr-role - the RUNTIME half of ENG-37 (porting-plan Unit 8). Grants
 * the "Monitoring Metrics Publisher" role to the ingestion service principal
 * on each deployed DCR, so Cribl can push telemetry through the DCR's
 * logs-ingestion endpoint. The HUMAN-MEDIATED half (the az-CLI script builder
 * and the change-request ticket generator) is ALREADY PORTED as role-plan +
 * change-request; this module is the app-driven counterpart that assigns the
 * role directly over ARM.
 *
 * Mined from the legacy Integration Solution's IS/azure-deploy.ts:
 *   - azure:assign-dcr-role (895-938): the per-DCR assign loop and the
 *     {results, assigned, total} aggregation. The legacy shelled out to
 *     Get-AzRoleAssignment / New-AzRoleAssignment; this port issues ARM REST
 *     PUTs instead. The role definition GUID is carried VERBATIM.
 *   - azure:get-dcr-ids (940-978): mapped tables -> DCR resource ids with
 *     SUBSTRING guessing (`dcrNameLower.includes(tableLower)`). That is a
 *     DO-NOT-PORT defect: shared-prefix tables (Cloudflare vs CloudflareAudit)
 *     cross-match. {@link matchDcrsToTables} replaces it with EXACT dcr-naming
 *     predictions - the SAME single name source the deploy path uses.
 *
 * REST is not the cmdlet: two behaviors the PowerShell cmdlets hid must be
 * handled explicitly here (both pinned by test):
 *
 *   - IDEMPOTENCY. A role assignment that already exists returns HTTP 409 with
 *     error code "RoleAssignmentExists". That is a SUCCESS, not a failure - the
 *     principal already holds the role. The legacy pre-checked with a GET; the
 *     REST path PUTs and treats that specific 409 as "already assigned" (one
 *     fewer round-trip, and race-free).
 *
 *   - GRAPH REPLICATION LAG. A service principal object id that was just
 *     referenced may not have replicated across Entra ID yet, so the PUT can
 *     fail with error code "PrincipalNotFound". The Az cmdlets retried this
 *     internally; REST does not. {@link assignDcrRoles} retries the PUT a
 *     bounded number of ATTEMPTS (never a wall-clock deadline - core stays
 *     Date-free), sleeping through the SHELL-injected {@link
 *     AssignDcrRoleRetry.sleep} between tries. A PrincipalNotFound that clears
 *     within the budget still succeeds; an exhausted budget fails cleanly.
 *
 * SHELL OWNS ID MINTING. Each role assignment is named by a GUID that is
 * SHELL-minted and injected as {@link AssignDcrRoleInput.mintAssignmentName} -
 * core never calls crypto/Math.random/Date. The same name is reused across a
 * target's retries so the PUT stays idempotent on name+scope.
 *
 * Pure orchestration over the AzureManagement (and optional JobStore/Logger)
 * ports; zero IO of its own, no wall-clock reads, no timers - retries are
 * bounded by ATTEMPT COUNT and paced only by the injected sleep hook.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { JobRecord, JobStep, JobStore } from "../../ports/job-store";
import type { Logger } from "../../ports/logger";
import { generateDcrName } from "../../domain/dcr-naming";
import { isCustomTableName } from "../../domain/custom-table";
import { parseResourceId } from "../../domain/azure-resource-id";
import { DIRECT_DCR_API_VERSION } from "../../domain/dcr-request";
import { listAllPages } from "../azure-discovery";

/**
 * "Monitoring Metrics Publisher" built-in role definition GUID, carried
 * VERBATIM from the legacy engine (IS/azure-deploy.ts line 903). It grants the
 * data-plane action Microsoft.Insights/telemetry/write - exactly the right the
 * Cribl ingestion SP needs against a DCR. Do NOT change this value; it is a
 * fixed Azure identifier.
 */
export const MONITORING_METRICS_PUBLISHER_ROLE_ID =
  "3913510d-42f4-4e42-8a64-420c390055eb";

/**
 * ARM api-version for Microsoft.Authorization/roleAssignments PUT. 2022-04-01
 * is the current stable version that accepts principalType on the request
 * body (the property that suppresses the Graph-replication PrincipalNotFound
 * pre-flight on the service side).
 */
export const ROLE_ASSIGNMENTS_API_VERSION = "2022-04-01";

/** JobStore `kind` for records created by {@link assignDcrRoles}. */
export const ASSIGN_DCR_ROLE_JOB_KIND = "assign-dcr-role";

/** Prefix of the per-DCR step names on the job record. */
export const ASSIGN_DCR_ROLE_STEP_PREFIX = "dcr:";

/**
 * Default bound on PrincipalNotFound retries (ATTEMPTS, not wall-clock). The
 * first attempt plus five retries covers the few seconds Entra ID typically
 * needs to replicate a freshly-referenced SP object id.
 */
export const DEFAULT_PRINCIPAL_NOT_FOUND_ATTEMPTS = 6;

/**
 * Default delay handed to the injected sleep hook between PrincipalNotFound
 * retries. Core never waits on this itself - the SHELL's sleep decides what
 * "10 seconds" means (real timer in production, fake tick in tests).
 */
export const DEFAULT_PRINCIPAL_NOT_FOUND_DELAY_MS = 10000;

/** ARM error code for a role assignment that already exists (idempotent hit). */
export const ROLE_ASSIGNMENT_EXISTS_ERROR_CODE = "RoleAssignmentExists";

/** ARM error code when the principal object has not replicated yet. */
export const PRINCIPAL_NOT_FOUND_ERROR_CODE = "PrincipalNotFound";

// ---------------------------------------------------------------------------
// Shared helpers (same pattern as the sibling usecases)
// ---------------------------------------------------------------------------

/** Render an HTTP failure as raw, greppable error text. */
function httpErrorText(context: string, status: number, body: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(body);
  } catch {
    raw = String(body);
  }
  return `${context}: HTTP ${status} ${raw ?? ""}`.trim();
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Coerce an unknown field to a string, '' for anything not a string. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Extract the ARM error code from a response body. ARM errors arrive as
 * `{ error: { code, message } }`; some surfaces nest a second `{ error: ... }`.
 * Returns '' when no code is present.
 */
function armErrorCode(body: unknown): string {
  const error = prop(body, "error");
  const code = asString(prop(error, "code"));
  if (code !== "") {
    return code;
  }
  // Tolerate the single-level `{ code }` shape some ARM proxies flatten to.
  return asString(prop(body, "code"));
}

/** Case-insensitive ARM error-code comparison. */
function isErrorCode(body: unknown, expected: string): boolean {
  return armErrorCode(body).toLowerCase() === expected.toLowerCase();
}

/** The last path segment of an ARM resource id (its own name). */
function lastSegment(resourceId: string): string {
  const segments = resourceId.split("/").filter((s) => s !== "");
  return segments.length > 0 ? segments[segments.length - 1] : resourceId;
}

/** Legacy default DCR name prefix (same default as the onboard usecases). */
const DEFAULT_DCR_NAME_PREFIX = "dcr-";

// ---------------------------------------------------------------------------
// buildRoleAssignmentRequest (pure)
// ---------------------------------------------------------------------------

/** Inputs for {@link buildRoleAssignmentRequest}. */
export interface RoleAssignmentRequestInput {
  /** Full ARM resource id of the DCR - the assignment SCOPE. */
  dcrResourceId: string;
  /** The assignment name (a GUID), SHELL-minted and passed in. */
  assignmentName: string;
  /** The ingestion service principal's OBJECT id (not its app/client id). */
  principalId: string;
  /**
   * Role definition GUID; defaults to
   * {@link MONITORING_METRICS_PUBLISHER_ROLE_ID}.
   */
  roleDefinitionId?: string;
}

/** The ARM PUT a role assignment deploys (built pure; the adapter sends it). */
export interface RoleAssignmentArmRequest {
  method: "PUT";
  /** roleAssignments path SCOPED to the DCR resource id. */
  path: string;
  apiVersion: string;
  body: {
    properties: {
      /** Fully-qualified role definition resource id (subscription-scoped). */
      roleDefinitionId: string;
      /** The SP object id the role is granted to. */
      principalId: string;
      /** Always "ServicePrincipal" (suppresses the Graph pre-flight). */
      principalType: "ServicePrincipal";
    };
  };
}

/**
 * Build the ARM role-assignment PUT for one DCR - a PURE function (no IO). The
 * scope is the DCR resource id; the role definition is expressed as a
 * subscription-scoped resource id (built-in roles are addressable at any scope,
 * and the subscription form is the portable canonical one). The subscription is
 * parsed from the DCR id via the tolerant azure-resource-id parser.
 */
export function buildRoleAssignmentRequest(
  input: RoleAssignmentRequestInput,
): RoleAssignmentArmRequest {
  const roleGuid = input.roleDefinitionId ?? MONITORING_METRICS_PUBLISHER_ROLE_ID;
  // Strip a trailing slash so the concatenation never doubles up.
  const scope = input.dcrResourceId.replace(/\/+$/, "");
  const subscriptionId = parseResourceId(scope).subscriptionId;
  // Built-in role definitions are addressable at any scope; use the DCR's own
  // scope when the subscription cannot be parsed (a malformed id ARM rejects).
  const roleDefinitionId =
    subscriptionId !== ""
      ? `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleGuid}`
      : `${scope}/providers/Microsoft.Authorization/roleDefinitions/${roleGuid}`;

  return {
    method: "PUT",
    path: `${scope}/providers/Microsoft.Authorization/roleAssignments/${input.assignmentName}`,
    apiVersion: ROLE_ASSIGNMENTS_API_VERSION,
    body: {
      properties: {
        roleDefinitionId,
        principalId: input.principalId,
        principalType: "ServicePrincipal",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// matchDcrsToTables - dcr-naming-based, replaces the legacy substring guess
// ---------------------------------------------------------------------------

/** The ARM scope a DCR-to-table match runs against. */
export interface DcrRoleMatchScope {
  subscriptionId: string;
  resourceGroup: string;
}

/** Naming inputs for {@link matchDcrsToTables} (dcr-naming prediction). */
export interface MatchDcrsToTablesOptions {
  /** "direct" (30-char limit) or "dce" (64-char limit) - from createDCE. */
  mode: "direct" | "dce";
  /** Azure region used in name prediction (dcr-naming input). */
  location: string;
  /** DCR name prefix, concatenated verbatim (legacy default "dcr-"). */
  dcrNamePrefix?: string;
  /** Optional DCR name suffix (legacy default: none). */
  dcrNameSuffix?: string;
}

/** Per-table result of {@link matchDcrsToTables}, in input order. */
export interface DcrTableMatch {
  /** The requested table, verbatim. */
  table: string;
  /** The PREDICTED DCR name (dcr-naming - THE single source). */
  dcrName: string;
  /** True when a DCR with EXACTLY that name exists in the resource group. */
  matched: boolean;
  /** The matched DCR's full ARM resource id (matches only). */
  dcrResourceId?: string;
}

/**
 * Map tables to their deployed DCR resource ids using the dcr-naming
 * prediction - the SAME name source the deploy path uses - matched EXACTLY
 * (full name, case-insensitive) against a live DCR list. Replaces the legacy
 * azure:get-dcr-ids substring match, so shared-prefix tables (Cloudflare vs
 * CloudflareAudit) can no longer cross-match.
 *
 * ONE list request per call (paginated via listAllPages when the adapter
 * implements requestUrl), scoped to the resource group. Results are returned
 * in input order.
 */
export async function matchDcrsToTables(
  azure: AzureManagement,
  scope: DcrRoleMatchScope,
  tables: readonly string[],
  options: MatchDcrsToTablesOptions,
): Promise<DcrTableMatch[]> {
  if (tables.length === 0) {
    return [];
  }

  const listPath =
    `/subscriptions/${scope.subscriptionId}` +
    `/resourceGroups/${scope.resourceGroup}` +
    `/providers/Microsoft.Insights/dataCollectionRules`;
  const items = await listAllPages(
    azure,
    { method: "GET", path: listPath, apiVersion: DIRECT_DCR_API_VERSION },
    `list DCRs in resource group '${scope.resourceGroup}'`,
  );

  // Deployed name (lowercased - ARM names are case-insensitive) -> ARM path.
  const deployed = new Map<string, string>();
  for (const item of items) {
    const name = asString(prop(item, "name"));
    if (name === "") {
      continue;
    }
    const id = asString(prop(item, "id"));
    deployed.set(name.toLowerCase(), id !== "" ? id : `${listPath}/${name}`);
  }

  return tables.map((table) => {
    const { name: dcrName } = generateDcrName({
      table,
      mode: options.mode,
      prefix: options.dcrNamePrefix ?? DEFAULT_DCR_NAME_PREFIX,
      suffix: options.dcrNameSuffix,
      location: options.location,
      isCustomTable: isCustomTableName(table),
    });
    const dcrResourceId = deployed.get(dcrName.toLowerCase());
    return dcrResourceId === undefined
      ? { table, dcrName, matched: false }
      : { table, dcrName, matched: true, dcrResourceId };
  });
}

// ---------------------------------------------------------------------------
// assignDcrRoles - the per-DCR assign loop with 409 + PrincipalNotFound logic
// ---------------------------------------------------------------------------

/** One DCR to grant the role on. */
export interface DcrRoleTarget {
  /** Full ARM resource id of the DCR (the assignment scope). */
  dcrResourceId: string;
  /**
   * Display label for the result and step name; defaults to the DCR's own
   * name (the last path segment). Usually the originating table name.
   */
  table?: string;
}

/**
 * PrincipalNotFound retry policy. Bounded by ATTEMPTS (never a clock); the
 * SHELL injects the sleep hook so core stays Date/timer-free.
 */
export interface AssignDcrRoleRetry {
  /**
   * Total PUT attempts per DCR before a persistent PrincipalNotFound fails;
   * defaults to {@link DEFAULT_PRINCIPAL_NOT_FOUND_ATTEMPTS}. 1 disables
   * retrying. Must be a positive integer.
   */
  maxAttempts?: number;
  /**
   * Delay passed to {@link AssignDcrRoleRetry.sleep} between attempts;
   * defaults to {@link DEFAULT_PRINCIPAL_NOT_FOUND_DELAY_MS}.
   */
  delayMs?: number;
  /**
   * SHELL-injected delay hook. Absent = no delay between retries (immediate
   * re-attempt) - handy for tests; production injects a real timer.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** The ports {@link assignDcrRoles} orchestrates. */
export interface AssignDcrRolePorts {
  azure: AzureManagement;
  /**
   * OPTIONAL job record: when present, a job of kind
   * {@link ASSIGN_DCR_ROLE_JOB_KIND} is created with one step per DCR (step
   * conventions mirror onboard-table/onboard-batch, so it slots into the
   * deploy flow). Absent = no persistence, pure aggregation only.
   */
  jobs?: JobStore;
  /** OPTIONAL diagnostics sink, tagged with the job id when jobs is present. */
  logger?: Logger;
}

/** Input for {@link assignDcrRoles}. */
export interface AssignDcrRoleInput {
  /**
   * The ingestion Enterprise Application's OBJECT id (NOT the app registration
   * client id - the hard-won legacy guidance). The role is granted to this
   * service principal on every target DCR.
   */
  principalId: string;
  /** The DCRs to grant the role on. */
  targets: readonly DcrRoleTarget[];
  /**
   * SHELL-minted assignment-name provider (a GUID per call). Core NEVER
   * generates a GUID - it calls this injected hook once per target (the name
   * is reused across that target's retries so the PUT is idempotent).
   */
  mintAssignmentName: () => string;
  /**
   * Role definition GUID; defaults to
   * {@link MONITORING_METRICS_PUBLISHER_ROLE_ID}.
   */
  roleDefinitionId?: string;
  /** PrincipalNotFound retry policy (see {@link AssignDcrRoleRetry}). */
  retry?: AssignDcrRoleRetry;
  /** Fired with a copy of the step after every step-state change. */
  onProgress?: (step: JobStep) => void;
}

/** Per-DCR result entry. */
export interface DcrRoleAssignmentResult {
  /** Display name of the DCR (target.table or the DCR's own name). */
  dcr: string;
  /** Full ARM resource id of the DCR. */
  dcrResourceId: string;
  /** The assignment name (GUID) that was PUT. */
  assignmentName: string;
  /** True when the role is now held (freshly assigned OR already present). */
  success: boolean;
  /** True when the role already existed (HTTP 409 RoleAssignmentExists). */
  alreadyAssigned: boolean;
  /** Raw greppable failure text when success is false. */
  error?: string;
}

/** Aggregated outcome (the legacy `{results, assigned, total}` shape). */
export interface AssignDcrRoleOutcome {
  /** Per-DCR results, in target order. */
  results: DcrRoleAssignmentResult[];
  /** Count of DCRs where the role is now held (assigned or already present). */
  assigned: number;
  /** Total DCRs attempted. */
  total: number;
}

/** The step name a target's job step carries. */
export function assignDcrRoleStepName(displayName: string): string {
  return `${ASSIGN_DCR_ROLE_STEP_PREFIX}${displayName}`;
}

/**
 * Grant "Monitoring Metrics Publisher" (or the supplied role) to the ingestion
 * service principal on each target DCR, aggregating {results, assigned, total}.
 *
 * Per DCR: PUT the role assignment (idempotent on the shell-minted name);
 * treat HTTP 409 RoleAssignmentExists as SUCCESS (already assigned); retry a
 * PrincipalNotFound up to {@link AssignDcrRoleRetry.maxAttempts} times through
 * the injected sleep; surface any other non-2xx as a per-DCR failure. One DCR
 * failing never stops the others (isolation).
 *
 * Never rejects for assignment failures - the outcome carries them. (It can
 * still reject if the optional JobStore itself fails, or if the injected
 * mintAssignmentName/sleep hooks throw.)
 */
export async function assignDcrRoles(
  ports: AssignDcrRolePorts,
  input: AssignDcrRoleInput,
): Promise<AssignDcrRoleOutcome> {
  const { azure, jobs, logger } = ports;
  const roleGuid = input.roleDefinitionId ?? MONITORING_METRICS_PUBLISHER_ROLE_ID;
  const retry = input.retry ?? {};
  const maxAttempts = retry.maxAttempts ?? DEFAULT_PRINCIPAL_NOT_FOUND_ATTEMPTS;
  const delayMs = retry.delayMs ?? DEFAULT_PRINCIPAL_NOT_FOUND_DELAY_MS;
  const sleep = retry.sleep ?? (async () => {});

  const displayName = (target: DcrRoleTarget): string =>
    target.table !== undefined && target.table !== ""
      ? target.table
      : lastSegment(target.dcrResourceId);

  // --- Optional job scaffolding (mirrors onboard-batch step conventions) ---
  let job: JobRecord | null = null;
  const steps: JobStep[] = [];
  if (jobs !== undefined) {
    job = await jobs.create(ASSIGN_DCR_ROLE_JOB_KIND, {
      principalId: input.principalId,
      roleDefinitionId: roleGuid,
      targets: input.targets.map((t) => ({
        dcrResourceId: t.dcrResourceId,
        table: t.table ?? null,
      })),
      maxAttempts,
    });
    for (const target of input.targets) {
      steps.push({ name: assignDcrRoleStepName(displayName(target)), status: "pending" });
    }
    await jobs.update(job.id, {
      status: "running",
      steps: steps.map((s) => ({ ...s })),
    });
  }

  logger?.info(
    "assign-dcr-role: job started",
    { targets: input.targets.length, roleDefinitionId: roleGuid },
    job?.id,
  );

  const setStep = async (
    name: string,
    status: JobStep["status"],
    detail?: string,
  ): Promise<void> => {
    if (job === null || jobs === undefined) {
      return;
    }
    const step = steps.find((candidate) => candidate.name === name);
    if (step === undefined) {
      // Unreachable: step names come from the same targets below.
      throw new Error(`unknown step '${name}'`);
    }
    step.status = status;
    if (detail !== undefined) {
      step.detail = detail;
    }
    await jobs.update(job.id, { steps: steps.map((s) => ({ ...s })) });
    input.onProgress?.({ ...step });
  };

  const results: DcrRoleAssignmentResult[] = [];

  for (const target of input.targets) {
    const name = displayName(target);
    const stepName = assignDcrRoleStepName(name);
    await setStep(stepName, "running");

    // Mint the assignment name ONCE per target (reused across retries so the
    // PUT stays idempotent on name+scope). Core never mints it itself.
    const assignmentName = input.mintAssignmentName();
    const request = buildRoleAssignmentRequest({
      dcrResourceId: target.dcrResourceId,
      assignmentName,
      principalId: input.principalId,
      roleDefinitionId: roleGuid,
    });

    let attempt = 0;
    let result: DcrRoleAssignmentResult | null = null;
    for (;;) {
      attempt++;
      const response = await azure.request(request);

      if (is2xx(response.status)) {
        result = {
          dcr: name,
          dcrResourceId: target.dcrResourceId,
          assignmentName,
          success: true,
          alreadyAssigned: false,
        };
        break;
      }
      if (
        response.status === 409 &&
        isErrorCode(response.body, ROLE_ASSIGNMENT_EXISTS_ERROR_CODE)
      ) {
        // Already held - idempotent success (the principal has the role).
        result = {
          dcr: name,
          dcrResourceId: target.dcrResourceId,
          assignmentName,
          success: true,
          alreadyAssigned: true,
        };
        break;
      }
      if (isErrorCode(response.body, PRINCIPAL_NOT_FOUND_ERROR_CODE)) {
        // Entra ID has not replicated the SP object id yet. Retry within the
        // attempt budget, pacing through the injected sleep (no clock read).
        if (attempt < maxAttempts) {
          await sleep(delayMs);
          continue;
        }
        result = {
          dcr: name,
          dcrResourceId: target.dcrResourceId,
          assignmentName,
          success: false,
          alreadyAssigned: false,
          error:
            `assign role on DCR '${name}': principal '${input.principalId}' ` +
            `not found after ${maxAttempts} attempt(s) - the service ` +
            "principal object may not have replicated across Entra ID; " +
            "verify the Enterprise Application OBJECT id and retry",
        };
        break;
      }
      // Any other non-2xx: a genuine failure (raw greppable text).
      result = {
        dcr: name,
        dcrResourceId: target.dcrResourceId,
        assignmentName,
        success: false,
        alreadyAssigned: false,
        error: httpErrorText(
          `assign role on DCR '${name}'`,
          response.status,
          response.body,
        ),
      };
      break;
    }

    results.push(result);
    if (result.success) {
      await setStep(
        stepName,
        "succeeded",
        result.alreadyAssigned ? "role already assigned" : "role assigned",
      );
    } else {
      await setStep(stepName, "failed", result.error);
    }
  }

  const outcome: AssignDcrRoleOutcome = {
    results,
    assigned: results.filter((r) => r.success).length,
    total: input.targets.length,
  };

  if (job !== null && jobs !== undefined) {
    const failed = outcome.total - outcome.assigned;
    await jobs.update(job.id, {
      status: failed > 0 ? "failed" : "succeeded",
      ...(failed > 0
        ? { error: `${failed} of ${outcome.total} role assignment(s) failed` }
        : {}),
      result: outcome,
    });
  }

  if (outcome.assigned < outcome.total) {
    logger?.error(
      "assign-dcr-role: job finished with failures",
      { assigned: outcome.assigned, total: outcome.total },
      job?.id,
    );
  } else {
    logger?.info(
      "assign-dcr-role: job succeeded",
      { assigned: outcome.assigned, total: outcome.total },
      job?.id,
    );
  }

  return outcome;
}
