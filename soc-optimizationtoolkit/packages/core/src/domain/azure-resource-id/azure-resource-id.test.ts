/**
 * Unit tests for the Azure ARM resource-id parser, organized by contract:
 *   - the canonical Log Analytics workspace id parses to all five parts
 *   - case-INSENSITIVE key matching with VERBATIM value preservation
 *   - slash tolerance (leading, trailing, doubled)
 *   - nested child-type ids resolve to the LAST /{type}/{name} pair
 *   - TOLERANT/TOTAL behavior: null/''/garbage/partial ids never throw
 *   - deriveResourceGroup convenience accessor
 *   - parseArmTypeAndName: the FULL nested type and name, for ARM templates
 *
 * The keys-vs-values distinction is load-bearing: Azure returns the well-known
 * KEYS in varying casing but the VALUES are identifiers that must round-trip
 * exactly, so casing is normalized only when matching keys, never on output.
 */
import { describe, expect, it } from "vitest";
import {
  deriveResourceGroup,
  parseArmTypeAndName,
  parseResourceId,
} from "./index";

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

/**
 * parseArmTypeAndName exists because parseResourceId deliberately keeps only
 * the LAST /{type}/{name} pair. These pins hold the difference: an ARM template
 * needs both halves whole, and a leaf-only answer silently produces a template
 * that deploys the wrong resource type.
 */
describe("parseArmTypeAndName", () => {
  it("joins every nested pair into the type and name ARM declares", () => {
    const parsed = parseArmTypeAndName(
      "/subscriptions/S/resourceGroups/R/providers/Microsoft.OperationalInsights" +
        "/workspaces/ws-soc/tables/Vendor_CL",
    );
    expect(parsed).toEqual({
      type: "Microsoft.OperationalInsights/workspaces/tables",
      name: "ws-soc/Vendor_CL",
      nameSegments: ["ws-soc", "Vendor_CL"],
    });
    // The distinction from parseResourceId, stated as an assertion so it
    // cannot quietly collapse into the leaf answer.
    expect(parseResourceId(
      "/subscriptions/S/resourceGroups/R/providers/Microsoft.OperationalInsights" +
        "/workspaces/ws-soc/tables/Vendor_CL",
    ).resourceType).toBe("tables");
  });

  it("handles a top-level resource as a one-segment name", () => {
    expect(
      parseArmTypeAndName(
        "/subscriptions/S/resourceGroups/R/providers/Microsoft.Insights" +
          "/dataCollectionRules/dcr-a",
      ),
    ).toEqual({
      type: "Microsoft.Insights/dataCollectionRules",
      name: "dcr-a",
      nameSegments: ["dcr-a"],
    });
  });

  it("returns null - not a partial answer - for a collection url", () => {
    // An odd tail is a type with no name: the resource does not exist yet.
    // '' would be indistinguishable from a resource named ''.
    expect(
      parseArmTypeAndName(
        "/subscriptions/S/resourceGroups/R/providers/Microsoft.Insights/dataCollectionRules",
      ),
    ).toBeNull();
  });

  it("returns null for ids with no providers section, and never throws", () => {
    expect(parseArmTypeAndName("/subscriptions/S/resourceGroups/R")).toBeNull();
    expect(parseArmTypeAndName("garbage")).toBeNull();
    expect(parseArmTypeAndName("")).toBeNull();
    expect(parseArmTypeAndName(null)).toBeNull();
    expect(parseArmTypeAndName(undefined)).toBeNull();
    expect(parseArmTypeAndName("/subscriptions/S/providers")).toBeNull();
  });

  it("tolerates doubled and trailing slashes like its sibling parser", () => {
    expect(
      parseArmTypeAndName(
        "//subscriptions/S//resourceGroups/R/providers/Microsoft.Insights" +
          "/dataCollectionEndpoints/dce-a/",
      )?.name,
    ).toBe("dce-a");
  });
});
