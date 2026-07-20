import { describe, expect, it } from "vitest";
import {
  LAB_ADX_VALID_SKUS,
  isValidLabCidr,
  labCidrRange,
  labRangesOverlap,
  validateLabAdxSku,
  validateLabEventHubPartitionCount,
  validateLabSettings,
  validateLabStorageAccountName,
  validateLabSubnetLayout,
} from "./lab-validation";
import { DEFAULT_LAB_SUBNETS, DEFAULT_LAB_VNET_CIDR } from "./lab-naming";

describe("isValidLabCidr", () => {
  it("accepts well-formed CIDR", () => {
    expect(isValidLabCidr("10.0.0.0/16")).toBe(true);
    expect(isValidLabCidr("10.198.30.0/27")).toBe(true);
    expect(isValidLabCidr("0.0.0.0/0")).toBe(true);
  });

  it("rejects malformed input (legacy rule set)", () => {
    expect(isValidLabCidr("10.0.0.0")).toBe(false);
    expect(isValidLabCidr("10.0.0/16")).toBe(false);
    expect(isValidLabCidr("10.0.0.256/16")).toBe(false);
    expect(isValidLabCidr("10.0.0.0/33")).toBe(false);
    expect(isValidLabCidr("not-a-cidr")).toBe(false);
  });
});

describe("labCidrRange", () => {
  it("computes network..broadcast with uint32 math", () => {
    const range = labCidrRange("10.198.30.0/27");
    expect(range.end - range.start).toBe(31);
    const vnet = labCidrRange("10.198.30.0/24");
    expect(vnet.end - vnet.start).toBe(255);
  });

  it("handles high-bit addresses without sign trouble", () => {
    const range = labCidrRange("192.168.1.0/24");
    expect(range.start).toBeGreaterThan(0);
    expect(range.end).toBeGreaterThan(range.start);
  });
});

describe("validateLabSubnetLayout", () => {
  it("passes the legacy default layout", () => {
    expect(validateLabSubnetLayout(DEFAULT_LAB_VNET_CIDR, DEFAULT_LAB_SUBNETS)).toEqual([]);
  });

  it("rejects a subnet outside the VNet", () => {
    const errors = validateLabSubnetLayout("10.198.30.0/24", [
      { key: "rogue", name: "Rogue", addressPrefix: "10.198.31.0/27" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("outside VNet range");
  });

  it("detects overlapping subnets pairwise", () => {
    const errors = validateLabSubnetLayout("10.198.30.0/24", [
      { key: "a", name: "A", addressPrefix: "10.198.30.0/26" },
      { key: "b", name: "B", addressPrefix: "10.198.30.32/27" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Subnets overlap");
    expect(errors[0]).toContain("'a'");
    expect(errors[0]).toContain("'b'");
  });

  it("rejects an invalid vnet cidr up front", () => {
    const errors = validateLabSubnetLayout("bogus", DEFAULT_LAB_SUBNETS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Invalid vNet address prefix");
  });

  it("flags a malformed subnet cidr without crashing the rest", () => {
    const errors = validateLabSubnetLayout("10.198.30.0/24", [
      { key: "bad", name: "Bad", addressPrefix: "nope" },
      { key: "ok", name: "Ok", addressPrefix: "10.198.30.0/27" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Invalid CIDR notation for subnet 'bad'");
  });
});

describe("validateLabStorageAccountName", () => {
  it("accepts a generated name", () => {
    expect(validateLabStorageAccountName("sacribllabcribl")).toEqual([]);
  });

  it("enforces 3-24 lowercase alphanumeric (legacy rules)", () => {
    expect(validateLabStorageAccountName("sa")).toHaveLength(1);
    expect(validateLabStorageAccountName("a".repeat(25))).toHaveLength(1);
    expect(validateLabStorageAccountName("Sacribl")).not.toEqual([]);
    expect(validateLabStorageAccountName("sa-cribl")).not.toEqual([]);
  });
});

describe("validateLabEventHubPartitionCount", () => {
  it("accepts 1..32 and rejects outside the bound (legacy)", () => {
    expect(validateLabEventHubPartitionCount(1)).toEqual([]);
    expect(validateLabEventHubPartitionCount(32)).toEqual([]);
    expect(validateLabEventHubPartitionCount(0)).toHaveLength(1);
    expect(validateLabEventHubPartitionCount(33)).toHaveLength(1);
    expect(validateLabEventHubPartitionCount(2.5)).toHaveLength(1);
  });
});

describe("validateLabAdxSku", () => {
  it("accepts every whitelisted SKU", () => {
    for (const sku of LAB_ADX_VALID_SKUS) {
      expect(validateLabAdxSku(sku).errors).toEqual([]);
    }
  });

  it("warns (not errors) on Dev SKUs - the legacy cost warning", () => {
    const result = validateLabAdxSku("Dev(No SLA)_Standard_E2a_v4");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("no SLA");
  });

  it("rejects an unknown SKU with the valid list", () => {
    const result = validateLabAdxSku("Standard_Bogus");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Invalid ADX cluster SKU");
  });
});

describe("validateLabSettings", () => {
  const valid = {
    subscriptionId: "11111111-2222-3333-4444-555555555555",
    resourceGroupName: "rg-lab-SentinelLab",
    location: "eastus",
    baseObjectName: "cribllab",
    ttlUserEmail: "user@example.com",
    ttlHours: 72,
    ttlWarningHours: 24,
  };

  it("passes a complete settings set", () => {
    expect(validateLabSettings(valid)).toEqual([]);
  });

  it("flags empty and angle-bracket placeholder values", () => {
    const errors = validateLabSettings({
      ...valid,
      subscriptionId: "",
      baseObjectName: "<YOUR-NAME>",
    });
    expect(errors).toHaveLength(2);
  });

  it("requires the TTL warning email (mandatory TTL policy)", () => {
    const errors = validateLabSettings({ ...valid, ttlUserEmail: "" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("TTL warning email");
  });

  it("requires positive TTL hours and a smaller warning lead", () => {
    expect(validateLabSettings({ ...valid, ttlHours: 0 })).not.toEqual([]);
    expect(validateLabSettings({ ...valid, ttlWarningHours: 72 })).not.toEqual([]);
    expect(validateLabSettings({ ...valid, ttlWarningHours: -1 })).not.toEqual([]);
    expect(validateLabSettings({ ...valid, ttlHours: 1.5 })).not.toEqual([]);
  });
});

describe("labRangesOverlap", () => {
  it("matches the legacy inclusive comparison", () => {
    expect(labRangesOverlap({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(true);
    expect(labRangesOverlap({ start: 0, end: 9 }, { start: 10, end: 20 })).toBe(false);
  });
});
