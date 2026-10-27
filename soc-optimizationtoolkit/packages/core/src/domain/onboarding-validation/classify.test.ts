// Pins for the Validate classifiers (AZR-32). The defects these guard against
// are silent: a denied read rendered as "not found", a truncated listing
// rendered as a verified absence, a Basic namespace (no Kafka) rendered as fine,
// and a measured zero arrival rendered the same as "could not measure".

import { describe, expect, it } from "vitest";

import { readRefused, readRows, type ListRead, type Refusal } from "../logging-map/list-read";
import { CHECK_KINDS, type CheckKind } from "../onboarding-howto/check-kinds";
import { defaultPlanValues, type PlanValues } from "../onboarding-howto/plan-values";
// The barrels, not the modules: Validate and the core root reach them there.
import { namespaceSupportsKafka, ruleCanListen } from "../eventhub-arm";
import { classifyExportForPlan, DEFENDER_EXPORT_NAME } from "../defender-export";
import { listSettingsRequest } from "../entra-diagnostics";
import {
  checkExpectationsFor,
  classifyArrival,
  classifyCheck,
  measuredHubNames,
  requestsFor,
  type CheckExpectations,
} from "./index";

const FULL: PlanValues = {
  ...defaultPlanValues({ subscriptionId: "sub-1", resourceGroup: "rg-1" }),
  managementGroupId: "mg-1",
  region: "eastus",
  namespace: "ns1",
  hubName: "defender-alerts",
  sendRule: "sender",
  listenRule: "reader",
  storageAccount: "flowlogsa",
  queueName: "flowlog-queue",
  systemTopic: "flowlogsa-events",
  networkWatcher: "NetworkWatcher_eastus",
  flowLogName: "vnet-flowlog",
  criblPrincipalObjectId: "00000000-0000-0000-0000-0000000000aa",
};
const NS_PATH = "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.EventHub/namespaces/ns1";
const AUDIT = checkExpectationsFor("diagnosticSettingsInitiative", FULL);

function refusal(over: Partial<Refusal> = {}): Refusal {
  return { request: "/x", status: 403, code: "AuthorizationFailed", text: "denied at /x", reason: "http", ...over };
}

const denied = readRefused<unknown>(refusal());
const one = (row: unknown): ListRead<unknown> => readRows([row]);

/** The kinds that make at least one request. */
const READING_KINDS = CHECK_KINDS.filter((k) => {
  const r = requestsFor(k, FULL, AUDIT);
  return r.kind === "requests" && r.requests.length > 0;
});

describe("refusals are unknown with their reason, never absent", () => {
  it("a 403 is unknown 'denied' for EVERY check kind that reads", () => {
    expect(READING_KINDS.length).toBe(CHECK_KINDS.length - 2);
    for (const kind of READING_KINDS) {
      expect(classifyCheck(kind, FULL, [denied], AUDIT), kind).toEqual({
        kind: "unknown",
        reason: "denied",
        detail: "denied at /x",
      });
    }
  });

  it("a 401 is denied too", () => {
    const v = classifyCheck("eh-hub", FULL, [readRefused(refusal({ status: 401 }))], AUDIT);
    expect(v.kind === "unknown" && v.reason).toBe("denied");
  });

  it("a too-many-pages refusal is truncated, for every list kind", () => {
    const truncated = readRefused<unknown>(refusal({ reason: "too-many-pages", status: null, code: "" }));
    for (const kind of READING_KINDS) {
      const v = classifyCheck(kind, FULL, [truncated], AUDIT);
      expect(v.kind === "unknown" && v.reason, kind).toBe("truncated");
    }
  });

  it("MissingSubscriptionRegistration is unregistered, even on a 404", () => {
    for (const status of [409, 404, 400]) {
      const v = classifyCheck(
        "defender-plans",
        FULL,
        [readRefused(refusal({ status, code: "MissingSubscriptionRegistration" }))],
        AUDIT,
      );
      expect(v.kind === "unknown" && v.reason).toBe("unregistered");
    }
  });

  it("a transport failure, a 5xx and an odd body are failed", () => {
    for (const r of [
      refusal({ reason: "transport", status: null, code: "" }),
      refusal({ status: 503, code: "" }),
      refusal({ reason: "unexpected-shape", status: 200, code: "" }),
    ]) {
      const v = classifyCheck("storage-account", FULL, [readRefused(r)], AUDIT);
      expect(v.kind === "unknown" && v.reason).toBe("failed");
    }
  });

  it("a 404 is absent ONLY for a GET by name; on a list it is unknown", () => {
    const notFound = readRefused<unknown>(refusal({ status: 404, code: "ResourceNotFound" }));
    expect(classifyCheck("eh-namespace", FULL, [notFound])).toEqual({ kind: "absent" });
    expect(classifyCheck("storage-queue", FULL, [notFound])).toEqual({ kind: "absent" });
    expect(classifyCheck("eh-hub", FULL, [notFound]).kind).toBe("unknown");
    expect(classifyCheck("defender-export", FULL, [notFound]).kind).toBe("unknown");
  });

  it("a missing NetworkWatcherRG is unknown, not an absent watcher", () => {
    const v = classifyCheck("network-watcher", FULL, [
      readRefused(refusal({ status: 404, code: "ResourceGroupNotFound" })),
    ]);
    expect(v.kind).toBe("unknown");
    expect(
      classifyCheck("network-watcher", FULL, [readRefused(refusal({ status: 404, code: "NotFound" }))]),
    ).toEqual({ kind: "absent" });
  });

  it("a refused SECOND read still decides the verdict", () => {
    const v = classifyCheck("eh-hub", FULL, [readRows([]), denied], AUDIT);
    expect(v.kind === "unknown" && v.reason).toBe("denied");
  });
});

describe("missing values", () => {
  it("a blank needed value is unknown 'missing-value' and names the field", () => {
    const v = classifyCheck("eh-namespace", { ...FULL, namespace: "" }, [one({})]);
    expect(v).toEqual({ kind: "unknown", reason: "missing-value", detail: "Set Event Hub namespace first." });
  });

  it("matches requestsFor: missing there is missing-value here, for every kind", () => {
    const blank = defaultPlanValues(null);
    for (const kind of CHECK_KINDS) {
      if (requestsFor(kind, blank, AUDIT).kind !== "missing") continue;
      const v = classifyCheck(kind, blank, [one({})], AUDIT);
      expect(v.kind === "unknown" && v.reason, kind).toBe("missing-value");
    }
  });

  it("a policy check with no expected initiative is missing-value", () => {
    const v = classifyCheck("policy-assignment", FULL, [readRows([])], {});
    expect(v.kind === "unknown" && v.reason).toBe("missing-value");
  });
});

describe("Event Hub checks", () => {
  it("a Basic namespace is present-differs on sku", () => {
    const v = classifyCheck("eh-namespace", FULL, [one({ sku: { name: "Basic" }, location: "eastus" })]);
    expect(v).toEqual({
      kind: "present-differs",
      diffs: [{ field: "sku", expected: "Standard or Premium (Kafka)", actual: "Basic" }],
    });
  });

  it("a Standard namespace in the planned region is as-expected; another region differs", () => {
    expect(classifyCheck("eh-namespace", FULL, [one({ sku: { name: "Standard" }, location: "East US" })])).toEqual({
      kind: "as-expected",
    });
    const v = classifyCheck("eh-namespace", FULL, [one({ sku: { name: "Standard" }, location: "westus" })]);
    expect(v.kind === "present-differs" && v.diffs.map((d) => d.field)).toEqual(["region"]);
  });

  it("an unreported sku is unknown, never fine", () => {
    expect(classifyCheck("eh-namespace", FULL, [one({ location: "eastus" })]).kind).toBe("unknown");
  });

  it("a named hub: present is as-expected, a complete listing without it is absent", () => {
    const hubs = (...names: string[]) => readRows(names.map((name) => ({ name })));
    const ex = checkExpectationsFor("defenderExport", FULL);
    expect(classifyCheck("eh-hub", FULL, [hubs("defender-alerts")], ex)).toEqual({ kind: "as-expected" });
    expect(classifyCheck("eh-hub", FULL, [hubs("other")], ex)).toEqual({ kind: "absent" });
    expect(classifyCheck("eh-hub", FULL, [hubs()], ex)).toEqual({ kind: "absent" });
  });

  it("auto-created hubs: some missing differs, a prefix match satisfies the initiative", () => {
    const entra: CheckExpectations = { expectedHubs: ["insights-logs-auditlogs", "insights-logs-signinlogs"] };
    const v = classifyCheck("eh-hub", FULL, [readRows([{ name: "insights-logs-auditlogs" }])], entra);
    expect(v.kind).toBe("present-differs");
    expect(classifyCheck("eh-hub", FULL, [readRows([{ name: "insights-logs-kube-audit" }])], AUDIT)).toEqual({
      kind: "as-expected",
    });
  });

  it("measuredHubNames is filled only from a complete read", () => {
    expect(measuredHubNames(readRows([{ name: "a" }, { name: "b" }]))).toEqual(["a", "b"]);
    expect(measuredHubNames(denied)).toBeNull();
  });

  it("a Send-only listen rule differs on rights; Manage is fine; a missing rule is absent", () => {
    const rules = readRows([
      { name: "reader", properties: { rights: ["Send"] } },
      { name: "sender", properties: { rights: ["Manage", "Send", "Listen"] } },
    ]);
    expect(classifyCheck("eh-rule-listen", FULL, [rules])).toEqual({
      kind: "present-differs",
      diffs: [{ field: "rights", expected: "Listen or Manage", actual: "Send" }],
    });
    expect(classifyCheck("eh-rule-send", FULL, [rules])).toEqual({ kind: "as-expected" });
    expect(classifyCheck("eh-rule-listen", { ...FULL, listenRule: "nope" }, [rules])).toEqual({ kind: "absent" });
  });

  it("rule rows that cannot be parsed are unknown, never absent", () => {
    const unparsed = readRows([{ properties: { rights: ["Listen"] } }, 42]);
    for (const kind of ["eh-rule-listen", "eh-rule-send"] as const) {
      const v = classifyCheck(kind, FULL, [unparsed]);
      expect(v.kind === "unknown" && v.reason, kind).toBe("failed");
      expect(v.kind === "unknown" && v.detail).toContain("2 authorization rule rows");
    }
    // A parsed match still decides even when another row was dropped.
    const mixed = readRows([{ name: "reader", properties: { rights: ["Listen"] } }, 42]);
    expect(classifyCheck("eh-rule-listen", FULL, [mixed])).toEqual({ kind: "as-expected" });
  });

  it("the $Default consumer group differs", () => {
    expect(classifyCheck("eh-consumer-group", { ...FULL, consumerGroup: "$Default" }, [one({})]).kind).toBe(
      "present-differs",
    );
    expect(classifyCheck("eh-consumer-group", FULL, [one({})])).toEqual({ kind: "as-expected" });
  });
});

describe("Defender, Entra, Activity Log, policy, XDR", () => {
  const exportItem = (name: string, hub = "defender-alerts") => ({
    id: `/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Security/automations/${name}`,
    name,
    properties: {
      isEnabled: true,
      scopes: [{ scopePath: "/subscriptions/sub-1" }],
      sources: [{ eventSource: "Alerts" }],
      actions: [{ actionType: "EventHub", eventHubResourceId: `${NS_PATH}/eventhubs/${hub}` }],
    },
  });

  it("defender-export: ours as-expected, another name on the plan hub present-other-name, none absent", () => {
    expect(classifyCheck("defender-export", FULL, [readRows([exportItem(DEFENDER_EXPORT_NAME)])])).toEqual({
      kind: "as-expected",
    });
    const v = classifyCheck("defender-export", FULL, [readRows([exportItem("PortalExport")])]);
    expect(v.kind === "present-other-name" && v.name).toBe("PortalExport");
    expect(classifyCheck("defender-export", FULL, [readRows([])])).toEqual({ kind: "absent" });
  });

  it("defender-export rows that cannot be parsed are unknown, never absent", () => {
    const v = classifyCheck("defender-export", FULL, [readRows([42, "x"])]);
    expect(v.kind === "unknown" && v.reason).toBe("failed");
    expect(v.kind === "unknown" && v.detail).toContain("2 automation rows");
    // A match among the parsed rows still decides.
    expect(classifyCheck("defender-export", FULL, [readRows([exportItem(DEFENDER_EXPORT_NAME), 42])])).toEqual({
      kind: "as-expected",
    });
  });

  it("defender-plans: any Standard is as-expected, all Free differs, none returned unknown", () => {
    const plan = (tier: string) => ({ name: "VirtualMachines", properties: { pricingTier: tier } });
    expect(classifyCheck("defender-plans", FULL, [readRows([plan("Free"), plan("Standard")])])).toEqual({
      kind: "as-expected",
    });
    expect(classifyCheck("defender-plans", FULL, [readRows([plan("Free")])]).kind).toBe("present-differs");
    expect(classifyCheck("defender-plans", FULL, [readRows([])]).kind).toBe("unknown");
  });

  it("defender-provider: NotRegistered differs on registrationState", () => {
    expect(classifyCheck("defender-provider", FULL, [one({ registrationState: "NotRegistered" })])).toEqual({
      kind: "present-differs",
      diffs: [{ field: "registrationState", expected: "Registered", actual: "NotRegistered" }],
    });
  });

  it("entra-setting: ours missing a category differs; another name to the namespace is present-other-name", () => {
    const ex = checkExpectationsFor("entraId", FULL, ["Standard"]);
    const setting = (name: string, categories: readonly string[]) => ({
      name,
      properties: {
        eventHubAuthorizationRuleId: `${NS_PATH}/authorizationRules/sender`,
        eventHubName: "",
        logs: categories.map((category) => ({ category, enabled: true })),
      },
    });
    const all = ex.entraCategories ?? [];
    expect(all.length).toBeGreaterThan(1);
    expect(classifyCheck("entra-setting", FULL, [readRows([setting("CriblEntraIDLogs", all)])], ex)).toEqual({
      kind: "as-expected",
    });
    const partial = classifyCheck("entra-setting", FULL, [readRows([setting("CriblEntraIDLogs", all.slice(1))])], ex);
    expect(partial.kind === "present-differs" && partial.diffs.map((d) => d.field)).toEqual(["logs"]);
    const other = classifyCheck("entra-setting", FULL, [readRows([setting("Portal", all)])], ex);
    expect(other).toEqual({ kind: "present-other-name", name: "Portal", diffs: [] });
    expect(classifyCheck("entra-setting", FULL, [readRows([])], ex)).toEqual({ kind: "absent" });
  });

  it("activity-log-setting: a setting to another namespace is absent for the plan", () => {
    const s = {
      name: "x",
      properties: {
        eventHubAuthorizationRuleId: `${NS_PATH}2/authorizationRules/sender`,
        logs: [{ category: "Administrative", enabled: true }],
      },
    };
    expect(classifyCheck("activity-log-setting", FULL, [readRows([s])])).toEqual({ kind: "absent" });
    const ours = { ...s, properties: { ...s.properties, eventHubAuthorizationRuleId: `${NS_PATH}/authorizationRules/sender` } };
    expect(classifyCheck("activity-log-setting", FULL, [readRows([ours])])).toEqual({ kind: "as-expected" });
  });

  it("policy-assignment: Cribl-AU-Central is as-expected; a family name is present-other-name", () => {
    const assignment = (name: string) => ({
      name,
      identity: { type: "UserAssigned" },
      properties: { policyDefinitionId: AUDIT.policy?.definitionId, enforcementMode: "Default" },
    });
    expect(classifyCheck("policy-assignment", FULL, [readRows([assignment("Cribl-AU-Central")])], AUDIT)).toEqual({
      kind: "as-expected",
    });
    expect(classifyCheck("policy-assignment", FULL, [readRows([assignment("Cribl-AU-Old")])], AUDIT)).toEqual({
      kind: "present-other-name",
      name: "Cribl-AU-Old",
      diffs: [],
    });
    expect(classifyCheck("policy-assignment", FULL, [readRows([])], AUDIT)).toEqual({ kind: "absent" });
  });

  it("xdr-streaming is never as-expected, whatever is read", () => {
    for (const reads of [[], [one({})], [readRows([])], [denied]]) {
      const v = classifyCheck("xdr-streaming", FULL, reads, AUDIT);
      expect(v.kind).toBe("unknown");
      expect(v.kind === "unknown" && v.reason).toBe("unmeasurable");
    }
  });

  it("policy-identity-roles is truncated, with the caveat", () => {
    const v = classifyCheck("policy-identity-roles", FULL, [], AUDIT);
    expect(v.kind === "unknown" && v.reason).toBe("truncated");
    expect(v.kind === "unknown" && v.detail).toContain("Monitoring Contributor");
  });
});

describe("blob checks", () => {
  it("storage-rbac: both roles as-expected, one differs, none absent", () => {
    const ra = (guid: string) => ({
      properties: { roleDefinitionId: `/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/${guid}` },
    });
    const blob = "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1";
    const queue = "8a0f0c08-91a1-4084-bc3d-661d67233fed";
    expect(classifyCheck("storage-rbac", FULL, [readRows([ra(blob), ra(queue)])])).toEqual({ kind: "as-expected" });
    expect(classifyCheck("storage-rbac", FULL, [readRows([ra(blob)])]).kind).toBe("present-differs");
    expect(classifyCheck("storage-rbac", FULL, [readRows([])])).toEqual({ kind: "absent" });
  });

  it("eventgrid-subscription: a queue destination with BlobCreated is as-expected", () => {
    const sub = (types: string[]) => ({
      properties: {
        destination: { endpointType: "StorageQueue", properties: { queueName: "flowlog-queue" } },
        filter: { includedEventTypes: types },
      },
    });
    expect(classifyCheck("eventgrid-subscription", FULL, [readRows([sub(["Microsoft.Storage.BlobCreated"])])])).toEqual({
      kind: "as-expected",
    });
    expect(classifyCheck("eventgrid-subscription", FULL, [readRows([sub(["Microsoft.Storage.BlobDeleted"])])]).kind).toBe(
      "present-differs",
    );
    expect(classifyCheck("eventgrid-subscription", FULL, [readRows([])])).toEqual({ kind: "absent" });
  });

  it("flow-log: disabled or version 1 differs", () => {
    const fl = (enabled: boolean, version: number) => ({
      location: "eastus",
      properties: {
        enabled,
        storageId: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Storage/storageAccounts/flowlogsa",
        format: { type: "JSON", version },
      },
    });
    expect(classifyCheck("flow-log", FULL, [one(fl(true, 2))])).toEqual({ kind: "as-expected" });
    const v = classifyCheck("flow-log", FULL, [one(fl(false, 1))]);
    expect(v.kind === "present-differs" && v.diffs.map((d) => d.field)).toEqual(["enabled", "format.version"]);
  });
});

describe("classifyArrival: a measured zero is not unknown", () => {
  const metrics = (totals: number[]) =>
    readRows([{ value: [{ timeseries: [{ data: totals.map((total) => ({ total })) }] }] }]);

  it("sums the totals", () => {
    expect(classifyArrival(metrics([2, 3]), "PT1H")).toEqual({ kind: "measured", messages: 5, window: "PT1H" });
  });

  it("a total of 0 is {measured, 0}; a 403 is unknown; the two are unequal", () => {
    const zero = classifyArrival(metrics([0, 0]));
    const forbidden = classifyArrival(denied);
    expect(zero).toEqual({ kind: "measured", messages: 0, window: "PT1H" });
    expect(forbidden.kind).toBe("unknown");
    expect(forbidden.kind === "unknown" && forbidden.reason).toBe("denied");
    expect(zero).not.toEqual(forbidden);
  });

  it("a body that carries no number is unknown, never a measured zero", () => {
    const shapes: unknown[] = [
      {},
      { value: [] },
      { value: [{ timeseries: [] }] },
      { value: [{ timeseries: [{}] }] },
      { value: [{ timeseries: [{ data: [] }] }] },
      { value: [{ timeseries: [{ data: [{ timeStamp: "t" }, { total: "3" }] }] }] },
      { value: [{ timeseries: [{ data: [{ total: 2 }] }, {}] }] },
    ];
    for (const body of shapes) {
      const v = classifyArrival(readRows([body]));
      expect(v.kind === "unknown" && v.reason, JSON.stringify(body)).toBe("failed");
    }
    // Each malformed shape names what was wrong with it.
    const detail = (body: unknown) => {
      const v = classifyArrival(readRows([body]));
      return v.kind === "unknown" ? v.detail : "";
    };
    expect(detail({ value: [{ timeseries: [] }] })).toContain("timeseries list is empty");
    expect(detail({ value: [{ timeseries: [{}] }] })).toContain("no data array");
    expect(detail({ value: [{ timeseries: [{ data: [] }] }] })).toContain("numeric total");
  });

  it("one point reporting 0 among points without a total is a measured zero", () => {
    const body = { value: [{ timeseries: [{ data: [{ timeStamp: "t" }, { total: 0 }] }] }] };
    expect(classifyArrival(readRows([body]))).toEqual({ kind: "measured", messages: 0, window: "PT1H" });
  });

  it("a 404 is unknown, never absent", () => {
    const v = classifyArrival(readRefused(refusal({ status: 404, code: "ResourceNotFound" })));
    expect(v.kind).toBe("unknown");
  });
});

describe("policy-remediation: outcomes", () => {
  const COMMUNITY = checkExpectationsFor("communityPolicyInitiative", FULL);
  const remediation = (assignment: string, provisioningState: string) => ({
    properties: {
      policyAssignmentId: `/providers/Microsoft.Management/managementGroups/mg-1/providers/Microsoft.Authorization/policyAssignments/${assignment}`,
      provisioningState,
    },
  });
  const check = (ex: CheckExpectations, rows: unknown[]) =>
    classifyCheck("policy-remediation", FULL, [readRows(rows)], ex);

  it("a Succeeded remediation of the exact assignment name is as-expected", () => {
    expect(AUDIT.policy?.assignmentName).toBe("Cribl-AU-Central");
    expect(check(AUDIT, [remediation("Cribl-AU-Central", "Succeeded")])).toEqual({ kind: "as-expected" });
    // Matched case-insensitively, on the id's last segment.
    expect(check(AUDIT, [remediation("cribl-au-central", "succeeded")])).toEqual({ kind: "as-expected" });
  });

  it("with no instructed name, a Succeeded remediation in the legacy family is as-expected", () => {
    expect(COMMUNITY.policy?.assignmentName).toBeNull();
    expect(check(COMMUNITY, [remediation("Cribl-Diag-EH-mg-1", "Succeeded")])).toEqual({ kind: "as-expected" });
  });

  it("no remediation of a matching assignment is absent", () => {
    expect(check(AUDIT, [])).toEqual({ kind: "absent" });
    expect(check(AUDIT, [remediation("SomeoneElse", "Succeeded")])).toEqual({ kind: "absent" });
    // The other initiative's name does not match the community family.
    expect(check(COMMUNITY, [remediation("Cribl-AU-Central", "Succeeded")])).toEqual({ kind: "absent" });
    // The bare family prefix is not a member: the family needs a suffix.
    expect(check(COMMUNITY, [remediation("Cribl-Diag-EH-", "Succeeded")])).toEqual({ kind: "absent" });
  });

  it("matching remediations none of which Succeeded differ on every provisioningState, joined", () => {
    expect(
      check(AUDIT, [
        remediation("Cribl-AU-Central", "Failed"),
        remediation("SomeoneElse", "Succeeded"),
        remediation("Cribl-AU-Central", "Running"),
      ]),
    ).toEqual({
      kind: "present-differs",
      diffs: [{ field: "provisioningState", expected: "Succeeded", actual: "Failed, Running" }],
    });
    // One Succeeded among them is enough.
    expect(
      check(AUDIT, [remediation("Cribl-AU-Central", "Failed"), remediation("Cribl-AU-Central", "Succeeded")]),
    ).toEqual({ kind: "as-expected" });
    // A missing state reads as "(none)", never as Succeeded.
    expect(check(AUDIT, [{ properties: { policyAssignmentId: "/x/policyAssignments/Cribl-AU-Central" } }])).toEqual({
      kind: "present-differs",
      diffs: [{ field: "provisioningState", expected: "Succeeded", actual: "(none)" }],
    });
  });
});

describe("eventgrid-topic: outcomes", () => {
  const ACCOUNT_ID = "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Storage/storageAccounts/flowlogsa";
  const topic = (source: string, topicType = "Microsoft.Storage.StorageAccounts") => ({
    name: "flowlogsa-events",
    properties: { source, topicType },
  });

  it("a system topic on the plan's storage account is as-expected", () => {
    expect(classifyCheck("eventgrid-topic", FULL, [one(topic(ACCOUNT_ID))])).toEqual({ kind: "as-expected" });
    expect(classifyCheck("eventgrid-topic", FULL, [one(topic(ACCOUNT_ID.toUpperCase()))])).toEqual({
      kind: "as-expected",
    });
  });

  it("a topic on another source differs on source; a non-storage topicType differs too", () => {
    const other = ACCOUNT_ID.replace("flowlogsa", "othersa");
    expect(classifyCheck("eventgrid-topic", FULL, [one(topic(other))])).toEqual({
      kind: "present-differs",
      diffs: [{ field: "source", expected: ACCOUNT_ID, actual: other }],
    });
    expect(classifyCheck("eventgrid-topic", FULL, [one(topic("", "Microsoft.Resources.Subscriptions"))])).toEqual({
      kind: "present-differs",
      diffs: [
        { field: "source", expected: ACCOUNT_ID, actual: "(none)" },
        {
          field: "topicType",
          expected: "Microsoft.Storage.StorageAccounts",
          actual: "Microsoft.Resources.Subscriptions",
        },
      ],
    });
  });

  it("a 404 for the topic is absent", () => {
    const notFound = readRefused<unknown>(refusal({ status: 404, code: "ResourceNotFound" }));
    expect(classifyCheck("eventgrid-topic", FULL, [notFound])).toEqual({ kind: "absent" });
  });

  it("a denied or failed read is unknown, never absent", () => {
    const v = classifyCheck("eventgrid-topic", FULL, [denied]);
    expect(v.kind === "unknown" && v.reason).toBe("denied");
    const serverError = readRefused<unknown>(refusal({ status: 500, code: "InternalServerError" }));
    const failed = classifyCheck("eventgrid-topic", FULL, [serverError]);
    expect(failed.kind === "unknown" && failed.reason).toBe("failed");
  });
});

describe("barrels reach the C3 additions", () => {
  it("resolves the new names through each domain index", () => {
    expect(ruleCanListen(["Listen"])).toBe(true);
    expect(namespaceSupportsKafka("Basic")).toBe(false);
    expect(typeof classifyExportForPlan).toBe("function");
    expect(listSettingsRequest().method).toBe("GET");
  });

  it("covers every check kind in the classifier", () => {
    const kinds: readonly CheckKind[] = CHECK_KINDS;
    for (const kind of kinds) {
      expect(() => classifyCheck(kind, FULL, [readRows([{}])], AUDIT), kind).not.toThrow();
    }
  });
});
