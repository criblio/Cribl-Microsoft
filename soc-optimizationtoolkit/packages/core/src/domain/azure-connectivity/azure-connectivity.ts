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
import { appPermissionPlan, rbacPermissions } from "../app-permissions";
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
  // By key, not name: Reader at the subscription and Reader on an Event Hub
  // namespace elsewhere are ticked separately (AZR-84).
  return plan.filter((p) => allowed.includes(p.key));
}

/**
 * The Azure RBAC entries a connectivity choice asks for, by
 * {@link AppPermission.key} - the filter the role-assignment ticket and the az
 * CLI script apply, so neither names a role the operator did not tick. A
 * setup-path role's key is its role name, which is what the script matches.
 */
export function requestedRoleNames(
  connectivity: AzureConnectivity,
  allowed: readonly string[],
  saved: AzureSetupPath,
): string[] {
  return rbacPermissions(requestedPermissions(connectivity, allowed, saved)).map(
    (p) => p.key,
  );
}

/** What scope of Azure access a request implies. */
export type ScopeNeed = "none" | "subscription" | "full";

export function scopeNeed(
  connectivity: AzureConnectivity,
  requested: readonly AppPermission[],
): ScopeNeed {
  if (connectivity === "disconnected" || requested.length === 0) return "none";
  // A workspace grant needs the group the workspace sits in (AZR-85).
  if (requested.some((p) => p.scopeLevel === "resourceGroup" || p.scopeLevel === "workspace")) {
    return "full";
  }
  if (requested.some((p) => p.scopeLevel === "subscription")) return "subscription";
  // Tenant-only entries (Graph, an Entra directory role), and grants at a
  // management group or on a resource the configuration does not name, need
  // no configured subscription or resource group.
  return "none";
}

/** The read-only entry, and every other "existing" entry in plan order. */
export function checklistEntries(): {
  readOnly: AppPermission;
  others: AppPermission[];
} {
  const plan = appPermissionPlan("existing");
  const readOnly = plan.find((p) => p.key === READ_ONLY_PERMISSION);
  if (!readOnly) {
    throw new Error(
      `${READ_ONLY_PERMISSION} is missing from the existing-path permission plan`,
    );
  }
  return { readOnly, others: plan.filter((p) => p !== readOnly) };
}
