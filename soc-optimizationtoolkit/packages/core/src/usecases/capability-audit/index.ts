/**
 * Capability audit (capability-model-plan step 2) - runs the permission
 * preflight, projects it onto capabilities, and caches the result per
 * connection. Never throws; a failed audit costs verdicts, never the app.
 */
export {
  loadCachedCapabilities,
  runCapabilityAudit,
  saveCapabilityAudit,
} from "./capability-audit";
export type {
  CapabilityAuditInput,
  CapabilityAuditPorts,
  CapabilityAuditResult,
} from "./capability-audit";
