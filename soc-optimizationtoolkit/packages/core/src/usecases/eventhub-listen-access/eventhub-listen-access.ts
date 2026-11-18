/**
 * Create, and remove, the Listen rule and the dedicated consumer group a
 * Cribl Event Hubs source reads with - the USECASES (AZR-36). Pure
 * orchestration over the AzureManagement port; the rules live in
 * domain/eventhub-listen-access.
 *
 * planListenAccess   READ-ONLY. GETs each name (the rule on the namespace,
 *                    the group on each hub) and gives each object one
 *                    verdict: create, reuse, refused or unknown. Only a 404
 *                    is "absent"; a refused or failed read is unknown, and
 *                    nothing is created under an unknown name. The plan
 *                    carries the exact PUT for each create, which is what the
 *                    confirm quotes.
 *
 * applyListenAccess  after the operator's confirm, for each planned create,
 *                    in order: GET the name AGAIN (read-modify-write: it may
 *                    have appeared since the plan; a PUT would then replace
 *                    it, so nothing is written and the object is reported),
 *                    PUT exactly the planned request, GET it back. The
 *                    result names the records to keep: one per object whose
 *                    PUT was accepted after a 404 - never an object reused.
 *
 * removeListenAccessObject
 *                    for one recorded object: GET it now (404 is already
 *                    gone), prove it the app's and not in use
 *                    (classifyListenAccessRemoval), DELETE, GET for the 404.
 *
 * Never throws: every rejection and non-2xx becomes an outcome; a 403 is
 * `denied` with the step named. No clock, no randomness.
 */

import type { AzureManagement, AzureManagementRequest } from "../../ports/azure-management";
import type { Logger } from "../../ports/logger";
import { attemptArm, classifyArmFailure, is2xx } from "../arm-http";
import type { ArmReadFailure } from "../arm-http";
import type { NamespaceRef } from "../../domain/eventhub-arm";
import { buildHubConsumerGroupGetRequest, namespaceRuleResourceId } from "../../domain/eventhub-arm";
import {
  CONSUMER_GROUP_STAMP,
  accessObjectName,
  buildListenRulePutRequest,
  buildNamespaceRuleGetRequest,
  buildStampedConsumerGroupPutRequest,
  classifyConsumerGroup,
  classifyListenAccessRemoval,
  classifyListenRule,
  consumerGroupRecord,
  consumerGroupResourceId,
  listenRuleRecord,
  readConsumerGroupMetadata,
  readRuleRights,
  requestsForAccessRecord,
  rightsAreListenOnly,
  type EventHubAccessRecord,
  type ListenAccessLookup,
  type ListenAccessVerdict,
} from "../../domain/eventhub-listen-access";

const LOG = "eventhub-listen-access:";

/** What to create, from the plan values and the chosen Event Hub lanes. */
export interface ListenAccessTarget {
  readonly namespace: NamespaceRef;
  /** The hubs the consumer group goes on: every hub a chosen Event Hub lane reads. */
  readonly hubs: readonly string[];
  readonly consumerGroup: string;
  readonly ruleName: string;
  /** Create the Listen rule (needed only for the connection-string credentials). */
  readonly createRule: boolean;
  /** Create the consumer group on each hub. */
  readonly createGroups: boolean;
}

/** One object the plan looked at. */
export interface ListenAccessItem {
  readonly kind: "listen-rule" | "consumer-group";
  /** The rule or group name. */
  readonly name: string;
  /** The hub, for a consumer group; null for the rule. */
  readonly hub: string | null;
  readonly resourceId: string;
  readonly verdict: ListenAccessVerdict;
  /** The exact PUT the apply sends: set exactly when the verdict is `create`. */
  readonly put: AzureManagementRequest | null;
}

export type ListenAccessPlan =
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "planned"; readonly target: ListenAccessTarget; readonly items: readonly ListenAccessItem[] };

/** The PUTs a plan would send, in order. Empty when there is nothing to create. */
export function plannedWrites(plan: ListenAccessPlan): AzureManagementRequest[] {
  if (plan.kind !== "planned") return [];
  return plan.items.flatMap((i) => (i.put === null ? [] : [i.put]));
}

/** GET a name: 404 absent, 2xx found, anything else unknown (never absent). */
async function lookup(azure: AzureManagement, request: AzureManagementRequest, what: string): Promise<ListenAccessLookup> {
  const attempt = await attemptArm(() => azure.request(request));
  if (attempt.ok && attempt.response.status === 404) return { kind: "absent" };
  if (attempt.ok && is2xx(attempt.response.status)) return { kind: "found", body: attempt.response.body };
  const failure = classifyArmFailure(attempt, what);
  return { kind: "unknown", detail: failure.message, denied: failure.kind === "denied" };
}

function uniqueHubs(hubs: readonly string[]): string[] {
  const out: string[] = [];
  for (const h of hubs) {
    const hub = h.trim();
    if (hub !== "" && !out.some((o) => o.toLowerCase() === hub.toLowerCase())) out.push(hub);
  }
  return out;
}

/** Plan the creates. READ-ONLY: GETs only. Never throws. */
export async function planListenAccess(
  azure: AzureManagement,
  target: ListenAccessTarget,
  logger?: Logger,
): Promise<ListenAccessPlan> {
  const ns = target.namespace;
  if (ns.subscriptionId.trim() === "" || ns.resourceGroup.trim() === "" || ns.name.trim() === "") {
    return { kind: "refused", detail: "Enter the Event Hub subscription, resource group and namespace in the plan values first." };
  }
  if (!target.createRule && !target.createGroups) {
    return { kind: "refused", detail: "Choose the Listen rule, the consumer group, or both." };
  }
  const ruleName = target.ruleName.trim();
  const group = target.consumerGroup.trim();
  const hubs = uniqueHubs(target.hubs);
  if (target.createRule && ruleName === "") return { kind: "refused", detail: "Enter the Listen rule name." };
  if (target.createGroups && group === "") return { kind: "refused", detail: "Enter the consumer group in the plan values first." };
  if (target.createGroups && hubs.length === 0) {
    return {
      kind: "refused",
      detail: "No hub is known yet for the chosen Event Hub sources. Set the hub name, or run Validate so the hubs Azure created are read, then check again.",
    };
  }

  const items: ListenAccessItem[] = [];
  if (target.createRule) {
    const found = await lookup(azure, buildNamespaceRuleGetRequest(ns, ruleName), `Read rule ${ruleName}`);
    const verdict = classifyListenRule(found, ruleName);
    items.push({
      kind: "listen-rule",
      name: ruleName,
      hub: null,
      resourceId: namespaceRuleResourceId(ns, ruleName),
      verdict,
      put: verdict.kind === "create" ? buildListenRulePutRequest(ns, ruleName) : null,
    });
  }
  if (target.createGroups) {
    for (const hub of hubs) {
      const found = await lookup(
        azure,
        buildHubConsumerGroupGetRequest(ns, hub, group),
        `Read consumer group ${group} on ${hub}`,
      );
      const verdict = classifyConsumerGroup(found, group, hub);
      items.push({
        kind: "consumer-group",
        name: group,
        hub,
        resourceId: consumerGroupResourceId(ns, hub, group),
        verdict,
        put: verdict.kind === "create" ? buildStampedConsumerGroupPutRequest(ns, hub, group) : null,
      });
    }
  }
  logger?.info(`${LOG} planned`, {
    namespace: ns.name,
    items: items.length,
    creates: items.filter((i) => i.put !== null).length,
  });
  return { kind: "planned", target: { ...target, ruleName, consumerGroup: group, hubs }, items };
}

/** How one planned create ended. */
export type ListenAccessItemOutcome =
  /** PUT accepted after a 404, and the read-back shows what was written. */
  | { readonly kind: "created"; readonly item: ListenAccessItem }
  /** PUT accepted after a 404, but the read-back did not confirm it. Still recorded. */
  | { readonly kind: "created-not-verified"; readonly item: ListenAccessItem; readonly reason: string }
  /** The name now exists (it did not at the plan): nothing was written. */
  | { readonly kind: "appeared"; readonly item: ListenAccessItem; readonly detail: string }
  /** The name could not be re-read: nothing was written. */
  | { readonly kind: "not-written"; readonly item: ListenAccessItem; readonly detail: string }
  /** The PUT was refused or got no answer. */
  | { readonly kind: "failed"; readonly item: ListenAccessItem; readonly failure: ArmReadFailure };

export interface ListenAccessApplyResult {
  readonly outcomes: readonly ListenAccessItemOutcome[];
  /** One per object whose PUT the app sent after a 404 and Azure accepted: the ownership records. */
  readonly records: readonly EventHubAccessRecord[];
}

function readBackProblem(item: ListenAccessItem, body: unknown): string | null {
  if (item.kind === "listen-rule") {
    const rights = readRuleRights(body);
    return rightsAreListenOnly(rights)
      ? null
      : `The rule read back with ${rights.length > 0 ? rights.join(", ") : "no"} rights, not Listen alone.`;
  }
  return readConsumerGroupMetadata(body) === CONSUMER_GROUP_STAMP
    ? null
    : "The consumer group read back without this app's description stamp.";
}

function recordFor(plan: Extract<ListenAccessPlan, { kind: "planned" }>, item: ListenAccessItem): EventHubAccessRecord {
  const ns = plan.target.namespace;
  return item.kind === "listen-rule" ? listenRuleRecord(ns, item.name) : consumerGroupRecord(ns, item.hub ?? "", item.name);
}

/**
 * Send the planned creates, after the operator's confirm. Each object is
 * re-read by name first and written only if it is still absent. Never throws.
 */
export async function applyListenAccess(
  azure: AzureManagement,
  plan: ListenAccessPlan,
  logger?: Logger,
): Promise<ListenAccessApplyResult> {
  if (plan.kind !== "planned") return { outcomes: [], records: [] };
  const outcomes: ListenAccessItemOutcome[] = [];
  const records: EventHubAccessRecord[] = [];
  const ns = plan.target.namespace;
  for (const item of plan.items) {
    if (item.put === null) continue;
    const get =
      item.kind === "listen-rule"
        ? buildNamespaceRuleGetRequest(ns, item.name)
        : buildHubConsumerGroupGetRequest(ns, item.hub ?? "", item.name);
    const label = item.kind === "listen-rule" ? `rule ${item.name}` : `consumer group ${item.name} on ${item.hub ?? ""}`;
    const now = await lookup(azure, get, `Read ${label} again`);
    if (now.kind === "found") {
      const verdict =
        item.kind === "listen-rule" ? classifyListenRule(now, item.name) : classifyConsumerGroup(now, item.name, item.hub ?? "");
      outcomes.push({
        kind: "appeared",
        item,
        detail: `${label} was created by someone else after the check, so nothing was written. ${"detail" in verdict ? verdict.detail : ""}`.trim(),
      });
      continue;
    }
    if (now.kind === "unknown") {
      outcomes.push({ kind: "not-written", item, detail: `${now.detail} Nothing was written.` });
      continue;
    }
    const put = await attemptArm(() => azure.request(item.put as AzureManagementRequest));
    if (!put.ok || !is2xx(put.response.status)) {
      outcomes.push({ kind: "failed", item, failure: classifyArmFailure(put, `Create ${label}`) });
      continue;
    }
    // Accepted after a 404: the app made it, whatever the read-back says.
    records.push(recordFor(plan, item));
    const back = await lookup(azure, get, `Read ${label} back`);
    if (back.kind !== "found") {
      outcomes.push({
        kind: "created-not-verified",
        item,
        reason: back.kind === "absent" ? `${label} did not read back yet.` : back.detail,
      });
      continue;
    }
    const problem = readBackProblem(item, back.body);
    outcomes.push(problem === null ? { kind: "created", item } : { kind: "created-not-verified", item, reason: problem });
  }
  logger?.info(`${LOG} applied`, {
    namespace: ns.name,
    outcomes: outcomes.map((o) => o.kind).join(","),
    recorded: records.length,
  });
  return { outcomes, records };
}

export type ListenAccessRemoveStep = "read" | "delete";

export type ListenAccessRemoveOutcome =
  /** DELETE accepted and the object no longer reads (404). The record can go. */
  | { readonly kind: "removed"; readonly resourceId: string }
  /** DELETE accepted, but it still reads or the read failed. Keep the record. */
  | { readonly kind: "removed-not-confirmed"; readonly resourceId: string; readonly reason: string }
  /** Nothing there: nothing sent. The record can go. */
  | { readonly kind: "already-gone"; readonly resourceId: string }
  /** There, but not provably the app's, or still read by a source the app made: nothing sent. */
  | { readonly kind: "not-proven" | "in-use"; readonly resourceId: string; readonly detail: string }
  /** The record names no object this app writes: nothing sent. */
  | { readonly kind: "invalid-record"; readonly resourceId: string }
  | {
      readonly kind: "denied" | "unregistered" | "failed";
      readonly resourceId: string;
      readonly step: ListenAccessRemoveStep;
      readonly message: string;
    };

export interface ListenAccessRemoveInput {
  readonly record: EventHubAccessRecord;
  /** Every record the progress document holds (the proof reads it again). */
  readonly recorded: readonly EventHubAccessRecord[];
  /** The Cribl Event Hubs sources the app still records: while any remains, nothing goes. */
  readonly inUseBy: readonly string[];
}

/** Remove one object the app created, after the operator's confirm. Never throws. */
export async function removeListenAccessObject(
  azure: AzureManagement,
  input: ListenAccessRemoveInput,
  logger?: Logger,
): Promise<ListenAccessRemoveOutcome> {
  const resourceId = input.record.resourceId;
  const name = accessObjectName(resourceId);
  const done = (outcome: ListenAccessRemoveOutcome): ListenAccessRemoveOutcome => {
    logger?.[outcome.kind === "removed" || outcome.kind === "already-gone" ? "info" : "warn"](`${LOG} remove finished`, {
      kind: input.record.kind,
      outcome: outcome.kind,
    });
    return outcome;
  };
  const requests = requestsForAccessRecord(input.record);
  if (requests === null) return done({ kind: "invalid-record", resourceId });

  const read = await attemptArm(() => azure.request(requests.get));
  let found: { readonly kind: "absent" } | { readonly kind: "found"; readonly body: unknown };
  if (read.ok && read.response.status === 404) found = { kind: "absent" };
  else if (read.ok && is2xx(read.response.status)) found = { kind: "found", body: read.response.body };
  else {
    const f = classifyArmFailure(read, `Read ${name}`);
    return done({ kind: f.kind, resourceId, step: "read", message: f.message });
  }

  const verdict = classifyListenAccessRemoval(found, input.record, input.recorded, input.inUseBy);
  if (verdict.kind === "already-gone") return done({ kind: "already-gone", resourceId });
  if (verdict.kind === "not-proven" || verdict.kind === "in-use") {
    return done({ kind: verdict.kind, resourceId, detail: verdict.detail });
  }

  const del = await attemptArm(() => azure.request(requests.del));
  if (!del.ok || !is2xx(del.response.status)) {
    const f = classifyArmFailure(del, `Remove ${name}`);
    return done({ kind: f.kind, resourceId, step: "delete", message: f.message });
  }
  const after = await attemptArm(() => azure.request(requests.get));
  if (after.ok && after.response.status === 404) return done({ kind: "removed", resourceId });
  const reason =
    after.ok && is2xx(after.response.status)
      ? "Azure accepted the removal, but it still reads back."
      : classifyArmFailure(after, "Read it after the removal").message;
  return done({ kind: "removed-not-confirmed", resourceId, reason });
}
