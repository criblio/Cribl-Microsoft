/**
 * The Azure actions the Activity Log export needs, per scope (AZR-98).
 *
 * THE SUBSCRIPTION ACTIONS ARE MEASURED (CAP-10). The capability audit
 * evaluates the three Microsoft.Insights/diagnosticSettings actions at the
 * subscription (capability-audit SUBSCRIPTION_AUDIT_ACTIONS) as the
 * `subscription-diagnostics.*` capabilities, and the section shows what the
 * cached check found for each. Two-sided: the setting lives on the
 * subscription itself, so a miss there is a denial. The result is a banner and
 * a caution beside Deploy, never a disabled button.
 *
 * THE NAMESPACE ACTION IS NOT. listKeys on the rule can be granted on the
 * namespace itself, which a subscription read cannot see, so it renders under
 * {@link ACTIVITY_LOG_ACTIONS_NOT_MEASURED} until CAP-9 evaluates it there.
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

/** List the subscription's diagnostic settings (and read ours by name). */
export const ACTIVITY_LOG_SETTINGS_READ = operationAction("activityLog.diagnosticSettings.read");
/** Create the setting. */
export const ACTIVITY_LOG_SETTINGS_WRITE = operationAction("activityLog.diagnosticSetting.write");
/** Remove the setting this app created. */
export const ACTIVITY_LOG_SETTINGS_DELETE = operationAction("activityLog.diagnosticSetting.delete");

/** Actions on the SUBSCRIPTION whose Activity Log is exported. */
export const ACTIVITY_LOG_SUBSCRIPTION_ACTIONS: readonly RequiredAction[] = [
  action("activityLog.diagnosticSettings.read", "List the subscription's diagnostic settings"),
  action("activityLog.diagnosticSetting.write", "Create the Activity Log diagnostic setting"),
  // AZR-105: Remove deletes the setting the app created (and proved its own).
  action("activityLog.diagnosticSetting.delete", "Remove the Activity Log diagnostic setting this app created"),
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
