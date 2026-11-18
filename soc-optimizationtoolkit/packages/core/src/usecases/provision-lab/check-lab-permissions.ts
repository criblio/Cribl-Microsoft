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
 *
 * SCOPES OUTSIDE THE LAB GROUP (AZR-81). In bring-your-own mode, the Event
 * Grid provider registration is decided at the subscription and the flow logs
 * at NetworkWatcherRG, so those rows get one permissions GET at their own
 * scope. A 403 or 404 there is NOT a denial - the caller may simply be unable
 * to read permissions at that scope (ARM usually answers 403 before it says
 * whether a group exists) - so the rows are reported as not measured.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { Logger } from "../../ports/logger";
import {
  checkResult,
  hasEffectiveAction,
  type PermissionCheckResult,
} from "../../domain/azure-permissions";
import {
  analyzeRoleAssignmentGrant,
  buildLabPermissionsGetRequest,
  labRequiredActions,
  parseLabPermissionsResponse,
  type LabActionScope,
  ROLE_ASSIGNMENTS_WRITE_ACTION,
  ROLE_CONDITION_PRINCIPALS_REMEDIATION,
  ROLE_CONDITION_REMEDIATION,
  type RoleAssignmentGrantAnalysis,
} from "../../domain/labs/lab-permissions";
import type { LabComponentFlags } from "../../domain/labs/lab-profiles";
import { AZURE_NETWORK_WATCHER_RG } from "../../domain/labs/lab-flowlogs";
import {
  buildEventGridProviderGetRequest,
  parseProviderRegistrationState,
} from "../../domain/labs/lab-storage";
import { operationAction } from "../../domain/least-privilege";
import { httpErrorText, is2xx } from "../arm-http";

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
  /**
   * Rows whose scope could not be read (AZR-81): unknown, never denied.
   * Empty when every scope answered.
   */
  unmeasured: LabUnmeasuredCheck[];
}

/** A required action whose scope's permissions could not be read. */
export interface LabUnmeasuredCheck {
  action: string;
  label: string;
  /** The ARM scope that was not readable. */
  scope: string;
  /** Why, in words: the HTTP status. */
  reason: string;
}

/** The Event Grid registration action, whose row the provider's state can satisfy. */
const REGISTER_ACTION = operationAction("eventGrid.provider.register");

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
  if (!is2xx(response.status)) {
    throw new Error(
      httpErrorText(`fetch RBAC permissions at '${scope}'`, response.status, response.body),
    );
  }

  const parsed = parseLabPermissionsResponse(response.body);
  const required = labRequiredActions(input.flags, input.rgMode);

  // One permissions GET per extra scope the profile needs, and only once. A
  // lab scope that already fell back to the subscription answers for it.
  const extraScopePath: Record<LabActionScope, string> = {
    subscription: subscriptionScope,
    "network-watcher-rg": `${subscriptionScope}/resourceGroups/${AZURE_NETWORK_WATCHER_RG}`,
  };
  const extra = new Map<LabActionScope, { ok: true; parsed: ReturnType<typeof parseLabPermissionsResponse> } | { ok: false; reason: string }>();
  for (const action of required) {
    if (action.scope === undefined || extra.has(action.scope)) {
      continue;
    }
    const path = extraScopePath[action.scope];
    if (path === scope) {
      extra.set(action.scope, { ok: true, parsed });
      continue;
    }
    const got = await azure.request(buildLabPermissionsGetRequest(path));
    extra.set(
      action.scope,
      is2xx(got.status)
        ? { ok: true, parsed: parseLabPermissionsResponse(got.body) }
        : { ok: false, reason: `permissions at this scope could not be read (HTTP ${got.status})` },
    );
  }

  const checks: PermissionCheckResult[] = [];
  const unmeasured: LabUnmeasuredCheck[] = [];
  for (const action of required) {
    if (action.scope === undefined) {
      checks.push(checkResult(action, hasEffectiveAction(parsed, action.action)));
      continue;
    }
    const evaluated = extra.get(action.scope);
    const holds =
      evaluated !== undefined && evaluated.ok
        ? hasEffectiveAction(evaluated.parsed, action.action)
        : undefined;
    if (action.action === REGISTER_ACTION && holds !== true) {
      // The registration is needed once, not the right to make it: an admin
      // may already have registered the provider (AZR-81 review). Read the
      // provider's state before calling the row missing.
      const provider = await azure.request(buildEventGridProviderGetRequest(input.subscriptionId));
      if (is2xx(provider.status) && parseProviderRegistrationState(provider.body) === "Registered") {
        checks.push(checkResult(action, true));
        continue;
      }
      if (!is2xx(provider.status) || holds === undefined) {
        unmeasured.push({
          action: action.action,
          label: action.label,
          scope: extraScopePath[action.scope],
          reason: !is2xx(provider.status)
            ? `the provider's registration could not be read (HTTP ${provider.status})`
            : evaluated !== undefined && !evaluated.ok
              ? evaluated.reason
              : "not read",
        });
        continue;
      }
      // Not registered, and no right to register it: missing.
      checks.push(checkResult(action, false));
      continue;
    }
    if (holds === undefined) {
      unmeasured.push({
        action: action.action,
        label: action.label,
        scope: extraScopePath[action.scope],
        reason: evaluated !== undefined && !evaluated.ok ? evaluated.reason : "not read",
      });
      continue;
    }
    checks.push(checkResult(action, holds));
  }

  const roleAssignmentGrant = analyzeRoleAssignmentGrant(response.body);
  // Keep the plain check row consistent with the deeper analysis: a grant
  // that exists only behind a Contributor-blocking condition WILL fail the
  // TTL PUT, so the row must not read as an unqualified pass.
  const outcome: LabPermissionCheckOutcome = {
    scope,
    checks,
    roleAssignmentGrant,
    notes,
    unmeasured,
  };
  if (
    roleAssignmentGrant.kind === "conditional-blocks-contributor" ||
    roleAssignmentGrant.kind === "conditional-constrains-principals"
  ) {
    outcome.roleConditionRemediation =
      roleAssignmentGrant.kind === "conditional-constrains-principals"
        ? ROLE_CONDITION_PRINCIPALS_REMEDIATION
        : ROLE_CONDITION_REMEDIATION;
    const row = checks.find((c) => c.action === ROLE_ASSIGNMENTS_WRITE_ACTION);
    if (row !== undefined) {
      row.granted = false;
    }
  }

  logger?.info("check-lab-permissions: evaluated", {
    scope,
    granted: checks.filter((c) => c.granted).length,
    total: checks.length,
    unmeasured: unmeasured.length,
    roleGrant: roleAssignmentGrant.kind,
  });
  return outcome;
}
