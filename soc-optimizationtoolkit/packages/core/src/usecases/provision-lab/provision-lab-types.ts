/**
 * provision-lab types - the PUBLIC interface of the lab deployment engine:
 * input/result shapes, per-phase outcome types, the step-list derivation,
 * and the retry/poll defaults. The engine itself is the phase sequencer in
 * provision-lab.ts composing the per-phase modules (*-phase.ts) over the
 * ARM resource toolkit (arm-resource.ts); everything a CALLER needs is
 * re-exported from provision-lab.ts unchanged.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { JobStore } from "../../ports/job-store";
import type { Logger } from "../../ports/logger";
import type { LabTtlSettings } from "../../domain/labs/lab-foundation";
import {
  isLabPhaseRequired,
  type LabComponentFlags,
} from "../../domain/labs/lab-profiles";
import type { LabResourceNames, LabSubnet } from "../../domain/labs/lab-naming";
import type {
  LabContainerDef,
  LabEventGridSubscriptionDef,
  LabQueueDef,
  LabStorageAccountSettings,
} from "../../domain/labs/lab-storage";
import type { LabNetworkSecuritySettings } from "../../domain/labs/lab-networking";
import type {
  LabAdxClusterSettings,
  LabAdxDatabaseSettings,
  LabEventHubNamespaceSettings,
} from "../../domain/labs/lab-analytics";
import type { LabFlowLogSettings } from "../../domain/labs/lab-flowlogs";
import type { LabVmDef, LabVmSettings } from "../../domain/labs/lab-compute";
import type {
  LabOnPremConnection,
  LabVpnGatewaySettings,
} from "../../domain/labs/lab-gateway";
import type { LabCriblBundle, LabDcrReference } from "../../domain/labs/lab-cribl";
import type { LabEventHub } from "../../domain/labs/lab-naming";
import type { JobStep } from "../../ports/job-store";

/** JobStore `kind` for records created by provisionLab. */
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

/** Retry policy: bounded by ATTEMPTS; the SHELL injects the sleep hook. */
export interface ProvisionLabRetry {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The ports provisionLab orchestrates. */
export interface ProvisionLabPorts {
  azure: AzureManagement;
  /** OPTIONAL job record (kind {@link PROVISION_LAB_JOB_KIND}). */
  jobs?: JobStore;
  /** OPTIONAL diagnostics sink, tagged with the job id when jobs is present. */
  logger?: Logger;
}

/** Input for provisionLab. */
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
export const PREREQUISITE_FAILED = "prerequisite-failed";

/** Reason detail for sub-steps the profile does not request. */
export const NOT_REQUESTED = "not requested by profile";
