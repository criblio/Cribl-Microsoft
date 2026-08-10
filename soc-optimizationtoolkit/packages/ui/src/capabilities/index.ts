/**
 * The app-level capability audit (capability-model-plan step 2): who the
 * connection is, what it was measured to be able to do, and how old that
 * measurement is.
 */
export {
  auditStatusTone,
  deriveCapabilityContext,
  hasAzureIdentity,
  refreshLabel,
} from "./capability-audit-state";
export { useCapabilityAudit } from "./use-capability-audit";
export type {
  CapabilityAuditOptions,
  CapabilityAuditState,
} from "./use-capability-audit";
export { FallbackNotice } from "./fallback-notice";
export type { FallbackNoticeProps } from "./fallback-notice";
export {
  fallbackActionLabel,
  fallbackHint,
  isInlineArtifact,
} from "./fallback-notice-state";
export { emptyInventoryMessage } from "./empty-inventory";
export type { EmptyInventoryMessage } from "./empty-inventory";
