/**
 * The Listen rule and the dedicated consumer group a Cribl Event Hubs source
 * reads with - the PURE half (AZR-36).
 *
 * AZR-34 creates the Cribl source against an EXISTING Listen-capable rule (or
 * Entra ID) and an EXISTING consumer group; in the How-to path the operator
 * makes both by hand (the eh-listen-rule and eh-consumer-group steps). This
 * module lets the Automated path create them from the app:
 *
 *   PUT .../namespaces/{ns}/authorizationRules/{rule}   rights ["Listen"]
 *   PUT .../eventhubs/{hub}/consumergroups/{group}      userMetadata = stamp
 *
 * CREATE-ONLY, NEVER REPLACE. Both PUTs are create-or-update in ARM, so the
 * name is read first and the PUT is built only for a 404. An existing object
 * of the same name is never written: a rule that can Listen and cannot Manage,
 * or any consumer group (other than $Default), is OFFERED FOR REUSE; a rule
 * that cannot Listen, or that can Manage (AZR-58: its key in a Cribl secret
 * is control of the namespace), is refused for this purpose and left as it is.
 *
 * LEAST PRIVILEGE. The rule carries Listen and nothing else, and sits on the
 * NAMESPACE because that is the rule a listKeys credential addresses
 * (eventhub-arm buildNamespaceListKeysRequest). Its default name says what it
 * is for and what it can do (`cribl-listen`). The consumer group's name is the
 * plan value (default `cribl`), never `$Default`, which every namespace has and
 * whose partitions another reader may already hold.
 *
 * OWNERSHIP PROOF (claude-kit cribl-config-writes rule 11, the AZR-105
 * pattern). The app records, in its progress KV document, the resource id of
 * each object ITS PUT created. A removal later needs every signal:
 *
 *   consumer group  the KV record, the name, and the description stamp the
 *                   PUT wrote into userMetadata
 *   Listen rule     the KV record, the name, and - in place of a stamp, which
 *                   a rule cannot carry - rights still exactly ["Listen"], as
 *                   the app wrote them
 *
 * and nothing the app created that reads with it may remain: a recorded Cribl
 * Event Hubs source may be using the rule's key or the group, so it is removed
 * first (the AZR-105 teardown panel), in that order.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import type { RequiredAction } from "../azure-permissions/azure-permissions";
import { operationAction, leastRoleFor } from "../least-privilege";
import type { OperationId } from "../least-privilege";
import {
  EVENTHUB_ARM_API_VERSION,
  buildHubConsumerGroupGetRequest,
  eventHubNamespacePath,
  eventHubResourceId,
  namespaceRuleResourceId,
  ruleCanListen,
  ruleCanManage,
  ruleCanSend,
  type NamespaceRef,
} from "../eventhub-arm/eventhub-arm";

/** The Listen rule's name when the plan values name none: what it is for, and what it can do. */
export const DEFAULT_LISTEN_RULE_NAME = "cribl-listen";

/** The consumer group every hub has. Never created, never recorded, never removed. */
export const DEFAULT_CONSUMER_GROUP_NAME = "$Default";

/**
 * The description stamp the app writes into a consumer group's userMetadata.
 * It is the group's ownership signal: a group of the same name without it was
 * not created by this app's PUT, and is never removed from the app.
 */
export const CONSUMER_GROUP_STAMP = "Created by the SOC Optimization Toolkit for a Cribl Event Hubs source.";

/** The one rights list the app writes. */
export const LISTEN_RULE_RIGHTS: readonly string[] = ["Listen"];

/** The rule name the plan values give, or {@link DEFAULT_LISTEN_RULE_NAME}. */
export function listenRuleName(planListenRule: string): string {
  const name = planListenRule.trim();
  return name === "" ? DEFAULT_LISTEN_RULE_NAME : name;
}

/** The ARM resource id of a consumer group. */
export function consumerGroupResourceId(ns: NamespaceRef, hubName: string, group: string): string {
  return `${eventHubResourceId(ns, hubName)}/consumergroups/${group}`;
}

/** GET one namespace-level authorization rule by name. */
export function buildNamespaceRuleGetRequest(ns: NamespaceRef, ruleName: string): AzureManagementRequest {
  return {
    method: "GET",
    path: `${eventHubNamespacePath(ns)}/authorizationRules/${ruleName}`,
    apiVersion: EVENTHUB_ARM_API_VERSION,
  };
}

/** PUT a namespace-level rule with Listen and nothing else. Sent only after a 404 for the name. */
export function buildListenRulePutRequest(ns: NamespaceRef, ruleName: string): AzureManagementRequest {
  return {
    method: "PUT",
    path: `${eventHubNamespacePath(ns)}/authorizationRules/${ruleName}`,
    apiVersion: EVENTHUB_ARM_API_VERSION,
    body: { properties: { rights: [...LISTEN_RULE_RIGHTS] } },
  };
}

/** DELETE one namespace-level rule. Sent only for a rule proven the app's. */
export function buildNamespaceRuleDeleteRequest(ns: NamespaceRef, ruleName: string): AzureManagementRequest {
  return {
    method: "DELETE",
    path: `${eventHubNamespacePath(ns)}/authorizationRules/${ruleName}`,
    apiVersion: EVENTHUB_ARM_API_VERSION,
  };
}

/** PUT a consumer group carrying the app's stamp. Sent only after a 404 for the name. */
export function buildStampedConsumerGroupPutRequest(
  ns: NamespaceRef,
  hubName: string,
  group: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: `${eventHubResourceId(ns, hubName)}/consumergroups/${group}`,
    apiVersion: EVENTHUB_ARM_API_VERSION,
    body: { properties: { userMetadata: CONSUMER_GROUP_STAMP } },
  };
}

/** DELETE one consumer group. Sent only for a group proven the app's. */
export function buildHubConsumerGroupDeleteRequest(
  ns: NamespaceRef,
  hubName: string,
  group: string,
): AzureManagementRequest {
  return {
    method: "DELETE",
    path: `${eventHubResourceId(ns, hubName)}/consumergroups/${group}`,
    apiVersion: EVENTHUB_ARM_API_VERSION,
  };
}

/**
 * The exact request, as the confirm quotes it: method, path with api-version,
 * and the body as JSON when there is one. What is quoted is what is sent.
 */
export function quoteArmRequest(request: AzureManagementRequest): string {
  const line = `${request.method} ${request.path}?api-version=${request.apiVersion}`;
  return request.body === undefined ? line : `${line} ${JSON.stringify(request.body)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The rights of one rule GET body; [] when the body carries none. */
export function readRuleRights(body: unknown): string[] {
  const props = isRecord(body) && isRecord(body["properties"]) ? body["properties"] : {};
  const raw = props["rights"];
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string") : [];
}

/** The userMetadata of one consumer group GET body; "" when absent. */
export function readConsumerGroupMetadata(body: unknown): string {
  const props = isRecord(body) && isRecord(body["properties"]) ? body["properties"] : {};
  const raw = props["userMetadata"];
  return typeof raw === "string" ? raw : "";
}

/** True when the rights are exactly Listen, as the app writes them. */
export function rightsAreListenOnly(rights: readonly string[]): boolean {
  return rights.length === 1 && (rights[0] ?? "").toLowerCase() === "listen";
}

/** What reading one name found. `unknown` is never treated as absent. */
export type ListenAccessLookup =
  | { readonly kind: "absent" }
  | { readonly kind: "found"; readonly body: unknown }
  | { readonly kind: "unknown"; readonly detail: string; readonly denied: boolean };

/** What the plan does with one object. Only `create` produces a write. */
export type ListenAccessVerdict =
  | { readonly kind: "create" }
  | { readonly kind: "reuse"; readonly detail: string }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string; readonly denied: boolean };

/**
 * The verdict for the Listen rule's name. Never a write over an existing rule:
 * one that can Listen and cannot Manage is reused as it is; anything else is
 * refused for a Cribl source and left untouched.
 */
export function classifyListenRule(lookup: ListenAccessLookup, ruleName: string): ListenAccessVerdict {
  if (lookup.kind === "absent") return { kind: "create" };
  if (lookup.kind === "unknown") {
    return {
      kind: "unknown",
      detail: `Whether rule ${ruleName} exists could not be read (${lookup.detail}), so nothing is created under that name.`,
      denied: lookup.denied,
    };
  }
  const rights = readRuleRights(lookup.body);
  const shown = rights.length > 0 ? rights.join(", ") : "no";
  if (!ruleCanListen(rights)) {
    return {
      kind: "refused",
      detail: `Rule ${ruleName} already exists with ${shown} rights and cannot Listen. It is not replaced; choose another Listen rule name in the plan values.`,
    };
  }
  if (ruleCanManage(rights)) {
    return {
      kind: "refused",
      detail: `Rule ${ruleName} already exists with ${shown} rights. A key that can Manage the namespace must not go into a Cribl secret, and the rule is not replaced; choose another Listen rule name in the plan values.`,
    };
  }
  return {
    kind: "reuse",
    detail: ruleCanSend(rights)
      ? `Rule ${ruleName} already exists with ${shown} rights. It is used as it is (nothing is written); a rule with Listen only would be narrower.`
      : `Rule ${ruleName} already exists with Listen rights. It is used as it is; nothing is written.`,
  };
}

/** The verdict for the consumer group's name on one hub. An existing group is reused, never written. */
export function classifyConsumerGroup(lookup: ListenAccessLookup, group: string, hubName: string): ListenAccessVerdict {
  if (group.trim().toLowerCase() === DEFAULT_CONSUMER_GROUP_NAME.toLowerCase()) {
    return {
      kind: "refused",
      detail: `${DEFAULT_CONSUMER_GROUP_NAME} is shared with every other reader of ${hubName}; set a dedicated consumer group in the plan values.`,
    };
  }
  if (lookup.kind === "absent") return { kind: "create" };
  if (lookup.kind === "unknown") {
    return {
      kind: "unknown",
      detail: `Whether consumer group ${group} exists on ${hubName} could not be read (${lookup.detail}), so it is not created.`,
      denied: lookup.denied,
    };
  }
  return {
    kind: "reuse",
    detail: `Consumer group ${group} already exists on ${hubName}. It is used as it is; nothing is written.`,
  };
}

// ---------------------------------------------------------------------------
// What the app created (the progress document holds these) and its removal
// ---------------------------------------------------------------------------

/**
 * One object the app's PUT created. Ids only. Written after the PUT for a name
 * the app had just read as absent was accepted, so the record is the proof
 * that THIS app made it; reuse of an existing object is never recorded.
 */
export interface EventHubAccessRecord {
  readonly kind: "listen-rule" | "consumer-group";
  /** The full ARM resource id the PUT addressed. */
  readonly resourceId: string;
}

/** The record for a rule the app created. */
export function listenRuleRecord(ns: NamespaceRef, ruleName: string): EventHubAccessRecord {
  return { kind: "listen-rule", resourceId: namespaceRuleResourceId(ns, ruleName) };
}

/** The record for a consumer group the app created. */
export function consumerGroupRecord(ns: NamespaceRef, hubName: string, group: string): EventHubAccessRecord {
  return { kind: "consumer-group", resourceId: consumerGroupResourceId(ns, hubName, group) };
}

/** Same ARM id, compared as ARM does (case-insensitive, no trailing slash). */
export function sameAccessResourceId(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** The last path segment of a resource id: the object's name. */
export function accessObjectName(resourceId: string): string {
  const parts = resourceId.split("/").filter((s) => s !== "");
  return parts[parts.length - 1] ?? "";
}

/** The GET and DELETE for a recorded object, or null when its id is not one this module writes. */
export function requestsForAccessRecord(
  record: EventHubAccessRecord,
): { readonly get: AzureManagementRequest; readonly del: AzureManagementRequest } | null {
  const segments = record.resourceId.split("/").filter((s) => s !== "");
  const lower = segments.map((s) => s.toLowerCase());
  const nsOk =
    lower[0] === "subscriptions" &&
    lower[2] === "resourcegroups" &&
    lower[4] === "providers" &&
    lower[5] === "microsoft.eventhub" &&
    lower[6] === "namespaces";
  if (!nsOk) return null;
  const ns: NamespaceRef = {
    subscriptionId: segments[1] ?? "",
    resourceGroup: segments[3] ?? "",
    name: segments[7] ?? "",
  };
  if (record.kind === "listen-rule" && segments.length === 10 && lower[8] === "authorizationrules") {
    const rule = segments[9] ?? "";
    return { get: buildNamespaceRuleGetRequest(ns, rule), del: buildNamespaceRuleDeleteRequest(ns, rule) };
  }
  if (record.kind === "consumer-group" && segments.length === 12 && lower[8] === "eventhubs" && lower[10] === "consumergroups") {
    const hub = segments[9] ?? "";
    const group = segments[11] ?? "";
    if (group.toLowerCase() === DEFAULT_CONSUMER_GROUP_NAME.toLowerCase()) return null;
    return { get: buildHubConsumerGroupGetRequest(ns, hub, group), del: buildHubConsumerGroupDeleteRequest(ns, hub, group) };
  }
  return null;
}

/** What a recorded object's removal may do. */
export type ListenAccessRemovalVerdict =
  | { readonly kind: "delete" }
  | { readonly kind: "already-gone" }
  | { readonly kind: "not-proven"; readonly detail: string }
  | { readonly kind: "in-use"; readonly detail: string };

/**
 * May the app delete this object? `inUseBy` names the Cribl Event Hubs
 * sources the app still records (any of them may read with this rule's key or
 * this group); while one remains, nothing is removed. Otherwise every signal
 * must hold (see the module comment), else not-proven with the missing one
 * named.
 */
export function classifyListenAccessRemoval(
  lookup: { readonly kind: "absent" } | { readonly kind: "found"; readonly body: unknown },
  record: EventHubAccessRecord,
  recorded: readonly EventHubAccessRecord[],
  inUseBy: readonly string[],
): ListenAccessRemovalVerdict {
  const name = accessObjectName(record.resourceId);
  if (lookup.kind === "absent") return { kind: "already-gone" };
  if (inUseBy.length > 0) {
    return {
      kind: "in-use",
      detail: `The Cribl source${inUseBy.length === 1 ? "" : "s"} ${inUseBy.join(", ")} this app created may read with ${name}. Remove ${inUseBy.length === 1 ? "it" : "them"} first (Remove or pause what this app created), then remove ${name}.`,
    };
  }
  const missing: string[] = [];
  if (!recorded.some((r) => r.kind === record.kind && sameAccessResourceId(r.resourceId, record.resourceId))) {
    missing.push("this app has no record of creating it");
  }
  const body = lookup.body;
  const foundName = isRecord(body) && typeof body["name"] === "string" ? body["name"] : "";
  if (foundName !== "" && foundName.toLowerCase() !== name.toLowerCase()) missing.push(`its name is ${foundName}, not ${name}`);
  if (record.kind === "listen-rule") {
    const rights = readRuleRights(body);
    if (!rightsAreListenOnly(rights)) {
      missing.push(`its rights are now ${rights.length > 0 ? rights.join(", ") : "none"}, not Listen alone as this app wrote them`);
    }
  } else if (readConsumerGroupMetadata(body) !== CONSUMER_GROUP_STAMP) {
    missing.push("its description does not carry this app's stamp");
  }
  if (missing.length > 0) {
    return {
      kind: "not-proven",
      detail: `This app cannot prove it created ${name} as it is now (${missing.join("; ")}), so it does not remove it. Remove it in the Azure portal if it should go.`,
    };
  }
  return { kind: "delete" };
}

// ---------------------------------------------------------------------------
// Permissions (shown as a banner; nothing here measures them)
// ---------------------------------------------------------------------------

function action(operationId: OperationId, label: string): RequiredAction {
  return { action: operationAction(operationId), label, necessity: "feature" };
}

/**
 * The Azure actions creating (and removing) these objects needs, from the
 * least-privilege registry. NOT MEASURED: the capability audit has no
 * capability for them (CAP-9 measures the namespace rule write; nothing
 * measures the consumer group write), so the panel shows them as needed, not
 * yet measured, and Azure's own refusal at the step is what decides.
 */
export const LISTEN_ACCESS_ACTIONS: readonly RequiredAction[] = [
  action("eventhub.rule.read", "Read the Listen rule by name before writing"),
  action("eventhub.rule.write", "Create the Listen rule"),
  action("eventhub.consumerGroup.read", "Read the consumer group by name before writing"),
  action("eventhub.consumerGroup.write", "Create the consumer group"),
  action("eventhub.rule.delete", "Remove the Listen rule this app created"),
  action("eventhub.consumerGroup.delete", "Remove the consumer group this app created"),
];

/** The least role for the two creates, from the registry (never restated). */
export const LISTEN_ACCESS_LEAST_ROLE = leastRoleFor("eventhub.rule.write");

/** The banner line: unmeasured is never worded as a denial. Visible copy. */
export const LISTEN_ACCESS_NOT_MEASURED =
  "Needed, not yet measured. The app does not check these permissions before it writes; if one is missing, Azure's refusal is shown at the step that needed it.";
