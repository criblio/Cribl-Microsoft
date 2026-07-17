/**
 * provision-lab - roadmap Phase 5: the phased lab deployment engine (LAB-01
 * orchestration; ALL ten legacy phases implemented). Later phases in brief -
 * the fully documented ports live in their domain modules:
 *
 * Phase 4b - Private Link (lab-privatelink): AMPLS + scoped workspace +
 * private endpoint + monitor DNS zone/link, private mode only.
 * Phase 5 - Analytics (lab-analytics): Event Hub namespace/hubs/consumer
 * groups; ADX cluster (LONG poll) + CriblLogs database + the
 * CommonSecurityLog table via the ARM script resource.
 * Phase 6 - Flow logs (lab-flowlogs): resolved Network Watcher (lab-named ->
 * Azure default -> create), vNet-level + per-subnet flow logs with the
 * legacy dual-level retention; the one-flow-log-per-target conflict is an
 * idempotent hit.
 * Phase 7 - Compute (lab-compute): the two test VMs (NIC + VM + DevTest
 * auto-shutdown), password as TRANSIENT input; schedule failures degrade to
 * warnings (legacy behavior).
 * Phase 8 - Data collection (LAB-10 redesign): Direct DCRs for the four
 * legacy native tables through the SAME dcr-naming/dcr-request/
 * schema-mapping pieces the onboarding thread uses (the legacy shelled out
 * to the DCR toolkit; here it is direct composition). Sentinel-provisioned
 * tables are polled attempt-bounded (the legacy blind 60s wait).
 * Phase 9 - Integration (lab-cribl): the Cribl config bundle assembled
 * PURELY into the result (the screen downloads it via the ArtifactSink).
 * Phase 10 - Gateway (lab-gateway): public IP + VPN gateway (30-45 min LONG
 * poll; exhaustion fails honestly and a re-run resumes GET-first) and the
 * optional site-to-site connection when the on-prem details are configured.
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
 * Phase 4 - Monitoring (LAB-06, when the profile deploys Log Analytics or
 * Sentinel): the workspace via the EXISTING createWorkspace usecase (legacy
 * PerGB2018/90-day defaults, attempt-bounded provisioning poll) and Sentinel
 * via the EXISTING enableSentinel usecase (idempotent SecurityInsights
 * solution at the workspace's ACTUAL location). Private Link (AMPLS) is NOT
 * implemented yet: a private-mode profile carries a 'private-link' step
 * reported 'skipped' with the reason, never silently dropped.
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
  CONTRIBUTOR_ROLE_DEFINITION_ID,
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
import {
  WORKSPACE_API_VERSION,
  createWorkspace,
  enableSentinel,
} from "../azure-discovery";
import {
  DEFAULT_LAB_ADX_CLUSTER,
  DEFAULT_LAB_ADX_DATABASE,
  DEFAULT_LAB_EVENTHUB_NAMESPACE,
  DEFAULT_LAB_CONSUMER_GROUPS,
  LAB_ADX_COMMONSECURITYLOG_SCHEMA,
  buildAdxClusterGetRequest,
  buildAdxClusterPutRequest,
  buildAdxDatabaseGetRequest,
  buildAdxDatabasePutRequest,
  buildAdxScriptGetRequest,
  buildAdxScriptPutRequest,
  buildConsumerGroupGetRequest,
  buildConsumerGroupPutRequest,
  buildEventHubGetRequest,
  buildEventHubNamespaceGetRequest,
  buildEventHubNamespacePutRequest,
  buildEventHubPutRequest,
  parseAdxClusterUri,
  type LabAdxClusterSettings,
  type LabAdxDatabaseSettings,
  type LabEventHubNamespaceSettings,
} from "../../domain/labs/lab-analytics";
import {
  AZURE_NETWORK_WATCHER_RG,
  DEFAULT_LAB_FLOW_LOG_SETTINGS,
  azureDefaultNetworkWatcherName,
  buildFlowLogGetRequest,
  buildFlowLogPutRequest,
  buildNetworkWatcherGetRequest,
  buildNetworkWatcherPutRequest,
  isFlowLogAlreadyExistsError,
  labFlowLogName,
  type LabFlowLogSettings,
} from "../../domain/labs/lab-flowlogs";
import {
  DEFAULT_LAB_VMS,
  DEFAULT_LAB_VM_SETTINGS,
  buildNicGetRequest,
  buildNicPutRequest,
  buildShutdownScheduleGetRequest,
  buildShutdownSchedulePutRequest,
  buildVmGetRequest,
  buildVmPutRequest,
  labVmName,
  labVmNicName,
  parseVmProvisioningState,
  type LabVmDef,
  type LabVmSettings,
} from "../../domain/labs/lab-compute";
import {
  DEFAULT_LAB_VPN_GATEWAY,
  buildGatewayPublicIpGetRequest,
  buildGatewayPublicIpPutRequest,
  buildLocalNetworkGatewayGetRequest,
  buildLocalNetworkGatewayPutRequest,
  buildVpnConnectionGetRequest,
  buildVpnConnectionPutRequest,
  buildVpnGatewayGetRequest,
  buildVpnGatewayPutRequest,
  isOnPremConnectionConfigured,
  LAB_LOCAL_NETWORK_GATEWAY_NAME,
  LAB_VPN_CONNECTION_NAME,
  type LabOnPremConnection,
  type LabVpnGatewaySettings,
} from "../../domain/labs/lab-gateway";
import {
  LAB_MONITOR_PRIVATE_DNS_ZONE,
  buildAmplsGetRequest,
  buildAmplsPutRequest,
  buildAmplsScopedResourceGetRequest,
  buildAmplsScopedResourcePutRequest,
  buildDnsVnetLinkGetRequest,
  buildDnsVnetLinkPutRequest,
  buildPrivateDnsZoneGetRequest,
  buildPrivateDnsZonePutRequest,
  buildPrivateEndpointGetRequest,
  buildPrivateEndpointPutRequest,
  labAmplsName,
  labPrivateEndpointName,
} from "../../domain/labs/lab-privatelink";
import {
  buildLabCriblBundle,
  type LabCriblBundle,
  type LabDcrReference,
} from "../../domain/labs/lab-cribl";
import { DEFAULT_LAB_EVENT_HUBS, type LabEventHub } from "../../domain/labs/lab-naming";
import {
  selectSchemaColumns,
  type LogAnalyticsColumn,
} from "../../domain/schema-mapping";
import { generateDcrName } from "../../domain/dcr-naming";
import {
  DIRECT_DCR_API_VERSION,
  buildDirectDcrRequest,
  parseDcrDeployment,
} from "../../domain/dcr-request";
import { LOG_ANALYTICS_TABLES_API_VERSION } from "../../domain/custom-table";

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

/** Phase 4 step names (present when the profile deploys monitoring). */
export const LAB_MONITORING_STEPS = ["log-analytics", "microsoft-sentinel"] as const;

/** Phase 5 step names (present when the profile deploys analytics). */
export const LAB_ANALYTICS_STEPS = ["event-hub", "adx"] as const;

/** The four native tables the legacy Deploy-DCRs targeted (LAB-10, verbatim). */
export const LAB_DCR_TABLES = [
  "CommonSecurityLog",
  "SecurityEvent",
  "WindowsEvent",
  "Syslog",
] as const;

/**
 * The job's step list for a flag set: foundation always; every other phase's
 * steps only when the profile's phase gating requires them (the same
 * isLabPhaseRequired the legacy orchestrator used, in the legacy execution
 * order - Storage, Networking, Monitoring (+ Private Link in private mode),
 * Analytics, Flow Logs, Compute, Data Collection, Integration, Gateway).
 */
export function provisionLabStepsFor(flags: LabComponentFlags): string[] {
  const steps: string[] = [...LAB_FOUNDATION_STEPS];
  if (isLabPhaseRequired(2, flags)) {
    steps.push(...LAB_STORAGE_STEPS);
  }
  if (isLabPhaseRequired(3, flags)) {
    steps.push(...LAB_NETWORKING_STEPS);
  }
  if (isLabPhaseRequired(4, flags)) {
    steps.push(...LAB_MONITORING_STEPS);
    if (flags.monitoring.deployPrivateLink) {
      steps.push("private-link");
    }
  }
  if (isLabPhaseRequired(5, flags)) {
    steps.push(...LAB_ANALYTICS_STEPS);
  }
  if (isLabPhaseRequired(6, flags)) {
    steps.push("flow-logs");
  }
  if (isLabPhaseRequired(7, flags)) {
    steps.push("virtual-machines");
  }
  if (isLabPhaseRequired(8, flags)) {
    steps.push("data-collection-rules");
  }
  if (isLabPhaseRequired(9, flags)) {
    steps.push("cribl-configs");
  }
  if (isLabPhaseRequired(10, flags)) {
    steps.push("vpn-gateway", "vpn-connection");
  }
  return steps;
}

/** Default bound on retries and provisioning polls (attempts, not clock). */
export const DEFAULT_LAB_RETRY_ATTEMPTS = 6;

/** Default delay handed to the injected sleep hook between attempts. */
export const DEFAULT_LAB_RETRY_DELAY_MS = 10000;

/**
 * Default bound for LONG provisioning polls (ADX cluster 10-15 min, VPN
 * gateway 30-45 min, VMs a few minutes): 270 attempts at the default 10s
 * delay covers 45 minutes. Exhaustion fails the step HONESTLY with a
 * re-run-to-resume note - Azure keeps provisioning server-side and the
 * GET-first idempotency picks the finished resource up on the next run.
 */
export const DEFAULT_LAB_LONG_POLL_ATTEMPTS = 270;

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
  /** Entra tenant id embedded in generated Cribl configs ("" acceptable). */
  tenantId?: string;
  /** Entra client id embedded in generated Cribl configs ("" acceptable). */
  clientId?: string;
  /** Event Hub namespace settings; legacy Standard/1 default. */
  eventHubNamespaceSettings?: LabEventHubNamespaceSettings;
  /** Event Hub definitions; the legacy logs/metrics/events default. */
  labEventHubs?: readonly LabEventHub[];
  /** ADX cluster settings; the legacy Dev SKU default. */
  adxCluster?: LabAdxClusterSettings;
  /** ADX database settings; the legacy CriblLogs default. */
  adxDatabase?: LabAdxDatabaseSettings;
  /** Flow-log retention layout; the legacy dual-level default. */
  flowLogSettings?: LabFlowLogSettings;
  /** VM image/size settings; the legacy Ubuntu B1s default. */
  vmSettings?: LabVmSettings;
  /** VMs to deploy; the legacy vm-security/vm-o11y default. */
  vms?: readonly LabVmDef[];
  /** TRANSIENT VM admin password - required when the profile deploys VMs. */
  vmAdminPassword?: string;
  /** VPN gateway settings; the legacy Basic/RouteBased default. */
  vpnGatewaySettings?: LabVpnGatewaySettings;
  /** Optional on-premises side; the connection deploys only when configured. */
  onPrem?: LabOnPremConnection;
  /** Tables the DCR phase targets; the legacy four natives by default. */
  dcrTables?: readonly string[];
  /** Bound for LONG provisioning polls (ADX/VPN/VMs); default 270 attempts. */
  longPollAttempts?: number;
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

/** Monitoring phase outcome (present when the phase ran). */
export interface LabMonitoringOutcome {
  workspaceName: string;
  /** True when this run created the workspace (false = already existed). */
  workspaceCreated: boolean;
  /** True when Sentinel is enabled on the workspace after this run. */
  sentinelEnabled: boolean;
  /** True when the SecurityInsights solution already existed. */
  sentinelAlreadyEnabled: boolean;
}

/** Private Link outcome (present when the private-mode phase ran). */
export interface LabPrivateLinkOutcome {
  amplsName: string;
  privateEndpointName: string;
  /** True when the monitor DNS zone is linked to the lab VNet. */
  dnsZoneLinked: boolean;
}

/** Analytics phase outcome (present when the phase ran). */
export interface LabAnalyticsOutcome {
  namespaceName?: string;
  namespaceCreated?: boolean;
  hubs?: LabResourceOutcome[];
  adxClusterName?: string;
  adxClusterCreated?: boolean;
  /** The cluster's data URI (feeds the Cribl ADX destination config). */
  adxClusterUri?: string;
  adxDatabase?: string;
}

/** Flow-log phase outcome (present when the phase ran). */
export interface LabFlowLogsOutcome {
  /** The resolved watcher as "{resourceGroup}/{name}". */
  networkWatcher: string;
  flowLogs: LabResourceOutcome[];
}

/** Compute phase outcome (present when the phase ran). */
export interface LabComputeOutcome {
  vms: LabResourceOutcome[];
  autoShutdownConfigured: boolean;
}

/** One DCR deployed (or reused) by the data-collection phase. */
export interface LabDcrOutcome extends LabDcrReference {
  /** True when an existing DCR was reused (no PUT sent). */
  reused: boolean;
  /** Per-table failure text; the other fields are best-effort when set. */
  error?: string;
}

/** Gateway phase outcome (present when the phase ran). */
export interface LabGatewayOutcome {
  publicIpName: string;
  gatewayName: string;
  /** True once the gateway reports provisioningState Succeeded. */
  gatewayReady: boolean;
  /** The last observed provisioningState ("" when unknown). */
  provisioningState: string;
  /** Set when the site-to-site connection deployed. */
  connectionName?: string;
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
  /** Monitoring phase outcome (only when the profile ran the phase). */
  monitoring?: LabMonitoringOutcome;
  /** Private Link outcome (only when the private-mode phase ran). */
  privateLink?: LabPrivateLinkOutcome;
  /** Analytics phase outcome (only when the profile ran the phase). */
  analytics?: LabAnalyticsOutcome;
  /** Flow-log phase outcome (only when the profile ran the phase). */
  flowLogs?: LabFlowLogsOutcome;
  /** Compute phase outcome (only when the profile ran the phase). */
  compute?: LabComputeOutcome;
  /** Deployed/reused DCRs (only when the data-collection phase ran). */
  dcrs?: LabDcrOutcome[];
  /** The generated Cribl config bundle (only when the integration phase ran). */
  criblConfigs?: LabCriblBundle;
  /** Gateway phase outcome (only when the profile ran the phase). */
  gateway?: LabGatewayOutcome;
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
    // A constrained RBAC Administrator grant whose ABAC condition does not
    // allow assigning Contributor fails exactly here - name the fix.
    const bodyText = JSON.stringify(response.body) ?? "";
    const abacHint = /ABAC condition/i.test(bodyText)
      ? " The app's RBAC Administrator grant carries a role-assignment condition " +
        "that does not allow assigning Contributor - ask an admin to add " +
        `Contributor (${CONTRIBUTOR_ROLE_DEFINITION_ID}) to the condition's ` +
        "allowed roles for service principals (or run the az command below). " +
        "Use the Labs screen's permission check to verify before re-running."
      : "";
    const error =
      httpErrorText(
        `grant Contributor to the TTL identity on '${rg}'`,
        response.status,
        response.body,
      ) +
      abacHint +
      ` - the lab CANNOT self-delete until an admin grants the role: ${command}`;
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

  // ==========================================================================
  // PHASE 4: Monitoring (Log Analytics + Sentinel via the existing usecases)
  // ==========================================================================
  // True when the profile has no monitoring phase at all; the DCR phase gates
  // on it (DCRs target the lab workspace).
  let workspaceReady = !hasStep("log-analytics");
  if (hasStep("log-analytics")) {
    const monitoring: LabMonitoringOutcome = {
      workspaceName: input.names.logAnalytics,
      workspaceCreated: false,
      sentinelEnabled: false,
      sentinelAlreadyEnabled: false,
    };
    result.monitoring = monitoring;

    // --- log-analytics --------------------------------------------------------
    if (
      !input.flags.monitoring.deployLogAnalytics &&
      !input.flags.monitoring.deploySentinel
    ) {
      await skipSteps(["log-analytics"], NOT_REQUESTED);
    } else {
      await setStep("log-analytics", "running");
      const getWorkspace = await azure.request({
        method: "GET",
        path:
          `/subscriptions/${sub}/resourceGroups/${rg}` +
          `/providers/Microsoft.OperationalInsights/workspaces/${monitoring.workspaceName}`,
        apiVersion: WORKSPACE_API_VERSION,
      });
      if (is2xx(getWorkspace.status)) {
        workspaceReady = true;
        await setStep("log-analytics", "succeeded", "already existed");
      } else if (getWorkspace.status === 404) {
        try {
          await createWorkspace(
            azure,
            {
              subscriptionId: sub,
              resourceGroup: rg,
              name: monitoring.workspaceName,
              location: input.location,
              maxPollAttempts: maxAttempts,
            },
            logger,
          );
          monitoring.workspaceCreated = true;
          workspaceReady = true;
          await setStep("log-analytics", "succeeded", "created (PerGB2018, 90-day retention)");
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          errors.push(error);
          await setStep("log-analytics", "failed", error);
        }
      } else {
        const error = httpErrorText(
          `read workspace '${monitoring.workspaceName}'`,
          getWorkspace.status,
          getWorkspace.body,
        );
        errors.push(error);
        await setStep("log-analytics", "failed", error);
      }
    }

    // --- microsoft-sentinel ---------------------------------------------------
    if (!input.flags.monitoring.deploySentinel) {
      await skipSteps(["microsoft-sentinel"], NOT_REQUESTED);
    } else if (!workspaceReady) {
      await skipSteps(["microsoft-sentinel"], PREREQUISITE_FAILED);
    } else {
      await setStep("microsoft-sentinel", "running");
      try {
        const enabled = await enableSentinel(
          azure,
          {
            subscriptionId: sub,
            resourceGroup: rg,
            workspaceName: monitoring.workspaceName,
          },
          logger,
        );
        monitoring.sentinelEnabled = true;
        monitoring.sentinelAlreadyEnabled = enabled.alreadyEnabled;
        await setStep(
          "microsoft-sentinel",
          "succeeded",
          enabled.alreadyEnabled ? "already enabled" : `enabled (${enabled.solutionName})`,
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        errors.push(error);
        await setStep("microsoft-sentinel", "failed", error);
      }
    }

    // --- private-link (AMPLS + endpoint + DNS; legacy Deploy-PrivateLink) ---
    if (hasStep("private-link")) {
      if (!workspaceReady) {
        await skipSteps(["private-link"], PREREQUISITE_FAILED);
      } else {
        await setStep("private-link", "running");
        const amplsName = labAmplsName(input.baseObjectName, input.location);
        const peName = labPrivateEndpointName(input.baseObjectName);
        const privateLink: LabPrivateLinkOutcome = {
          amplsName,
          privateEndpointName: peName,
          dnsZoneLinked: false,
        };
        result.privateLink = privateLink;
        const amplsId =
          `/subscriptions/${sub}/resourceGroups/${rg}` +
          `/providers/microsoft.insights/privateLinkScopes/${amplsName}`;
        const workspaceId =
          `/subscriptions/${sub}/resourceGroups/${rg}` +
          `/providers/Microsoft.OperationalInsights/workspaces/${input.names.logAnalytics}`;
        const plSubnet =
          (input.subnets ?? DEFAULT_LAB_SUBNETS).find(
            (s) => s.key === "privatelink",
          )?.name ?? "PrivateLinkSubnet";
        const vnetId =
          `/subscriptions/${sub}/resourceGroups/${rg}` +
          `/providers/Microsoft.Network/virtualNetworks/${input.names.vnet}`;
        let plError = "";

        const ensure = async (
          get: () => Promise<{ status: number; body: unknown }>,
          put: () => Promise<{ status: number; body: unknown }>,
          context: string,
        ): Promise<boolean> => {
          if (plError !== "") {
            return false;
          }
          const got = await get();
          if (is2xx(got.status)) {
            return true;
          }
          if (got.status !== 404) {
            plError = httpErrorText(`read ${context}`, got.status, got.body);
            return false;
          }
          const created = await put();
          if (!is2xx(created.status)) {
            plError = httpErrorText(`create ${context}`, created.status, created.body);
            return false;
          }
          return true;
        };

        await ensure(
          () => azure.request(buildAmplsGetRequest(sub, rg, amplsName)),
          () => azure.request(buildAmplsPutRequest(sub, rg, amplsName)),
          `AMPLS '${amplsName}'`,
        );
        await ensure(
          () => azure.request(buildAmplsScopedResourceGetRequest(sub, rg, amplsName)),
          () =>
            azure.request(
              buildAmplsScopedResourcePutRequest(sub, rg, amplsName, workspaceId),
            ),
          "AMPLS workspace association",
        );
        await ensure(
          () => azure.request(buildPrivateEndpointGetRequest(sub, rg, peName)),
          () =>
            azure.request(
              buildPrivateEndpointPutRequest(
                sub,
                rg,
                peName,
                input.location,
                `${vnetId}/subnets/${plSubnet}`,
                amplsId,
              ),
            ),
          `private endpoint '${peName}'`,
        );
        const zoneReady = await ensure(
          () =>
            azure.request(
              buildPrivateDnsZoneGetRequest(sub, rg, LAB_MONITOR_PRIVATE_DNS_ZONE),
            ),
          () =>
            azure.request(
              buildPrivateDnsZonePutRequest(sub, rg, LAB_MONITOR_PRIVATE_DNS_ZONE),
            ),
          `private DNS zone '${LAB_MONITOR_PRIVATE_DNS_ZONE}'`,
        );
        if (zoneReady) {
          const linked = await ensure(
            () =>
              azure.request(
                buildDnsVnetLinkGetRequest(
                  sub,
                  rg,
                  LAB_MONITOR_PRIVATE_DNS_ZONE,
                  input.names.vnet,
                ),
              ),
            () =>
              azure.request(
                buildDnsVnetLinkPutRequest(
                  sub,
                  rg,
                  LAB_MONITOR_PRIVATE_DNS_ZONE,
                  input.names.vnet,
                  vnetId,
                ),
              ),
            "DNS zone VNet link",
          );
          privateLink.dnsZoneLinked = linked;
        }

        if (plError !== "") {
          errors.push(plError);
          await setStep("private-link", "failed", plError);
        } else {
          await setStep(
            "private-link",
            "succeeded",
            `${amplsName}, ${peName}, DNS zone linked`,
          );
        }
      }
    }
  }

  const longPollAttempts = input.longPollAttempts ?? DEFAULT_LAB_LONG_POLL_ATTEMPTS;
  const provisioningState = (body: unknown): string => {
    const properties = prop(body, "properties");
    return asString(prop(properties, "provisioningState"));
  };

  // ==========================================================================
  // PHASE 5: Analytics (Event Hub namespace/hubs/groups + ADX)
  // ==========================================================================
  if (hasStep("event-hub")) {
    const analytics: LabAnalyticsOutcome = result.analytics ?? {};
    result.analytics = analytics;

    if (!input.flags.analytics.deployEventHub) {
      await skipSteps(["event-hub"], NOT_REQUESTED);
    } else {
      await setStep("event-hub", "running");
      const nsName = input.names.eventHubNamespace;
      analytics.namespaceName = nsName;
      analytics.hubs = [];
      let ehError = "";

      const getNs = await azure.request(
        buildEventHubNamespaceGetRequest(sub, rg, nsName),
      );
      if (getNs.status === 404) {
        const putNs = await azure.request(
          buildEventHubNamespacePutRequest(
            sub,
            rg,
            nsName,
            input.location,
            input.eventHubNamespaceSettings ?? DEFAULT_LAB_EVENTHUB_NAMESPACE,
          ),
        );
        if (!is2xx(putNs.status)) {
          ehError = httpErrorText(
            `create Event Hub namespace '${nsName}'`,
            putNs.status,
            putNs.body,
          );
        } else {
          analytics.namespaceCreated = true;
          let state = provisioningState(putNs.body);
          for (let poll = 0; state !== "Succeeded" && poll < maxAttempts; poll++) {
            await sleep(delayMs);
            const read = await azure.request(
              buildEventHubNamespaceGetRequest(sub, rg, nsName),
            );
            state = is2xx(read.status) ? provisioningState(read.body) : "";
          }
          if (state !== "Succeeded") {
            ehError =
              `Event Hub namespace '${nsName}' did not reach Succeeded ` +
              `within ${maxAttempts} attempt(s)`;
          }
        }
      } else if (!is2xx(getNs.status)) {
        ehError = httpErrorText(
          `read Event Hub namespace '${nsName}'`,
          getNs.status,
          getNs.body,
        );
      } else {
        analytics.namespaceCreated = false;
      }

      if (ehError === "") {
        for (const hub of input.labEventHubs ?? DEFAULT_LAB_EVENT_HUBS) {
          const getHub = await azure.request(
            buildEventHubGetRequest(sub, rg, nsName, hub.name),
          );
          if (is2xx(getHub.status)) {
            analytics.hubs.push({ name: hub.name, created: false });
          } else if (getHub.status === 404) {
            const putHub = await azure.request(
              buildEventHubPutRequest(
                sub,
                rg,
                nsName,
                hub.name,
                hub.partitionCount,
                hub.messageRetentionInDays,
              ),
            );
            if (is2xx(putHub.status)) {
              analytics.hubs.push({ name: hub.name, created: true });
            } else {
              ehError = httpErrorText(
                `create Event Hub '${hub.name}'`,
                putHub.status,
                putHub.body,
              );
              break;
            }
          } else {
            ehError = httpErrorText(
              `read Event Hub '${hub.name}'`,
              getHub.status,
              getHub.body,
            );
            break;
          }
          // The legacy per-hub consumer groups (["cribl"] in the shipped config).
          for (const group of DEFAULT_LAB_CONSUMER_GROUPS) {
            const getGroup = await azure.request(
              buildConsumerGroupGetRequest(sub, rg, nsName, hub.name, group),
            );
            if (getGroup.status === 404) {
              const putGroup = await azure.request(
                buildConsumerGroupPutRequest(sub, rg, nsName, hub.name, group),
              );
              if (!is2xx(putGroup.status)) {
                ehError = httpErrorText(
                  `create consumer group '${group}' on '${hub.name}'`,
                  putGroup.status,
                  putGroup.body,
                );
                break;
              }
            } else if (!is2xx(getGroup.status)) {
              ehError = httpErrorText(
                `read consumer group '${group}' on '${hub.name}'`,
                getGroup.status,
                getGroup.body,
              );
              break;
            }
          }
          if (ehError !== "") {
            break;
          }
        }
      }

      if (ehError !== "") {
        errors.push(ehError);
        await setStep("event-hub", "failed", ehError);
      } else {
        await setStep(
          "event-hub",
          "succeeded",
          `${nsName}: ${analytics.hubs.map((h) => h.name).join(", ")}`,
        );
      }
    }

    if (!input.flags.analytics.deployADX) {
      await skipSteps(["adx"], NOT_REQUESTED);
    } else {
      await setStep("adx", "running");
      const clusterName = input.names.adxCluster;
      const database = input.adxDatabase ?? DEFAULT_LAB_ADX_DATABASE;
      analytics.adxClusterName = clusterName;
      analytics.adxDatabase = database.name;
      let adxError = "";

      const getCluster = await azure.request(
        buildAdxClusterGetRequest(sub, rg, clusterName),
      );
      if (is2xx(getCluster.status)) {
        analytics.adxClusterCreated = false;
        analytics.adxClusterUri = parseAdxClusterUri(getCluster.body);
      } else if (getCluster.status === 404) {
        const putCluster = await azure.request(
          buildAdxClusterPutRequest(
            sub,
            rg,
            clusterName,
            input.location,
            input.adxCluster ?? DEFAULT_LAB_ADX_CLUSTER,
          ),
        );
        if (!is2xx(putCluster.status)) {
          adxError = httpErrorText(
            `create ADX cluster '${clusterName}'`,
            putCluster.status,
            putCluster.body,
          );
        } else {
          analytics.adxClusterCreated = true;
          // A 10-15 minute provisioning operation: the LONG poll bound.
          let state = provisioningState(putCluster.body);
          let uri = parseAdxClusterUri(putCluster.body);
          for (
            let poll = 0;
            state !== "Succeeded" && poll < longPollAttempts;
            poll++
          ) {
            await sleep(delayMs);
            const read = await azure.request(
              buildAdxClusterGetRequest(sub, rg, clusterName),
            );
            if (is2xx(read.status)) {
              state = provisioningState(read.body);
              uri = parseAdxClusterUri(read.body);
            }
          }
          analytics.adxClusterUri = uri;
          if (state !== "Succeeded") {
            adxError =
              `ADX cluster '${clusterName}' is still provisioning after ` +
              `${longPollAttempts} poll attempt(s) - Azure continues server-side; ` +
              "re-run the deploy later to resume from the finished cluster";
          }
        }
      } else {
        adxError = httpErrorText(
          `read ADX cluster '${clusterName}'`,
          getCluster.status,
          getCluster.body,
        );
      }

      if (adxError === "") {
        const getDb = await azure.request(
          buildAdxDatabaseGetRequest(sub, rg, clusterName, database.name),
        );
        if (getDb.status === 404) {
          const putDb = await azure.request(
            buildAdxDatabasePutRequest(sub, rg, clusterName, input.location, database),
          );
          if (!is2xx(putDb.status)) {
            adxError = httpErrorText(
              `create ADX database '${database.name}'`,
              putDb.status,
              putDb.body,
            );
          }
        } else if (!is2xx(getDb.status)) {
          adxError = httpErrorText(
            `read ADX database '${database.name}'`,
            getDb.status,
            getDb.body,
          );
        }
      }

      if (adxError === "") {
        // The CommonSecurityLog table via the ARM script resource (GET-first;
        // the script runs async inside the database after the PUT accepts).
        const getScript = await azure.request(
          buildAdxScriptGetRequest(sub, rg, clusterName, database.name, "CommonSecurityLog"),
        );
        if (getScript.status === 404) {
          const putScript = await azure.request(
            buildAdxScriptPutRequest(
              sub,
              rg,
              clusterName,
              database.name,
              "CommonSecurityLog",
              LAB_ADX_COMMONSECURITYLOG_SCHEMA,
            ),
          );
          if (!is2xx(putScript.status)) {
            adxError = httpErrorText(
              "create ADX table script 'create-table-CommonSecurityLog'",
              putScript.status,
              putScript.body,
            );
          }
        } else if (!is2xx(getScript.status)) {
          adxError = httpErrorText(
            "read ADX table script 'create-table-CommonSecurityLog'",
            getScript.status,
            getScript.body,
          );
        }
      }

      if (adxError !== "") {
        errors.push(adxError);
        await setStep("adx", "failed", adxError);
      } else {
        await setStep(
          "adx",
          "succeeded",
          `${clusterName} / ${database.name} (CommonSecurityLog table script submitted)`,
        );
      }
    }
  }

  // ==========================================================================
  // PHASE 6: Flow logs (resolved Network Watcher; vNet + subnet levels)
  // ==========================================================================
  if (hasStep("flow-logs")) {
    await setStep("flow-logs", "running");
    const settings = input.flowLogSettings ?? DEFAULT_LAB_FLOW_LOG_SETTINGS;
    const storageAccountName = result.storage?.accountName ?? input.names.storageAccount;
    const storageId =
      `/subscriptions/${sub}/resourceGroups/${rg}` +
      `/providers/Microsoft.Storage/storageAccounts/${storageAccountName}`;
    const vnetId =
      `/subscriptions/${sub}/resourceGroups/${rg}` +
      `/providers/Microsoft.Network/virtualNetworks/${input.names.vnet}`;
    let flError = "";

    // Watcher resolution, legacy order: lab-named -> Azure default -> create.
    let watcherRg = rg;
    let watcherName = input.names.networkWatcher;
    const labWatcher = await azure.request(
      buildNetworkWatcherGetRequest(sub, rg, watcherName),
    );
    if (!is2xx(labWatcher.status)) {
      const defaultWatcher = await azure.request(
        buildNetworkWatcherGetRequest(
          sub,
          AZURE_NETWORK_WATCHER_RG,
          azureDefaultNetworkWatcherName(input.location),
        ),
      );
      if (is2xx(defaultWatcher.status)) {
        watcherRg = AZURE_NETWORK_WATCHER_RG;
        watcherName = azureDefaultNetworkWatcherName(input.location);
      } else {
        const createWatcher = await azure.request(
          buildNetworkWatcherPutRequest(sub, rg, watcherName, input.location),
        );
        if (!is2xx(createWatcher.status)) {
          flError = httpErrorText(
            `create Network Watcher '${watcherName}'`,
            createWatcher.status,
            createWatcher.body,
          );
        }
      }
    }

    const flowLogs: LabFlowLogsOutcome = {
      networkWatcher: `${watcherRg}/${watcherName}`,
      flowLogs: [],
    };
    result.flowLogs = flowLogs;

    const ensureFlowLog = async (
      name: string,
      targetResourceId: string,
      retentionDays: number,
    ): Promise<void> => {
      if (flError !== "") {
        return;
      }
      const got = await azure.request(
        buildFlowLogGetRequest(sub, watcherRg, watcherName, name),
      );
      if (is2xx(got.status)) {
        flowLogs.flowLogs.push({ name, created: false });
        return;
      }
      const put = await azure.request(
        buildFlowLogPutRequest({
          subscriptionId: sub,
          networkWatcherResourceGroup: watcherRg,
          networkWatcherName: watcherName,
          flowLogName: name,
          location: input.location,
          targetResourceId,
          storageAccountResourceId: storageId,
          retentionDays,
        }),
      );
      if (is2xx(put.status)) {
        flowLogs.flowLogs.push({ name, created: true });
      } else if (isFlowLogAlreadyExistsError(put.body)) {
        // The target already carries a flow log under another name (legacy
        // treated this conflict as already-exists).
        flowLogs.flowLogs.push({ name, created: false });
      } else {
        flError = httpErrorText(`create flow log '${name}'`, put.status, put.body);
      }
    };

    if (settings.vnetLevel.enabled) {
      await ensureFlowLog(
        labFlowLogName(input.names.vnet),
        vnetId,
        settings.vnetLevel.retentionDays,
      );
    }
    for (const subnet of input.subnets ?? DEFAULT_LAB_SUBNETS) {
      const subnetSettings = settings.subnetLevel[subnet.key];
      if (subnetSettings === undefined || !subnetSettings.enabled) {
        continue;
      }
      await ensureFlowLog(
        labFlowLogName(input.names.vnet, subnet.name),
        `${vnetId}/subnets/${subnet.name}`,
        subnetSettings.retentionDays,
      );
    }

    if (flError !== "") {
      errors.push(flError);
      await setStep("flow-logs", "failed", flError);
    } else {
      await setStep(
        "flow-logs",
        "succeeded",
        `${flowLogs.flowLogs.length} flow log(s) via ${flowLogs.networkWatcher}`,
      );
    }
  }

  // ==========================================================================
  // PHASE 7: Compute (test VMs + auto-shutdown)
  // ==========================================================================
  if (hasStep("virtual-machines")) {
    await setStep("virtual-machines", "running");
    const settings = input.vmSettings ?? DEFAULT_LAB_VM_SETTINGS;
    const compute: LabComputeOutcome = {
      vms: [],
      autoShutdownConfigured: settings.autoShutdownEnabled,
    };
    result.compute = compute;
    const password = input.vmAdminPassword ?? "";
    let vmError = "";

    if (password === "") {
      vmError =
        "VM admin password is required (transient deploy input) - supply it and re-run; " +
        "existing VMs are picked up without it on a re-run";
    } else {
      const vnetId =
        `/subscriptions/${sub}/resourceGroups/${rg}` +
        `/providers/Microsoft.Network/virtualNetworks/${input.names.vnet}`;
      const subnets = input.subnets ?? DEFAULT_LAB_SUBNETS;
      for (const vm of input.vms ?? DEFAULT_LAB_VMS) {
        const subnet = subnets.find((s) => s.key === vm.subnetKey);
        if (subnet === undefined) {
          vmError = `VM '${vm.vmName}' targets unknown subnet key '${vm.subnetKey}'`;
          break;
        }
        const fullName = labVmName(input.baseObjectName, vm.vmName);
        const nicName = labVmNicName(fullName);

        const getVm = await azure.request(buildVmGetRequest(sub, rg, fullName));
        if (is2xx(getVm.status)) {
          compute.vms.push({ name: fullName, created: false });
        } else if (getVm.status === 404) {
          const getNic = await azure.request(buildNicGetRequest(sub, rg, nicName));
          if (getNic.status === 404) {
            const putNic = await azure.request(
              buildNicPutRequest(
                sub,
                rg,
                nicName,
                input.location,
                `${vnetId}/subnets/${subnet.name}`,
              ),
            );
            if (!is2xx(putNic.status)) {
              vmError = httpErrorText(
                `create NIC '${nicName}'`,
                putNic.status,
                putNic.body,
              );
              break;
            }
          } else if (!is2xx(getNic.status)) {
            vmError = httpErrorText(
              `read NIC '${nicName}'`,
              getNic.status,
              getNic.body,
            );
            break;
          }
          const nicId =
            `/subscriptions/${sub}/resourceGroups/${rg}` +
            `/providers/Microsoft.Network/networkInterfaces/${nicName}`;
          const putVm = await azure.request(
            buildVmPutRequest({
              subscriptionId: sub,
              resourceGroup: rg,
              vmName: fullName,
              location: input.location,
              settings,
              nicResourceId: nicId,
              adminPassword: password,
            }),
          );
          if (!is2xx(putVm.status)) {
            vmError = httpErrorText(
              `create VM '${fullName}'`,
              putVm.status,
              putVm.body,
            );
            break;
          }
          let state = parseVmProvisioningState(putVm.body);
          for (let poll = 0; state !== "Succeeded" && poll < longPollAttempts; poll++) {
            await sleep(delayMs);
            const read = await azure.request(buildVmGetRequest(sub, rg, fullName));
            state = is2xx(read.status) ? parseVmProvisioningState(read.body) : "";
          }
          if (state !== "Succeeded") {
            vmError =
              `VM '${fullName}' did not reach Succeeded within ` +
              `${longPollAttempts} poll attempt(s)`;
            break;
          }
          compute.vms.push({ name: fullName, created: true });
        } else {
          vmError = httpErrorText(`read VM '${fullName}'`, getVm.status, getVm.body);
          break;
        }

        if (settings.autoShutdownEnabled) {
          const getSchedule = await azure.request(
            buildShutdownScheduleGetRequest(sub, rg, fullName),
          );
          if (getSchedule.status === 404) {
            const putSchedule = await azure.request(
              buildShutdownSchedulePutRequest(sub, rg, fullName, input.location, settings),
            );
            if (!is2xx(putSchedule.status)) {
              // Legacy treated schedule failures as warnings, not VM failures.
              logger?.warn(
                "provision-lab: auto-shutdown schedule failed",
                { vm: fullName, status: putSchedule.status },
                job?.id,
              );
            }
          }
        }
      }
    }

    if (vmError !== "") {
      errors.push(vmError);
      await setStep("virtual-machines", "failed", vmError);
    } else {
      await setStep(
        "virtual-machines",
        "succeeded",
        compute.vms.map((v) => v.name).join(", "),
      );
    }
  }

  // ==========================================================================
  // PHASE 8: Data collection rules (the four legacy natives, Direct DCRs)
  // ==========================================================================
  if (hasStep("data-collection-rules") && !workspaceReady) {
    await skipSteps(["data-collection-rules"], PREREQUISITE_FAILED);
  } else if (hasStep("data-collection-rules")) {
    await setStep("data-collection-rules", "running");
    const dcrs: LabDcrOutcome[] = [];
    result.dcrs = dcrs;
    const workspaceId =
      `/subscriptions/${sub}/resourceGroups/${rg}` +
      `/providers/Microsoft.OperationalInsights/workspaces/${input.names.logAnalytics}`;

    for (const table of input.dcrTables ?? LAB_DCR_TABLES) {
      const record: LabDcrOutcome = {
        table,
        dcrName: "",
        immutableId: "",
        logsIngestionEndpoint: "",
        stream: `Custom-${table}`,
        reused: false,
      };
      dcrs.push(record);

      // Sentinel-provisioned native tables appear asynchronously (the legacy
      // waited a blind 60s); poll the table attempt-bounded.
      let tableBody: unknown = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const tableResponse = await azure.request({
          method: "GET",
          path: `${workspaceId}/tables/${table}`,
          apiVersion: LOG_ANALYTICS_TABLES_API_VERSION,
        });
        if (is2xx(tableResponse.status)) {
          tableBody = tableResponse.body;
          break;
        }
        if (tableResponse.status !== 404) {
          record.error = httpErrorText(
            `read table '${table}'`,
            tableResponse.status,
            tableResponse.body,
          );
          break;
        }
        await sleep(delayMs);
      }
      if (record.error !== undefined) {
        continue;
      }
      if (tableBody === null) {
        record.error =
          `table '${table}' is not provisioned yet (Sentinel tables appear ` +
          `asynchronously) - re-run the deploy later`;
        continue;
      }

      const schema = prop(prop(tableBody, "properties"), "schema");
      const columns = selectSchemaColumns(
        {
          columns: prop(schema, "columns") as LogAnalyticsColumn[] | undefined,
          standardColumns: prop(schema, "standardColumns") as
            | LogAnalyticsColumn[]
            | undefined,
        },
        "native",
      );
      if (columns === null) {
        record.error = `table '${table}' has no usable column source in its schema`;
        continue;
      }

      const { name: dcrName } = generateDcrName({
        table,
        mode: "direct",
        prefix: "dcr-",
        location: input.location,
        isCustomTable: false,
      });
      record.dcrName = dcrName;
      const dcrPath =
        `/subscriptions/${sub}/resourceGroups/${rg}` +
        `/providers/Microsoft.Insights/dataCollectionRules/${dcrName}`;

      const getDcr = await azure.request({
        method: "GET",
        path: dcrPath,
        apiVersion: DIRECT_DCR_API_VERSION,
      });
      if (is2xx(getDcr.status)) {
        const existing = parseDcrDeployment(getDcr.body);
        record.reused = true;
        record.immutableId = existing.immutableId ?? "";
        record.logsIngestionEndpoint = existing.logsIngestionEndpoint ?? "";
        continue;
      }
      if (getDcr.status !== 404) {
        record.error = httpErrorText(
          `read DCR '${dcrName}'`,
          getDcr.status,
          getDcr.body,
        );
        continue;
      }

      let request;
      try {
        request = buildDirectDcrRequest({
          table,
          columns,
          location: input.location,
          workspaceResourceId: workspaceId,
          dcrName,
          tableMode: "native",
        });
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
        continue;
      }
      record.stream = request.streamName;
      const putDcr = await azure.request({
        method: request.method,
        path: request.path,
        apiVersion: request.apiVersion,
        body: request.body,
      });
      if (!is2xx(putDcr.status)) {
        record.error = httpErrorText(
          `deploy DCR '${dcrName}'`,
          putDcr.status,
          putDcr.body,
        );
        continue;
      }
      let deployment = parseDcrDeployment(putDcr.body);
      for (
        let poll = 0;
        deployment.provisioningState?.toLowerCase() !== "succeeded" &&
        poll < maxAttempts;
        poll++
      ) {
        await sleep(delayMs);
        const read = await azure.request({
          method: "GET",
          path: dcrPath,
          apiVersion: DIRECT_DCR_API_VERSION,
        });
        if (is2xx(read.status)) {
          deployment = parseDcrDeployment(read.body);
        }
      }
      if (deployment.provisioningState?.toLowerCase() !== "succeeded") {
        record.error =
          `DCR '${dcrName}' did not reach Succeeded within ${maxAttempts} poll attempt(s)`;
        continue;
      }
      record.immutableId = deployment.immutableId ?? "";
      record.logsIngestionEndpoint = deployment.logsIngestionEndpoint ?? "";
    }

    const failures = dcrs.filter((d) => d.error !== undefined);
    if (failures.length > 0) {
      const error = failures.map((f) => `${f.table}: ${f.error}`).join("; ");
      errors.push(error);
      await setStep("data-collection-rules", "failed", error);
    } else {
      await setStep(
        "data-collection-rules",
        "succeeded",
        dcrs
          .map((d) => `${d.table} -> ${d.dcrName}${d.reused ? " (reused)" : ""}`)
          .join(", "),
      );
    }
  }

  // ==========================================================================
  // PHASE 9: Integration (the Cribl config bundle - pure assembly)
  // ==========================================================================
  if (hasStep("cribl-configs")) {
    await setStep("cribl-configs", "running");
    const bundle = buildLabCriblBundle({
      flags: input.flags,
      tenantId: input.tenantId ?? "",
      clientId: input.clientId ?? "",
      storageAccountName: result.storage?.accountName ?? input.names.storageAccount,
      eventHubNamespace: input.names.eventHubNamespace,
      eventHubs: input.labEventHubs ?? DEFAULT_LAB_EVENT_HUBS,
      adxClusterName: input.names.adxCluster,
      adxClusterUri: result.analytics?.adxClusterUri ?? "",
      adxDatabase: (input.adxDatabase ?? DEFAULT_LAB_ADX_DATABASE).name,
      dcrs: (result.dcrs ?? []).filter((d) => d.error === undefined),
    });
    result.criblConfigs = bundle;
    await setStep(
      "cribl-configs",
      "succeeded",
      `${bundle.adxDestinations.length} destination(s), ` +
        `${bundle.eventHubSources.length + bundle.blobSources.length} source(s), ` +
        `${bundle.requiredSecrets.length} required secret(s)`,
    );
  }

  // ==========================================================================
  // PHASE 10: Gateway (VPN gateway + optional site-to-site connection)
  // ==========================================================================
  if (hasStep("vpn-gateway")) {
    await setStep("vpn-gateway", "running");
    const gateway: LabGatewayOutcome = {
      publicIpName: input.names.vpnPublicIp,
      gatewayName: input.names.vpnGateway,
      gatewayReady: false,
      provisioningState: "",
    };
    result.gateway = gateway;
    let gwError = "";

    const getGw = await azure.request(
      buildVpnGatewayGetRequest(sub, rg, gateway.gatewayName),
    );
    if (is2xx(getGw.status)) {
      gateway.provisioningState = provisioningState(getGw.body);
      gateway.gatewayReady = gateway.provisioningState === "Succeeded";
    } else if (getGw.status === 404) {
      const getPip = await azure.request(
        buildGatewayPublicIpGetRequest(sub, rg, gateway.publicIpName),
      );
      if (getPip.status === 404) {
        const putPip = await azure.request(
          buildGatewayPublicIpPutRequest(sub, rg, gateway.publicIpName, input.location),
        );
        if (!is2xx(putPip.status)) {
          gwError = httpErrorText(
            `create public IP '${gateway.publicIpName}'`,
            putPip.status,
            putPip.body,
          );
        }
      } else if (!is2xx(getPip.status)) {
        gwError = httpErrorText(
          `read public IP '${gateway.publicIpName}'`,
          getPip.status,
          getPip.body,
        );
      }
      if (gwError === "") {
        const vnetId =
          `/subscriptions/${sub}/resourceGroups/${rg}` +
          `/providers/Microsoft.Network/virtualNetworks/${input.names.vnet}`;
        const putGw = await azure.request(
          buildVpnGatewayPutRequest({
            subscriptionId: sub,
            resourceGroup: rg,
            gatewayName: gateway.gatewayName,
            location: input.location,
            gatewaySubnetResourceId: `${vnetId}/subnets/GatewaySubnet`,
            publicIpResourceId:
              `/subscriptions/${sub}/resourceGroups/${rg}` +
              `/providers/Microsoft.Network/publicIPAddresses/${gateway.publicIpName}`,
            settings: input.vpnGatewaySettings ?? DEFAULT_LAB_VPN_GATEWAY,
          }),
        );
        if (!is2xx(putGw.status)) {
          gwError = httpErrorText(
            `create VPN gateway '${gateway.gatewayName}'`,
            putGw.status,
            putGw.body,
          );
        } else {
          // The 30-45 minute operation: the LONG poll bound; exhaustion is an
          // honest still-provisioning failure and a re-run resumes GET-first.
          let state = provisioningState(putGw.body);
          for (
            let poll = 0;
            state !== "Succeeded" && poll < longPollAttempts;
            poll++
          ) {
            await sleep(delayMs);
            const read = await azure.request(
              buildVpnGatewayGetRequest(sub, rg, gateway.gatewayName),
            );
            state = is2xx(read.status) ? provisioningState(read.body) : "";
          }
          gateway.provisioningState = state;
          gateway.gatewayReady = state === "Succeeded";
          if (!gateway.gatewayReady) {
            gwError =
              `VPN gateway '${gateway.gatewayName}' is still provisioning after ` +
              `${longPollAttempts} poll attempt(s) (30-45 minutes is normal) - ` +
              "Azure continues server-side; re-run the deploy later to resume";
          }
        }
      }
    } else {
      gwError = httpErrorText(
        `read VPN gateway '${gateway.gatewayName}'`,
        getGw.status,
        getGw.body,
      );
    }

    if (gwError !== "") {
      errors.push(gwError);
      await setStep("vpn-gateway", "failed", gwError);
    } else {
      await setStep(
        "vpn-gateway",
        "succeeded",
        `${gateway.gatewayName} (${gateway.provisioningState})`,
      );
    }

    // --- vpn-connection (optional on-premises site-to-site) -----------------
    if (hasStep("vpn-connection")) {
      if (!isOnPremConnectionConfigured(input.onPrem)) {
        await skipSteps(
          ["vpn-connection"],
          "on-premises connection not configured (device IP, address spaces, shared key)",
        );
      } else if (!gateway.gatewayReady) {
        await skipSteps(["vpn-connection"], PREREQUISITE_FAILED);
      } else {
        await setStep("vpn-connection", "running");
        let connError = "";
        const getLng = await azure.request(
          buildLocalNetworkGatewayGetRequest(sub, rg),
        );
        if (getLng.status === 404) {
          const putLng = await azure.request(
            buildLocalNetworkGatewayPutRequest(sub, rg, input.location, input.onPrem),
          );
          if (!is2xx(putLng.status)) {
            connError = httpErrorText(
              `create local network gateway '${LAB_LOCAL_NETWORK_GATEWAY_NAME}'`,
              putLng.status,
              putLng.body,
            );
          }
        } else if (!is2xx(getLng.status)) {
          connError = httpErrorText(
            `read local network gateway '${LAB_LOCAL_NETWORK_GATEWAY_NAME}'`,
            getLng.status,
            getLng.body,
          );
        }
        if (connError === "") {
          const getConn = await azure.request(buildVpnConnectionGetRequest(sub, rg));
          if (getConn.status === 404) {
            const putConn = await azure.request(
              buildVpnConnectionPutRequest(
                sub,
                rg,
                input.location,
                `/subscriptions/${sub}/resourceGroups/${rg}` +
                  `/providers/Microsoft.Network/virtualNetworkGateways/${gateway.gatewayName}`,
                `/subscriptions/${sub}/resourceGroups/${rg}` +
                  `/providers/Microsoft.Network/localNetworkGateways/${LAB_LOCAL_NETWORK_GATEWAY_NAME}`,
                input.onPrem.sharedKey,
              ),
            );
            if (!is2xx(putConn.status)) {
              connError = httpErrorText(
                `create VPN connection '${LAB_VPN_CONNECTION_NAME}'`,
                putConn.status,
                putConn.body,
              );
            }
          } else if (!is2xx(getConn.status)) {
            connError = httpErrorText(
              `read VPN connection '${LAB_VPN_CONNECTION_NAME}'`,
              getConn.status,
              getConn.body,
            );
          }
        }
        if (connError !== "") {
          errors.push(connError);
          await setStep("vpn-connection", "failed", connError);
        } else {
          gateway.connectionName = LAB_VPN_CONNECTION_NAME;
          await setStep(
            "vpn-connection",
            "succeeded",
            `${LAB_VPN_CONNECTION_NAME} via ${LAB_LOCAL_NETWORK_GATEWAY_NAME}`,
          );
        }
      }
    }
  }

  return finish();
}
