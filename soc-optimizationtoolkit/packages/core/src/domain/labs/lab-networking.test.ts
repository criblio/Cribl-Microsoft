import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAB_NETWORK_SECURITY,
  buildNsgPutRequest,
  buildVnetPutRequest,
  labNsgSecurityRules,
  parseVnetProvisioningState,
} from "./lab-networking";
import { DEFAULT_LAB_SUBNETS, DEFAULT_LAB_VNET_CIDR } from "./lab-naming";

const SUB = "11111111-2222-3333-4444-555555555555";
const RG = "rg-lab-BasicInfrastructure";

describe("labNsgSecurityRules (legacy Deploy-NSGs rules, verbatim)", () => {
  it("emits AllowOnPremises rules from priority 100 plus AllowAzureServices at 120", () => {
    const rules = labNsgSecurityRules({
      allowOnPremisesTraffic: true,
      allowAzureServices: true,
      onPremisesAddressSpaces: ["10.198.32.0/24", "192.168.10.0/24"],
    });
    expect(rules.map((r) => r.name)).toEqual([
      "AllowOnPremises_100",
      "AllowOnPremises_101",
      "AllowAzureServices",
    ]);
    expect(rules[0].properties.priority).toBe(100);
    expect(rules[0].properties.sourceAddressPrefix).toBe("10.198.32.0/24");
    expect(rules[2].properties.priority).toBe(120);
    expect(rules[2].properties.sourceAddressPrefix).toBe("AzureCloud");
  });

  it("drops placeholder and malformed on-premises entries (legacy would have failed the NSG)", () => {
    const rules = labNsgSecurityRules({
      allowOnPremisesTraffic: true,
      allowAzureServices: false,
      onPremisesAddressSpaces: ["<YOUR-ONPREM-CIDR>", "not-a-cidr", "10.0.0.0/24"],
    });
    expect(rules.map((r) => r.name)).toEqual(["AllowOnPremises_100"]);
    expect(rules[0].properties.sourceAddressPrefix).toBe("10.0.0.0/24");
  });

  it("defaults produce only the AzureCloud rule (no on-prem spaces configured)", () => {
    const rules = labNsgSecurityRules(DEFAULT_LAB_NETWORK_SECURITY);
    expect(rules.map((r) => r.name)).toEqual(["AllowAzureServices"]);
  });

  it("emits nothing when both toggles are off", () => {
    expect(
      labNsgSecurityRules({
        allowOnPremisesTraffic: false,
        allowAzureServices: false,
        onPremisesAddressSpaces: ["10.0.0.0/24"],
      }),
    ).toEqual([]);
  });
});

describe("buildNsgPutRequest", () => {
  it("PUTs the NSG with the rule set", () => {
    const rules = labNsgSecurityRules(DEFAULT_LAB_NETWORK_SECURITY);
    const request = buildNsgPutRequest(SUB, RG, "nsg-lab-SecuritySubnet-eastus", "eastus", rules);
    expect(request.method).toBe("PUT");
    expect(request.path).toBe(
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/networkSecurityGroups/nsg-lab-SecuritySubnet-eastus`,
    );
    expect((request.body as any).properties.securityRules).toHaveLength(1);
  });
});

describe("buildVnetPutRequest (desired-state subnets + inline NSG associations)", () => {
  const request = buildVnetPutRequest({
    subscriptionId: SUB,
    resourceGroup: RG,
    vnetName: "vnet-lab-eastus",
    location: "eastus",
    vnetCidr: DEFAULT_LAB_VNET_CIDR,
    subnets: DEFAULT_LAB_SUBNETS,
    nsgNameBySubnetKey: {
      security: "nsg-lab-SecuritySubnet-eastus",
      o11y: "nsg-lab-O11ySubnet-eastus",
      privatelink: "nsg-lab-PrivateLinkSubnet-eastus",
    },
  });
  const body = request.body as Record<string, any>;

  it("carries the address space and the FULL desired subnet set", () => {
    expect(body.properties.addressSpace.addressPrefixes).toEqual([
      DEFAULT_LAB_VNET_CIDR,
    ]);
    expect(body.properties.subnets.map((s: any) => s.name)).toEqual([
      "GatewaySubnet",
      "SecuritySubnet",
      "O11ySubnet",
      "PrivateLinkSubnet",
    ]);
  });

  it("associates NSGs inline, leaving GatewaySubnet bare (legacy rule)", () => {
    const byName = new Map<string, any>(
      body.properties.subnets.map((s: any) => [s.name, s]),
    );
    expect(byName.get("GatewaySubnet").properties.networkSecurityGroup).toBeUndefined();
    expect(
      byName.get("SecuritySubnet").properties.networkSecurityGroup.id,
    ).toContain("nsg-lab-SecuritySubnet-eastus");
  });
});

describe("parseVnetProvisioningState", () => {
  it("reads properties.provisioningState tolerantly", () => {
    expect(
      parseVnetProvisioningState({ properties: { provisioningState: "Updating" } }),
    ).toBe("Updating");
    expect(parseVnetProvisioningState("junk")).toBe("");
  });
});
