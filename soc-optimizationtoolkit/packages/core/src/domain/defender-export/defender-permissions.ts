/**
 * The Azure actions the Defender export needs, per scope.
 *
 * AZR-3. The permission preflight measures capabilities (`domain/capabilities`)
 * from effective actions and probes. CAP-7a measures the SUBSCRIPTION list:
 * REQUIRED_ACTIONS['existing-subscription'] spreads it in as `feature` checks,
 * and capability-mapping turns each into a capability - the write only ever as
 * granted, because the automation lives in a resource group the subscription
 * evaluation cannot see into (GRANT_ONLY_AZURE_ACTIONS). The NAMESPACE list is
 * still unmeasured (CAP-7b): listKeys can be granted on the namespace itself,
 * so a subscription-scope evaluation would read it as denied. The screen shows
 * the subscription list with the cached audit's verdict per action (AZR-60,
 * onboarding-sections/automation-permissions), and only the namespace list
 * under {@link DEFENDER_ACTIONS_NOT_MEASURED}, where Azure's own 403 at the
 * step is what the operator actually sees.
 *
 * ONE LIST PER SCOPE, BECAUSE THE SCOPES DIFFER AND `RequiredAction` HAS NO
 * SCOPE FIELD. The automation is written at the subscription; the connection
 * string is read from a rule on the Event Hub namespace, which may sit in
 * another resource group or subscription. Adding a scope to RequiredAction
 * would reach every preflight consumer, so the grouping is carried by which
 * list an action is in.
 *
 * EVERY ACTION IS `feature`. Deploy readiness is one boolean over the
 * REQUIRED_ACTIONS core entries; the Defender export is one feature, and a
 * denial here must never report the DCR path as not ready. Only the
 * subscription list is merged into REQUIRED_ACTIONS, only on the
 * subscription-scope path, and only as `feature` - all three are pinned.
 *
 * NO PRICINGS WRITE, EVER. The app reads which Defender plans are on and never
 * changes one (see defender-plans). Listing `pricings/write` here would ask an
 * operator to grant a permission the app must not use.
 *
 * listKeys IS NEVER PROBED. A probe of it would succeed by returning a SAS key
 * into the iframe. It can only ever be established from effective actions.
 *
 * The least roles are the least-privilege registry's (AZR-61): Security Admin
 * for the automation write on its resource group, Security Reader for the
 * subscription reads, and Azure Event Hubs Data Owner - not Contributor, as
 * this comment used to say - for listKeys on the namespace. Legacy asked for
 * Security Admin plus Contributor (Deploy-DefenderExport.ps1:24-26).
 *
 * Every action string here is READ from the registry: each entry names the
 * registry operation it comes from, so the How-to can also read that
 * operation's scope (the automation write lands on a resource group, not the
 * subscription).
 *
 * Pure: data only.
 */

import type { RequiredAction } from "../azure-permissions/azure-permissions";
import { operationAction } from "../least-privilege";
import type { OperationId } from "../least-privilege";

// Named so capability-mapping can key on them without restating the strings.
/** Read which Defender plans are on (defender-plans). */
export const DEFENDER_PRICINGS_READ = operationAction("defender.pricings.read");
/** List the subscription's continuous exports (defender-automation). */
export const DEFENDER_AUTOMATIONS_READ = operationAction("defender.automations.list");
/** Create the continuous export (defender-automation). */
export const DEFENDER_AUTOMATIONS_WRITE = operationAction("defender.automation.write");

/** One Defender action and the registry operation it is read from. */
export interface DefenderOperation extends RequiredAction {
  readonly operationId: OperationId;
}

function defenderAction(operationId: OperationId, label: string): DefenderOperation {
  return { operationId, action: operationAction(operationId), label, necessity: "feature" };
}

/** The subscription list, with each entry's registry operation (for its scope). */
export const DEFENDER_SUBSCRIPTION_OPERATIONS: readonly DefenderOperation[] = [
  defenderAction("defender.pricings.read", "Read which Defender plans are enabled"),
  defenderAction("defender.automations.list", "List the subscription's continuous exports"),
  defenderAction("defender.automation.write", "Create the continuous export"),
];

/** The namespace list, with each entry's registry operation. */
export const DEFENDER_NAMESPACE_OPERATIONS: readonly DefenderOperation[] = [
  defenderAction("eventhub.rule.listKeys", "Read the connection string of the chosen Event Hub rule"),
];

/** Drop the registry key: the preflight's lists are plain RequiredActions. */
function asRequired({ action, label, necessity }: DefenderOperation): RequiredAction {
  return necessity === undefined ? { action, label } : { action, label, necessity };
}

/**
 * Actions checked at the SUBSCRIPTION evaluation. The automation write lives
 * in a resource group below it, which is why capability-mapping treats it as
 * grant-only.
 */
export const DEFENDER_SUBSCRIPTION_ACTIONS: readonly RequiredAction[] =
  DEFENDER_SUBSCRIPTION_OPERATIONS.map(asRequired);

/** Actions on the Event Hub NAMESPACE the export sends to. */
export const DEFENDER_NAMESPACE_ACTIONS: readonly RequiredAction[] =
  DEFENDER_NAMESPACE_OPERATIONS.map(asRequired);

/**
 * The line shown under the NAMESPACE list's heading - the one list no
 * capability measures. It names its scope, so it cannot be read as covering
 * the measured subscription rows above it. Visible copy: no card ids, dates or
 * phases.
 */
export const DEFENDER_ACTIONS_NOT_MEASURED =
  "Needed, not yet measured. The app does not check this namespace permission before it runs; if it is missing, Azure's refusal is shown at the step that needed it.";
