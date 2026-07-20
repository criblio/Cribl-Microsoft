import { describe, expect, it } from "vitest";
import { buildLabPlan, labPermissionRequirements, type LabPlanInput } from "./lab-plan";

const VALID: LabPlanInput = {
  labType: "SentinelLab",
  labMode: "public",
  subscriptionId: "11111111-2222-3333-4444-555555555555",
  rgMode: "create-new",
  resourceGroupPrefix: "rg-lab",
  existingResourceGroupName: "",
  location: "eastus",
  baseObjectName: "cribllab",
  ttl: { hours: 72, warningHours: 24, userEmail: "user@example.com" },
};

describe("buildLabPlan", () => {
  it("composes RG name from prefix + profile suffix in create-new mode", () => {
    const plan = buildLabPlan(VALID);
    expect(plan.resourceGroupName).toBe("rg-lab-SentinelLab");
    expect(plan.errors).toEqual([]);
  });

  it("uses the existing RG name verbatim in bring-your-own mode", () => {
    const plan = buildLabPlan({
      ...VALID,
      rgMode: "bring-your-own",
      existingResourceGroupName: "rg-preapproved-lab",
    });
    expect(plan.resourceGroupName).toBe("rg-preapproved-lab");
  });

  it("gates the phase list on the profile", () => {
    expect(buildLabPlan(VALID).phases.map((p) => p.number)).toEqual([1, 4, 8, 9]);
    expect(
      buildLabPlan({ ...VALID, labType: "CompleteLab" }).phases.map((p) => p.number),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("validates only the components the profile deploys", () => {
    // SentinelLab (public) has no storage/VNet/ADX, so a hostile base name that
    // would break the storage-account rule cannot block it...
    const sentinel = buildLabPlan({ ...VALID, baseObjectName: "x" });
    expect(sentinel.errors).toEqual([]);
    // ...but CompleteLab deploys storage, so the same base name fails the
    // 3-char storage minimum there? ("sa" + "x" + "cribl" = 8 chars - fine.)
    // Use the subnet check instead: CompleteLab validates the VNet layout.
    const complete = buildLabPlan({
      ...VALID,
      labType: "CompleteLab",
      vnetCidr: "not-a-cidr",
    });
    expect(complete.errors.some((e) => e.includes("Invalid vNet address prefix"))).toBe(true);
  });

  it("carries the Dev-SKU ADX cost warning on ADX profiles", () => {
    const plan = buildLabPlan({ ...VALID, labType: "ADXLab" });
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("no SLA"))).toBe(true);
  });

  it("warns about the 30-45 minute VPN gateway on VPN profiles", () => {
    const plan = buildLabPlan({ ...VALID, labType: "BasicInfrastructure" });
    expect(plan.warnings.some((w) => w.includes("30-45 minutes"))).toBe(true);
  });

  it("surfaces settings errors (placeholders, TTL rules)", () => {
    const plan = buildLabPlan({
      ...VALID,
      subscriptionId: "",
      ttl: { hours: 72, warningHours: 24, userEmail: "" },
    });
    expect(plan.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("names resources through the naming engine with the location applied", () => {
    const plan = buildLabPlan({ ...VALID, labType: "CompleteLab" });
    expect(plan.names.vnet).toBe("vnet-cribllab-eastus");
    expect(plan.names.storageAccount).toBe("sacribllabcribl");
  });
});

describe("labPermissionRequirements", () => {
  it("create-new needs subscription Contributor plus constrained RBAC Administrator", () => {
    const rows = labPermissionRequirements("create-new", "rg-x");
    expect(rows).toHaveLength(2);
    expect(rows[0].scope).toBe("Subscription");
    expect(rows[1].role).toContain("Role Based Access Control Administrator");
  });

  it("bring-your-own needs only Contributor on the named group", () => {
    const rows = labPermissionRequirements("bring-your-own", "rg-preapproved");
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toContain("rg-preapproved");
    expect(rows[0].role).toBe("Contributor");
  });
});
