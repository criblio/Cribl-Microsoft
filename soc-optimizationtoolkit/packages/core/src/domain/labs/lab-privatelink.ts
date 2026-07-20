/**
 * Lab Private Link (AMPLS) request builders - roadmap Phase 5 (the LAB-06
 * private half: Azure Monitor Private Link Scope, scoped workspace, private
 * endpoint, private DNS).
 *
 * Ported from the legacy UnifiedLab Phase4-Monitoring/Deploy-PrivateLink.ps1:
 * - AMPLS "ampls-{base}-{location}" at location GLOBAL, the "{ampls}-law"
 *   scoped resource linking the workspace, and the "pe-ampls-{base}" private
 *   endpoint in the PrivateLinkSubnet with the azuremonitor group id -
 *   names and shapes verbatim.
 * - The privatelink.monitor.azure.com private DNS zone with a
 *   "link-to-{vnet}" virtual-network link.
 *
 * Recorded deviations:
 * - The endpoint's subnet needs privateEndpointNetworkPolicies Disabled; the
 *   legacy flipped it lazily with a second VNet write - here the VNet PUT
 *   sets it up front on the PrivateLinkSubnet (lab-networking honors
 *   {@link LabSubnet.disablePrivateEndpointNetworkPolicies}).
 * - The legacy DNS-zone block was gated on a config key
 *   (createPrivateDnsZone) that the SHIPPED config never defined, so it
 *   silently never ran and private resolution was broken out of the box.
 *   The engine deploys the zone by default (an explicit opt-out exists).
 * - The AMPLS body carries accessModeSettings Open/Open - REQUIRED by the
 *   2021-07-01-preview api-version the resource is addressed with (the
 *   legacy's empty property bag rode an older implicit default).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import { LAB_NETWORK_API_VERSION } from "./lab-networking";

/** ARM api-version for microsoft.insights/privateLinkScopes (+ scoped resources). */
export const LAB_AMPLS_API_VERSION = "2021-07-01-preview";

/** ARM api-version for Microsoft.Network/privateDnsZones (+ links). */
export const LAB_PRIVATE_DNS_API_VERSION = "2020-06-01";

/** The Azure Monitor private DNS zone the legacy created. */
export const LAB_MONITOR_PRIVATE_DNS_ZONE = "privatelink.monitor.azure.com";

/** AMPLS name (legacy "ampls-{base}-{location}", verbatim). */
export function labAmplsName(baseObjectName: string, location: string): string {
  return `ampls-${baseObjectName}-${location}`;
}

/** Scoped-resource name (legacy "{ampls}-law", verbatim). */
export function labAmplsScopedResourceName(amplsName: string): string {
  return `${amplsName}-law`;
}

/** Private endpoint name (legacy "pe-ampls-{base}", verbatim). */
export function labPrivateEndpointName(baseObjectName: string): string {
  return `pe-ampls-${baseObjectName}`;
}

function amplsPath(
  subscriptionId: string,
  resourceGroup: string,
  amplsName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/microsoft.insights/privateLinkScopes/${amplsName}`
  );
}

/** GET the AMPLS. */
export function buildAmplsGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  amplsName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: amplsPath(subscriptionId, resourceGroup, amplsName),
    apiVersion: LAB_AMPLS_API_VERSION,
  };
}

/** PUT the AMPLS (location global, Open access modes). */
export function buildAmplsPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  amplsName: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: amplsPath(subscriptionId, resourceGroup, amplsName),
    apiVersion: LAB_AMPLS_API_VERSION,
    body: {
      location: "global",
      properties: {
        accessModeSettings: {
          ingestionAccessMode: "Open",
          queryAccessMode: "Open",
        },
      },
    },
  };
}

/** GET the workspace's scoped-resource association. */
export function buildAmplsScopedResourceGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  amplsName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      amplsPath(subscriptionId, resourceGroup, amplsName) +
      `/scopedResources/${labAmplsScopedResourceName(amplsName)}`,
    apiVersion: LAB_AMPLS_API_VERSION,
  };
}

/** PUT the workspace into the AMPLS (legacy linkedResourceId association). */
export function buildAmplsScopedResourcePutRequest(
  subscriptionId: string,
  resourceGroup: string,
  amplsName: string,
  workspaceResourceId: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path:
      amplsPath(subscriptionId, resourceGroup, amplsName) +
      `/scopedResources/${labAmplsScopedResourceName(amplsName)}`,
    apiVersion: LAB_AMPLS_API_VERSION,
    body: { properties: { linkedResourceId: workspaceResourceId } },
  };
}

function privateEndpointPath(
  subscriptionId: string,
  resourceGroup: string,
  endpointName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Network/privateEndpoints/${endpointName}`
  );
}

/** GET the AMPLS private endpoint. */
export function buildPrivateEndpointGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  endpointName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: privateEndpointPath(subscriptionId, resourceGroup, endpointName),
    apiVersion: LAB_NETWORK_API_VERSION,
  };
}

/**
 * PUT the AMPLS private endpoint in the PrivateLinkSubnet (legacy shape:
 * one service connection to the scope, group id azuremonitor).
 */
export function buildPrivateEndpointPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  endpointName: string,
  location: string,
  subnetResourceId: string,
  amplsResourceId: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: privateEndpointPath(subscriptionId, resourceGroup, endpointName),
    apiVersion: LAB_NETWORK_API_VERSION,
    body: {
      location,
      properties: {
        subnet: { id: subnetResourceId },
        privateLinkServiceConnections: [
          {
            name: `${endpointName}-connection`,
            properties: {
              privateLinkServiceId: amplsResourceId,
              groupIds: ["azuremonitor"],
            },
          },
        ],
      },
    },
  };
}

function dnsZonePath(
  subscriptionId: string,
  resourceGroup: string,
  zoneName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Network/privateDnsZones/${zoneName}`
  );
}

/** GET the monitor private DNS zone. */
export function buildPrivateDnsZoneGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  zoneName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: dnsZonePath(subscriptionId, resourceGroup, zoneName),
    apiVersion: LAB_PRIVATE_DNS_API_VERSION,
  };
}

/** PUT the monitor private DNS zone (global). */
export function buildPrivateDnsZonePutRequest(
  subscriptionId: string,
  resourceGroup: string,
  zoneName: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: dnsZonePath(subscriptionId, resourceGroup, zoneName),
    apiVersion: LAB_PRIVATE_DNS_API_VERSION,
    body: { location: "global", properties: {} },
  };
}

/** The DNS zone's VNet link name (legacy "link-to-{vnet}", verbatim). */
export function labDnsVnetLinkName(vnetName: string): string {
  return `link-to-${vnetName}`;
}

/** GET the zone's VNet link. */
export function buildDnsVnetLinkGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  zoneName: string,
  vnetName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      dnsZonePath(subscriptionId, resourceGroup, zoneName) +
      `/virtualNetworkLinks/${labDnsVnetLinkName(vnetName)}`,
    apiVersion: LAB_PRIVATE_DNS_API_VERSION,
  };
}

/** PUT the zone's VNet link (no auto-registration - resolution only). */
export function buildDnsVnetLinkPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  zoneName: string,
  vnetName: string,
  vnetResourceId: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path:
      dnsZonePath(subscriptionId, resourceGroup, zoneName) +
      `/virtualNetworkLinks/${labDnsVnetLinkName(vnetName)}`,
    apiVersion: LAB_PRIVATE_DNS_API_VERSION,
    body: {
      location: "global",
      properties: {
        virtualNetwork: { id: vnetResourceId },
        registrationEnabled: false,
      },
    },
  };
}
