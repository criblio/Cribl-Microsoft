/**
 * Capability model (docs/capability-model-plan.md) - what the connected
 * identity can actually do, replacing app modes as the thing the product gates
 * on. Not yet wired into the frame; see the plan's sequencing.
 */
export type {
  AzureCapability,
  Capability,
  CapabilityContext,
  CapabilitySet,
  CapabilityVerdict,
  CriblCapability,
} from "./capabilities";
export {
  AZURE_CAPABILITIES,
  CRIBL_CAPABILITIES,
  can,
  emptyCapabilitySet,
  isAttemptable,
  isAzureCapability,
  isSetForConnection,
  unavailableReason,
  verdictFor,
} from "./capabilities";
export type {
  AuditDecision,
  AuditStatus,
  AuditTrigger,
  CapabilityAuditKeyInput,
  CapabilityAuditView,
} from "./audit-lifecycle";
export {
  AUDIT_SKIP_CACHED_REASON,
  CAPABILITY_AUDIT_KEY_VERSION,
  auditAgeMs,
  capabilityAuditKey,
  describeAuditAge,
  describeCapabilityAudit,
  shouldRunAudit,
  usableCapabilitySet,
} from "./audit-lifecycle";
export type {
  CapabilityFallback,
  CapabilityFallbackKind,
} from "./fallbacks";
export {
  CAPABILITY_FALLBACKS,
  IDENTITY_FALLBACK,
  fallbackFor,
} from "./fallbacks";
export type {
  AnnotatedNavItem,
  NavAvailability,
  NavItemCapabilities,
} from "./nav-annotation";
export { annotateNavItems, unavailableCount } from "./nav-annotation";
export type { CachedCapabilitySet } from "./capability-codec";
export {
  CAPABILITY_AUDIT_CACHE_KEY,
  parseCapabilitySet,
  serializeCapabilitySet,
} from "./capability-codec";
