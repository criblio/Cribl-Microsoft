/**
 * check-lab-permissions - the Labs screen's pre-deploy permission check
 * (roadmap Phase 5; the LAB-14 permission-check half, redesigned to
 * effective-action evaluation like the setup wizard's preflight).
 *
 * ONE RBAC permissions GET at the scope the selected resource-group mode
 * operates on (create-new: the subscription, where the RG create and the
 * inherited lab writes are decided; bring-your-own: the pre-created group,
 * falling back to the subscription with a note when the group does not exist
 * yet). The profile-derived action list and the ABAC condition analysis are
 * pure domain logic (domain/labs/lab-permissions); this usecase only fetches
 * and composes. INFORMATIONAL like the RBAC preflight - it reports, the
 * deploy button is not gated on it.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { Logger } from "../../ports/logger";
import {
  hasEffectiveAction,
  type PermissionCheckResult,
} from "../../domain/azure-permissions";
import {
  analyzeRoleAssignmentGrant,
  buildLabPermissionsGetRequest,
  labRequiredActions,
  parseLabPermissionsResponse,
  ROLE_ASSIGNMENTS_WRITE_ACTION,
  ROLE_CONDITION_REMEDIATION,
  type RoleAssignmentGrantAnalysis,
} from "../../domain/labs/lab-permissions";
import type { LabComponentFlags } from "../../domain/labs/lab-profiles";

/** Input for {@link checkLabPermissions}. */
export interface CheckLabPermissionsInput {
  subscriptionId: string;
  /** The lab resource group (bring-your-own mode queries its scope). */
  resourceGroupName: string;
  rgMode: "create-new" | "bring-your-own";
  /** The selected profile's component flags (drives the action list). */
  flags: LabComponentFlags;
}

/** The composed preflight outcome the screen renders. */
export interface LabPermissionCheckOutcome {
  /** The ARM scope path the permissions were evaluated at. */
  scope: string;
  /** Per-action results in the profile's deploy order. */
  checks: PermissionCheckResult[];
  /** How roleAssignments/write is held (the ABAC-condition analysis). */
  roleAssignmentGrant: RoleAssignmentGrantAnalysis;
  /**
   * The remediation text for a condition-blocked TTL grant; present exactly
   * when the analysis is "conditional-blocks-contributor".
   */
  roleConditionRemediation?: string;
  /** Non-fatal notes (e.g. the bring-your-own fallback to subscription). */
  notes: string[];
}

/**
 * Fetch and evaluate the caller's effective permissions for the selected lab
 * profile. Throws only on transport failure or a non-2xx permissions GET -
 * the caller renders that as "check unavailable", never as denied.
 */
export async function checkLabPermissions(
  azure: AzureManagement,
  input: CheckLabPermissionsInput,
  logger?: Logger,
): Promise<LabPermissionCheckOutcome> {
  const subscriptionScope = `/subscriptions/${input.subscriptionId}`;
  const rgScope = `${subscriptionScope}/resourceGroups/${input.resourceGroupName}`;
  const notes: string[] = [];

  let scope = input.rgMode === "bring-your-own" ? rgScope : subscriptionScope;
  let response = await azure.request(buildLabPermissionsGetRequest(scope));
  if (
    input.rgMode === "bring-your-own" &&
    (response.status === 404 || response.status === 403)
  ) {
    // The pre-created group is missing (or unreadable): fall back to the
    // subscription so the operator still gets a signal, with the caveat.
    notes.push(
      `resource group '${input.resourceGroupName}' was not readable at its own ` +
        "scope - permissions were evaluated at the subscription instead",
    );
    scope = subscriptionScope;
    response = await azure.request(buildLabPermissionsGetRequest(scope));
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `fetch RBAC permissions at '${scope}': HTTP ${response.status} ` +
        JSON.stringify(response.body),
    );
  }

  const parsed = parseLabPermissionsResponse(response.body);
  const checks: PermissionCheckResult[] = labRequiredActions(
    input.flags,
    input.rgMode,
  ).map((required) => ({
    action: required.action,
    label: required.label,
    granted: hasEffectiveAction(parsed, required.action),
  }));

  const roleAssignmentGrant = analyzeRoleAssignmentGrant(response.body);
  // Keep the plain check row consistent with the deeper analysis: a grant
  // that exists only behind a Contributor-blocking condition WILL fail the
  // TTL PUT, so the row must not read as an unqualified pass.
  const outcome: LabPermissionCheckOutcome = {
    scope,
    checks,
    roleAssignmentGrant,
    notes,
  };
  if (roleAssignmentGrant.kind === "conditional-blocks-contributor") {
    outcome.roleConditionRemediation = ROLE_CONDITION_REMEDIATION;
    const row = checks.find((c) => c.action === ROLE_ASSIGNMENTS_WRITE_ACTION);
    if (row !== undefined) {
      row.granted = false;
    }
  }

  logger?.info("check-lab-permissions: evaluated", {
    scope,
    granted: checks.filter((c) => c.granted).length,
    total: checks.length,
    roleGrant: roleAssignmentGrant.kind,
  });
  return outcome;
}
