import { describe, expect, it } from "vitest";
import { consumerGroupRecord, emptyProgress, listenRuleRecord, withCriblSource } from "@soc/core";
import type { ListenAccessPlan, ListenAccessTarget } from "@soc/core";
import {
  accessRemoveConfirmText,
  accessRemoveMessage,
  applyOutcomeMessage,
  eventHubSourcesInUse,
  listenAccessArmKey,
  listenAccessConfirmLines,
  listenAccessPermissionMessage,
  nothingToCreateText,
  planItemLine,
} from "./listen-access-state";

const NS = { subscriptionId: "sub-1", resourceGroup: "rg-eh", name: "ns1" };
const NS_PATH = "/subscriptions/sub-1/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns1";
const TARGET: ListenAccessTarget = {
  namespace: NS,
  hubs: ["hub-a"],
  consumerGroup: "cribl",
  ruleName: "cribl-listen",
  createRule: true,
  createGroups: true,
};

const PLAN: ListenAccessPlan = {
  kind: "planned",
  target: TARGET,
  items: [
    {
      kind: "listen-rule",
      name: "cribl-listen",
      hub: null,
      resourceId: `${NS_PATH}/authorizationRules/cribl-listen`,
      verdict: { kind: "create" },
      put: { method: "PUT", path: `${NS_PATH}/authorizationRules/cribl-listen`, apiVersion: "2021-11-01", body: { properties: { rights: ["Listen"] } } },
    },
    {
      kind: "consumer-group",
      name: "cribl",
      hub: "hub-a",
      resourceId: `${NS_PATH}/eventhubs/hub-a/consumergroups/cribl`,
      verdict: { kind: "reuse", detail: "Consumer group cribl already exists on hub-a. It is used as it is; nothing is written." },
      put: null,
    },
  ],
};

describe("listen access panel state", () => {
  it("the permission banner is informational and says not measured, never denied", () => {
    const m = listenAccessPermissionMessage();
    expect(m.tone).toBe("info");
    expect(m.text).toContain("Microsoft.EventHub/namespaces/authorizationRules/write and Microsoft.EventHub/namespaces/eventHubs/consumergroups/write");
    expect(m.text).toContain("Needed, not yet measured.");
    expect(m.text).not.toMatch(/denied|lacks/i);
  });

  it("the confirm quotes each PUT exactly, and only the PUTs", () => {
    const lines = listenAccessConfirmLines(PLAN);
    expect(lines).toEqual([
      "Confirm to send this request to Azure, in this order:",
      `PUT ${NS_PATH}/authorizationRules/cribl-listen?api-version=2021-11-01 {"properties":{"rights":["Listen"]}}`,
      "Each name is read again just before its request; one that exists by then is left as it is and not written. Nothing that already exists is replaced.",
    ]);
  });

  it("a plan with nothing to create has no confirm and says why", () => {
    const none: ListenAccessPlan = { ...PLAN, items: [PLAN.kind === "planned" ? PLAN.items[1]! : (undefined as never)] };
    expect(listenAccessConfirmLines(none)).toEqual([]);
    expect(nothingToCreateText(none)).toContain("Nothing to create");
    expect(nothingToCreateText({ kind: "refused", detail: "Enter it." })).toBe("Enter it.");
    expect(nothingToCreateText(PLAN)).toBeNull();
  });

  it("any change to what the confirm names is a new key", () => {
    const base = listenAccessArmKey(TARGET, 1);
    expect(listenAccessArmKey({ ...TARGET }, 1)).toBe(base);
    for (const changed of [
      listenAccessArmKey({ ...TARGET, hubs: ["hub-b"] }, 1),
      listenAccessArmKey({ ...TARGET, ruleName: "x" }, 1),
      listenAccessArmKey({ ...TARGET, consumerGroup: "x" }, 1),
      listenAccessArmKey({ ...TARGET, createRule: false }, 1),
      listenAccessArmKey({ ...TARGET, namespace: { ...NS, name: "ns2" } }, 1),
      listenAccessArmKey(TARGET, 2),
    ]) {
      expect(changed).not.toBe(base);
    }
  });

  it("an unreadable name reads as a likely permission refusal only when Azure said 403", () => {
    const item = PLAN.kind === "planned" ? PLAN.items[0]! : (undefined as never);
    expect(planItemLine({ ...item, verdict: { kind: "unknown", detail: "x", denied: true } })).toEqual({
      tone: "error",
      text: "x Azure refused the read: a permission is likely missing.",
    });
    expect(planItemLine({ ...item, verdict: { kind: "unknown", detail: "x", denied: false } })).toEqual({ tone: "warning", text: "x" });
  });

  it("a refused create names the least role", () => {
    const item = PLAN.kind === "planned" ? PLAN.items[0]! : (undefined as never);
    const m = applyOutcomeMessage({ kind: "failed", item, failure: { kind: "denied", status: 403, code: "AuthorizationFailed", message: "Create rule cribl-listen: HTTP 403" } });
    expect(m).toEqual({
      tone: "error",
      text: "Create rule cribl-listen: HTTP 403. Azure refused it: the identity likely lacks Azure Event Hubs Data Owner (or Contributor) on the namespace.",
    });
  });

  it("the Remove confirm quotes the exact DELETE", () => {
    expect(accessRemoveConfirmText(consumerGroupRecord(NS, "hub-a", "cribl"))).toBe(
      `Remove sends DELETE ${NS_PATH}/eventhubs/hub-a/consumergroups/cribl?api-version=2021-11-01 - it is read first and removed only if this app's record names it and it still carries this app's description. A Cribl source that read with it stops reading.`,
    );
    expect(accessRemoveConfirmText(listenRuleRecord(NS, "cribl-listen"))).toContain("its rights are still Listen alone");
  });

  it("the remove outcomes", () => {
    const id = `${NS_PATH}/authorizationRules/cribl-listen`;
    expect(accessRemoveMessage({ kind: "removed", resourceId: id })).toEqual({ tone: "info", text: "Removed cribl-listen." });
    expect(accessRemoveMessage({ kind: "in-use", resourceId: id, detail: "d" })).toEqual({ tone: "warning", text: "d" });
  });

  it("only recorded Event Hubs sources count as in use", () => {
    let p = withCriblSource(emptyProgress(), "activityLog", { groupId: "g", inputId: "eh1", inputType: "eventhub", secretId: "s" });
    p = withCriblSource(p, "vnetFlowLogs", { groupId: "g", inputId: "blob1", inputType: "azure_blob", secretId: "s2" });
    expect(eventHubSourcesInUse(p)).toEqual(["eh1"]);
    expect(eventHubSourcesInUse(emptyProgress())).toEqual([]);
  });
});
