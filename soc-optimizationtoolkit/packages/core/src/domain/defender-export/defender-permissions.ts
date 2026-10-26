/**
 * The Azure actions the Defender export needs - STATED, NOT YET MEASURED.
 *
 * AZR-3. The permission preflight measures capabilities (`domain/capabilities`)
 * from effective actions and probes, and none of them covers Microsoft.Security
 * or an Event Hub listKeys. The capabilities and probes that would are filed
 * as CAP-7; until they land, the screen shows these lists under
 * {@link DEFENDER_ACTIONS_NOT_MEASURED} and Azure's own 403 at each step is
 * what the operator actually sees.
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
 * denial here must never report the DCR path as not ready. None of these lists
 * is merged into REQUIRED_ACTIONS - that is pinned.
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

/** Actions at the SUBSCRIPTION the export watches. */
export const DEFENDER_SUBSCRIPTION_ACTIONS: readonly RequiredAction[] = [
  {
    action: "Microsoft.Security/pricings/read",
    label: "Read which Defender plans are enabled",
    necessity: "feature",
  },
  {
    action: "Microsoft.Security/automations/read",
    label: "List the subscription's continuous exports",
    necessity: "feature",
  },
  {
    action: "Microsoft.Security/automations/write",
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
