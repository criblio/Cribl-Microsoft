/**
 * What the Entra ID tenant diagnostic setting deploy needs, per scope (AZR-99).
 *
 * NOTHING HERE IS MEASURED, AND THE TENANT HALF CANNOT BE. The write needs an
 * Entra DIRECTORY ROLE (Security Administrator, or Global Administrator), which
 * the permission preflight cannot see at all - see
 * entra-diagnostic-setting's ENTRA_DIRECTORY_PRECONDITION. So both lists
 * render as not measured, and Azure's own refusal at the step is what the
 * operator sees. The change request asks for the role as an optional, warned
 * Entra directory role (app-permissions ENTRA_DIRECTORY_ROLES).
 *
 * Every action string is READ from the least-privilege registry, never
 * restated. Every action is `feature`: one optional source.
 *
 * Pure: data only.
 */

import type { RequiredAction } from "../azure-permissions/azure-permissions";
import { operationAction } from "../least-privilege";
import type { OperationId } from "../least-privilege";

function action(operationId: OperationId, label: string): RequiredAction {
  return { action: operationAction(operationId), label, necessity: "feature" };
}

/** Actions in the Entra TENANT (granted by a directory role, not an Azure role). */
export const ENTRA_TENANT_ACTIONS: readonly RequiredAction[] = [
  action("entra.diagnosticSettings.read", "List the tenant's Entra ID diagnostic settings"),
  action("entra.diagnosticSetting.write", "Create the Entra ID diagnostic setting"),
  action("entra.diagnosticSetting.delete", "Remove the Entra ID diagnostic setting this app created"),
];

/** Actions on the Event Hub namespace RULE the setting names. */
export const ENTRA_NAMESPACE_ACTIONS: readonly RequiredAction[] = [
  action("eventhub.rule.listKeys", "Use the chosen rule for the setting (Azure checks this; no key is read)"),
];

/** The line under the tenant list: why it is not measured, in visible copy (no card ids). */
export const ENTRA_ACTIONS_NOT_MEASURABLE =
  "Granted by a Microsoft Entra directory role - Security Administrator or Global Administrator - not by an Azure role. The app's permission check reads Azure roles only, so it cannot tell whether your identity holds it; Azure's refusal is shown at the step that needed it.";
