/**
 * The Azure actions the Data Receiver grant needs (AZR-103), as the banner
 * over the grant shows them.
 *
 * NOTHING HERE IS MEASURED. The permission preflight measures capabilities
 * (`domain/capabilities`), and none covers Microsoft.Authorization role
 * assignments on an Event Hub - a hub or namespace the configuration does not
 * name, which no preflight scope reaches. So the declaration has no measured
 * need, and automationPermissionView renders the "not measured" note: a
 * banner, never a block. Azure's own answer to the PUT is what decides.
 *
 * Every action string is READ from the least-privilege registry, never
 * restated, and every one is `feature`: the grant is optional (the Listen-only
 * SAS credential needs none of it).
 *
 * Pure: data only.
 */

import type { RequiredAction } from "../azure-permissions/azure-permissions";
import { leastRoleFor, operationAction } from "../least-privilege";
import type { OperationId } from "../least-privilege";
import type { AutomationPermissions } from "../onboarding-sections/automation-permissions";

function action(operationId: OperationId, label: string): RequiredAction {
  return { action: operationAction(operationId), label, necessity: "feature" };
}

/** Actions on the hub (or the namespace, when chosen) the grant is made at. */
export const RECEIVER_GRANT_SCOPE_ACTIONS: readonly RequiredAction[] = [
  action("rbac.roleAssignments.read", "Read the Cribl principal's existing role assignments there"),
  action("eventhub.receiverGrant.write", "Create the Azure Event Hubs Data Receiver assignment"),
  // AZR-141: Remove, in "Remove or pause what this app created".
  action("eventhub.receiverGrant.delete", "Remove the assignment this app created"),
];

/** The delete action alone, for the removal row's note and its refusal. */
export const RECEIVER_GRANT_DELETE_ACTION = operationAction("eventhub.receiverGrant.delete");

/** The role an administrator grants the app for this, from the registry. */
export const RECEIVER_GRANT_ADMIN_ROLE = leastRoleFor("eventhub.receiverGrant.write");

/**
 * The condition that narrows {@link RECEIVER_GRANT_ADMIN_ROLE} to this one
 * grant. Shared with the app-registration change request (FEATURE_ROLES), so
 * the banner and the ticket ask for the same thing.
 */
export const RECEIVER_GRANT_ADMIN_CONDITION =
  "Constrain roles and principal types: only Azure Event Hubs Data Receiver, only to service principals.";

/** The banner declaration (automationPermissionView). Nothing is measured. */
export const RECEIVER_GRANT_PERMISSIONS: AutomationPermissions = {
  sourceTitle: "the Data Receiver grant",
  measuredScope: "On the hub or namespace",
  measured: [],
  notMeasured: [{ scope: "On the hub, or the namespace when that scope is chosen", actions: RECEIVER_GRANT_SCOPE_ACTIONS }],
};

/** The line shown under the unmeasured list. Visible copy: no card ids, dates or phases. */
export const RECEIVER_GRANT_ACTIONS_NOT_MEASURED =
  `Needed, not yet measured. ${RECEIVER_GRANT_ADMIN_ROLE} (or User Access Administrator, or Owner) on the hub or namespace holds all three; ` +
  `an administrator can narrow it with the condition: ${RECEIVER_GRANT_ADMIN_CONDITION} ` +
  "If one is missing, Azure's refusal is shown at the step that needed it.";
