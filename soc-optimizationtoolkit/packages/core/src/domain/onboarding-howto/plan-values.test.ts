import { describe, expect, it } from "vitest";
import {
  PLAN_VALUE_KEYS,
  PLAN_VALUE_LABELS,
  defaultPlanValues,
  missingValues,
  planFingerprint,
  sanitizePlanValue,
} from "./index";

describe("defaultPlanValues", () => {
  it("seeds subscription and resource group, consumer group cribl and the flow-log container", () => {
    const v = defaultPlanValues({ subscriptionId: "sub1", resourceGroup: "rg1" });
    expect(v.subscriptionId).toBe("sub1");
    expect(v.resourceGroup).toBe("rg1");
    expect(v.consumerGroup).toBe("cribl");
    expect(v.consumerGroup).not.toBe("$Default");
    expect(v.container).toBe("insights-logs-flowlogflowevent");
    expect(Object.keys(v).sort()).toEqual([...PLAN_VALUE_KEYS].sort());
    const others = PLAN_VALUE_KEYS.filter(
      (k) => !["subscriptionId", "resourceGroup", "consumerGroup", "container"].includes(k),
    );
    for (const k of others) expect(v[k], k).toBe("");
  });

  it("has every D4 key and no credential-shaped key", () => {
    expect([...PLAN_VALUE_KEYS].sort()).toEqual(
      [
        "subscriptionId",
        "managementGroupId",
        "resourceGroup",
        "namespace",
        "hubName",
        "sendRule",
        "listenRule",
        "consumerGroup",
        "region",
        "storageAccount",
        "container",
        "queueName",
        "systemTopic",
        "networkWatcher",
        "flowLogName",
        "criblPrincipalObjectId",
      ].sort(),
    );
    for (const k of PLAN_VALUE_KEYS) expect(k).not.toMatch(/key|secret|password|connection/i);
  });
});

describe("planFingerprint", () => {
  const base = { ...defaultPlanValues(null), namespace: "ns1", hubName: "h1" };

  it("changes only when a listed key changes", () => {
    const fp = planFingerprint(base, ["namespace", "hubName"]);
    expect(planFingerprint({ ...base, region: "eastus" }, ["namespace", "hubName"])).toBe(fp);
    expect(planFingerprint({ ...base, hubName: "h2" }, ["namespace", "hubName"])).not.toBe(fp);
    expect(planFingerprint({ ...base, namespace: "ns2" }, ["namespace", "hubName"])).not.toBe(fp);
  });

  it("is independent of key order and duplicates, and ignores surrounding whitespace", () => {
    expect(planFingerprint(base, ["hubName", "namespace", "hubName"])).toBe(
      planFingerprint(base, ["namespace", "hubName"]),
    );
    expect(planFingerprint({ ...base, hubName: " h1 " }, ["hubName"])).toBe(
      planFingerprint(base, ["hubName"]),
    );
  });
});

describe("missingValues", () => {
  it("lists blank keys only", () => {
    const v = { ...defaultPlanValues(null), namespace: "ns1", hubName: "  " };
    expect(missingValues(v, ["namespace", "hubName", "listenRule"])).toEqual([
      "hubName",
      "listenRule",
    ]);
  });
});

describe("sanitizePlanValue", () => {
  it("blanks a pasted connection string and keeps a name", () => {
    expect(
      sanitizePlanValue(
        "Endpoint=sb://ns1.servicebus.windows.net/;SharedAccessKeyName=r;SharedAccessKey=abc",
      ),
    ).toBe("");
    expect(sanitizePlanValue("DefaultEndpointsProtocol=https;AccountKey=abc")).toBe("");
    expect(sanitizePlanValue("ns1")).toBe("ns1");
  });

  it("keeps a rule NAME that contains SharedAccessKey, blanks the credential shape", () => {
    expect(sanitizePlanValue("RootManageSharedAccessKey")).toBe("RootManageSharedAccessKey");
    expect(sanitizePlanValue("SharedAccessKeyName=reader")).toBe("SharedAccessKeyName=reader");
    expect(sanitizePlanValue("SharedAccessKey = abc")).toBe("");
    expect(sanitizePlanValue("Password=abc")).toBe("");
    expect(sanitizePlanValue("Endpoint = sb://ns1.servicebus.windows.net/")).toBe("");
  });
});

describe("PLAN_VALUE_LABELS", () => {
  it("has a label and (i) text for every key", () => {
    expect(Object.keys(PLAN_VALUE_LABELS).sort()).toEqual([...PLAN_VALUE_KEYS].sort());
    for (const k of PLAN_VALUE_KEYS) {
      expect(PLAN_VALUE_LABELS[k].label.length).toBeGreaterThan(0);
      expect(PLAN_VALUE_LABELS[k].info.length).toBeGreaterThan(0);
    }
  });
});
