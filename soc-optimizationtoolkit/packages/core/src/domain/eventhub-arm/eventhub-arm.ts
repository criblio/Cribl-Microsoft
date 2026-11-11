/**
 * Event Hub ARM request builders and parsers - the SHARED half (AZR-12
 * "extend" verdict, used by AZR-11 and AZR-3 on the Azure onboarding screen).
 *
 * WHY THIS MODULE EXISTS. Before it, the Microsoft.EventHub namespace and hub
 * builders lived in labs/lab-analytics (LAB-07) and the hub list lived in
 * eventhub-discovery (EVH-03), each with its own copy of the same api-version
 * and the same namespace path. The onboarding screen needs both, plus the
 * namespace-level authorization rules and their listKeys, so the path and the
 * api-version are lifted here ONCE and the two older modules now delegate.
 * Their exported names are kept as wrappers so no caller changes.
 *
 * NAMING. Every export here has a name that neither labs nor eventhub-discovery
 * exports, because the core barrel re-exports all three with `export *` and a
 * clash would be an ambiguity error (pinned in eventhub-arm.test.ts).
 *
 * NAMESPACE-LEVEL RULES, NOT HUB-LEVEL. The Defender export action and the
 * Cribl Event Hub source both authenticate with a connection string from a
 * rule on the NAMESPACE (`.../namespaces/{ns}/authorizationRules/{rule}`). A
 * hub-level rule (`.../eventhubs/{hub}/authorizationRules/...`, what
 * eventhub-discovery's EVH-06 enumeration lists) is a different resource; the
 * listKeys builder here can only address the namespace one.
 *
 * SECRETS. {@link parseListKeys} is the only place a SAS key passes through
 * core. It returns the connection string and, when the body is not what was
 * expected, throws a message that never echoes the body - a partial body can
 * still carry a key.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import type { Listing } from "../inventory-listing/inventory-listing";
import { toListing } from "../inventory-listing/inventory-listing";

/**
 * The ONE ARM api-version for Microsoft.EventHub namespaces, hubs, consumer
 * groups and authorization rules. LAB_EVENTHUB_ARM_API_VERSION and
 * EVENTHUB_API_VERSION are aliases of this value.
 */
export const EVENTHUB_ARM_API_VERSION = "2021-11-01";

/**
 * The rule every Event Hub namespace is created with. Named so the UI can
 * recognise it and show the "a dedicated Send-only rule is safer" note; it is
 * NOT a default selection (operator answer 2026-10-21: allowed, never
 * preselected). Legacy Deploy-DefenderExport.ps1 hard-coded it (:423-427).
 */
export const DEFAULT_NAMESPACE_RULE = "RootManageSharedAccessKey";

/**
 * The three fields that address an Event Hub namespace. Deliberately minimal:
 * a pasted resource id yields exactly these, and the discovery inventory's
 * EventHubNamespaceInfo satisfies it structurally.
 */
export interface NamespaceRef {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
}

/** SKU settings for a namespace PUT (labs passes its legacy Standard/1). */
export interface NamespaceSkuSettings {
  sku: string;
  capacity: number;
}

/** One namespace-level authorization rule. */
export interface NamespaceAuthRule {
  name: string;
  /** The rule's ARM resource id ("" when the response omitted it). */
  id: string;
  /** The rights as returned (Azure uses "Listen", "Send", "Manage"). */
  rights: string[];
}

/** The ARM path of one Event Hub namespace. */
export function eventHubNamespacePath(ns: NamespaceRef): string {
  return (
    `/subscriptions/${ns.subscriptionId}/resourceGroups/${ns.resourceGroup}` +
    `/providers/Microsoft.EventHub/namespaces/${ns.name}`
  );
}

/**
 * The ARM resource id of one hub. The Defender export action's
 * eventHubResourceId is the HUB id, not the namespace id (plan decision; on
 * the live-verification list).
 */
export function eventHubResourceId(ns: NamespaceRef, hubName: string): string {
  return `${eventHubNamespacePath(ns)}/eventhubs/${hubName}`;
}

/**
 * The ARM resource id of one NAMESPACE-level authorization rule - what a
 * diagnostic setting names as its eventHubAuthorizationRuleId.
 */
export function namespaceRuleResourceId(ns: NamespaceRef, ruleName: string): string {
  return `${eventHubNamespacePath(ns)}/authorizationRules/${ruleName}`;
}

/** GET one namespace (existence + provisioningState). */
export function buildNamespaceGetRequest(ns: NamespaceRef): AzureManagementRequest {
  return {
    method: "GET",
    path: eventHubNamespacePath(ns),
    apiVersion: EVENTHUB_ARM_API_VERSION,
  };
}

/** PUT one namespace with the given SKU and capacity. */
export function buildNamespacePutRequest(
  ns: NamespaceRef,
  location: string,
  settings: NamespaceSkuSettings,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: eventHubNamespacePath(ns),
    apiVersion: EVENTHUB_ARM_API_VERSION,
    body: {
      location,
      sku: { name: settings.sku, tier: settings.sku, capacity: settings.capacity },
      properties: {},
    },
  };
}

/** GET the list of hubs inside one namespace. */
export function buildNamespaceHubsListRequest(
  ns: NamespaceRef,
): AzureManagementRequest {
  return {
    method: "GET",
    path: `${eventHubNamespacePath(ns)}/eventhubs`,
    apiVersion: EVENTHUB_ARM_API_VERSION,
  };
}

/** GET one hub inside a namespace. */
export function buildHubGetRequest(
  ns: NamespaceRef,
  hubName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: eventHubResourceId(ns, hubName),
    apiVersion: EVENTHUB_ARM_API_VERSION,
  };
}

/** PUT one hub with a partition count and retention. */
export function buildHubPutRequest(
  ns: NamespaceRef,
  hubName: string,
  partitionCount: number,
  messageRetentionInDays: number,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: eventHubResourceId(ns, hubName),
    apiVersion: EVENTHUB_ARM_API_VERSION,
    body: {
      properties: { partitionCount, messageRetentionInDays },
    },
  };
}

/** GET one consumer group on a hub. */
export function buildHubConsumerGroupGetRequest(
  ns: NamespaceRef,
  hubName: string,
  groupName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: `${eventHubResourceId(ns, hubName)}/consumergroups/${groupName}`,
    apiVersion: EVENTHUB_ARM_API_VERSION,
  };
}

/** PUT one consumer group on a hub. */
export function buildHubConsumerGroupPutRequest(
  ns: NamespaceRef,
  hubName: string,
  groupName: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: `${eventHubResourceId(ns, hubName)}/consumergroups/${groupName}`,
    apiVersion: EVENTHUB_ARM_API_VERSION,
    body: { properties: {} },
  };
}

// ---------------------------------------------------------------------------
// Namespace-level authorization rules (AZR-11 rule picker, AZR-3 listKeys)
// ---------------------------------------------------------------------------

/** GET the namespace-level authorization rules. */
export function buildNamespaceAuthRulesListRequest(
  ns: NamespaceRef,
): AzureManagementRequest {
  return {
    method: "GET",
    path: `${eventHubNamespacePath(ns)}/authorizationRules`,
    apiVersion: EVENTHUB_ARM_API_VERSION,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the namespace rules list. A 200 with no rules, or a body without a
 * `value` array, is `empty` - an unverified nothing, never a measured zero,
 * because an RBAC-filtered list and a truly empty one are the same bytes.
 * Items without a name are dropped. `nextLink` is not followed: a namespace
 * holds at most a handful of rules.
 */
export function parseNamespaceAuthRules(body: unknown): Listing<NamespaceAuthRule> {
  const value = isRecord(body) ? body["value"] : undefined;
  const items = Array.isArray(value) ? value : [];
  const rules: NamespaceAuthRule[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const name = item["name"];
    if (typeof name !== "string" || name === "") continue;
    const id = typeof item["id"] === "string" ? item["id"] : "";
    const props = isRecord(item["properties"]) ? item["properties"] : {};
    const rightsRaw = props["rights"];
    const rights = Array.isArray(rightsRaw)
      ? rightsRaw.filter((r): r is string => typeof r === "string")
      : [];
    rules.push({ name, id, rights });
  }
  return toListing(rules);
}

/**
 * True when a rule with these rights can SEND events. Manage implies Send in
 * Azure (a Manage rule must also carry Send and Listen), so either qualifies.
 * A Listen-only rule is the trap this guards: the Defender PUT and its
 * read-back both succeed with one, and nothing is ever delivered.
 */
export function ruleCanSend(rights: readonly string[]): boolean {
  return rights.some((r) => {
    const lower = r.toLowerCase();
    return lower === "send" || lower === "manage";
  });
}

/**
 * True when a rule with these rights can LISTEN (read events). Manage implies
 * Listen in Azure, so either qualifies. This is the right a Cribl Event Hub
 * SOURCE needs; a Send-only rule - the one the Defender export writes with -
 * authenticates and then reads nothing, so it must be refused before a write.
 */
export function ruleCanListen(rights: readonly string[]): boolean {
  return rights.some((r) => {
    const lower = r.toLowerCase();
    return lower === "listen" || lower === "manage";
  });
}

/** True when a rule with these rights can MANAGE the namespace. */
export function ruleCanManage(rights: readonly string[]): boolean {
  return rights.some((r) => r.toLowerCase() === "manage");
}

/**
 * True when a rule's key may be handed to a Cribl Event Hub SOURCE (AZR-58):
 * it can Listen and it can NOT Manage. A Manage key stored as a Cribl secret
 * is control of the whole namespace - reconfigure, delete, mint keys - for
 * anyone who can read secrets in the worker group, where the source only ever
 * needs to read. Listen-and-Send is allowed. Reasoning: backlog.md 6h-i.
 */
export function ruleSafeForCriblSource(rights: readonly string[]): boolean {
  return ruleCanListen(rights) && !ruleCanManage(rights);
}

/**
 * The name Azure gives the Manage rule it creates on every namespace. Used to
 * refuse a pasted key by NAME when the rules themselves could not be read.
 */
export const ROOT_MANAGE_RULE_NAME = "RootManageSharedAccessKey";

/**
 * Whether a namespace of this SKU speaks the Kafka protocol Cribl's Event Hub
 * source reads with. Basic does not; Standard and Premium do (and Dedicated,
 * which is Premium-class). `null` when the SKU is empty or not one of those:
 * an unknown SKU is never guessed either way, and callers treat it as unknown.
 */
export function namespaceSupportsKafka(sku: string): boolean | null {
  const lower = sku.trim().toLowerCase();
  if (lower === "basic") return false;
  if (lower === "standard" || lower === "premium" || lower === "dedicated") return true;
  return null;
}

/**
 * POST listKeys on a NAMESPACE rule. Returns a SAS key - callers fetch it only
 * after the operator's confirm, and never probe it as a permission check.
 */
export function buildNamespaceListKeysRequest(
  ns: NamespaceRef,
  ruleName: string,
): AzureManagementRequest {
  return {
    method: "POST",
    path: `${eventHubNamespacePath(ns)}/authorizationRules/${ruleName}/listKeys`,
    apiVersion: EVENTHUB_ARM_API_VERSION,
  };
}

/**
 * The primary connection string out of a listKeys response. Throws when it is
 * missing or empty, with a fixed message that names only the missing field:
 * the body is never echoed, because whatever it does hold may be a key.
 */
export function parseListKeys(body: unknown): string {
  const value = isRecord(body) ? body["primaryConnectionString"] : undefined;
  if (typeof value !== "string" || value === "") {
    throw new Error(
      "The Event Hub listKeys response did not include primaryConnectionString.",
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Resource-id parsing (the paste-an-id path and the Defender action target)
// ---------------------------------------------------------------------------

/**
 * Split an id into its non-empty segments when it is an Event Hub namespace id
 * or a child of one, else null. Keys and the provider are matched
 * case-insensitively; values are returned verbatim.
 */
function namespaceSegments(id: string): string[] | null {
  const segments = id.trim().split("/").filter((s) => s !== "");
  if (segments.length < 8) return null;
  const lower = segments.map((s) => s.toLowerCase());
  if (
    lower[0] !== "subscriptions" ||
    lower[2] !== "resourcegroups" ||
    lower[4] !== "providers" ||
    lower[5] !== "microsoft.eventhub" ||
    lower[6] !== "namespaces"
  ) {
    return null;
  }
  return segments;
}

/**
 * Parse an Event Hub NAMESPACE id. Returns null for anything else - including
 * a hub id, so a pasted hub id is never silently treated as its namespace.
 */
export function parseNamespaceResourceId(id: string): NamespaceRef | null {
  const segments = namespaceSegments(id);
  if (segments === null || segments.length !== 8) return null;
  return { subscriptionId: segments[1], resourceGroup: segments[3], name: segments[7] };
}

/** Parse an Event Hub HUB id into its namespace and hub name, else null. */
export function parseEventHubResourceId(
  id: string,
): { namespace: NamespaceRef; hubName: string } | null {
  const segments = namespaceSegments(id);
  if (segments === null || segments.length !== 10) return null;
  if (segments[8].toLowerCase() !== "eventhubs") return null;
  return {
    namespace: {
      subscriptionId: segments[1],
      resourceGroup: segments[3],
      name: segments[7],
    },
    hubName: segments[9],
  };
}

/**
 * The built-in role that qualifies a Cribl principal to READ a hub through
 * Entra ID (AZR-59, ADR 0008). Keyed by role definition GUID, which is what a
 * role assignment carries. Verified on Microsoft Learn
 * (built-in-roles/analytics) 2026-11-03: Data Receiver grants the Event Hubs
 * receive data action and nothing else of note.
 */
export const EVENT_HUB_RECEIVER_ROLES: readonly { readonly guid: string; readonly roleName: string }[] = [
  { guid: "a638d3c7-ab3a-418d-83e6-5f17a39d4fde", roleName: "Azure Event Hubs Data Receiver" },
];

/**
 * Roles that can receive but are REFUSED for a Cribl principal. Data Owner
 * carries Microsoft.EventHub/* in actions and dataActions, which includes
 * control-plane listKeys on every authorization rule: a principal holding it
 * can read RootManageSharedAccessKey, so its secret in a Cribl secret is the
 * Manage-key exposure AZR-58 closed, reopened (ADR 0008 section 4).
 */
export const EVENT_HUB_OVERPRIVILEGED_ROLES: readonly { readonly guid: string; readonly roleName: string }[] = [
  { guid: "f526a384-b230-433a-b45c-95f59c4a2dec", roleName: "Azure Event Hubs Data Owner" },
];

function normScope(scope: string): string {
  const s = scope.trim().toLowerCase().replace(/\/+$/, "");
  return s === "" ? "/" : s;
}

/**
 * Whether an assignment at `scope` applies to `target`: the same scope, an
 * ARM ancestor of it (at a path-segment boundary, so `.../eventhubs/h10` never
 * covers `.../eventhubs/h1`), the root, or a management group. A management
 * group is not a string prefix of a subscription path, but an assignedTo()
 * read at `target` only returns management-group grants that apply above it.
 */
function scopeCovers(scope: string, target: string): boolean {
  const s = normScope(scope);
  const t = normScope(target);
  if (s === "/" || s === t) return true;
  if (s.startsWith("/providers/microsoft.management/managementgroups/")) return true;
  return t.startsWith(`${s}/`);
}

function roleCovering(
  rows: readonly unknown[],
  targetScope: string,
  roles: readonly { readonly guid: string; readonly roleName: string }[],
): { readonly roleName: string; readonly scope: string } | null {
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const props = (row as { properties?: unknown }).properties;
    if (typeof props !== "object" || props === null) continue;
    const roleId = (props as { roleDefinitionId?: unknown }).roleDefinitionId;
    const scope = (props as { scope?: unknown }).scope;
    if (typeof roleId !== "string" || typeof scope !== "string") continue;
    const role = roles.find((r) => roleId.toLowerCase().endsWith(r.guid));
    if (role !== undefined && scopeCovers(scope, targetScope)) return { roleName: role.roleName, scope };
  }
  return null;
}

/**
 * The first role assignment in `rows` (a roleAssignments listing) that holds
 * Data Receiver at, or above, `targetScope`; null when none does. Data Owner
 * never counts (overprivilegedRoleCovering). A grant on a DIFFERENT hub, or
 * below the target, never counts. Rows that are not role assignments are
 * skipped. Pure: the caller decides what a refused or incomplete read means
 * (unknown, never absent).
 */
export function receiverRoleCovering(
  rows: readonly unknown[],
  targetScope: string,
): { readonly roleName: string; readonly scope: string } | null {
  return roleCovering(rows, targetScope, EVENT_HUB_RECEIVER_ROLES);
}

/**
 * The first assignment in `rows` of a role that can receive but is refused for
 * a Cribl principal (Data Owner) at, or above, `targetScope`; null when none.
 */
export function overprivilegedRoleCovering(
  rows: readonly unknown[],
  targetScope: string,
): { readonly roleName: string; readonly scope: string } | null {
  return roleCovering(rows, targetScope, EVENT_HUB_OVERPRIVILEGED_ROLES);
}
