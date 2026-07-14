/**
 * Unit tests for the Azure ARM resource-id parser, organized by contract:
 *   - the canonical Log Analytics workspace id parses to all five parts
 *   - case-INSENSITIVE key matching with VERBATIM value preservation
 *   - slash tolerance (leading, trailing, doubled)
 *   - nested child-type ids resolve to the LAST /{type}/{name} pair
 *   - TOLERANT/TOTAL behavior: null/''/garbage/partial ids never throw
 *   - deriveResourceGroup convenience accessor
 *
 * The keys-vs-values distinction is load-bearing: Azure returns the well-known
 * KEYS in varying casing but the VALUES are identifiers that must round-trip
 * exactly, so casing is normalized only when matching keys, never on output.
 */
import { describe, expect, it } from "vitest";
import { deriveResourceGroup, parseResourceId } from "./index";

/** The canonical Log Analytics workspace id used across the wizard. */
const WORKSPACE_ID =
  "/subscriptions/SUB/resourceGroups/RG/providers/Microsoft.OperationalInsights/workspaces/WS";

describe("parseResourceId - canonical workspace id", () => {
  it("extracts all five parts from a Log Analytics workspace id", () => {
    expect(parseResourceId(WORKSPACE_ID)).toEqual({
      subscriptionId: "SUB",
      resourceGroup: "RG",
      provider: "Microsoft.OperationalInsights",
      resourceType: "workspaces",
      name: "WS",
    });
  });
});

describe("parseResourceId - case-insensitive keys, verbatim values", () => {
  it("parses mixed-case segment KEYS while preserving VALUE casing", () => {
    const parsed = parseResourceId(
      "/subscriptions/s/RESOURCEGROUPS/r/providers/Microsoft.Compute/virtualMachines/VM",
    );
    expect(parsed).toEqual({
      subscriptionId: "s",
      resourceGroup: "r",
      provider: "Microsoft.Compute",
      resourceType: "virtualMachines",
      name: "VM",
    });
  });

  it("matches 'subscriptions'/'providers' regardless of casing", () => {
    const parsed = parseResourceId(
      "/SUBSCRIPTIONS/S/ResourceGroups/R/PROVIDERS/Microsoft.X/things/T",
    );
    expect(parsed.subscriptionId).toBe("S");
    expect(parsed.resourceGroup).toBe("R");
    expect(parsed.provider).toBe("Microsoft.X");
    expect(parsed.resourceType).toBe("things");
    expect(parsed.name).toBe("T");
  });
});

describe("parseResourceId - slash tolerance", () => {
  it("tolerates a missing leading slash", () => {
    expect(
      parseResourceId(
        "subscriptions/SUB/resourceGroups/RG/providers/Microsoft.X/t/N",
      ),
    ).toEqual({
      subscriptionId: "SUB",
      resourceGroup: "RG",
      provider: "Microsoft.X",
      resourceType: "t",
      name: "N",
    });
  });

  it("tolerates a trailing slash", () => {
    expect(parseResourceId(`${WORKSPACE_ID}/`)).toEqual({
      subscriptionId: "SUB",
      resourceGroup: "RG",
      provider: "Microsoft.OperationalInsights",
      resourceType: "workspaces",
      name: "WS",
    });
  });

  it("tolerates doubled internal slashes", () => {
    expect(
      parseResourceId(
        "/subscriptions//SUB//resourceGroups//RG//providers//Microsoft.X//t//N",
      ),
    ).toEqual({
      subscriptionId: "SUB",
      resourceGroup: "RG",
      provider: "Microsoft.X",
      resourceType: "t",
      name: "N",
    });
  });
});

describe("parseResourceId - nested child types", () => {
  it("returns the LAST /{type}/{name} pair for a nested id", () => {
    const parsed = parseResourceId(
      "/subscriptions/S/resourceGroups/R/providers/Microsoft.X/foo/A/bar/B",
    );
    expect(parsed.provider).toBe("Microsoft.X");
    expect(parsed.resourceType).toBe("bar");
    expect(parsed.name).toBe("B");
  });

  it("resolves a real subnet (deeply nested) to its leaf type and name", () => {
    const parsed = parseResourceId(
      "/subscriptions/S/resourceGroups/R/providers/Microsoft.Network/virtualNetworks/my-vnet/subnets/my-subnet",
    );
    expect(parsed.resourceType).toBe("subnets");
    expect(parsed.name).toBe("my-subnet");
  });
});

describe("parseResourceId - tolerant and total (never throws)", () => {
  it("returns all-empty for null", () => {
    expect(parseResourceId(null)).toEqual({
      subscriptionId: "",
      resourceGroup: "",
      provider: "",
      resourceType: "",
      name: "",
    });
  });

  it("returns all-empty for undefined", () => {
    expect(parseResourceId(undefined)).toEqual({
      subscriptionId: "",
      resourceGroup: "",
      provider: "",
      resourceType: "",
      name: "",
    });
  });

  it("returns all-empty for the empty string", () => {
    expect(parseResourceId("")).toEqual({
      subscriptionId: "",
      resourceGroup: "",
      provider: "",
      resourceType: "",
      name: "",
    });
  });

  it("returns all-empty for a slash-only string", () => {
    expect(parseResourceId("///")).toEqual({
      subscriptionId: "",
      resourceGroup: "",
      provider: "",
      resourceType: "",
      name: "",
    });
  });

  it("returns all-empty for unstructured garbage", () => {
    expect(parseResourceId("garbage")).toEqual({
      subscriptionId: "",
      resourceGroup: "",
      provider: "",
      resourceType: "",
      name: "",
    });
  });

  it("returns a safe partial for a dangling 'subscriptions' with no value", () => {
    expect(parseResourceId("/subscriptions/")).toEqual({
      subscriptionId: "",
      resourceGroup: "",
      provider: "",
      resourceType: "",
      name: "",
    });
  });

  it("does not return a reference to the shared empty result (no mutation risk)", () => {
    const a = parseResourceId(null);
    const b = parseResourceId(null);
    expect(a).not.toBe(b);
    a.name = "mutated";
    expect(parseResourceId(null).name).toBe("");
  });
});

describe("parseResourceId - name fallback when no providers section", () => {
  it("falls back to the resource group when there is no providers section", () => {
    const parsed = parseResourceId("/subscriptions/SUB/resourceGroups/RG");
    expect(parsed.subscriptionId).toBe("SUB");
    expect(parsed.resourceGroup).toBe("RG");
    expect(parsed.provider).toBe("");
    expect(parsed.resourceType).toBe("");
    expect(parsed.name).toBe("RG");
  });

  it("falls back to the subscription when only a subscription is present", () => {
    const parsed = parseResourceId("/subscriptions/SUB");
    expect(parsed.subscriptionId).toBe("SUB");
    expect(parsed.resourceGroup).toBe("");
    expect(parsed.name).toBe("SUB");
  });
});

describe("deriveResourceGroup", () => {
  it("returns the case-preserved resource group of the workspace id", () => {
    expect(deriveResourceGroup(WORKSPACE_ID)).toBe("RG");
  });

  it("returns '' for null/undefined/garbage without throwing", () => {
    expect(deriveResourceGroup(null)).toBe("");
    expect(deriveResourceGroup(undefined)).toBe("");
    expect(deriveResourceGroup("garbage")).toBe("");
  });
});
