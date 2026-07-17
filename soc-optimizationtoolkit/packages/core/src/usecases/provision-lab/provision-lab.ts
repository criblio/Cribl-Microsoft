/**
 * provision-lab - roadmap Phase 5: the phased lab deployment engine
 * (LAB-01 orchestration; phases 1-3 implemented, later phases land as
 * sibling steps per the roadmap).
 *
 * Phase 1 - Foundation (ALWAYS runs; LAB-02): the lab resource group with
 * the MANDATORY TTL self-destruct - the tagged group, the hourly TTL
 * watchdog Logic App (system-assigned identity), and the Contributor grant
 * that lets the watchdog delete its own resource group at expiry.
 *
 * Phase 2 - Storage (LAB-04 + LAB-05, when the profile deploys storage):
 * the storage account (GET-first; global-name collisions retried with a
 * SHELL-minted suffix, the legacy random-suffix behavior), the pattern
 * containers with the verbatim skip rules, the notification queue, and the
 * Event Grid system topic + BlobCreated-to-queue subscriptions (provider
 * registered on demand). Containers/queues ride the ARM MANAGEMENT plane -
 * no storage keys ever touch the app.
 *
 * Phase 3 - Networking (LAB-03, when the profile deploys a VNet): one NSG
 * per non-Gateway subnet with the verbatim legacy rule set, then ONE VNet
 * PUT carrying the full desired subnet set with inline NSG associations
 * (the legacy add/remove/associate synchronization, in one request - a
 * recorded redesign). The legacy execution order (Storage before
 * Networking) is preserved.
 *
 * Failure semantics (the first-class 'skipped' convention):
 * - A resource-group failure skips EVERYTHING behind it.
 * - A TTL watchdog/grant failure skips all later phases: the TTL mandate
 *   means the app never creates billable lab resources without a working
 *   self-destruct.
 * - A storage-account failure skips the dependent storage sub-steps but the
 *   independent networking phase still runs (legacy phases were isolated).
 * - Sub-steps not requested by the profile report 'skipped' with the
 *   reason; phases the profile does not require contribute NO steps at all
 *   (see {@link provisionLabStepsFor}).
 *
 * SHELL OWNS TIME, IDS, AND RANDOMNESS: nowIso (TTL math),
 * mintAssignmentName (role-assignment GUID), and mintStorageSuffix
 * (collision retry) are injected; retries/polls are attempt-bounded and
 * paced only by the injected sleep hook.
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
import {
  isLabPhaseRequired,
  type LabComponentFlags,
} from "../../domain/labs/lab-profiles";
import type { LabResourceNames, LabSubnet } from "../../domain/labs/lab-naming";
import {
  DEFAULT_LAB_SUBNETS,
  DEFAULT_LAB_VNET_CIDR,
} from "../../domain/labs/lab-naming";
import {
  DEFAULT_LAB_CONTAINERS,
  DEFAULT_LAB_EVENT_GRID_SUBSCRIPTIONS,
  DEFAULT_LAB_QUEUES,
  DEFAULT_LAB_STORAGE_SETTINGS,
  buildBlobContainerGetRequest,
  buildBlobContainerPutRequest,
  buildEventGridProviderGetRequest,
  buildEventGridProviderRegisterRequest,
  buildEventSubscriptionGetRequest,
  buildEventSubscriptionPutRequest,
  buildStorageAccountGetRequest,
  buildStorageAccountPutRequest,
  buildStorageQueueGetRequest,
  buildStorageQueuePutRequest,
  buildSystemTopicGetRequest,
  buildSystemTopicPutRequest,
  collisionStorageAccountName,
  containersToDeploy,
  eventGridSystemTopicName,
  parseProviderRegistrationState,
  parseStorageProvisioningState,
  type LabContainerDef,
  type LabEventGridSubscriptionDef,
  type LabQueueDef,
  type LabStorageAccountSettings,
} from "../../domain/labs/lab-storage";
import {
  DEFAULT_LAB_NETWORK_SECURITY,
  buildNsgGetRequest,
  buildNsgPutRequest,
  buildVnetGetRequest,
  buildVnetPutRequest,
  labNsgSecurityRules,
  parseVnetProvisioningState,
  type LabNetworkSecuritySettings,
} from "../../domain/labs/lab-networking";

/** JobStore `kind` for records created by {@link provisionLab}. */
export const PROVISION_LAB_JOB_KIND = "provision-lab";

/** Phase 1 step names, in execution order (always present). */
export const LAB_FOUNDATION_STEPS = [
  "resource-group",
  "ttl-logic-app",
  "ttl-role-assignment",
] as const;

/** Phase 2 step names (present when the profile deploys storage). */
export const LAB_STORAGE_STEPS = [
  "storage-account",
  "blob-containers",
  "storage-queues",
  "event-grid",
] as const;

/** Phase 3 step names (present when the profile deploys a VNet). */
export const LAB_NETWORKING_STEPS = [
  "network-security-groups",
  "virtual-network",
] as const;

/**
 * The job's step list for a flag set: foundation always; the storage and
 * networking steps only when the profile's phase gating requires them (the
 * same isLabPhaseRequired the legacy orchestrator used).
 */
export function provisionLabStepsFor(flags: LabComponentFlags): string[] {
  const steps: string[] = [...LAB_FOUNDATION_STEPS];
  if (isLabPhaseRequired(2, flags)) {
    steps.push(...LAB_STORAGE_STEPS);
  }
  if (isLabPhaseRequired(3, flags)) {
    steps.push(...LAB_NETWORKING_STEPS);
  }
  return steps;
}

/** Default bound on retries and provisioning polls (attempts, not clock). */
export const DEFAULT_LAB_RETRY_ATTEMPTS = 6;

/** Default delay handed to the injected sleep hook between attempts. */
export const DEFAULT_LAB_RETRY_DELAY_MS = 10000;

/** ARM error code for a role assignment that already exists (idempotent hit). */
const ROLE_ASSIGNMENT_EXISTS = "RoleAssignmentExists";

/** ARM error code when the principal object has not replicated yet. */
const PRINCIPAL_NOT_FOUND = "PrincipalNotFound";

/** ARM error code when a storage account name is globally taken. */
const STORAGE_NAME_TAKEN = "StorageAccountAlreadyTaken";

/** Retry policy: bounded by ATTEMPTS; the SHELL injects the sleep hook. */
export interface ProvisionLabRetry {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The ports {@link provisionLab} orchestrates. */
export interface ProvisionLabPorts {
  azure: AzureManagement;
  /** OPTIONAL job record (kind {@link PROVISION_LAB_JOB_KIND}). */
  jobs?: JobStore;
  /** OPTIONAL diagnostics sink, tagged with the job id when jobs is present. */
  logger?: Logger;
}

/** Input for {@link provisionLab}. */
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
  /** The profile's component flags (labDeploymentConfig output). */
  flags: LabComponentFlags;
  /** The planned resource names (allLabResourceNames output). */
  names: LabResourceNames;
  /** SHELL-minted UTC instant (ISO 8601) the TTL math runs from. */
  nowIso: string;
  /** SHELL-minted GUID provider for the role-assignment name. */
  mintAssignmentName: () => string;
  /**
   * SHELL-minted random suffix for storage-name collision retries (the
   * legacy 4-char random suffix). Absent = a taken name fails immediately.
   */
  mintStorageSuffix?: () => string;
  /** Subnet layout; defaults to the legacy 4-subnet /24 layout. */
  subnets?: readonly LabSubnet[];
  /** VNet address space; defaults to the legacy 10.198.30.0/24. */
  vnetCidr?: string;
  /** Storage account settings; legacy StorageV2/Standard_LRS/Hot default. */
  storageSettings?: LabStorageAccountSettings;
  /** Container definitions; the legacy three-pattern default. */
  containers?: readonly LabContainerDef[];
  /** Queue definitions; the legacy blob-notifications default. */
  queues?: readonly LabQueueDef[];
  /** Event Grid subscriptions; the legacy blobCreated default. */
  eventGridSubscriptions?: readonly LabEventGridSubscriptionDef[];
  /** NSG posture; defaults allow AzureCloud only (no on-prem spaces). */
  networkSecurity?: LabNetworkSecuritySettings;
  retry?: ProvisionLabRetry;
  /** Fired with a copy of the step after every step-state change. */
  onProgress?: (step: JobStep) => void;
}

/** Per-resource outcome inside a phase result. */
export interface LabResourceOutcome {
  name: string;
  /** True when this run created it (false = already existed, reused). */
  created: boolean;
}

/** Storage phase outcome (present when the phase ran). */
export interface LabStorageOutcome {
  /** The FINAL account name (may carry a collision suffix). */
  accountName: string;
  accountCreated: boolean;
  containers: LabResourceOutcome[];
  queues: LabResourceOutcome[];
  eventGridTopic?: string;
  eventGridSubscriptions?: string[];
}

/** Networking phase outcome (present when the phase ran). */
export interface LabNetworkingOutcome {
  vnetName: string;
  nsgs: LabResourceOutcome[];
}

/** The provisioning outcome (also embedded as the job result). */
export interface ProvisionLabResult {
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
  /** Storage phase outcome (only when the profile ran the phase). */
  storage?: LabStorageOutcome;
  /** Networking phase outcome (only when the profile ran the phase). */
  networking?: LabNetworkingOutcome;
  /** True when every non-skipped step succeeded. */
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

/** Reason detail for steps skipped behind a failed prerequisite. */
const PREREQUISITE_FAILED = "prerequisite-failed";

/** Reason detail for sub-steps the profile does not request. */
const NOT_REQUESTED = "not requested by profile";

// ---------------------------------------------------------------------------
// provisionLab
// ---------------------------------------------------------------------------

/**
 * Run the lab deployment: foundation always, then the storage and networking
 * phases the profile requires (legacy order: Storage before Networking).
 * See the module doc for the failure/skip semantics.
 */
export async function provisionLab(
  ports: ProvisionLabPorts,
  input: ProvisionLabInput,
): Promise<ProvisionLabResult> {
  const { azure, jobs, logger } = ports;
  const retry = input.retry ?? {};
  const maxAttempts = retry.maxAttempts ?? DEFAULT_LAB_RETRY_ATTEMPTS;
  const delayMs = retry.delayMs ?? DEFAULT_LAB_RETRY_DELAY_MS;
  const sleep = retry.sleep ?? (async () => {});
  const sub = input.subscriptionId;
  const rg = input.resourceGroupName;

  const stepNames = provisionLabStepsFor(input.flags);
  const steps: JobStep[] = stepNames.map((name) => ({ name, status: "pending" }));
  const hasStep = (name: string): boolean => stepNames.includes(name);

  let job: JobRecord | null = null;
  if (jobs !== undefined) {
    job = await jobs.create(PROVISION_LAB_JOB_KIND, {
      subscriptionId: sub,
      resourceGroupName: rg,
      location: input.location,
      baseObjectName: input.baseObjectName,
      rgMode: input.rgMode,
      ttl: input.ttl,
      flags: input.flags,
    });
    await jobs.update(job.id, {
      status: "running",
      steps: steps.map((s) => ({ ...s })),
    });
  }

  logger?.info(
    "provision-lab: started",
    { resourceGroup: rg, rgMode: input.rgMode, steps: stepNames.length },
    job?.id,
  );

  const setStep = async (
    name: string,
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

  const skipSteps = async (names: readonly string[], reason: string): Promise<void> => {
    for (const name of names) {
      if (hasStep(name)) {
        await setStep(name, "skipped", reason);
      }
    }
  };

  const instants = labTtlInstants(input.ttl, input.nowIso);
  const result: ProvisionLabResult = {
    resourceGroupId: `/subscriptions/${sub}/resourceGroups/${rg}`,
    resourceGroupCreated: false,
    ttlExpiresAt: instants.expirationTime,
    logicAppName: ttlLogicAppName(input.baseObjectName),
    logicAppCreated: false,
    principalId: "",
    roleAssigned: false,
    roleAlreadyAssigned: false,
    ok: false,
  };
  const errors: string[] = [];

  const finish = async (): Promise<ProvisionLabResult> => {
    result.ok = errors.length === 0;
    if (job !== null && jobs !== undefined) {
      await jobs.update(job.id, {
        status: result.ok ? "succeeded" : "failed",
        ...(result.ok ? {} : { error: errors[0] }),
        result,
      });
    }
    if (result.ok) {
      logger?.info("provision-lab: succeeded", { resourceGroup: rg }, job?.id);
    } else {
      logger?.error(
        "provision-lab: finished with failures",
        { failures: errors.length, first: errors[0] },
        job?.id,
      );
    }
    return result;
  };

  const remainingAfter = (name: string): string[] =>
    stepNames.slice(stepNames.indexOf(name));

  // ==========================================================================
  // PHASE 1: Foundation (always)
  // ==========================================================================

  // --- resource-group (GET-first; create or TTL-extend) --------------------
  await setStep("resource-group", "running");
  const foundationTags = labFoundationTags(input.ttl, input.nowIso);
  const getRg = await azure.request(buildResourceGroupGetRequest(sub, rg));

  if (is2xx(getRg.status)) {
    const patch = await azure.request(
      buildResourceGroupPatchTagsRequest(sub, rg, mergedTags(getRg.body, foundationTags)),
    );
    if (!is2xx(patch.status)) {
      const error = httpErrorText(
        `extend TTL tags on resource group '${rg}'`,
        patch.status,
        patch.body,
      );
      errors.push(error);
      await setStep("resource-group", "failed", error);
      await skipSteps(remainingAfter("ttl-logic-app"), PREREQUISITE_FAILED);
      return finish();
    }
    await setStep(
      "resource-group",
      "succeeded",
      `already existed - TTL extended to ${instants.expirationTime}`,
    );
  } else if (getRg.status === 404) {
    if (input.rgMode === "bring-your-own") {
      const error =
        `resource group '${rg}' not found - bring-your-own mode requires an ` +
        "admin-pre-created group (or switch to create-new mode)";
      errors.push(error);
      await setStep("resource-group", "failed", error);
      await skipSteps(remainingAfter("ttl-logic-app"), PREREQUISITE_FAILED);
      return finish();
    }
    const put = await azure.request(
      buildResourceGroupPutRequest(sub, rg, input.location, foundationTags),
    );
    if (!is2xx(put.status)) {
      const error = httpErrorText(
        `create resource group '${rg}'`,
        put.status,
        put.body,
      );
      errors.push(error);
      await setStep("resource-group", "failed", error);
      await skipSteps(remainingAfter("ttl-logic-app"), PREREQUISITE_FAILED);
      return finish();
    }
    result.resourceGroupCreated = true;
    await setStep(
      "resource-group",
      "succeeded",
      `created with TTL expiring ${instants.expirationTime}`,
    );
  } else {
    const error = httpErrorText(
      `read resource group '${rg}'`,
      getRg.status,
      getRg.body,
    );
    errors.push(error);
    await setStep("resource-group", "failed", error);
    await skipSteps(remainingAfter("ttl-logic-app"), PREREQUISITE_FAILED);
    return finish();
  }

  // --- ttl-logic-app (GET-first; identity readback) ------------------------
  // A TTL failure skips ALL later phases: the mandate means no billable lab
  // resources exist without a working self-destruct.
  const ttlSkipReason = "TTL self-destruct is mandatory and did not deploy";
  await setStep("ttl-logic-app", "running");
  const readPrincipalId = (body: unknown): string =>
    asString(prop(prop(body, "identity"), "principalId"));

  const getApp = await azure.request(
    buildTtlLogicAppGetRequest(sub, rg, input.baseObjectName),
  );
  if (is2xx(getApp.status)) {
    result.principalId = readPrincipalId(getApp.body);
  } else if (getApp.status === 404) {
    const put = await azure.request(
      buildTtlLogicAppPutRequest(sub, rg, input.location, input.baseObjectName),
    );
    if (!is2xx(put.status)) {
      const error = httpErrorText(
        `create TTL Logic App '${result.logicAppName}'`,
        put.status,
        put.body,
      );
      errors.push(error);
      await setStep("ttl-logic-app", "failed", error);
      await skipSteps(remainingAfter("ttl-role-assignment"), ttlSkipReason);
      return finish();
    }
    result.logicAppCreated = true;
    result.principalId = readPrincipalId(put.body);
  } else {
    const error = httpErrorText(
      `read TTL Logic App '${result.logicAppName}'`,
      getApp.status,
      getApp.body,
    );
    errors.push(error);
    await setStep("ttl-logic-app", "failed", error);
    await skipSteps(remainingAfter("ttl-role-assignment"), ttlSkipReason);
    return finish();
  }

  let readbackAttempt = 1;
  while (result.principalId === "" && readbackAttempt < maxAttempts) {
    readbackAttempt++;
    await sleep(delayMs);
    const reread = await azure.request(
      buildTtlLogicAppGetRequest(sub, rg, input.baseObjectName),
    );
    if (is2xx(reread.status)) {
      result.principalId = readPrincipalId(reread.body);
    }
  }
  if (result.principalId === "") {
    const error =
      `TTL Logic App '${result.logicAppName}' has no managed-identity principal id ` +
      `after ${maxAttempts} attempt(s) - re-run the deploy, then grant Contributor manually if it persists`;
    errors.push(error);
    await setStep("ttl-logic-app", "failed", error);
    await skipSteps(remainingAfter("ttl-role-assignment"), ttlSkipReason);
    return finish();
  }
  await setStep(
    "ttl-logic-app",
    "succeeded",
    result.logicAppCreated
      ? `created (identity ${result.principalId})`
      : `already existed (identity ${result.principalId})`,
  );

  // --- ttl-role-assignment --------------------------------------------------
  await setStep("ttl-role-assignment", "running");
  const assignmentName = input.mintAssignmentName();
  const roleRequest = buildRgContributorRoleAssignmentRequest({
    subscriptionId: sub,
    resourceGroup: rg,
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
    if (response.status === 409 && isErrorCode(response.body, ROLE_ASSIGNMENT_EXISTS)) {
      result.roleAssigned = true;
      result.roleAlreadyAssigned = true;
      break;
    }
    if (isErrorCode(response.body, PRINCIPAL_NOT_FOUND) && attempt < maxAttempts) {
      await sleep(delayMs);
      continue;
    }
    const command = manualLabRoleCommand(sub, rg, result.principalId);
    result.manualRoleAssignmentCommand = command;
    const error =
      httpErrorText(
        `grant Contributor to the TTL identity on '${rg}'`,
        response.status,
        response.body,
      ) + ` - the lab CANNOT self-delete until an admin grants the role: ${command}`;
    errors.push(error);
    await setStep("ttl-role-assignment", "failed", error);
    const afterRole = stepNames.slice(stepNames.indexOf("ttl-role-assignment") + 1);
    await skipSteps(afterRole, ttlSkipReason);
    return finish();
  }
  await setStep(
    "ttl-role-assignment",
    "succeeded",
    result.roleAlreadyAssigned ? "role already assigned" : "role assigned",
  );

  // ==========================================================================
  // PHASE 2: Storage (legacy order: before Networking)
  // ==========================================================================
  if (hasStep("storage-account")) {
    const storage: LabStorageOutcome = {
      accountName: input.names.storageAccount,
      accountCreated: false,
      containers: [],
      queues: [],
    };
    result.storage = storage;
    const settings = input.storageSettings ?? DEFAULT_LAB_STORAGE_SETTINGS;
    let accountReady = false;

    await setStep("storage-account", "running");
    const getAccount = await azure.request(
      buildStorageAccountGetRequest(sub, rg, storage.accountName),
    );
    if (is2xx(getAccount.status)) {
      accountReady = true;
      await setStep("storage-account", "succeeded", "already existed");
    } else if (getAccount.status === 404) {
      // PUT with the legacy collision retry: a globally-taken name gets a
      // SHELL-minted suffix (base truncated to 20 + 4 chars, capped 24).
      let name = storage.accountName;
      let created = false;
      let putAttempt = 0;
      let lastError = "";
      while (!created && putAttempt < maxAttempts) {
        putAttempt++;
        const put = await azure.request(
          buildStorageAccountPutRequest(sub, rg, name, input.location, settings),
        );
        if (is2xx(put.status)) {
          created = true;
          break;
        }
        if (
          put.status === 409 &&
          isErrorCode(put.body, STORAGE_NAME_TAKEN) &&
          input.mintStorageSuffix !== undefined
        ) {
          name = collisionStorageAccountName(
            input.names.storageAccount,
            input.mintStorageSuffix(),
          );
          continue;
        }
        lastError = httpErrorText(
          `create storage account '${name}'`,
          put.status,
          put.body,
        );
        break;
      }
      if (created) {
        // Attempt-bounded provisioning poll (PUT is async on new accounts).
        let state = "";
        for (let poll = 0; poll < maxAttempts; poll++) {
          const read = await azure.request(
            buildStorageAccountGetRequest(sub, rg, name),
          );
          state = is2xx(read.status)
            ? parseStorageProvisioningState(read.body)
            : "";
          if (state === "Succeeded") {
            break;
          }
          await sleep(delayMs);
        }
        if (state === "Succeeded") {
          storage.accountName = name;
          storage.accountCreated = true;
          accountReady = true;
          await setStep(
            "storage-account",
            "succeeded",
            name === input.names.storageAccount
              ? "created"
              : `created as '${name}' (name collision suffix applied)`,
          );
        } else {
          const error =
            `storage account '${name}' did not reach provisioningState Succeeded ` +
            `within ${maxAttempts} attempt(s)`;
          errors.push(error);
          await setStep("storage-account", "failed", error);
        }
      } else {
        const error =
          lastError !== ""
            ? lastError
            : `create storage account '${name}': name is taken and no suffix ` +
              `minter was provided after ${maxAttempts} attempt(s)`;
        errors.push(error);
        await setStep("storage-account", "failed", error);
      }
    } else {
      const error = httpErrorText(
        `read storage account '${storage.accountName}'`,
        getAccount.status,
        getAccount.body,
      );
      errors.push(error);
      await setStep("storage-account", "failed", error);
    }

    const storageAccountId =
      `/subscriptions/${sub}/resourceGroups/${rg}` +
      `/providers/Microsoft.Storage/storageAccounts/${storage.accountName}`;

    if (!accountReady) {
      // Dependent sub-steps cannot run; networking is independent and still does.
      await skipSteps(
        ["blob-containers", "storage-queues", "event-grid"],
        PREREQUISITE_FAILED,
      );
    } else {
      // --- blob-containers --------------------------------------------------
      if (!input.flags.storage.deployContainers) {
        await skipSteps(["blob-containers"], NOT_REQUESTED);
      } else {
        await setStep("blob-containers", "running");
        const toDeploy = containersToDeploy(
          input.containers ?? DEFAULT_LAB_CONTAINERS,
          input.flags,
        );
        const failures: string[] = [];
        for (const container of toDeploy) {
          const get = await azure.request(
            buildBlobContainerGetRequest(sub, rg, storage.accountName, container.name),
          );
          if (is2xx(get.status)) {
            storage.containers.push({ name: container.name, created: false });
            continue;
          }
          const put = await azure.request(
            buildBlobContainerPutRequest(sub, rg, storage.accountName, container.name),
          );
          if (is2xx(put.status)) {
            storage.containers.push({ name: container.name, created: true });
          } else {
            failures.push(
              httpErrorText(
                `create container '${container.name}'`,
                put.status,
                put.body,
              ),
            );
          }
        }
        if (failures.length > 0) {
          errors.push(...failures);
          await setStep("blob-containers", "failed", failures.join("; "));
        } else {
          await setStep(
            "blob-containers",
            "succeeded",
            toDeploy.length === 0
              ? "no containers apply to this profile"
              : storage.containers.map((c) => c.name).join(", "),
          );
        }
      }

      // --- storage-queues ---------------------------------------------------
      if (!input.flags.storage.deployQueues) {
        await skipSteps(["storage-queues"], NOT_REQUESTED);
      } else {
        await setStep("storage-queues", "running");
        const failures: string[] = [];
        for (const queue of input.queues ?? DEFAULT_LAB_QUEUES) {
          const get = await azure.request(
            buildStorageQueueGetRequest(sub, rg, storage.accountName, queue.name),
          );
          if (is2xx(get.status)) {
            storage.queues.push({ name: queue.name, created: false });
            continue;
          }
          const put = await azure.request(
            buildStorageQueuePutRequest(sub, rg, storage.accountName, queue.name),
          );
          if (is2xx(put.status)) {
            storage.queues.push({ name: queue.name, created: true });
          } else {
            failures.push(
              httpErrorText(`create queue '${queue.name}'`, put.status, put.body),
            );
          }
        }
        if (failures.length > 0) {
          errors.push(...failures);
          await setStep("storage-queues", "failed", failures.join("; "));
        } else {
          await setStep(
            "storage-queues",
            "succeeded",
            storage.queues.map((q) => q.name).join(", "),
          );
        }
      }

      // --- event-grid (LAB-05) ----------------------------------------------
      if (!input.flags.storage.deployEventGrid) {
        await skipSteps(["event-grid"], NOT_REQUESTED);
      } else {
        await setStep("event-grid", "running");
        let egFailed = "";

        // Provider registration (legacy Register-AzResourceProvider path).
        const provider = await azure.request(buildEventGridProviderGetRequest(sub));
        let registration = is2xx(provider.status)
          ? parseProviderRegistrationState(provider.body)
          : "";
        if (registration !== "Registered") {
          const register = await azure.request(
            buildEventGridProviderRegisterRequest(sub),
          );
          if (!is2xx(register.status)) {
            egFailed = httpErrorText(
              "register the Microsoft.EventGrid provider",
              register.status,
              register.body,
            );
          } else {
            for (let poll = 0; poll < maxAttempts; poll++) {
              const read = await azure.request(buildEventGridProviderGetRequest(sub));
              registration = is2xx(read.status)
                ? parseProviderRegistrationState(read.body)
                : "";
              if (registration === "Registered") {
                break;
              }
              await sleep(delayMs);
            }
            if (registration !== "Registered") {
              egFailed =
                "Microsoft.EventGrid provider did not reach Registered within " +
                `${maxAttempts} attempt(s)`;
            }
          }
        }

        // System topic (GET-first) + subscriptions.
        const topicName = eventGridSystemTopicName(storage.accountName);
        if (egFailed === "") {
          const getTopic = await azure.request(
            buildSystemTopicGetRequest(sub, rg, topicName),
          );
          if (getTopic.status === 404) {
            const putTopic = await azure.request(
              buildSystemTopicPutRequest(
                sub,
                rg,
                topicName,
                input.location,
                storageAccountId,
              ),
            );
            if (!is2xx(putTopic.status)) {
              egFailed = httpErrorText(
                `create Event Grid system topic '${topicName}'`,
                putTopic.status,
                putTopic.body,
              );
            }
          } else if (!is2xx(getTopic.status)) {
            egFailed = httpErrorText(
              `read Event Grid system topic '${topicName}'`,
              getTopic.status,
              getTopic.body,
            );
          }
        }
        if (egFailed === "") {
          storage.eventGridTopic = topicName;
          storage.eventGridSubscriptions = [];
          for (const subscription of input.eventGridSubscriptions ??
            DEFAULT_LAB_EVENT_GRID_SUBSCRIPTIONS) {
            const getSub = await azure.request(
              buildEventSubscriptionGetRequest(sub, rg, topicName, subscription.key),
            );
            if (is2xx(getSub.status)) {
              storage.eventGridSubscriptions.push(subscription.key);
              continue;
            }
            const putSub = await azure.request(
              buildEventSubscriptionPutRequest(
                sub,
                rg,
                topicName,
                storageAccountId,
                subscription,
              ),
            );
            if (is2xx(putSub.status)) {
              storage.eventGridSubscriptions.push(subscription.key);
            } else {
              egFailed = httpErrorText(
                `create Event Grid subscription '${subscription.key}'`,
                putSub.status,
                putSub.body,
              );
              break;
            }
          }
        }

        if (egFailed !== "") {
          errors.push(egFailed);
          await setStep("event-grid", "failed", egFailed);
        } else {
          await setStep(
            "event-grid",
            "succeeded",
            `topic ${topicName}, subscription(s): ` +
              (storage.eventGridSubscriptions ?? []).join(", "),
          );
        }
      }
    }
  }

  // ==========================================================================
  // PHASE 3: Networking (NSGs first, then the VNet with inline associations)
  // ==========================================================================
  if (hasStep("virtual-network")) {
    const networking: LabNetworkingOutcome = {
      vnetName: input.names.vnet,
      nsgs: [],
    };
    result.networking = networking;
    const subnets = input.subnets ?? DEFAULT_LAB_SUBNETS;
    const ensuredNsgByKey: Record<string, string> = {};

    // --- network-security-groups --------------------------------------------
    if (!input.flags.infrastructure.deployNSGs) {
      await skipSteps(["network-security-groups"], NOT_REQUESTED);
    } else {
      await setStep("network-security-groups", "running");
      const rules = labNsgSecurityRules(
        input.networkSecurity ?? DEFAULT_LAB_NETWORK_SECURITY,
      );
      const failures: string[] = [];
      for (const [subnetKey, nsgName] of Object.entries(input.names.nsgBySubnet)) {
        const get = await azure.request(buildNsgGetRequest(sub, rg, nsgName));
        if (is2xx(get.status)) {
          networking.nsgs.push({ name: nsgName, created: false });
          ensuredNsgByKey[subnetKey] = nsgName;
          continue;
        }
        const put = await azure.request(
          buildNsgPutRequest(sub, rg, nsgName, input.location, rules),
        );
        if (is2xx(put.status)) {
          networking.nsgs.push({ name: nsgName, created: true });
          ensuredNsgByKey[subnetKey] = nsgName;
        } else {
          failures.push(
            httpErrorText(`create NSG '${nsgName}'`, put.status, put.body),
          );
        }
      }
      if (failures.length > 0) {
        errors.push(...failures);
        await setStep("network-security-groups", "failed", failures.join("; "));
      } else {
        await setStep(
          "network-security-groups",
          "succeeded",
          networking.nsgs.map((n) => n.name).join(", "),
        );
      }
    }

    // --- virtual-network ------------------------------------------------------
    // The desired-state PUT: full subnet set with inline associations for the
    // NSGs that actually exist (a failed NSG never gets referenced).
    await setStep("virtual-network", "running");
    const putVnet = await azure.request(
      buildVnetPutRequest({
        subscriptionId: sub,
        resourceGroup: rg,
        vnetName: networking.vnetName,
        location: input.location,
        vnetCidr: input.vnetCidr ?? DEFAULT_LAB_VNET_CIDR,
        subnets,
        nsgNameBySubnetKey: ensuredNsgByKey,
      }),
    );
    if (!is2xx(putVnet.status)) {
      const error = httpErrorText(
        `deploy VNet '${networking.vnetName}'`,
        putVnet.status,
        putVnet.body,
      );
      errors.push(error);
      await setStep("virtual-network", "failed", error);
    } else {
      let state = parseVnetProvisioningState(putVnet.body);
      for (let poll = 0; state !== "Succeeded" && poll < maxAttempts; poll++) {
        await sleep(delayMs);
        const read = await azure.request(
          buildVnetGetRequest(sub, rg, networking.vnetName),
        );
        state = is2xx(read.status) ? parseVnetProvisioningState(read.body) : "";
      }
      if (state === "Succeeded") {
        await setStep(
          "virtual-network",
          "succeeded",
          `${networking.vnetName} with ${subnets.length} subnet(s)`,
        );
      } else {
        const error =
          `VNet '${networking.vnetName}' did not reach provisioningState ` +
          `Succeeded within ${maxAttempts} attempt(s)`;
        errors.push(error);
        await setStep("virtual-network", "failed", error);
      }
    }
  }

  return finish();
}
