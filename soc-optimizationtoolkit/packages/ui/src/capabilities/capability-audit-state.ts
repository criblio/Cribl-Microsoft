/**
 * Capability audit state - the PURE decisions behind the app-level permission
 * audit (capability-model-plan step 2), kept out of the hook so they are
 * testable without a DOM or a fake clock.
 *
 * The one genuinely non-obvious decision here is {@link deriveCapabilityContext}:
 * it derives "is there an Azure identity at all" from the config, which is what
 * lets the domain distinguish `unreachable` from `unknown`. Getting this wrong
 * collapses the plan's most important correction - "Connect Azure to enable" is
 * a fact about the connection, while "not checked yet" is a fact about the
 * audit, and they must never render as each other.
 *
 * Pure: no IO, no React, no clock.
 */

import type { AzureConfig, CapabilityContext, AuditStatus } from "@soc/core";

/**
 * Whether the active config names an App registration at all.
 *
 * BOTH ids are required: a tenant without a client (or the reverse) cannot
 * authenticate, so treating it as "identity present" would mean the UI blames
 * permissions for what is really an incomplete connection.
 */
export function hasAzureIdentity(config: AzureConfig): boolean {
  return config.tenantId !== "" && config.clientId !== "";
}

/**
 * The connection facts the capability domain resolves unmeasured verdicts from.
 *
 * `criblReachable` is SHELL-SUPPLIED rather than derived here, because the two
 * shells know it differently: the cloud app runs inside the leader under
 * policies.yml, while the local app connects out to a configured one. The plan
 * calls this the seam that keeps the presentation identical while the
 * measurement source differs.
 */
export function deriveCapabilityContext(
  config: AzureConfig,
  criblReachable: boolean,
): CapabilityContext {
  return {
    azureIdentityPresent: hasAzureIdentity(config),
    criblReachable,
  };
}

/** The CSS tone for an audit status (single source for the stylesheet). */
export function auditStatusTone(status: AuditStatus): string {
  switch (status) {
    case "current":
      return "ok";
    case "never-run":
      return "muted";
    case "other-connection":
      return "attention";
  }
}

/** Label for the manual re-audit control, which doubles as its own state. */
export function refreshLabel(running: boolean): string {
  return running ? "Checking..." : "Re-check permissions";
}
