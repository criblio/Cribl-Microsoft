import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAB_VPN_GATEWAY,
  LAB_LOCAL_NETWORK_GATEWAY_NAME,
  LAB_VPN_CONNECTION_NAME,
  buildGatewayPublicIpPutRequest,
  buildLocalNetworkGatewayPutRequest,
  buildVpnConnectionPutRequest,
  buildVpnGatewayPutRequest,
  isOnPremConnectionConfigured,
} from "./lab-gateway";

const SUB = "11111111-2222-3333-4444-555555555555";
const RG = "rg-lab-BasicInfrastructure";

describe("lab-gateway", () => {
  it("PUTs a Standard/Static public IP (the Basic-retirement deviation)", () => {
    const request = buildGatewayPublicIpPutRequest(SUB, RG, "pip-lab-vpn-eastus", "eastus");
    const body = request.body as Record<string, any>;
    expect(body.sku).toEqual({ name: "Standard" });
    expect(body.properties.publicIPAllocationMethod).toBe("Static");
  });

  it("PUTs the VPN gateway with the legacy gwIpConfig/RouteBased/Basic shape", () => {
    const request = buildVpnGatewayPutRequest({
      subscriptionId: SUB,
      resourceGroup: RG,
      gatewayName: "vpngw-lab-eastus",
      location: "eastus",
      gatewaySubnetResourceId: "/gateway-subnet-id",
      publicIpResourceId: "/pip-id",
      settings: DEFAULT_LAB_VPN_GATEWAY,
    });
    const properties = (request.body as any).properties;
    expect(properties.gatewayType).toBe("Vpn");
    expect(properties.vpnType).toBe("RouteBased");
    expect(properties.sku).toEqual({ name: "Basic", tier: "Basic" });
    const ipConfig = properties.ipConfigurations[0];
    expect(ipConfig.name).toBe("gwIpConfig");
    expect(ipConfig.properties.subnet.id).toBe("/gateway-subnet-id");
    expect(ipConfig.properties.publicIPAddress.id).toBe("/pip-id");
  });

  it("PUTs the legacy-named local gateway and IPsec connection", () => {
    expect(LAB_LOCAL_NETWORK_GATEWAY_NAME).toBe("lng-onprem");
    expect(LAB_VPN_CONNECTION_NAME).toBe("conn-azure-to-onprem");

    const lng = buildLocalNetworkGatewayPutRequest(SUB, RG, "eastus", {
      gatewayIpAddress: "203.0.113.10",
      addressSpaces: ["10.198.32.0/24"],
      sharedKey: "test-key",
    });
    const lngProps = (lng.body as any).properties;
    expect(lngProps.gatewayIpAddress).toBe("203.0.113.10");
    expect(lngProps.localNetworkAddressSpace.addressPrefixes).toEqual(["10.198.32.0/24"]);

    const conn = buildVpnConnectionPutRequest(SUB, RG, "eastus", "/gw-id", "/lng-id", "test-key");
    const connProps = (conn.body as any).properties;
    expect(connProps.connectionType).toBe("IPsec");
    expect(connProps.virtualNetworkGateway1.id).toBe("/gw-id");
    expect(connProps.localNetworkGateway2.id).toBe("/lng-id");
    expect(connProps.sharedKey).toBe("test-key");
    expect(connProps.enableBgp).toBe(false);
  });

  it("treats placeholder on-prem configs as not configured (legacy skip)", () => {
    expect(isOnPremConnectionConfigured(undefined)).toBe(false);
    expect(
      isOnPremConnectionConfigured({
        gatewayIpAddress: "<YOUR-ONPREM-VPN-PUBLIC-IP>",
        addressSpaces: ["10.0.0.0/24"],
        sharedKey: "key",
      }),
    ).toBe(false);
    expect(
      isOnPremConnectionConfigured({
        gatewayIpAddress: "203.0.113.10",
        addressSpaces: [],
        sharedKey: "key",
      }),
    ).toBe(false);
    expect(
      isOnPremConnectionConfigured({
        gatewayIpAddress: "203.0.113.10",
        addressSpaces: ["10.0.0.0/24"],
        sharedKey: "key",
      }),
    ).toBe(true);
  });
});
