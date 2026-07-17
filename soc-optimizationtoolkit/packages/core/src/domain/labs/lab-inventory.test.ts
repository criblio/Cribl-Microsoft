import { describe, expect, it } from "vitest";
import {
  buildResourceGroupDeleteRequest,
  buildResourceGroupsListRequest,
  isLabResourceGroup,
  parseLabInventory,
} from "./lab-inventory";

const SUB = "11111111-2222-3333-4444-555555555555";
const NOW = "2026-07-17T12:00:00.000Z";

describe("lab identification", () => {
  it("matches this app's tag, the legacy tag, and bare TTL markers", () => {
    expect(isLabResourceGroup({ ManagedBy: "SOC-OptimizationToolkit" })).toBe(true);
    expect(isLabResourceGroup({ ManagedBy: "UnifiedAzureLab" })).toBe(true);
    expect(isLabResourceGroup({ TTL_Enabled: "true" })).toBe(true);
    expect(isLabResourceGroup({ ManagedBy: "SomethingElse" })).toBe(false);
    expect(isLabResourceGroup({})).toBe(false);
  });
});

describe("parseLabInventory", () => {
  const items = [
    {
      name: "rg-lab-FlowLogLab",
      location: "eastus",
      tags: {
        ManagedBy: "SOC-OptimizationToolkit",
        TTL_Enabled: "true",
        TTL_ExpirationTime: "2026-07-17T14:00:00Z", // 2h left
        TTL_UserEmail: "user@example.com",
      },
    },
    {
      name: "rg-prod-app",
      location: "eastus",
      tags: { Owner: "someone" },
    },
    {
      name: "rg-lab-old",
      location: "westus2",
      tags: {
        ManagedBy: "UnifiedAzureLab",
        TTL_Enabled: "true",
        TTL_ExpirationTime: "2026-07-17T10:00:00Z", // 2h overdue
      },
    },
    {
      name: "rg-lab-nottl",
      location: "eastus",
      tags: { ManagedBy: "SOC-OptimizationToolkit" },
    },
    "junk",
  ];

  it("keeps only lab groups, computes remaining hours, sorts soonest first", () => {
    const labs = parseLabInventory(items, NOW);
    expect(labs.map((l) => l.name)).toEqual([
      "rg-lab-old",
      "rg-lab-FlowLogLab",
      "rg-lab-nottl",
    ]);
    expect(labs[0].expired).toBe(true);
    expect(labs[0].remainingHours).toBeCloseTo(-2, 5);
    expect(labs[1].expired).toBe(false);
    expect(labs[1].remainingHours).toBeCloseTo(2, 5);
    expect(labs[1].userEmail).toBe("user@example.com");
    expect(labs[2].remainingHours).toBeNull();
    expect(labs[2].ttlEnabled).toBe(false);
  });
});

describe("request builders", () => {
  it("lists resource groups at the subscription and deletes at the group", () => {
    const list = buildResourceGroupsListRequest(SUB);
    expect(list.method).toBe("GET");
    expect(list.path).toBe(`/subscriptions/${SUB}/resourcegroups`);

    const del = buildResourceGroupDeleteRequest(SUB, "rg-lab-x");
    expect(del.method).toBe("DELETE");
    expect(del.path).toBe(`/subscriptions/${SUB}/resourceGroups/rg-lab-x`);
  });
});
