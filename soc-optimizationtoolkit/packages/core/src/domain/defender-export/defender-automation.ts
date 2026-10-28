/**
 * Defender for Cloud continuous export - THE AUTOMATION, how to build it and
 * how to recognise one that already exists.
 *
 * AZR-3. A continuous export is a `Microsoft.Security/automations` resource
 * whose action sends Defender events to an Event Hub. Ported from
 * `legacy/Deploy-DefenderExport.ps1` (a frozen copy of the deprecated script):
 *
 *   line 52        the export name `CriblDefenderExport`
 *   lines 219-236  the PUT body and its api-version 2019-01-01-preview
 *   line 222       the description, verbatim
 *
 * WHAT CHANGED FROM LEGACY, AND WHY EACH ONE IS DELIBERATE:
 *
 * - SCOPES ARE OBJECTS. Legacy sent `scopes = @("/subscriptions/{sub}")`, a
 *   plain string (:224). The published schema is `[{description, scopePath}]`.
 *   That is an inference from the schema, on the live-verification list.
 * - THE TARGET IS THE HUB ID. Legacy stripped the rule id back to the
 *   NAMESPACE (:426) and sent that as eventHubResourceId. The schema names an
 *   Event Hub, so the hub id is sent. Also on the live-verification list.
 * - THE RESOURCE GROUP IS THE OPERATOR'S. Legacy created `CriblSecurityExport`
 *   in a hard-coded `eastus` (:208-216). The caller passes an existing group
 *   and its location; nothing here creates a group.
 * - NOTHING IS REPLACED BLINDLY. A PUT of this resource replaces it whole, and
 *   legacy PUT on every run without reading first (its GET helper at :272-291
 *   is never called). This module supplies the reads that make create-only
 *   possible: {@link classifyOurs} finds an existing export BY NAME IN ANY
 *   RESOURCE GROUP - legacy's lived in CriblSecurityExport, which a check
 *   scoped to the operator's group would miss - and
 *   {@link findSameTargetExports} finds any OTHER export already feeding the
 *   chosen hub, which would make every alert arrive twice.
 *
 * THE SECRET NEVER TAKES PART IN A COMPARISON. The PUT carries the namespace
 * rule's connection string, because Azure needs it to send. On read-back Azure
 * is believed (an inference, on the live-verification list) to omit or redact
 * it. {@link automationMatches} therefore compares only isEnabled, the event
 * sources, the scope paths, the action type and the hub id, and
 * {@link parseAutomation} does not even keep the connection string, so no
 * parsed automation can carry it anywhere.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. The caller
 * performs every request.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import type { NamespaceRef } from "../eventhub-arm/eventhub-arm";
import {
  eventHubNamespacePath,
  eventHubResourceId,
  parseEventHubResourceId,
  parseNamespaceResourceId,
} from "../eventhub-arm/eventhub-arm";
import { parseResourceId } from "../azure-resource-id/azure-resource-id";
import type { Listing } from "../inventory-listing/inventory-listing";
import { listingRows, listingWasRead, toListing } from "../inventory-listing/inventory-listing";
import type { StepVerdict, VerdictDiff } from "../onboarding-howto/check-kinds";

/**
 * api-version for Microsoft.Security/automations, verbatim from legacy :236.
 * Kept until Live Preview proves a GA version accepts the same body (operator
 * answer 2026-10-21).
 */
export const SECURITY_AUTOMATIONS_API_VERSION = "2019-01-01-preview";

/** The automation's name, verbatim from the legacy parameter default (:52). */
export const DEFENDER_EXPORT_NAME = "CriblDefenderExport";

/** The automation's description, verbatim from legacy :222. */
export const DEFENDER_EXPORT_DESCRIPTION = "Cribl Stream - Export Defender alerts to Event Hub";

/** The only event source this slice exports. */
export const ALERTS_EVENT_SOURCE = "Alerts";

/** The action type that sends to an Event Hub. */
export const EVENTHUB_ACTION_TYPE = "EventHub";

/** One action of an automation, without any secret it carried. */
export interface AutomationAction {
  readonly actionType: string;
  /** "" when the action has no eventHubResourceId (a Logic App or workspace action). */
  readonly eventHubResourceId: string;
}

/** One `Microsoft.Security/automations` resource, as this app reads it. */
export interface DefenderAutomation {
  readonly id: string;
  readonly name: string;
  /** From the id; "" when the id does not carry one. */
  readonly resourceGroup: string;
  /** False when Azure said false OR said nothing - see {@link automationDiffs}. */
  readonly isEnabled: boolean;
  /** Every `sources[].eventSource`, in response order. */
  readonly sources: readonly string[];
  /** Every scope path; a legacy plain-string scope is read as its path. */
  readonly scopePaths: readonly string[];
  readonly actions: readonly AutomationAction[];
  /** The eventHubResourceId of every EventHub action, non-empty only. */
  readonly eventHubTargets: readonly string[];
}

/** What a correctly-written export must look like. Carries no secret. */
export interface ExpectedExport {
  readonly scopePath: string;
  readonly eventHubResourceId: string;
}

/** Everything the PUT needs. The connection string goes in the body only. */
export interface DefenderExportInput {
  readonly subscriptionId: string;
  /** An EXISTING resource group the operator picked. */
  readonly resourceGroup: string;
  /** That resource group's location. */
  readonly location: string;
  readonly namespace: NamespaceRef;
  readonly hubName: string;
  /** From listKeys on a namespace rule that can Send. Never logged, never returned. */
  readonly connectionString: string;
}

/** The PUT this module builds. */
export interface DefenderExportPutRequest extends AzureManagementRequest {
  readonly method: "PUT";
  readonly body: {
    readonly location: string;
    readonly properties: {
      readonly description: string;
      readonly isEnabled: true;
      readonly scopes: readonly { readonly description: string; readonly scopePath: string }[];
      readonly sources: readonly { readonly eventSource: string }[];
      readonly actions: readonly {
        readonly actionType: string;
        readonly eventHubResourceId: string;
        readonly connectionString: string;
      }[];
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sameId(a: string, b: string): boolean {
  // ARM resource ids are case-insensitive; Azure itself returns mixed casing.
  return a.toLowerCase() === b.toLowerCase();
}

/** The subscription scope path the export watches. */
export function subscriptionScopePath(subscriptionId: string): string {
  return `/subscriptions/${subscriptionId}`;
}

/**
 * The GET that lists every automation in the SUBSCRIPTION, across all
 * resource groups. Deliberately not the resource-group list: an export
 * created by legacy lives in CriblSecurityExport, wherever the operator now
 * points this app. The subscription-scope endpoint is an inference from the
 * Azure API, on the live-verification list.
 */
export function buildSubscriptionAutomationsListRequest(
  subscriptionId: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: `/subscriptions/${subscriptionId}/providers/Microsoft.Security/automations`,
    apiVersion: SECURITY_AUTOMATIONS_API_VERSION,
  };
}

/** The GET that reads one automation back by its full resource id. */
export function buildAutomationGetByIdRequest(automationId: string): AzureManagementRequest {
  return {
    method: "GET",
    path: automationId,
    apiVersion: SECURITY_AUTOMATIONS_API_VERSION,
  };
}

/** The resource path the PUT writes to, which is also the new automation's id. */
export function defenderExportPath(subscriptionId: string, resourceGroup: string): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Security/automations/${DEFENDER_EXPORT_NAME}`
  );
}

/** The non-secret shape the PUT below writes, for comparing a read-back. */
export function expectedExportFor(
  input: Pick<DefenderExportInput, "subscriptionId" | "namespace" | "hubName">,
): ExpectedExport {
  return {
    scopePath: subscriptionScopePath(input.subscriptionId),
    eventHubResourceId: eventHubResourceId(input.namespace, input.hubName),
  };
}

/**
 * Build the create PUT: Alerts only, this subscription only, one EventHub
 * action targeting the HUB.
 *
 * The caller must have listed the subscription's automations first and found
 * neither {@link classifyOurs} nor {@link findSameTargetExports} objecting -
 * this PUT replaces whatever is at the path, and this builder cannot know.
 */
export function buildAutomationPutRequest(input: DefenderExportInput): DefenderExportPutRequest {
  const expected = expectedExportFor(input);
  return {
    method: "PUT",
    path: defenderExportPath(input.subscriptionId, input.resourceGroup),
    apiVersion: SECURITY_AUTOMATIONS_API_VERSION,
    body: {
      location: input.location,
      properties: {
        description: DEFENDER_EXPORT_DESCRIPTION,
        isEnabled: true,
        scopes: [
          {
            description: `Subscription ${input.subscriptionId}`,
            scopePath: expected.scopePath,
          },
        ],
        sources: [{ eventSource: ALERTS_EVENT_SOURCE }],
        actions: [
          {
            actionType: EVENTHUB_ACTION_TYPE,
            eventHubResourceId: expected.eventHubResourceId,
            connectionString: input.connectionString,
          },
        ],
      },
    },
  };
}

/**
 * Read one automation out of an ARM item. Null when the item has neither a
 * name nor an id - there is nothing to call it by. A name missing on its own
 * is taken from the id's last segment.
 *
 * The connection string is NOT read. See the module docblock.
 */
export function parseAutomation(item: unknown): DefenderAutomation | null {
  if (!isRecord(item)) return null;
  const id = str(item["id"]);
  const parsedId = parseResourceId(id);
  const name = str(item["name"]) !== "" ? str(item["name"]) : parsedId.name;
  if (name === "" && id === "") return null;
  const props = isRecord(item["properties"]) ? item["properties"] : {};

  const sources: string[] = [];
  for (const s of Array.isArray(props["sources"]) ? props["sources"] : []) {
    const eventSource = isRecord(s) ? str(s["eventSource"]) : "";
    if (eventSource !== "") sources.push(eventSource);
  }

  const scopePaths: string[] = [];
  for (const s of Array.isArray(props["scopes"]) ? props["scopes"] : []) {
    // Legacy wrote plain strings; the schema returns objects. Read both.
    const scopePath = typeof s === "string" ? s : isRecord(s) ? str(s["scopePath"]) : "";
    if (scopePath !== "") scopePaths.push(scopePath);
  }

  const actions: AutomationAction[] = [];
  for (const a of Array.isArray(props["actions"]) ? props["actions"] : []) {
    if (!isRecord(a)) continue;
    actions.push({
      actionType: str(a["actionType"]),
      eventHubResourceId: str(a["eventHubResourceId"]),
    });
  }

  return {
    id,
    name,
    resourceGroup: parsedId.resourceGroup,
    isEnabled: props["isEnabled"] === true,
    sources,
    scopePaths,
    actions,
    eventHubTargets: actions
      .filter((a) => isEventHubAction(a) && a.eventHubResourceId !== "")
      .map((a) => a.eventHubResourceId),
  };
}

/**
 * Wrap the items of the subscription-wide list (every page's `value`,
 * concatenated) as a {@link Listing}. Items that are not automations are
 * dropped.
 *
 * Zero items is the unverified `empty`, never a measured `none`: that is the
 * Listing rule for any raw ARM list, and it is why {@link classifyOurs}
 * reports whether its `absent` was measured.
 */
export function parseAutomations(items: readonly unknown[]): Listing<DefenderAutomation> {
  const rows: DefenderAutomation[] = [];
  for (const item of items) {
    const automation = parseAutomation(item);
    if (automation !== null) rows.push(automation);
  }
  return toListing(rows);
}

function isEventHubAction(action: AutomationAction): boolean {
  return action.actionType.toLowerCase() === EVENTHUB_ACTION_TYPE.toLowerCase();
}

/** An Event Hub target this app can address: a hub id or a namespace id. */
function targetIsParseable(id: string): boolean {
  return parseEventHubResourceId(id) !== null || parseNamespaceResourceId(id) !== null;
}

/**
 * Every way `observed` falls short of an export that works, in words an
 * operator can act on. Empty means it matches.
 *
 * With `expected`, the scope path and the hub id must be the expected ones -
 * that is the read-back after our own PUT. Without it, an EventHub action with
 * a target this app can parse is enough - that is classifying an export we
 * did not just write, whose target we do not know in advance.
 *
 * Compares ONLY isEnabled, sources[].eventSource, scopes[].scopePath,
 * actions[].actionType and actions[].eventHubResourceId. Extra sources are
 * not a difference: an operator may have added one in the portal.
 */
export function automationDiffs(
  expected: ExpectedExport | undefined,
  observed: DefenderAutomation,
): string[] {
  const diffs: string[] = [];
  if (!observed.isEnabled) {
    diffs.push("The export is not enabled.");
  }
  if (!observed.sources.some((s) => s.toLowerCase() === ALERTS_EVENT_SOURCE.toLowerCase())) {
    diffs.push("The export does not include security alerts.");
  }
  const hubActions = observed.actions.filter(isEventHubAction);
  if (hubActions.length === 0) {
    diffs.push("The export has no Event Hub action.");
  } else if (expected === undefined) {
    if (!hubActions.some((a) => targetIsParseable(a.eventHubResourceId))) {
      diffs.push("The export's Event Hub target is not a namespace or hub this app can read.");
    }
  } else if (!hubActions.some((a) => sameId(a.eventHubResourceId, expected.eventHubResourceId))) {
    const seen = hubActions.map((a) => a.eventHubResourceId || "(none)").join(", ");
    diffs.push(`The export sends to ${seen}, not ${expected.eventHubResourceId}.`);
  }
  if (expected !== undefined && !observed.scopePaths.some((p) => sameId(p, expected.scopePath))) {
    diffs.push(`The export does not watch ${expected.scopePath}.`);
  }
  return diffs;
}

/**
 * True when `observed` has the non-secret shape of `expected`. Used for the
 * read-back after the PUT: a connection string that Azure omits or redacts on
 * GET cannot make this false, because it is never looked at.
 */
export function automationMatches(expected: ExpectedExport, observed: DefenderAutomation): boolean {
  return automationDiffs(expected, observed).length === 0;
}

/** What the subscription already holds under our name. */
export type OursState =
  | {
      readonly kind: "absent";
      /**
       * True when the list behind this was READ (it had rows, none ours).
       * False when the list came back empty, which for a raw ARM list cannot
       * be told apart from a list we were not shown - see inventory-listing.
       */
      readonly measured: boolean;
    }
  | { readonly kind: "present-matching"; readonly automation: DefenderAutomation }
  | {
      readonly kind: "present-differs";
      readonly automation: DefenderAutomation;
      readonly diffs: readonly string[];
    };

/**
 * Find {@link DEFENDER_EXPORT_NAME} in the subscription-wide listing, in ANY
 * resource group, by name (case-insensitively, as ARM names are).
 *
 * Only `present-matching` means deployed. More than one automation under our
 * name is itself a difference, named with every resource group, and the
 * first is reported - which one does not matter, as nothing repairs it here.
 */
export function classifyOurs(
  listing: Listing<DefenderAutomation>,
  expected?: ExpectedExport,
): OursState {
  const ours = listingRows(listing).filter((a) => sameId(a.name, DEFENDER_EXPORT_NAME));
  const first = ours[0];
  if (first === undefined) {
    return { kind: "absent", measured: listingWasRead(listing) };
  }
  const diffs = automationDiffs(expected, first);
  if (ours.length > 1) {
    const groups = ours.map((a) => a.resourceGroup || "(unknown resource group)").join(", ");
    diffs.unshift(
      `${ours.length} exports are named ${DEFENDER_EXPORT_NAME}, in resource groups ${groups}.`,
    );
  }
  return diffs.length === 0
    ? { kind: "present-matching", automation: first }
    : { kind: "present-differs", automation: first, diffs };
}

/**
 * Every OTHER export (any name but ours) whose Event Hub action targets the
 * chosen hub, or anything inside the chosen hub's namespace - the namespace id
 * itself (the legacy form) or another hub in it. Either way, deploying would
 * put a second copy of the alerts into the namespace Cribl reads.
 *
 * Ours is left out because {@link classifyOurs} already answers for it.
 */
export function findSameTargetExports(
  listing: Listing<DefenderAutomation>,
  hubId: string,
): DefenderAutomation[] {
  const parsed = parseEventHubResourceId(hubId);
  const prefix = (parsed !== null ? eventHubNamespacePath(parsed.namespace) : hubId).toLowerCase();
  const hits = (target: string): boolean => {
    const t = target.toLowerCase();
    return sameId(t, hubId) || t === prefix || t.startsWith(`${prefix}/`);
  };
  return listingRows(listing).filter(
    (a) => !sameId(a.name, DEFENDER_EXPORT_NAME) && a.eventHubTargets.some(hits),
  );
}

// ---------------------------------------------------------------------------
// Validate (AZR-32): classify the subscription's exports against a PLAN
// ---------------------------------------------------------------------------

/**
 * The structured form of {@link automationDiffs} with an expected export: one
 * entry per field that falls short. Same comparisons, same order; the field
 * names are what the Validate panel shows in its diffs table.
 */
function planDiffs(expected: ExpectedExport, observed: DefenderAutomation): VerdictDiff[] {
  const diffs: VerdictDiff[] = [];
  if (!observed.isEnabled) {
    diffs.push({ field: "isEnabled", expected: "true", actual: "false" });
  }
  if (!observed.sources.some((s) => s.toLowerCase() === ALERTS_EVENT_SOURCE.toLowerCase())) {
    diffs.push({
      field: "sources",
      expected: ALERTS_EVENT_SOURCE,
      actual: observed.sources.length === 0 ? "(none)" : observed.sources.join(", "),
    });
  }
  const hubActions = observed.actions.filter(isEventHubAction);
  if (!hubActions.some((a) => sameId(a.eventHubResourceId, expected.eventHubResourceId))) {
    diffs.push({
      field: "eventHubResourceId",
      expected: expected.eventHubResourceId,
      actual:
        hubActions.length === 0
          ? "(no Event Hub action)"
          : hubActions.map((a) => a.eventHubResourceId || "(none)").join(", "),
    });
  }
  if (!observed.scopePaths.some((p) => sameId(p, expected.scopePath))) {
    diffs.push({
      field: "scopes",
      expected: expected.scopePath,
      actual: observed.scopePaths.length === 0 ? "(none)" : observed.scopePaths.join(", "),
    });
  }
  return diffs;
}

/**
 * The plan's export, as {@link automationDiffs} judges it, in field form.
 * automationDiffs is the authority on WHETHER it differs; if it reports a
 * difference planDiffs cannot place in a field, the sentence is kept as-is.
 */
function verdictDiffs(expected: ExpectedExport, observed: DefenderAutomation): VerdictDiff[] {
  const sentences = automationDiffs(expected, observed);
  if (sentences.length === 0) return [];
  const fields = planDiffs(expected, observed);
  return fields.length > 0
    ? fields
    : sentences.map((s) => ({ field: "export", expected: "as planned", actual: s }));
}

/**
 * Classify the subscription's continuous exports against the plan (Validate,
 * AZR-32). READ-ONLY, and a different question from {@link classifyOurs}:
 * that one guards the AZR-18 create; this one asks "is the plan satisfied, by
 * whatever name".
 *
 *   as-expected         ours ({@link DEFENDER_EXPORT_NAME}) matches the plan
 *   present-differs     ours exists and falls short (or is duplicated)
 *   present-other-name  ours is absent, but another export targets the plan's
 *                       hub - or another hub in its namespace - so alerts are
 *                       (or would be) delivered under that name
 *   absent              the list was READ (rows or a verified none) and holds
 *                       neither
 *   unknown             the listing is `empty` - unverified, so never absent
 *
 * The listing must come from `toListingFromRead` over the per-subscription
 * read: a refused read is `empty` there, and only a completed read can be
 * `none`. A raw `toListing` of zero rows is also `empty`, and reads unknown.
 */
export function classifyExportForPlan(
  listing: Listing<DefenderAutomation>,
  expected: ExpectedExport,
): StepVerdict {
  if (listing.kind === "empty") {
    return {
      kind: "unknown",
      reason: "failed",
      detail: "The subscription's continuous exports could not be read, so whether one exists is not known.",
    };
  }
  const ours = classifyOurs(listing, expected);
  if (ours.kind === "present-matching") return { kind: "as-expected" };
  if (ours.kind === "present-differs") {
    const diffs = verdictDiffs(expected, ours.automation);
    const count = listingRows(listing).filter((a) => sameId(a.name, DEFENDER_EXPORT_NAME)).length;
    if (count > 1) {
      diffs.unshift({
        field: "name",
        expected: `one export named ${DEFENDER_EXPORT_NAME}`,
        actual: `${count} exports named ${DEFENDER_EXPORT_NAME}`,
      });
    }
    return { kind: "present-differs", diffs };
  }
  const others = findSameTargetExports(listing, expected.eventHubResourceId);
  // Prefer one that targets the plan's hub exactly over one that only shares
  // its namespace: the exact one is the export the plan describes.
  const exact = others.find((a) =>
    a.eventHubTargets.some((t) => sameId(t, expected.eventHubResourceId)),
  );
  const other = exact ?? others[0];
  if (other !== undefined) {
    const diffs = verdictDiffs(expected, other);
    // The rest are counted, so the screen does not imply the named one is alone (DBT-178).
    return others.length > 1
      ? { kind: "present-other-name", name: other.name, diffs, alsoFound: others.length - 1 }
      : { kind: "present-other-name", name: other.name, diffs };
  }
  return { kind: "absent" };
}
