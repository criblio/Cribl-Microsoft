/**
 * Lab VPN gateway request builders - roadmap Phase 5 (LAB-12: VPN gateway +
 * optional site-to-site connection to an on-premises network).
 *
 * Ported from the legacy UnifiedLab Phase10-Gateway scripts:
 * - Deploy-VPNGateway.ps1: public IP + virtual network gateway on the
 *   GatewaySubnet (RouteBased, Basic SKU default; a 30-45 minute
 *   provisioning operation - the reason lab provisioning needed the polled
 *   job redesign).
 * - Deploy-VPNConnection.ps1 (config contract onprem-connection-parameters):
 *   the lng-onprem local network gateway (on-prem VPN device IP + address
 *   spaces) and the conn-azure-to-onprem IPsec connection with the shared
 *   key. The connection deploys ONLY when the operator supplies the on-prem
 *   details (the legacy skipped when the file held placeholders); the shared
 *   key is TRANSIENT deploy input that lands only in the ARM resource.
 *
 * Recorded deviation: the legacy created a Basic-SKU Dynamic public IP;
 * Basic public IPs are RETIRED for new deployments, so the gateway IP is
 * Standard/Static here (supported for Basic and VpnGw gateways alike).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import { LAB_NETWORK_API_VERSION } from "./lab-networking";

/** VPN gateway settings (legacy infrastructure.vpnGateway). */
export interface LabVpnGatewaySettings {
  /** Gateway SKU (legacy default Basic, ~$27/month). */
  sku: string;
  /** RouteBased (legacy default) or PolicyBased. */
  vpnType: string;
}

/** The legacy defaults, verbatim. */
export const DEFAULT_LAB_VPN_GATEWAY: LabVpnGatewaySettings = {
  sku: "Basic",
  vpnType: "RouteBased",
};

/** The optional on-premises connection (onprem-connection-parameters shape). */
export interface LabOnPremConnection {
  /** Public IP of the on-premises VPN device. */
  gatewayIpAddress: string;
  /** On-premises CIDR blocks reachable through the tunnel. */
  addressSpaces: readonly string[];
  /** TRANSIENT pre-shared key - deploy input only, never stored app-side. */
  sharedKey: string;
}

/** The legacy resource names, verbatim. */
export const LAB_LOCAL_NETWORK_GATEWAY_NAME = "lng-onprem";
export const LAB_VPN_CONNECTION_NAME = "conn-azure-to-onprem";

function networkPath(
  subscriptionId: string,
  resourceGroup: string,
  provider: string,
  name: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Network/${provider}/${name}`
  );
}

/** GET the gateway's public IP. */
export function buildGatewayPublicIpGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  pipName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: networkPath(subscriptionId, resourceGroup, "publicIPAddresses", pipName),
    apiVersion: LAB_NETWORK_API_VERSION,
  };
}

/** PUT the gateway's public IP (Standard/Static - the retirement deviation). */
export function buildGatewayPublicIpPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  pipName: string,
  location: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: networkPath(subscriptionId, resourceGroup, "publicIPAddresses", pipName),
    apiVersion: LAB_NETWORK_API_VERSION,
    body: {
      location,
      sku: { name: "Standard" },
      properties: { publicIPAllocationMethod: "Static" },
    },
  };
}

/** GET the VPN gateway (existence + provisioningState). */
export function buildVpnGatewayGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  gatewayName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: networkPath(
      subscriptionId,
      resourceGroup,
      "virtualNetworkGateways",
      gatewayName,
    ),
    apiVersion: LAB_NETWORK_API_VERSION,
  };
}

/** Inputs for {@link buildVpnGatewayPutRequest}. */
export interface VpnGatewayPutInput {
  subscriptionId: string;
  resourceGroup: string;
  gatewayName: string;
  location: string;
  /** The VNet's GatewaySubnet resource id. */
  gatewaySubnetResourceId: string;
  publicIpResourceId: string;
  settings: LabVpnGatewaySettings;
}

/**
 * PUT the VPN gateway (legacy New-AzVirtualNetworkGateway shape: gwIpConfig
 * on the GatewaySubnet + public IP, GatewayType Vpn). Provisioning takes
 * 30-45 minutes - the engine polls attempt-bounded and a re-run resumes via
 * the GET-first check.
 */
export function buildVpnGatewayPutRequest(
  input: VpnGatewayPutInput,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: networkPath(
      input.subscriptionId,
      input.resourceGroup,
      "virtualNetworkGateways",
      input.gatewayName,
    ),
    apiVersion: LAB_NETWORK_API_VERSION,
    body: {
      location: input.location,
      properties: {
        ipConfigurations: [
          {
            name: "gwIpConfig",
            properties: {
              subnet: { id: input.gatewaySubnetResourceId },
              publicIPAddress: { id: input.publicIpResourceId },
            },
          },
        ],
        gatewayType: "Vpn",
        vpnType: input.settings.vpnType,
        sku: { name: input.settings.sku, tier: input.settings.sku },
      },
    },
  };
}

/** GET the local network gateway. */
export function buildLocalNetworkGatewayGetRequest(
  subscriptionId: string,
  resourceGroup: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: networkPath(
      subscriptionId,
      resourceGroup,
      "localNetworkGateways",
      LAB_LOCAL_NETWORK_GATEWAY_NAME,
    ),
    apiVersion: LAB_NETWORK_API_VERSION,
  };
}

/** PUT the local network gateway (the on-premises side descriptor). */
export function buildLocalNetworkGatewayPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  location: string,
  onPrem: LabOnPremConnection,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: networkPath(
      subscriptionId,
      resourceGroup,
      "localNetworkGateways",
      LAB_LOCAL_NETWORK_GATEWAY_NAME,
    ),
    apiVersion: LAB_NETWORK_API_VERSION,
    body: {
      location,
      properties: {
        gatewayIpAddress: onPrem.gatewayIpAddress,
        localNetworkAddressSpace: {
          addressPrefixes: [...onPrem.addressSpaces],
        },
      },
    },
  };
}

/** GET the site-to-site connection. */
export function buildVpnConnectionGetRequest(
  subscriptionId: string,
  resourceGroup: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: networkPath(
      subscriptionId,
      resourceGroup,
      "connections",
      LAB_VPN_CONNECTION_NAME,
    ),
    apiVersion: LAB_NETWORK_API_VERSION,
  };
}

/**
 * PUT the IPsec site-to-site connection (legacy defaults: BGP off,
 * policy-based traffic selectors off, platform-default IPsec policies - the
 * shipped config's custom-policy block was disabled).
 */
export function buildVpnConnectionPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  location: string,
  vpnGatewayResourceId: string,
  localGatewayResourceId: string,
  sharedKey: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: networkPath(
      subscriptionId,
      resourceGroup,
      "connections",
      LAB_VPN_CONNECTION_NAME,
    ),
    apiVersion: LAB_NETWORK_API_VERSION,
    body: {
      location,
      properties: {
        connectionType: "IPsec",
        virtualNetworkGateway1: { id: vpnGatewayResourceId },
        localNetworkGateway2: { id: localGatewayResourceId },
        sharedKey,
        enableBgp: false,
        usePolicyBasedTrafficSelectors: false,
      },
    },
  };
}

/**
 * True when the on-prem details are usable: a device IP, at least one
 * address space, and a shared key - with angle-bracket placeholders treated
 * as absent (the legacy skipped the connection for placeholder configs).
 */
export function isOnPremConnectionConfigured(
  onPrem: LabOnPremConnection | undefined,
): onPrem is LabOnPremConnection {
  if (onPrem === undefined) {
    return false;
  }
  const isPlaceholder = (value: string): boolean => {
    const trimmed = value.trim();
    return trimmed === "" || (trimmed.startsWith("<") && trimmed.endsWith(">"));
  };
  return (
    !isPlaceholder(onPrem.gatewayIpAddress) &&
    onPrem.addressSpaces.length > 0 &&
    onPrem.addressSpaces.every((space) => !isPlaceholder(space)) &&
    !isPlaceholder(onPrem.sharedKey)
  );
}
