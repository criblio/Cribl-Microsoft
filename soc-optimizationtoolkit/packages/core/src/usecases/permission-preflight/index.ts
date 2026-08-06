export {
  runPermissionPreflight,
  runAzurePreflight,
  runCriblPreflight,
  scopeKindForSetupPath,
  buildArmScope,
  checkedAzureActions,
  leastPrivilegeRoleDefinition,
  CRIBL_CAPABILITY_PROBES,
  RBAC_PERMISSIONS_API_VERSION,
} from "./permission-preflight";
export type {
  PermissionReport,
  PermissionPreflightPorts,
  PermissionPreflightInput,
  AzurePreflight,
  AzurePreflightTarget,
  AzureProbeResult,
  AzureProbeStatus,
  AzureRolePermission,
  CriblPreflight,
  CriblCapabilityProbe,
  CriblCapabilitySpec,
  CriblProbeStatus,
  CriblShellMode,
  LeastPrivilegeRoleDefinition,
  PreflightScopeKind,
} from "./permission-preflight";
export {
  AZURE_ACTION_CAPABILITIES,
  AZURE_PROBE_CAPABILITIES,
  CRIBL_PROBE_CAPABILITIES,
  capabilitiesCheckedForSetupPath,
  capabilitiesFromReport,
} from "./capability-mapping";
export type { CapabilityAuditMeta } from "./capability-mapping";
