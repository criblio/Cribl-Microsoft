/**
 * Azure connectivity - the saved choice of how much Azure access the operator
 * grants the app (setup-pages-plan).
 *
 *   full          the whole permission plan for the saved setup path
 *   partial       only the entries the operator allowed; always the "existing"
 *                 path, so a lab path never leaks into a partial request
 *   disconnected  nothing is requested
 *
 * The permission data is NOT restated here: every entry comes from
 * {@link appPermissionPlan}.
 *
 * Pure: no IO, no React.
 */

import type { AzureSetupPath } from "../azure-config";
import { appPermissionPlan } from "../app-permissions";
import type { AppPermission } from "../app-permissions";

export type AzureConnectivity = "full" | "partial" | "disconnected";

/** The one role a read-only (partial) connection is built around. */
export const READ_ONLY_PERMISSION = "Reader";

/** The setup path the plan is computed for: partial is always "existing". */
export function effectiveSetupPath(
  connectivity: AzureConnectivity,
  saved: AzureSetupPath,
): AzureSetupPath {
  return connectivity === "partial" ? "existing" : saved;
}

/** The permissions to ask for under a connectivity choice. */
export function requestedPermissions(
  connectivity: AzureConnectivity,
  allowed: readonly string[],
  saved: AzureSetupPath,
): AppPermission[] {
  if (connectivity === "disconnected") return [];
  const plan = appPermissionPlan(effectiveSetupPath(connectivity, saved));
  if (connectivity === "full") return plan;
  return plan.filter((p) => allowed.includes(p.name));
}

/** What scope of Azure access a request implies. */
export type ScopeNeed = "none" | "subscription" | "full";

export function scopeNeed(
  connectivity: AzureConnectivity,
  requested: readonly AppPermission[],
): ScopeNeed {
  if (connectivity === "disconnected" || requested.length === 0) return "none";
  if (requested.some((p) => p.scopeLevel === "resourceGroup")) return "full";
  if (requested.some((p) => p.scopeLevel === "subscription")) return "subscription";
  // Tenant-only Graph entries need no Azure scope.
  return "none";
}

/** The read-only entry, and every other "existing" entry in plan order. */
export function checklistEntries(): {
  readOnly: AppPermission;
  others: AppPermission[];
} {
  const plan = appPermissionPlan("existing");
  const readOnly = plan.find((p) => p.name === READ_ONLY_PERMISSION);
  if (!readOnly) {
    throw new Error(
      `${READ_ONLY_PERMISSION} is missing from the existing-path permission plan`,
    );
  }
  return { readOnly, others: plan.filter((p) => p !== readOnly) };
}
