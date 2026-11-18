import { describe, expect, it } from "vitest";
import {
  CONSUMER_GROUP_STAMP,
  DEFAULT_LISTEN_RULE_NAME,
  LISTEN_ACCESS_ACTIONS,
  buildListenRulePutRequest,
  buildStampedConsumerGroupPutRequest,
  classifyConsumerGroup,
  classifyListenAccessRemoval,
  classifyListenRule,
  consumerGroupRecord,
  listenRuleName,
  listenRuleRecord,
  quoteArmRequest,
  requestsForAccessRecord,
} from "./listen-access";

const NS = { subscriptionId: "sub-1", resourceGroup: "rg-eh", name: "ns1" };
const NS_PATH = "/subscriptions/sub-1/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns1";

function rule(rights: string[]): { kind: "found"; body: unknown } {
  return { kind: "found", body: { name: "cribl-listen", properties: { rights } } };
}

describe("listen access request builders", () => {
  it("the rule PUT carries Listen and nothing else, on the namespace", () => {
    expect(buildListenRulePutRequest(NS, "cribl-listen")).toEqual({
      method: "PUT",
      path: `${NS_PATH}/authorizationRules/cribl-listen`,
      apiVersion: "2021-11-01",
      body: { properties: { rights: ["Listen"] } },
    });
  });

  it("the consumer group PUT carries the app's stamp", () => {
    expect(buildStampedConsumerGroupPutRequest(NS, "hub-a", "cribl")).toEqual({
      method: "PUT",
      path: `${NS_PATH}/eventhubs/hub-a/consumergroups/cribl`,
      apiVersion: "2021-11-01",
      body: { properties: { userMetadata: CONSUMER_GROUP_STAMP } },
    });
  });

  it("the confirm quotes the exact request: method, path, api-version and JSON body", () => {
    expect(quoteArmRequest(buildListenRulePutRequest(NS, "cribl-listen"))).toBe(
      `PUT ${NS_PATH}/authorizationRules/cribl-listen?api-version=2021-11-01 {"properties":{"rights":["Listen"]}}`,
    );
  });

  it("a blank plan value names the rule cribl-listen; a set one wins", () => {
    expect(listenRuleName("  ")).toBe(DEFAULT_LISTEN_RULE_NAME);
    expect(DEFAULT_LISTEN_RULE_NAME).toBe("cribl-listen");
    expect(listenRuleName(" my-listen ")).toBe("my-listen");
  });
});

describe("classifyListenRule - never replaces an existing rule", () => {
  it("absent is the only verdict that creates", () => {
    expect(classifyListenRule({ kind: "absent" }, "r")).toEqual({ kind: "create" });
  });

  it("an unreadable name is unknown, never absent", () => {
    const v = classifyListenRule({ kind: "unknown", detail: "HTTP 403", denied: true }, "r");
    expect(v).toMatchObject({ kind: "unknown", denied: true });
  });

  it("an existing Listen-only rule is offered for reuse", () => {
    expect(classifyListenRule(rule(["Listen"]), "cribl-listen").kind).toBe("reuse");
  });

  it("an existing Listen and Send rule is reused, with the narrower option named", () => {
    const v = classifyListenRule(rule(["Listen", "Send"]), "cribl-listen");
    expect(v.kind).toBe("reuse");
    expect("detail" in v && v.detail).toContain("a rule with Listen only would be narrower");
  });

  it("an existing Manage rule is refused, not replaced (AZR-58)", () => {
    const v = classifyListenRule(rule(["Manage", "Listen", "Send"]), "cribl-listen");
    expect(v.kind).toBe("refused");
    expect("detail" in v && v.detail).toContain("must not go into a Cribl secret");
  });

  it("an existing Send-only rule is refused: it cannot Listen", () => {
    const v = classifyListenRule(rule(["Send"]), "cribl-listen");
    expect(v.kind).toBe("refused");
    expect("detail" in v && v.detail).toContain("cannot Listen");
  });
});

describe("classifyConsumerGroup", () => {
  it("absent creates; present is reused as it is", () => {
    expect(classifyConsumerGroup({ kind: "absent" }, "cribl", "h")).toEqual({ kind: "create" });
    expect(classifyConsumerGroup({ kind: "found", body: {} }, "cribl", "h").kind).toBe("reuse");
  });

  it("$Default is refused whatever the read said", () => {
    expect(classifyConsumerGroup({ kind: "absent" }, "$default", "h").kind).toBe("refused");
    expect(classifyConsumerGroup({ kind: "found", body: {} }, "$Default", "h").kind).toBe("refused");
  });
});

describe("classifyListenAccessRemoval - every signal, and nothing still reading with it", () => {
  const ruleRec = listenRuleRecord(NS, "cribl-listen");
  const cgRec = consumerGroupRecord(NS, "hub-a", "cribl");
  const recorded = [ruleRec, cgRec];
  const stamped = { kind: "found" as const, body: { name: "cribl", properties: { userMetadata: CONSUMER_GROUP_STAMP } } };

  it("a recorded Listen-only rule nobody reads with is deleted", () => {
    expect(classifyListenAccessRemoval(rule(["Listen"]), ruleRec, recorded, [])).toEqual({ kind: "delete" });
  });

  it("a recorded stamped consumer group is deleted", () => {
    expect(classifyListenAccessRemoval(stamped, cgRec, recorded, [])).toEqual({ kind: "delete" });
  });

  it("absent is already gone", () => {
    expect(classifyListenAccessRemoval({ kind: "absent" }, cgRec, recorded, ["in-1"])).toEqual({ kind: "already-gone" });
  });

  it("while a recorded Cribl source remains, nothing goes", () => {
    const v = classifyListenAccessRemoval(stamped, cgRec, recorded, ["eventhub_x"]);
    expect(v.kind).toBe("in-use");
    expect("detail" in v && v.detail).toContain("eventhub_x");
  });

  it("without the KV record it is not proven", () => {
    const v = classifyListenAccessRemoval(stamped, cgRec, [ruleRec], []);
    expect(v.kind).toBe("not-proven");
    expect("detail" in v && v.detail).toContain("no record of creating it");
  });

  it("a group without the stamp is not proven", () => {
    const v = classifyListenAccessRemoval({ kind: "found", body: { properties: { userMetadata: "mine" } } }, cgRec, recorded, []);
    expect(v.kind).toBe("not-proven");
    expect("detail" in v && v.detail).toContain("stamp");
  });

  it("a rule whose rights were widened is not proven", () => {
    const v = classifyListenAccessRemoval(rule(["Listen", "Send"]), ruleRec, recorded, []);
    expect(v.kind).toBe("not-proven");
    expect("detail" in v && v.detail).toContain("its rights are now Listen, Send");
  });
});

describe("requestsForAccessRecord", () => {
  it("maps a rule record to its GET and DELETE", () => {
    const r = requestsForAccessRecord(listenRuleRecord(NS, "cribl-listen"));
    expect(r?.get).toEqual({ method: "GET", path: `${NS_PATH}/authorizationRules/cribl-listen`, apiVersion: "2021-11-01" });
    expect(r?.del).toEqual({ method: "DELETE", path: `${NS_PATH}/authorizationRules/cribl-listen`, apiVersion: "2021-11-01" });
  });

  it("maps a consumer group record to its GET and DELETE", () => {
    const r = requestsForAccessRecord(consumerGroupRecord(NS, "hub-a", "cribl"));
    expect(r?.del.path).toBe(`${NS_PATH}/eventhubs/hub-a/consumergroups/cribl`);
  });

  it("refuses a record that names anything else, or $Default", () => {
    expect(requestsForAccessRecord({ kind: "listen-rule", resourceId: `${NS_PATH}/eventhubs/h/authorizationRules/x` })).toBeNull();
    expect(requestsForAccessRecord({ kind: "consumer-group", resourceId: `${NS_PATH}/authorizationRules/x` })).toBeNull();
    expect(requestsForAccessRecord(consumerGroupRecord(NS, "hub-a", "$Default"))).toBeNull();
    expect(requestsForAccessRecord({ kind: "listen-rule", resourceId: "/subscriptions/s/resourceGroups/r/providers/Microsoft.Storage/x/y/authorizationRules/z" })).toBeNull();
  });
});

describe("LISTEN_ACCESS_ACTIONS", () => {
  it("lists the six registry actions, all feature", () => {
    expect(LISTEN_ACCESS_ACTIONS.map((a) => a.action)).toEqual([
      "Microsoft.EventHub/namespaces/authorizationRules/read",
      "Microsoft.EventHub/namespaces/authorizationRules/write",
      "Microsoft.EventHub/namespaces/eventHubs/consumergroups/read",
      "Microsoft.EventHub/namespaces/eventHubs/consumergroups/write",
      "Microsoft.EventHub/namespaces/authorizationRules/delete",
      "Microsoft.EventHub/namespaces/eventHubs/consumergroups/delete",
    ]);
    expect(LISTEN_ACCESS_ACTIONS.every((a) => a.necessity === "feature")).toBe(true);
  });
});
