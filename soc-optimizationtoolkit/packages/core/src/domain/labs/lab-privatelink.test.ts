import { describe, expect, it } from "vitest";
import {
  LAB_MONITOR_PRIVATE_DNS_ZONE,
  buildAmplsPutRequest,
  buildAmplsScopedResourcePutRequest,
  buildDnsVnetLinkPutRequest,
  buildPrivateDnsZonePutRequest,
  buildPrivateEndpointPutRequest,
  labAmplsName,
  labAmplsScopedResourceName,
  labDnsVnetLinkName,
  labPrivateEndpointName,
} from "./lab-privatelink";

const SUB = "11111111-2222-3333-4444-555555555555";
const RG = "rg-lab-SentinelLab";

describe("lab-privatelink", () => {
  it("carries the legacy names verbatim", () => {
    expect(labAmplsName("cribllab", "eastus")).toBe("ampls-cribllab-eastus");
    expect(labAmplsScopedResourceName("ampls-cribllab-eastus")).toBe(
      "ampls-cribllab-eastus-law",
    );
    expect(labPrivateEndpointName("cribllab")).toBe("pe-ampls-cribllab");
    expect(labDnsVnetLinkName("vnet-lab-eastus")).toBe("link-to-vnet-lab-eastus");
    expect(LAB_MONITOR_PRIVATE_DNS_ZONE).toBe("privatelink.monitor.azure.com");
  });

  it("PUTs the AMPLS at location global with Open access modes", () => {
    const request = buildAmplsPutRequest(SUB, RG, "ampls-cribllab-eastus");
    expect(request.path).toContain(
      "/providers/microsoft.insights/privateLinkScopes/ampls-cribllab-eastus",
    );
    const body = request.body as Record<string, any>;
    expect(body.location).toBe("global");
    expect(body.properties.accessModeSettings).toEqual({
      ingestionAccessMode: "Open",
      queryAccessMode: "Open",
    });
  });

  it("associates the workspace via linkedResourceId (legacy scoped resource)", () => {
    const request = buildAmplsScopedResourcePutRequest(
      SUB,
      RG,
      "ampls-cribllab-eastus",
      "/workspace-id",
    );
    expect(request.path).toContain("/scopedResources/ampls-cribllab-eastus-law");
    expect((request.body as any).properties.linkedResourceId).toBe("/workspace-id");
  });

  it("PUTs the endpoint in the PrivateLinkSubnet with the azuremonitor group id", () => {
    const request = buildPrivateEndpointPutRequest(
      SUB,
      RG,
      "pe-ampls-cribllab",
      "eastus",
      "/subnet-id",
      "/ampls-id",
    );
    const properties = (request.body as any).properties;
    expect(properties.subnet.id).toBe("/subnet-id");
    const connection = properties.privateLinkServiceConnections[0];
    expect(connection.name).toBe("pe-ampls-cribllab-connection");
    expect(connection.properties.privateLinkServiceId).toBe("/ampls-id");
    expect(connection.properties.groupIds).toEqual(["azuremonitor"]);
  });

  it("PUTs the global DNS zone and a resolution-only VNet link", () => {
    const zone = buildPrivateDnsZonePutRequest(SUB, RG, LAB_MONITOR_PRIVATE_DNS_ZONE);
    expect((zone.body as any).location).toBe("global");

    const link = buildDnsVnetLinkPutRequest(
      SUB,
      RG,
      LAB_MONITOR_PRIVATE_DNS_ZONE,
      "vnet-lab-eastus",
      "/vnet-id",
    );
    expect(link.path).toContain("/virtualNetworkLinks/link-to-vnet-lab-eastus");
    const properties = (link.body as any).properties;
    expect(properties.virtualNetwork.id).toBe("/vnet-id");
    expect(properties.registrationEnabled).toBe(false);
  });
});
