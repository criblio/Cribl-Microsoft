/**
 * The Azure actions the Activity Log export needs, per scope (AZR-98).
 *
 * NOTHING HERE IS MEASURED. The permission preflight measures capabilities
 * (`domain/capabilities`), and none covers Microsoft.Insights diagnostic
 * settings yet. So both lists render under
 * {@link ACTIVITY_LOG_ACTIONS_NOT_MEASURED}, and the section's banner says the
 * check does not measure them (automationPermissionView, for a declaration
 * with no measured capability). Azure's own refusal at the step is what the
 * operator sees. Adding capabilities for these is a follow-up, not a gap this
 * file papers over.
 *
 * TWO SCOPES. The setting is written at the SUBSCRIPTION. Azure also checks,
 * at that write, that the caller may use the namespace rule the setting names
 * - listKeys on the rule - although no key is returned to anyone (Azure
 * Monitor documentation; not measured live).
 *
 * Every action string is READ from the least-privilege registry, never
 * restated. Every action is `feature`: this is one optional source, and its
 * denial must never report the DCR path as not ready.
 *
 * Pure: data only.
 */

import type { RequiredAction } from "../azure-permissions/azure-permissions";
import { operationAction } from "../least-privilege";
import type { OperationId } from "../least-privilege";

function action(operationId: OperationId, label: string): RequiredAction {
  return { action: operationAction(operationId), label, necessity: "feature" };
}

/** Actions on the SUBSCRIPTION whose Activity Log is exported. */
export const ACTIVITY_LOG_SUBSCRIPTION_ACTIONS: readonly RequiredAction[] = [
  action("activityLog.diagnosticSettings.read", "List the subscription's diagnostic settings"),
  action("activityLog.diagnosticSetting.write", "Create the Activity Log diagnostic setting"),
];

/** Actions on the Event Hub namespace RULE the setting names. */
export const ACTIVITY_LOG_NAMESPACE_ACTIONS: readonly RequiredAction[] = [
  action("eventhub.rule.listKeys", "Use the chosen rule for the setting (Azure checks this; no key is read)"),
];

/**
 * The line shown under each unmeasured list. Visible copy: no card ids, dates
 * or phases.
 */
export const ACTIVITY_LOG_ACTIONS_NOT_MEASURED =
  "Needed, not yet measured. The app does not check these permissions before it runs; if one is missing, Azure's refusal is shown at the step that needed it.";
