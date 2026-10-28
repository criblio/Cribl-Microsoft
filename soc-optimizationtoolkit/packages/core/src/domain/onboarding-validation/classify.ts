/**
 * Validate classifiers - WHAT A READ MAY BE SAID TO MEAN.
 *
 * Each check's GETs (requests.ts) come back as the EXISTING verdict shape of
 * the logging map, {@link ListRead}: `read` with its rows (a single resource
 * is one row - `readSingle`) or `refused` with why. No new read type is
 * defined; the usecase reads with `readAllPages` / `readSingle` and hands the
 * results here in request order.
 *
 * THE HONESTY RULES (claude-kit standards/inventory-honesty.md):
 *   - a refused read is UNKNOWN, with its reason - never absent:
 *       401 / 403                          denied
 *       MissingSubscriptionRegistration    unregistered
 *       transport error, 5xx, odd body     failed
 *       too many pages                     truncated
 *   - `absent` is returned ONLY for a GET-by-name 404, or for a COMPLETE
 *     listing that does not hold the item. A 404 on a LIST (its parent is
 *     gone) is unknown: the parent's own check says absent.
 *   - a plan value the request needs is blank: unknown `missing-value`.
 *
 * ARRIVAL IS NOT A VERDICT. {@link classifyArrival} returns an
 * {@link ArrivalReading}: a measured total (0 is a REAL zero, "no messages in
 * the window") or unknown. It never says absent. {@link classifyHubArrival}
 * adds `no-hub`, and only from a COMPLETE hub listing without the hub.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import {
  namespaceSupportsKafka,
  parseNamespaceAuthRules,
  eventHubNamespacePath,
  ruleCanListen,
  ruleCanManage,
  ruleCanSend,
} from "../eventhub-arm/eventhub-arm";
import {
  classifyExportForPlan,
  expectedExportFor,
  parseAutomations,
} from "../defender-export/defender-automation";
import { STANDARD_TIER } from "../defender-export/defender-plans";
import { DEFAULT_SETTING_NAME } from "../entra-diagnostics/entra-diagnostic-setting";
import { listingRows } from "../inventory-listing/inventory-listing";
import {
  readRows,
  toListingFromRead,
  type ListRead,
  type Refusal,
} from "../logging-map/list-read";
import type {
  ArrivalReading,
  CheckKind,
  StepVerdict,
  UnknownReason,
  VerdictDiff,
} from "../onboarding-howto/check-kinds";
import {
  PLAN_VALUE_LABELS,
  missingValues,
  type PlanValues,
} from "../onboarding-howto/plan-values";
import {
  CHECK_REQUIRED_VALUES,
  DEFAULT_ARRIVAL_WINDOW,
  STORAGE_READER_ROLES,
  planNamespace,
  planStorageAccountId,
  type CheckExpectations,
} from "./requests";

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rec(value: unknown, key: string): Record<string, unknown> {
  const inner = isRecord(value) ? value[key] : undefined;
  return isRecord(inner) ? inner : {};
}

function str(value: unknown, key: string): string {
  const inner = isRecord(value) ? value[key] : undefined;
  return typeof inner === "string" ? inner : "";
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Azure regions arrive as "East US" or "eastus"; compare them as one. */
function sameRegion(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  return norm(a) === norm(b);
}

function lastSegment(id: string): string {
  const parts = id.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? "";
}

function value(values: PlanValues, key: keyof PlanValues): string {
  return (values[key] ?? "").trim();
}

function verdictOf(diffs: readonly VerdictDiff[]): StepVerdict {
  return diffs.length === 0 ? { kind: "as-expected" } : { kind: "present-differs", diffs };
}

/**
 * present-other-name for `name`, one of `matches` objects that matched the
 * same way; the rest are counted in `alsoFound` (DBT-178).
 */
function otherName(name: string, diffs: readonly VerdictDiff[], matches: number): StepVerdict {
  return matches > 1
    ? { kind: "present-other-name", name, diffs, alsoFound: matches - 1 }
    : { kind: "present-other-name", name, diffs };
}

function unknown(reason: UnknownReason, detail: string): StepVerdict {
  return { kind: "unknown", reason, detail };
}

function regionDiff(values: PlanValues, location: string): VerdictDiff[] {
  const planned = value(values, "region");
  if (planned === "" || location === "" || sameRegion(planned, location)) return [];
  return [{ field: "region", expected: planned, actual: location }];
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** The kinds read with a GET BY NAME - the only ones a 404 may call absent. */
export const GET_BY_NAME_KINDS: ReadonlySet<CheckKind> = new Set<CheckKind>([
  "eh-namespace",
  "eh-consumer-group",
  "defender-provider",
  "policy-set-definition",
  "network-watcher",
  "flow-log",
  "storage-account",
  "storage-container",
  "storage-queue",
  "eventgrid-topic",
]);

/**
 * The Network Watcher is looked for in Azure's own NetworkWatcherRG, which the
 * plan does not name. When THAT group or the watcher in it is missing, the
 * 404 says nothing about the operator's watcher - unknown, not absent.
 */
const ASSUMED_PARENT_KINDS: ReadonlySet<CheckKind> = new Set<CheckKind>([
  "network-watcher",
  "flow-log",
]);

const PARENT_MISSING_CODES = /^(ResourceGroupNotFound|ParentResourceNotFound)$/i;

const UNREGISTERED_CODES = /^(MissingSubscriptionRegistration|SubscriptionNotRegistered)$/i;

/** Why a refused read could not answer, in the check vocabulary. */
export function refusalReason(refusal: Refusal): UnknownReason {
  switch (refusal.reason) {
    case "transport":
    case "unexpected-shape":
      return "failed";
    case "too-many-pages":
      return "truncated";
    case "http":
      if (UNREGISTERED_CODES.test(refusal.code)) return "unregistered";
      if (refusal.status === 401 || refusal.status === 403) return "denied";
      return "failed";
  }
}

function refusalVerdict(kind: CheckKind, refusal: Refusal): StepVerdict {
  if (
    refusal.reason === "http" &&
    refusal.status === 404 &&
    !UNREGISTERED_CODES.test(refusal.code) &&
    GET_BY_NAME_KINDS.has(kind)
  ) {
    if (ASSUMED_PARENT_KINDS.has(kind) && PARENT_MISSING_CODES.test(refusal.code)) {
      return unknown(
        "failed",
        `Looked in NetworkWatcherRG, which does not hold it (${refusal.code}); the watcher may be in another resource group.`,
      );
    }
    return { kind: "absent" };
  }
  return unknown(refusalReason(refusal), refusal.text);
}

// ---------------------------------------------------------------------------
// Per-kind classifiers over completed reads
// ---------------------------------------------------------------------------

/** The hub names of a COMPLETE hub listing, or null when it was not read. */
export function measuredHubNames(read: ListRead<unknown>): readonly string[] | null {
  if (read.state !== "read") return null;
  return read.rows.map((row) => str(row, "name")).filter((n) => n !== "");
}

function classifyNamespace(values: PlanValues, row: unknown): StepVerdict {
  const sku = str(rec(row, "sku"), "name");
  const kafka = namespaceSupportsKafka(sku);
  if (kafka === null) {
    return unknown(
      "failed",
      sku === ""
        ? "The namespace was read, but Azure did not report its SKU."
        : `The namespace's SKU ${sku} is not one this app knows.`,
    );
  }
  const diffs: VerdictDiff[] = [];
  if (!kafka) {
    diffs.push({ field: "sku", expected: "Standard or Premium (Kafka)", actual: sku });
  }
  diffs.push(...regionDiff(values, str(row, "location")));
  return verdictOf(diffs);
}

function classifyHubs(
  values: PlanValues,
  read: ListRead<unknown>,
  ex: CheckExpectations,
): StepVerdict {
  const names = (measuredHubNames(read) ?? []).map((n) => n.toLowerCase());
  const has = (hub: string) => names.includes(hub.trim().toLowerCase());
  const expected =
    ex.expectedHubs !== undefined && ex.expectedHubs.length > 0
      ? ex.expectedHubs
      : value(values, "hubName") !== "" && ex.expectedHubPrefix === undefined
        ? [value(values, "hubName")]
        : [];
  if (expected.length > 0) {
    const missing = expected.filter((h) => !has(h));
    if (missing.length === 0) return { kind: "as-expected" };
    if (missing.length === expected.length) return { kind: "absent" };
    return {
      kind: "present-differs",
      diffs: [{ field: "hubs", expected: expected.join(", "), actual: `missing ${missing.join(", ")}` }],
    };
  }
  if (ex.expectedHubPrefix !== undefined) {
    const prefix = ex.expectedHubPrefix.toLowerCase();
    return names.some((n) => n.startsWith(prefix)) ? { kind: "as-expected" } : { kind: "absent" };
  }
  return unknown("missing-value", "No hub is named for this source, so there is nothing to look for.");
}

function classifyRule(
  read: ListRead<unknown>,
  ruleName: string,
  can: (rights: readonly string[]) => boolean,
  needs: string,
): StepVerdict {
  const rows = read.state === "read" ? read.rows : [];
  const rules = listingRows(parseNamespaceAuthRules({ value: rows }));
  const rule = rules.find((r) => same(r.name, ruleName));
  if (rule === undefined) {
    // A row the parser dropped may BE the rule: the listing was read but not
    // shown to lack it, so it is unknown, never absent.
    const dropped = rows.length - rules.length;
    return dropped > 0 ? unparsedRows(dropped, "authorization rule") : { kind: "absent" };
  }
  if (can(rule.rights)) return { kind: "as-expected" };
  return {
    kind: "present-differs",
    diffs: [
      {
        field: "rights",
        expected: needs,
        actual: rule.rights.length === 0 ? "(none)" : rule.rights.join(", "),
      },
    ],
  };
}

/** A completed read some of whose rows could not be parsed, with no match among the rest. */
function unparsedRows(dropped: number, what: string): StepVerdict {
  return unknown(
    "failed",
    `${dropped} ${what} ${dropped === 1 ? "row" : "rows"} could not be read, so the listing does not show it is missing.`,
  );
}

function classifyConsumerGroup(values: PlanValues): StepVerdict {
  const group = value(values, "consumerGroup");
  if (same(group, "$Default")) {
    return {
      kind: "present-differs",
      diffs: [
        {
          field: "consumerGroup",
          expected: "a dedicated consumer group",
          actual: "$Default, which other readers share",
        },
      ],
    };
  }
  return { kind: "as-expected" };
}

function classifyPlans(rows: readonly unknown[]): StepVerdict {
  if (rows.length === 0) {
    return unknown("failed", "Azure returned no Defender plans, which a readable subscription always has.");
  }
  const standard = rows.some((r) => same(str(rec(r, "properties"), "pricingTier"), STANDARD_TIER));
  return standard
    ? { kind: "as-expected" }
    : {
        kind: "present-differs",
        diffs: [
          { field: "pricingTier", expected: "Standard on at least one plan", actual: "Free on every plan" },
        ],
      };
}

function classifyProvider(row: unknown): StepVerdict {
  const state = str(row, "registrationState");
  if (state === "") return unknown("failed", "The provider was read, but its registration state was not reported.");
  return same(state, "Registered")
    ? { kind: "as-expected" }
    : { kind: "present-differs", diffs: [{ field: "registrationState", expected: "Registered", actual: state }] };
}

/** One diagnostic setting, as Validate reads it. */
interface DiagnosticSetting {
  readonly name: string;
  readonly ruleId: string;
  readonly hub: string;
  readonly enabled: readonly string[];
}

function parseSettings(rows: readonly unknown[]): DiagnosticSetting[] {
  return rows.map((row) => {
    const props = rec(row, "properties");
    const logs = Array.isArray(props["logs"]) ? props["logs"] : [];
    return {
      name: str(row, "name"),
      ruleId: str(props, "eventHubAuthorizationRuleId"),
      hub: str(props, "eventHubName"),
      enabled: logs
        .filter((l) => isRecord(l) && l["enabled"] === true)
        .map((l) => str(l, "category") || str(l, "categoryGroup"))
        .filter((c) => c !== ""),
    };
  });
}

function settingDiffs(
  values: PlanValues,
  setting: DiagnosticSetting,
  expectedCategories: readonly string[],
  autoHubText: string,
): VerdictDiff[] {
  const diffs: VerdictDiff[] = [];
  const nsPath = eventHubNamespacePath(planNamespace(values));
  const sendRule = value(values, "sendRule");
  const expectedRule = sendRule === "" ? `${nsPath}/authorizationRules/...` : `${nsPath}/authorizationRules/${sendRule}`;
  const targetsNs = setting.ruleId.toLowerCase().startsWith(`${nsPath.toLowerCase()}/`);
  const ruleOk = targetsNs && (sendRule === "" || same(lastSegment(setting.ruleId), sendRule));
  if (!ruleOk) {
    diffs.push({ field: "eventHubAuthorizationRuleId", expected: expectedRule, actual: setting.ruleId || "(none)" });
  }
  if (setting.hub !== "") {
    diffs.push({ field: "eventHubName", expected: autoHubText, actual: setting.hub });
  }
  if (expectedCategories.length > 0) {
    const off = expectedCategories.filter((c) => !setting.enabled.some((e) => same(e, c)));
    if (off.length > 0) {
      diffs.push({ field: "logs", expected: expectedCategories.join(", "), actual: `not enabled: ${off.join(", ")}` });
    }
  } else if (setting.enabled.length === 0) {
    diffs.push({ field: "logs", expected: "at least one category enabled", actual: "none enabled" });
  }
  return diffs;
}

function targetsPlanNamespace(values: PlanValues, setting: DiagnosticSetting): boolean {
  const nsPath = eventHubNamespacePath(planNamespace(values)).toLowerCase();
  return setting.ruleId.toLowerCase().startsWith(`${nsPath}/`);
}

function classifyEntra(values: PlanValues, rows: readonly unknown[], ex: CheckExpectations): StepVerdict {
  const settings = parseSettings(rows);
  const categories = ex.entraCategories ?? [];
  const autoHub = "(none: Azure creates one hub per category)";
  const ours = settings.find((s) => same(s.name, DEFAULT_SETTING_NAME));
  if (ours !== undefined) return verdictOf(settingDiffs(values, ours, categories, autoHub));
  const others = settings.filter((s) => targetsPlanNamespace(values, s));
  const other = others[0];
  if (other !== undefined) {
    return otherName(other.name, settingDiffs(values, other, categories, autoHub), others.length);
  }
  return { kind: "absent" };
}

function classifyActivityLog(values: PlanValues, rows: readonly unknown[]): StepVerdict {
  // No name is prescribed for the subscription setting: the one that sends to
  // the plan's namespace IS the plan's, whatever it is called.
  const setting = parseSettings(rows).find((s) => targetsPlanNamespace(values, s));
  if (setting === undefined) return { kind: "absent" };
  return verdictOf(settingDiffs(values, setting, [], "(none: Azure writes to insights-activity-logs)"));
}

function assignmentDiffs(row: unknown, definitionId: string): VerdictDiff[] {
  const props = rec(row, "properties");
  const diffs: VerdictDiff[] = [];
  const actualDef = str(props, "policyDefinitionId");
  if (!same(actualDef, definitionId)) {
    diffs.push({ field: "policyDefinitionId", expected: definitionId, actual: actualDef || "(none)" });
  }
  const identity = str(rec(row, "identity"), "type");
  if (identity === "" || same(identity, "None")) {
    diffs.push({
      field: "identity",
      expected: "a managed identity (the initiative deploys settings)",
      actual: identity || "(none)",
    });
  }
  const mode = str(props, "enforcementMode");
  if (mode !== "" && !same(mode, "Default")) {
    diffs.push({ field: "enforcementMode", expected: "Default", actual: mode });
  }
  return diffs;
}

function classifyAssignment(rows: readonly unknown[], ex: CheckExpectations): StepVerdict {
  const policy = ex.policy;
  if (policy === undefined) return unknown("missing-value", "No initiative is expected for this source.");
  const named = (r: unknown) => policy.assignmentName !== null && same(str(r, "name"), policy.assignmentName);
  const usesDefinition = (r: unknown) =>
    same(str(rec(r, "properties"), "policyDefinitionId"), policy.definitionId);
  const inFamily = (r: unknown) => policy.assignmentFamily.test(str(r, "name"));

  const exact = rows.find(named);
  if (exact !== undefined) return verdictOf(assignmentDiffs(exact, policy.definitionId));
  if (policy.assignmentName === null) {
    const ours = rows.find((r) => usesDefinition(r) && inFamily(r)) ?? rows.find(usesDefinition);
    if (ours !== undefined) return verdictOf(assignmentDiffs(ours, policy.definitionId));
  }
  const others = rows.filter((r) => usesDefinition(r) || inFamily(r));
  const other = others[0];
  if (other !== undefined) {
    return otherName(str(other, "name"), assignmentDiffs(other, policy.definitionId), others.length);
  }
  return { kind: "absent" };
}

/**
 * The custom definitions the steps save at the management group, from a
 * COMPLETE listing of them (readAllPages refuses a truncated one, which is
 * unknown before this runs). Matched on the full id, so a same-named
 * definition at another scope the listing returns is not the plan's. Every
 * one present is as-expected; none is absent; some is present-differs naming
 * the missing. A row without an id may BE a missing one: unknown, never absent.
 */
function classifyDefinitions(rows: readonly unknown[], ex: CheckExpectations): StepVerdict {
  const expected = ex.policyDefinitions ?? [];
  const ids = rows.map((r) => str(r, "id")).filter((id) => id !== "");
  const missing = expected.filter((e) => !ids.some((id) => same(id, e)));
  if (missing.length === 0) return { kind: "as-expected" };
  const dropped = rows.length - ids.length;
  if (dropped > 0) return unparsedRows(dropped, "policy definition");
  if (missing.length === expected.length) return { kind: "absent" };
  return {
    kind: "present-differs",
    diffs: [
      {
        field: "definitions",
        expected: `${expected.length} definitions`,
        actual: `missing ${missing.map(lastSegment).join(", ")}`,
      },
    ],
  };
}

/** The provisioningState diffs of a set of remediations: none when one Succeeded. */
function remediationDiffs(matches: readonly unknown[]): VerdictDiff[] {
  const states = matches.map((r) => str(rec(r, "properties"), "provisioningState"));
  if (states.some((s) => same(s, "Succeeded"))) return [];
  return [{ field: "provisioningState", expected: "Succeeded", actual: states.join(", ") || "(none)" }];
}

/**
 * Remediations of the plan's assignment. With an assignment name instructed,
 * only that exact name is the plan's; a legacy-family assignment is another
 * one, present-other-name - the same call classifyAssignment makes of it
 * (DBT-166). With no name instructed, the family is the plan's.
 */
function classifyRemediation(rows: readonly unknown[], ex: CheckExpectations): StepVerdict {
  const policy = ex.policy;
  if (policy === undefined) return unknown("missing-value", "No initiative is expected for this source.");
  const assignmentOf = (r: unknown) => lastSegment(str(rec(r, "properties"), "policyAssignmentId"));
  const inFamily = (r: unknown) => policy.assignmentFamily.test(assignmentOf(r));
  const instructed = policy.assignmentName;
  const ours =
    instructed !== null ? rows.filter((r) => same(assignmentOf(r), instructed)) : rows.filter(inFamily);
  if (ours.length > 0) return verdictOf(remediationDiffs(ours));
  if (instructed === null) return { kind: "absent" };
  const other = rows.filter(inFamily);
  const first = other[0];
  if (first === undefined) return { kind: "absent" };
  const name = assignmentOf(first);
  // Counted by assignment, not by remediation: one assignment may have several.
  const assignments = new Set(other.map((r) => assignmentOf(r).toLowerCase()));
  return otherName(name, remediationDiffs(other.filter((r) => same(assignmentOf(r), name))), assignments.size);
}

function classifyFlowLog(values: PlanValues, row: unknown): StepVerdict {
  const props = rec(row, "properties");
  const diffs: VerdictDiff[] = [];
  if (props["enabled"] !== true) {
    diffs.push({ field: "enabled", expected: "true", actual: String(props["enabled"] ?? "(not set)") });
  }
  if (value(values, "storageAccount") !== "" && value(values, "resourceGroup") !== "") {
    const expected = planStorageAccountId(values);
    const actual = str(props, "storageId");
    if (!same(actual, expected)) {
      diffs.push({ field: "storageId", expected, actual: actual || "(none)" });
    }
  }
  const version = rec(props, "format")["version"];
  if (version !== 2) {
    diffs.push({ field: "format.version", expected: "2", actual: String(version ?? "(not set)") });
  }
  diffs.push(...regionDiff(values, str(row, "location")));
  return verdictOf(diffs);
}

/**
 * The system topic is the plan's only if its source is the plan's storage
 * account, so without one it cannot be as-expected. classifyCheck already
 * stops on the missing value (CHECK_REQUIRED_VALUES); this guard holds even
 * if that list drifts (DBT-167). Exported for that pin only, not the barrel.
 */
export function classifyTopic(values: PlanValues, row: unknown): StepVerdict {
  if (value(values, "storageAccount") === "") {
    return unknown("missing-value", `Set ${PLAN_VALUE_LABELS.storageAccount.label} first.`);
  }
  const props = rec(row, "properties");
  const diffs: VerdictDiff[] = [];
  const expected = planStorageAccountId(values);
  const actual = str(props, "source");
  if (!same(actual, expected)) diffs.push({ field: "source", expected, actual: actual || "(none)" });
  const topicType = str(props, "topicType");
  if (topicType !== "" && !same(topicType, "Microsoft.Storage.StorageAccounts")) {
    diffs.push({ field: "topicType", expected: "Microsoft.Storage.StorageAccounts", actual: topicType });
  }
  return verdictOf(diffs);
}

const BLOB_CREATED = "Microsoft.Storage.BlobCreated";

/** A storage account's ARM id: the only topic id that names an account. */
const STORAGE_ACCOUNT_ID = /\/providers\/Microsoft\.Storage\/storageAccounts\/[^/]+$/i;

/** The storage account a StorageQueue destination delivers to, '' when unsaid. */
function queueAccountOf(row: unknown): string {
  return str(rec(rec(rec(row, "properties"), "destination"), "properties"), "resourceId");
}

/**
 * The plan's BlobCreated subscription to its queue. A queue name is not
 * enough: the subscription is the plan's only if its queue is on the plan's
 * storage account and its topic is that account's (DBT-179, the shape DBT-167
 * fixed for the topic). A definite difference is reported as one; a read that
 * does not say the account (no destination resourceId, or a topic id that is
 * not a storage account's) is unknown, never as-expected. Without a storage
 * account in the plan it cannot be as-expected: classifyCheck already stops
 * on the missing value, and this guard holds if CHECK_REQUIRED_VALUES drifts.
 * Exported for that pin only, not the barrel.
 */
export function classifyEventSubscription(values: PlanValues, rows: readonly unknown[]): StepVerdict {
  if (value(values, "storageAccount") === "") {
    return unknown("missing-value", `Set ${PLAN_VALUE_LABELS.storageAccount.label} first.`);
  }
  const queue = value(values, "queueName");
  const accountId = planStorageAccountId(values);
  const candidates = rows.filter((r) => {
    const dest = rec(rec(r, "properties"), "destination");
    return same(str(dest, "endpointType"), "StorageQueue") && same(str(rec(dest, "properties"), "queueName"), queue);
  });
  // Several may share the queue name: the one on the plan's account is the plan's.
  const match = candidates.find((r) => same(queueAccountOf(r), accountId)) ?? candidates[0];
  if (match === undefined) return { kind: "absent" };
  const props = rec(match, "properties");
  const diffs: VerdictDiff[] = [];
  const queueAccount = queueAccountOf(match);
  if (queueAccount !== "" && !same(queueAccount, accountId)) {
    diffs.push({ field: "destination.resourceId", expected: accountId, actual: queueAccount });
  }
  const topic = str(props, "topic").trim();
  const topicNamesAccount = STORAGE_ACCOUNT_ID.test(topic);
  if (topicNamesAccount && !same(topic, accountId)) {
    diffs.push({ field: "topic", expected: accountId, actual: topic });
  }
  const types = rec(props, "filter")["includedEventTypes"];
  // No includedEventTypes means every event type, BlobCreated among them.
  if (Array.isArray(types) && !types.some((t) => typeof t === "string" && same(t, BLOB_CREATED))) {
    diffs.push({ field: "includedEventTypes", expected: BLOB_CREATED, actual: types.join(", ") });
  }
  // A definite difference is true whatever the read leaves unsaid.
  if (diffs.length > 0) return { kind: "present-differs", diffs };
  if (queueAccount === "") {
    return unknown(
      "failed",
      "The event subscription was read, but Azure did not report which storage account its queue is on.",
    );
  }
  if (!topicNamesAccount) {
    return unknown(
      "failed",
      "The event subscription was read, but its topic does not say which storage account it belongs to.",
    );
  }
  return { kind: "as-expected" };
}

function classifyStorageRbac(rows: readonly unknown[]): StepVerdict {
  const roleIds = rows.map((r) => str(rec(r, "properties"), "roleDefinitionId").toLowerCase());
  const held = STORAGE_READER_ROLES.filter((role) => roleIds.some((id) => id.endsWith(role.guid)));
  if (held.length === STORAGE_READER_ROLES.length) return { kind: "as-expected" };
  if (held.length === 0) return { kind: "absent" };
  return {
    kind: "present-differs",
    diffs: [
      {
        field: "roles",
        expected: STORAGE_READER_ROLES.map((r) => r.roleName).join(", "),
        actual: held.map((r) => r.roleName).join(", "),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------

/** Evidence XDR streaming leaves, since its configuration cannot be read. */
export const XDR_UNMEASURABLE_DETAIL =
  "Defender XDR streaming is configured in the Microsoft Defender portal, which Azure Resource Manager " +
  "cannot read. Indirect evidence only: whether its Event Hub exists and receives messages (the hub and " +
  "arrival lines of this source).";

/** Why the policy identity's roles are not fully checked. */
export const POLICY_IDENTITY_ROLES_DETAIL =
  "The initiative's managed identity is only known once its assignment is read, and its grants span the " +
  "management group and the namespace; this check does not follow that chain. Confirm in the portal that " +
  "the assignment's identity holds Monitoring Contributor at the management group and Azure Event Hubs " +
  "Data Owner on the namespace.";

/**
 * What one check concludes from its reads. `reads` are in the order
 * `requestsFor` returned the requests. A missing plan value is
 * unknown `missing-value`; the first refused read decides the verdict (see
 * the module header); otherwise the per-kind rules apply.
 */
export function classifyCheck(
  kind: CheckKind,
  values: PlanValues,
  reads: readonly ListRead<unknown>[],
  expectations: CheckExpectations = {},
): StepVerdict {
  const missing = missingValues(values, CHECK_REQUIRED_VALUES[kind]);
  if (missing.length > 0) {
    return unknown("missing-value", `Set ${missing.map((k) => PLAN_VALUE_LABELS[k].label).join(", ")} first.`);
  }
  if (kind === "xdr-streaming") return unknown("unmeasurable", XDR_UNMEASURABLE_DETAIL);
  if (kind === "policy-identity-roles") return unknown("truncated", POLICY_IDENTITY_ROLES_DETAIL);
  if (kind === "policy-definition") {
    if ((expectations.policyDefinitions ?? []).length === 0) {
      return unknown("missing-value", "No policy definition is imported for this source.");
    }
  } else if (kind.startsWith("policy-") && expectations.policy === undefined) {
    return unknown("missing-value", "No initiative is expected for this source.");
  }

  const read = reads[0];
  if (read === undefined) return unknown("failed", "Nothing was read for this check.");
  const refused = reads.find((r) => r.state === "refused");
  if (refused !== undefined && refused.state === "refused") return refusalVerdict(kind, refused.refusal);
  if (read.state !== "read") return unknown("failed", "Nothing was read for this check.");
  const rows = read.rows;
  const row = rows[0];

  switch (kind) {
    case "eh-namespace":
      return classifyNamespace(values, row);
    case "eh-hub":
      return classifyHubs(values, read, expectations);
    case "eh-rule-send":
      return classifyRule(read, value(values, "sendRule"), ruleCanSend, "Send or Manage");
    case "eh-rule-listen":
      return classifyRule(read, value(values, "listenRule"), ruleCanListen, "Listen or Manage");
    case "eh-rule-manage":
      // The rule Azure creates hubs with: Send alone is a difference, not done.
      return classifyRule(read, value(values, "sendRule"), ruleCanManage, "Manage");
    case "eh-consumer-group":
      return classifyConsumerGroup(values);
    case "defender-plans":
      return classifyPlans(rows);
    case "defender-provider":
      return classifyProvider(row);
    case "defender-export": {
      const automations = listingRows(parseAutomations(rows));
      const verdict = classifyExportForPlan(
        toListingFromRead(readRows(automations)),
        expectedExportFor({
          subscriptionId: value(values, "subscriptionId"),
          namespace: planNamespace(values),
          hubName: value(values, "hubName"),
        }),
      );
      const dropped = rows.length - automations.length;
      return verdict.kind === "absent" && dropped > 0 ? unparsedRows(dropped, "automation") : verdict;
    }
    case "entra-setting":
      return classifyEntra(values, rows, expectations);
    case "activity-log-setting":
      return classifyActivityLog(values, rows);
    case "policy-assignment":
      return classifyAssignment(rows, expectations);
    case "policy-set-definition":
      return { kind: "as-expected" };
    case "policy-definition":
      return classifyDefinitions(rows, expectations);
    case "policy-remediation":
      return classifyRemediation(rows, expectations);
    case "network-watcher":
    case "storage-account":
      return verdictOf(regionDiff(values, str(row, "location")));
    case "flow-log":
      return classifyFlowLog(values, row);
    case "storage-container":
    case "storage-queue":
      return { kind: "as-expected" };
    case "eventgrid-topic":
      return classifyTopic(values, row);
    case "eventgrid-subscription":
      return classifyEventSubscription(values, rows);
    case "storage-rbac":
      return classifyStorageRbac(rows);
  }
}

/**
 * One hub's arrival reading from its IncomingMessages read. A refused read is
 * unknown with its reason (a 404 too: arrival is never absent). A read body is
 * parsed STRICTLY - unlike eventhub-discovery's tolerant sum, a body that does
 * not carry a number is unknown, never a zero: no `value[0].timeseries`
 * array, an EMPTY timeseries, a series without a `data` array, or no point
 * with a finite numeric `total`. A total of 0 is a MEASURED zero only when
 * at least one point reports it.
 */
export function classifyArrival(
  read: ListRead<unknown>,
  window: string = DEFAULT_ARRIVAL_WINDOW,
): ArrivalReading {
  if (read.state === "refused") {
    return { kind: "unknown", reason: refusalReason(read.refusal), detail: read.refusal.text };
  }
  const body = read.rows[0];
  const metrics = isRecord(body) ? body["value"] : undefined;
  const first = Array.isArray(metrics) ? metrics[0] : undefined;
  const timeseries = isRecord(first) ? first["timeseries"] : undefined;
  const shape = (detail: string): ArrivalReading => ({
    kind: "unknown",
    reason: "failed",
    detail: `Unexpected IncomingMessages answer: ${detail}`,
  });
  if (!Array.isArray(timeseries)) return shape("no value[0].timeseries array.");
  if (timeseries.length === 0) return shape("the timeseries list is empty.");
  let messages = 0;
  let reported = 0;
  for (const series of timeseries) {
    const points = isRecord(series) ? series["data"] : undefined;
    if (!Array.isArray(points)) return shape("a series has no data array.");
    for (const point of points) {
      const total = isRecord(point) ? point["total"] : undefined;
      if (typeof total === "number" && Number.isFinite(total)) {
        messages += total;
        reported += 1;
      }
    }
  }
  if (reported === 0) return shape("no data point carries a numeric total.");
  return { kind: "measured", messages, window };
}

/**
 * One hub's arrival reading, checked against the namespace's hub listing.
 * `listedHubs` is the hub names of a COMPLETE listing, or null when the
 * listing was denied, truncated, failed or not read. Azure Monitor answers an
 * IncomingMessages read for a hub that does not exist with a zero series, so
 * a complete listing without the hub (compared case-insensitively, as Event
 * Hubs names are) is `no-hub` whatever the metric said. Without a complete
 * listing the metric reading stands: absence is never inferred from a read
 * that did not finish.
 */
export function classifyHubArrival(
  hub: string,
  read: ListRead<unknown>,
  listedHubs: readonly string[] | null,
  window: string = DEFAULT_ARRIVAL_WINDOW,
): ArrivalReading {
  if (listedHubs !== null) {
    const wanted = hub.trim().toLowerCase();
    if (!listedHubs.some((name) => name.toLowerCase() === wanted)) return { kind: "no-hub" };
  }
  return classifyArrival(read, window);
}
