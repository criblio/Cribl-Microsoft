/**
 * provision-lab - roadmap Phase 5, the FOUNDATION slice (LAB-01 phase 1 +
 * LAB-02). Provisions the lab's resource group with the MANDATORY TTL
 * self-destruct: the tagged resource group, the hourly TTL watchdog Logic App
 * (system-assigned identity), and the Contributor grant that lets the
 * watchdog delete its own resource group at expiry. Later phases (storage,
 * networking, monitoring, analytics...) land as sibling steps per the
 * roadmap; this usecase deliberately starts with the one phase every profile
 * requires and the cost-control mandate depends on.
 *
 * Mined from the legacy UnifiedLab Phase1-Foundation scripts (the request
 * shapes live in domain/labs/lab-foundation):
 * - Deploy-ResourceGroup.ps1: GET-first idempotency; an EXISTING group gets
 *   its TTL tags refreshed ("TTL extended") by MERGING into the current tag
 *   set; a missing group is created with the full foundation tag set.
 * - Deploy-TTL.ps1: GET-first Logic App create; the identity principal id is
 *   read from the PUT/GET response; the Contributor grant retries through
 *   identity-propagation lag (PrincipalNotFound) with bounded ATTEMPTS, and
 *   an already-existing assignment (409 RoleAssignmentExists) is SUCCESS -
 *   both conventions shared with the assign-dcr-role usecase.
 *
 * Resource-group modes (feature-catalog "Lab environments" permission
 * design): "create-new" creates the group (subscription-scoped rights);
 * "bring-your-own" requires the group to EXIST - a missing group is a
 * per-step failure with guidance, never a silent create. In bring-your-own
 * mode a 403 on the role grant is EXPECTED for least-privilege operators;
 * the result carries the identity's principal id plus a ready-to-send az CLI
 * command so an admin can grant the delete right manually.
 *
 * SHELL OWNS TIME AND IDS: `nowIso` (TTL math) and `mintAssignmentName` (the
 * role-assignment GUID) are injected - core never reads a clock or mints an
 * id. Retries are bounded by attempt count and paced only by the injected
 * sleep hook.
 *
 * Pure orchestration over AzureManagement (and optional JobStore/Logger);
 * zero IO of its own. Never rejects for ARM failures - the outcome carries
 * them; it can still reject if the optional JobStore itself fails.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { JobRecord, JobStep, JobStore } from "../../ports/job-store";
import type { Logger } from "../../ports/logger";
import {
  buildResourceGroupGetRequest,
  buildResourceGroupPatchTagsRequest,
  buildResourceGroupPutRequest,
  buildRgContributorRoleAssignmentRequest,
  buildTtlLogicAppGetRequest,
  buildTtlLogicAppPutRequest,
  labFoundationTags,
  labTtlInstants,
  ttlLogicAppName,
  type LabTtlSettings,
} from "../../domain/labs/lab-foundation";

/** JobStore `kind` for records created by {@link provisionLabFoundation}. */
export const PROVISION_LAB_JOB_KIND = "provision-lab-foundation";

/** The three foundation step names, in execution order. */
export const PROVISION_LAB_STEPS = [
  "resource-group",
  "ttl-logic-app",
  "ttl-role-assignment",
] as const;

/** Default bound on PrincipalNotFound / identity-readback retries (attempts). */
export const DEFAULT_LAB_RETRY_ATTEMPTS = 6;

/** Default delay handed to the injected sleep hook between retries. */
export const DEFAULT_LAB_RETRY_DELAY_MS = 10000;

/** ARM error code for a role assignment that already exists (idempotent hit). */
const ROLE_ASSIGNMENT_EXISTS = "RoleAssignmentExists";

/** ARM error code when the principal object has not replicated yet. */
const PRINCIPAL_NOT_FOUND = "PrincipalNotFound";

/** Retry policy: bounded by ATTEMPTS; the SHELL injects the sleep hook. */
export interface ProvisionLabRetry {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The ports {@link provisionLabFoundation} orchestrates. */
export interface ProvisionLabPorts {
  azure: AzureManagement;
  /** OPTIONAL job record (kind {@link PROVISION_LAB_JOB_KIND}, three steps). */
  jobs?: JobStore;
  /** OPTIONAL diagnostics sink, tagged with the job id when jobs is present. */
  logger?: Logger;
}

/** Input for {@link provisionLabFoundation}. */
export interface ProvisionLabInput {
  subscriptionId: string;
  resourceGroupName: string;
  location: string;
  /** Names the TTL Logic App (la-ttl-cleanup-{baseObjectName}). */
  baseObjectName: string;
  /** "create-new" creates a missing group; "bring-your-own" requires it. */
  rgMode: "create-new" | "bring-your-own";
  /** MANDATORY TTL - every app-provisioned lab self-destructs. */
  ttl: LabTtlSettings;
  /** SHELL-minted UTC instant (ISO 8601) the TTL math runs from. */
  nowIso: string;
  /** SHELL-minted GUID provider for the role-assignment name. */
  mintAssignmentName: () => string;
  retry?: ProvisionLabRetry;
  /** Fired with a copy of the step after every step-state change. */
  onProgress?: (step: JobStep) => void;
}

/** The foundation outcome (also embedded as the job result). */
export interface ProvisionLabFoundationResult {
  /** Full ARM id of the lab resource group. */
  resourceGroupId: string;
  /** True when this run CREATED the group (false = existed, TTL extended). */
  resourceGroupCreated: boolean;
  /** The TTL expiration instant stamped on the group. */
  ttlExpiresAt: string;
  logicAppName: string;
  /** True when this run created the watchdog (false = already existed). */
  logicAppCreated: boolean;
  /** The watchdog identity's principal (object) id; "" when unavailable. */
  principalId: string;
  /** True when the identity now holds Contributor on the group. */
  roleAssigned: boolean;
  /** True when the grant already existed (409 RoleAssignmentExists). */
  roleAlreadyAssigned: boolean;
  /**
   * Ready-to-run az CLI grant for an admin, present ONLY when the role step
   * failed but the principal id is known (the bring-your-own 403 path).
   */
  manualRoleAssignmentCommand?: string;
  /** True when every step succeeded. */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers (same conventions as the sibling usecases)
// ---------------------------------------------------------------------------

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function httpErrorText(context: string, status: number, body: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(body);
  } catch {
    raw = String(body);
  }
  return `${context}: HTTP ${status} ${raw ?? ""}`.trim();
}

function armErrorCode(body: unknown): string {
  const code = asString(prop(prop(body, "error"), "code"));
  return code !== "" ? code : asString(prop(body, "code"));
}

function isErrorCode(body: unknown, expected: string): boolean {
  return armErrorCode(body).toLowerCase() === expected.toLowerCase();
}

/** Merge existing RG tags with the foundation tags (foundation wins). */
function mergedTags(
  existingBody: unknown,
  foundation: Record<string, string>,
): Record<string, string> {
  const existing = prop(existingBody, "tags");
  const merged: Record<string, string> = {};
  if (typeof existing === "object" && existing !== null) {
    for (const [key, value] of Object.entries(existing as Record<string, unknown>)) {
      if (typeof value === "string") {
        merged[key] = value;
      }
    }
  }
  return { ...merged, ...foundation };
}

/** The az CLI command an admin runs when the app cannot grant the role. */
export function manualLabRoleCommand(
  subscriptionId: string,
  resourceGroup: string,
  principalId: string,
): string {
  return (
    `az role assignment create --assignee-object-id ${principalId} ` +
    `--assignee-principal-type ServicePrincipal --role Contributor ` +
    `--scope /subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`
  );
}

// ---------------------------------------------------------------------------
// provisionLabFoundation
// ---------------------------------------------------------------------------

/**
 * Run the foundation phase: resource group (created or TTL-extended), TTL
 * watchdog Logic App, Contributor grant for the watchdog identity. A failed
 * step fails the job and SKIPS the steps behind it (the first-class 'skipped'
 * convention - a skipped step did no work); the outcome and job record report
 * exactly what happened.
 */
export async function provisionLabFoundation(
  ports: ProvisionLabPorts,
  input: ProvisionLabInput,
): Promise<ProvisionLabFoundationResult> {
  const { azure, jobs, logger } = ports;
  const retry = input.retry ?? {};
  const maxAttempts = retry.maxAttempts ?? DEFAULT_LAB_RETRY_ATTEMPTS;
  const delayMs = retry.delayMs ?? DEFAULT_LAB_RETRY_DELAY_MS;
  const sleep = retry.sleep ?? (async () => {});

  const steps: JobStep[] = PROVISION_LAB_STEPS.map((name) => ({
    name,
    status: "pending",
  }));

  let job: JobRecord | null = null;
  if (jobs !== undefined) {
    job = await jobs.create(PROVISION_LAB_JOB_KIND, {
      subscriptionId: input.subscriptionId,
      resourceGroupName: input.resourceGroupName,
      location: input.location,
      baseObjectName: input.baseObjectName,
      rgMode: input.rgMode,
      ttl: input.ttl,
    });
    await jobs.update(job.id, {
      status: "running",
      steps: steps.map((s) => ({ ...s })),
    });
  }

  logger?.info(
    "provision-lab: foundation started",
    {
      resourceGroup: input.resourceGroupName,
      rgMode: input.rgMode,
      ttlHours: input.ttl.hours,
    },
    job?.id,
  );

  const setStep = async (
    name: (typeof PROVISION_LAB_STEPS)[number],
    status: JobStep["status"],
    detail?: string,
  ): Promise<void> => {
    const step = steps.find((candidate) => candidate.name === name);
    if (step === undefined) {
      throw new Error(`unknown step '${name}'`);
    }
    step.status = status;
    if (detail !== undefined) {
      step.detail = detail;
    }
    if (job !== null && jobs !== undefined) {
      await jobs.update(job.id, { steps: steps.map((s) => ({ ...s })) });
    }
    input.onProgress?.({ ...step });
  };

  const rgId = `/subscriptions/${input.subscriptionId}/resourceGroups/${input.resourceGroupName}`;
  const instants = labTtlInstants(input.ttl, input.nowIso);
  const result: ProvisionLabFoundationResult = {
    resourceGroupId: rgId,
    resourceGroupCreated: false,
    ttlExpiresAt: instants.expirationTime,
    logicAppName: ttlLogicAppName(input.baseObjectName),
    logicAppCreated: false,
    principalId: "",
    roleAssigned: false,
    roleAlreadyAssigned: false,
    ok: false,
  };

  const finish = async (
    ok: boolean,
    error?: string,
  ): Promise<ProvisionLabFoundationResult> => {
    result.ok = ok;
    if (job !== null && jobs !== undefined) {
      await jobs.update(job.id, {
        status: ok ? "succeeded" : "failed",
        ...(error !== undefined ? { error } : {}),
        result,
      });
    }
    if (ok) {
      logger?.info("provision-lab: foundation succeeded", { resourceGroup: input.resourceGroupName }, job?.id);
    } else {
      logger?.error("provision-lab: foundation failed", { error: error ?? "" }, job?.id);
    }
    return result;
  };

  const skipRemaining = async (
    from: (typeof PROVISION_LAB_STEPS)[number],
  ): Promise<void> => {
    const fromIndex = PROVISION_LAB_STEPS.indexOf(from);
    for (const name of PROVISION_LAB_STEPS.slice(fromIndex)) {
      await setStep(name, "skipped", "prerequisite-failed");
    }
  };

  // --- Step 1: resource group (GET-first; create or TTL-extend) -----------
  await setStep("resource-group", "running");
  const foundationTags = labFoundationTags(input.ttl, input.nowIso);
  const getRg = await azure.request(
    buildResourceGroupGetRequest(input.subscriptionId, input.resourceGroupName),
  );

  if (is2xx(getRg.status)) {
    // Existing group: merge tags and PATCH - the legacy "TTL extended" path.
    const patch = await azure.request(
      buildResourceGroupPatchTagsRequest(
        input.subscriptionId,
        input.resourceGroupName,
        mergedTags(getRg.body, foundationTags),
      ),
    );
    if (!is2xx(patch.status)) {
      const error = httpErrorText(
        `extend TTL tags on resource group '${input.resourceGroupName}'`,
        patch.status,
        patch.body,
      );
      await setStep("resource-group", "failed", error);
      await skipRemaining("ttl-logic-app");
      return finish(false, error);
    }
    await setStep(
      "resource-group",
      "succeeded",
      `already existed - TTL extended to ${instants.expirationTime}`,
    );
  } else if (getRg.status === 404) {
    if (input.rgMode === "bring-your-own") {
      const error =
        `resource group '${input.resourceGroupName}' not found - bring-your-own mode ` +
        "requires an admin-pre-created group (or switch to create-new mode)";
      await setStep("resource-group", "failed", error);
      await skipRemaining("ttl-logic-app");
      return finish(false, error);
    }
    const put = await azure.request(
      buildResourceGroupPutRequest(
        input.subscriptionId,
        input.resourceGroupName,
        input.location,
        foundationTags,
      ),
    );
    if (!is2xx(put.status)) {
      const error = httpErrorText(
        `create resource group '${input.resourceGroupName}'`,
        put.status,
        put.body,
      );
      await setStep("resource-group", "failed", error);
      await skipRemaining("ttl-logic-app");
      return finish(false, error);
    }
    result.resourceGroupCreated = true;
    await setStep(
      "resource-group",
      "succeeded",
      `created with TTL expiring ${instants.expirationTime}`,
    );
  } else {
    const error = httpErrorText(
      `read resource group '${input.resourceGroupName}'`,
      getRg.status,
      getRg.body,
    );
    await setStep("resource-group", "failed", error);
    await skipRemaining("ttl-logic-app");
    return finish(false, error);
  }

  // --- Step 2: TTL watchdog Logic App (GET-first; identity readback) ------
  await setStep("ttl-logic-app", "running");
  const readPrincipalId = (body: unknown): string =>
    asString(prop(prop(body, "identity"), "principalId"));

  const getApp = await azure.request(
    buildTtlLogicAppGetRequest(
      input.subscriptionId,
      input.resourceGroupName,
      input.baseObjectName,
    ),
  );
  if (is2xx(getApp.status)) {
    result.principalId = readPrincipalId(getApp.body);
  } else if (getApp.status === 404) {
    const put = await azure.request(
      buildTtlLogicAppPutRequest(
        input.subscriptionId,
        input.resourceGroupName,
        input.location,
        input.baseObjectName,
      ),
    );
    if (!is2xx(put.status)) {
      const error = httpErrorText(
        `create TTL Logic App '${result.logicAppName}'`,
        put.status,
        put.body,
      );
      await setStep("ttl-logic-app", "failed", error);
      await skipRemaining("ttl-role-assignment");
      return finish(false, error);
    }
    result.logicAppCreated = true;
    result.principalId = readPrincipalId(put.body);
  } else {
    const error = httpErrorText(
      `read TTL Logic App '${result.logicAppName}'`,
      getApp.status,
      getApp.body,
    );
    await setStep("ttl-logic-app", "failed", error);
    await skipRemaining("ttl-role-assignment");
    return finish(false, error);
  }

  // Identity readback: a fresh PUT can return before the identity is
  // populated - re-GET within the attempt budget (legacy fallback, bounded).
  let readbackAttempt = 1;
  while (result.principalId === "" && readbackAttempt < maxAttempts) {
    readbackAttempt++;
    await sleep(delayMs);
    const reread = await azure.request(
      buildTtlLogicAppGetRequest(
        input.subscriptionId,
        input.resourceGroupName,
        input.baseObjectName,
      ),
    );
    if (is2xx(reread.status)) {
      result.principalId = readPrincipalId(reread.body);
    }
  }
  if (result.principalId === "") {
    const error =
      `TTL Logic App '${result.logicAppName}' has no managed-identity principal id ` +
      `after ${maxAttempts} attempt(s) - re-run the deploy, then grant Contributor manually if it persists`;
    await setStep("ttl-logic-app", "failed", error);
    await skipRemaining("ttl-role-assignment");
    return finish(false, error);
  }
  await setStep(
    "ttl-logic-app",
    "succeeded",
    result.logicAppCreated
      ? `created (identity ${result.principalId})`
      : `already existed (identity ${result.principalId})`,
  );

  // --- Step 3: Contributor grant for the watchdog identity ----------------
  await setStep("ttl-role-assignment", "running");
  const assignmentName = input.mintAssignmentName();
  const roleRequest = buildRgContributorRoleAssignmentRequest({
    subscriptionId: input.subscriptionId,
    resourceGroup: input.resourceGroupName,
    assignmentName,
    principalId: result.principalId,
  });

  let attempt = 0;
  for (;;) {
    attempt++;
    const response = await azure.request(roleRequest);
    if (is2xx(response.status)) {
      result.roleAssigned = true;
      break;
    }
    if (
      response.status === 409 &&
      isErrorCode(response.body, ROLE_ASSIGNMENT_EXISTS)
    ) {
      result.roleAssigned = true;
      result.roleAlreadyAssigned = true;
      break;
    }
    if (isErrorCode(response.body, PRINCIPAL_NOT_FOUND) && attempt < maxAttempts) {
      await sleep(delayMs);
      continue;
    }
    // Terminal failure: surface the manual grant path (the least-privilege
    // bring-your-own operator lands here with a 403 by design).
    const command = manualLabRoleCommand(
      input.subscriptionId,
      input.resourceGroupName,
      result.principalId,
    );
    result.manualRoleAssignmentCommand = command;
    const error =
      httpErrorText(
        `grant Contributor to the TTL identity on '${input.resourceGroupName}'`,
        response.status,
        response.body,
      ) +
      ` - the lab CANNOT self-delete until an admin grants the role: ${command}`;
    await setStep("ttl-role-assignment", "failed", error);
    return finish(false, error);
  }

  await setStep(
    "ttl-role-assignment",
    "succeeded",
    result.roleAlreadyAssigned ? "role already assigned" : "role assigned",
  );
  return finish(true);
}
