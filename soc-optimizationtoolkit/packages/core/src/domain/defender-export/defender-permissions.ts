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
 * so a subscription-scope evaluation would read it as denied. The screen still
 * shows both lists under {@link DEFENDER_ACTIONS_NOT_MEASURED}, because it does
 * not read the audit's verdicts, and Azure's own 403 at each step is what the
 * operator actually sees.
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
 * Inferred from Azure's built-in roles, not from this repository (verify live):
 * Security Admin covers the subscription list but not listKeys, which needs
 * Contributor or an equivalent on the namespace. Legacy asked for the same
 * pair (Deploy-DefenderExport.ps1:24-26).
 *
 * Pure: data only.
 */

import type { RequiredAction } from "../azure-permissions/azure-permissions";

// Named so capability-mapping can key on them without restating the strings.
/** Read which Defender plans are on (defender-plans). */
export const DEFENDER_PRICINGS_READ = "Microsoft.Security/pricings/read";
/** List the subscription's continuous exports (defender-automation). */
export const DEFENDER_AUTOMATIONS_READ = "Microsoft.Security/automations/read";
/** Create the continuous export (defender-automation). */
export const DEFENDER_AUTOMATIONS_WRITE = "Microsoft.Security/automations/write";

/** Actions at the SUBSCRIPTION the export watches. */
export const DEFENDER_SUBSCRIPTION_ACTIONS: readonly RequiredAction[] = [
  {
    action: DEFENDER_PRICINGS_READ,
    label: "Read which Defender plans are enabled",
    necessity: "feature",
  },
  {
    action: DEFENDER_AUTOMATIONS_READ,
    label: "List the subscription's continuous exports",
    necessity: "feature",
  },
  {
    action: DEFENDER_AUTOMATIONS_WRITE,
    label: "Create the continuous export",
    necessity: "feature",
  },
];

/** Actions on the Event Hub NAMESPACE the export sends to. */
export const DEFENDER_NAMESPACE_ACTIONS: readonly RequiredAction[] = [
  {
    action: "Microsoft.EventHub/namespaces/authorizationRules/listKeys/action",
    label: "Read the connection string of the chosen Event Hub rule",
    necessity: "feature",
  },
];

/**
 * The line shown above both lists. Visible copy: no card ids, dates or phases.
 */
export const DEFENDER_ACTIONS_NOT_MEASURED =
  "Needed, not yet measured. The app does not check these permissions before it runs; if one is missing, Azure's refusal is shown at the step that needed it.";
