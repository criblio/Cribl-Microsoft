import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { CONSUMER_GROUP_STAMP, consumerGroupRecord, listenRuleRecord } from "../../domain/eventhub-listen-access";
import {
  applyListenAccess,
  planListenAccess,
  plannedWrites,
  removeListenAccessObject,
  type ListenAccessTarget,
} from "./eventhub-listen-access";

const NS = { subscriptionId: "sub-1", resourceGroup: "rg-eh", name: "ns1" };
const NS_PATH = "/subscriptions/sub-1/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns1";
const RULE_PATH = `${NS_PATH}/authorizationRules/cribl-listen`;
const CG_A = `${NS_PATH}/eventhubs/hub-a/consumergroups/cribl`;
const CG_B = `${NS_PATH}/eventhubs/hub-b/consumergroups/cribl`;
const API = "2021-11-01";

const notFound = { status: 404, body: { error: { code: "NotFound" } } };
const forbidden = { status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } };
const ok = { status: 200, body: {} };
const RULE_AT = "2026-11-18T10:00:00.123Z";
const GROUP_AT = "2026-11-18T10:00:01Z";
const listenRule = {
  status: 200,
  body: { name: "cribl-listen", properties: { rights: ["Listen"] }, systemData: { createdAt: RULE_AT } },
};
const stampedGroup = { status: 200, body: { name: "cribl", properties: { userMetadata: CONSUMER_GROUP_STAMP, createdAt: GROUP_AT } } };

const TARGET: ListenAccessTarget = {
  namespace: NS,
  hubs: ["hub-a", "hub-b", "HUB-A", " "],
  consumerGroup: "cribl",
  ruleName: "cribl-listen",
  createRule: true,
  createGroups: true,
};

describe("planListenAccess (read-only)", () => {
  it("reads each name once, GETs only, and plans a PUT for each 404", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(notFound, notFound, { status: 200, body: { name: "cribl" } });
    const plan = await planListenAccess(azure, TARGET);
    expect(azure.calls).toEqual([
      { method: "GET", path: RULE_PATH, apiVersion: API },
      { method: "GET", path: CG_A, apiVersion: API },
      { method: "GET", path: CG_B, apiVersion: API },
    ]);
    expect(plan.kind).toBe("planned");
    if (plan.kind !== "planned") return;
    expect(plan.items.map((i) => [i.kind, i.hub, i.verdict.kind])).toEqual([
      ["listen-rule", null, "create"],
      ["consumer-group", "hub-a", "create"],
      ["consumer-group", "hub-b", "reuse"],
    ]);
    expect(plannedWrites(plan).map((r) => `${r.method} ${r.path}`)).toEqual([`PUT ${RULE_PATH}`, `PUT ${CG_A}`]);
  });

  it("an unreadable name plans no PUT", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(forbidden);
    const plan = await planListenAccess(azure, { ...TARGET, createGroups: false });
    expect(plan.kind === "planned" && plan.items[0]?.verdict).toMatchObject({ kind: "unknown", denied: true });
    expect(plannedWrites(plan)).toEqual([]);
  });

  it("refuses with no namespace, no object chosen, or no hub - before any call", async () => {
    const azure = new FakeAzureManagement();
    expect((await planListenAccess(azure, { ...TARGET, namespace: { ...NS, name: "" } })).kind).toBe("refused");
    expect((await planListenAccess(azure, { ...TARGET, createRule: false, createGroups: false })).kind).toBe("refused");
    expect((await planListenAccess(azure, { ...TARGET, hubs: [] })).kind).toBe("refused");
    expect(azure.calls).toEqual([]);
  });
});

describe("applyListenAccess (create-only)", () => {
  it("re-reads, PUTs, reads back - per object, in order - and records what it created", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(notFound, notFound);
    const plan = await planListenAccess(azure, { ...TARGET, hubs: ["hub-a"] });
    azure.calls.length = 0;
    azure.respondWith(notFound, ok, listenRule, notFound, ok, stampedGroup);
    const result = await applyListenAccess(azure, plan);
    expect(azure.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${RULE_PATH}`,
      `PUT ${RULE_PATH}`,
      `GET ${RULE_PATH}`,
      `GET ${CG_A}`,
      `PUT ${CG_A}`,
      `GET ${CG_A}`,
    ]);
    expect(azure.calls[1]?.body).toEqual({ properties: { rights: ["Listen"] } });
    expect(result.outcomes.map((o) => o.kind)).toEqual(["created", "created"]);
    expect(result.records).toEqual([
      { kind: "listen-rule", resourceId: RULE_PATH, createdAt: RULE_AT },
      { kind: "consumer-group", resourceId: CG_A, createdAt: GROUP_AT },
    ]);
  });

  it("a name that appeared since the check is never written over, and not recorded", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(notFound);
    const plan = await planListenAccess(azure, { ...TARGET, createGroups: false });
    azure.calls.length = 0;
    azure.respondWith({ status: 200, body: { properties: { rights: ["Manage", "Listen", "Send"] } } });
    const result = await applyListenAccess(azure, plan);
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(result.outcomes[0]?.kind).toBe("appeared");
    expect(result.records).toEqual([]);
  });

  it("a refused PUT is failed (denied) and records nothing", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(notFound);
    const plan = await planListenAccess(azure, { ...TARGET, createGroups: false });
    azure.respondWith(notFound, forbidden);
    const result = await applyListenAccess(azure, plan);
    expect(result.outcomes[0]).toMatchObject({ kind: "failed", failure: { kind: "denied", status: 403 } });
    expect(result.records).toEqual([]);
  });

  it("an accepted PUT whose read-back differs is created-not-verified, and still recorded", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(notFound);
    const plan = await planListenAccess(azure, { ...TARGET, createRule: false, hubs: ["hub-a"] });
    azure.respondWith(notFound, ok, { status: 200, body: { properties: {} } });
    const result = await applyListenAccess(azure, plan);
    expect(result.outcomes[0]).toMatchObject({ kind: "created-not-verified" });
    expect(result.records).toEqual([{ kind: "consumer-group", resourceId: CG_A }]);
  });

  it("a rule whose read-back failed is recorded without a creation time", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(notFound);
    const plan = await planListenAccess(azure, { ...TARGET, createGroups: false });
    azure.respondWith(notFound, ok, forbidden);
    const result = await applyListenAccess(azure, plan);
    expect(result.outcomes[0]).toMatchObject({ kind: "created-not-verified" });
    expect(result.records).toEqual([{ kind: "listen-rule", resourceId: RULE_PATH }]);
  });

  it("sends nothing for a refused plan", async () => {
    const azure = new FakeAzureManagement();
    const result = await applyListenAccess(azure, { kind: "refused", detail: "x" });
    expect(result).toEqual({ outcomes: [], records: [] });
    expect(azure.calls).toEqual([]);
  });
});

describe("removeListenAccessObject", () => {
  const rec = consumerGroupRecord(NS, "hub-a", "cribl");

  it("reads, proves, deletes, confirms the 404 - in that order", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(stampedGroup, ok, notFound);
    const outcome = await removeListenAccessObject(azure, { record: rec, recorded: [rec], inUseBy: [] });
    expect(outcome).toEqual({ kind: "removed", resourceId: CG_A });
    expect(azure.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${CG_A}`, `DELETE ${CG_A}`, `GET ${CG_A}`]);
  });

  it("an unstamped group is not proven and nothing is deleted", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { properties: {} } });
    const outcome = await removeListenAccessObject(azure, { record: rec, recorded: [rec], inUseBy: [] });
    expect(outcome.kind).toBe("not-proven");
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a recorded Cribl source still present keeps it", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(stampedGroup);
    const outcome = await removeListenAccessObject(azure, { record: rec, recorded: [rec], inUseBy: ["eventhub_x"] });
    expect(outcome.kind).toBe("in-use");
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a stale rule record against a rule re-created by hand sends no DELETE", async () => {
    const ruleRec = listenRuleRecord(NS, "cribl-listen", RULE_AT);
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: { name: "cribl-listen", properties: { rights: ["Listen"] }, systemData: { createdAt: "2026-11-19T08:00:00Z" } },
    });
    const outcome = await removeListenAccessObject(azure, { record: ruleRec, recorded: [ruleRec], inUseBy: [] });
    expect(outcome.kind).toBe("not-proven");
    expect(azure.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${RULE_PATH}`]);
  });

  it("the rule the app recorded (same creation time) is deleted", async () => {
    const ruleRec = listenRuleRecord(NS, "cribl-listen", RULE_AT);
    const azure = new FakeAzureManagement();
    azure.respondWith(listenRule, ok, notFound);
    const outcome = await removeListenAccessObject(azure, { record: ruleRec, recorded: [ruleRec], inUseBy: [] });
    expect(outcome).toEqual({ kind: "removed", resourceId: RULE_PATH });
    expect(azure.calls.map((c) => c.method)).toEqual(["GET", "DELETE", "GET"]);
  });

  it("a 403 on the DELETE is denied at the delete step", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(stampedGroup, forbidden);
    const outcome = await removeListenAccessObject(azure, { record: rec, recorded: [rec], inUseBy: [] });
    expect(outcome).toMatchObject({ kind: "denied", step: "delete" });
  });

  it("a 404 first is already gone; an invalid record sends nothing", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(notFound);
    expect((await removeListenAccessObject(azure, { record: rec, recorded: [rec], inUseBy: [] })).kind).toBe("already-gone");
    const bad = { kind: "listen-rule" as const, resourceId: "/nope" };
    expect((await removeListenAccessObject(azure, { record: bad, recorded: [bad], inUseBy: [] })).kind).toBe("invalid-record");
    expect(azure.calls).toHaveLength(1);
  });
});
