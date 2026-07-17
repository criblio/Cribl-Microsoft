/**
 * Lab networking request builders - roadmap Phase 5 (LAB-03: VNet + NSGs).
 *
 * Ported from the legacy UnifiedLab Phase2-Networking scripts:
 * - Deploy-NSGs.ps1: one NSG per subnet (GatewaySubnet never gets one), with
 *   the VERBATIM rule set - AllowOnPremises_{priority} inbound-allow rules
 *   from priority 100 per configured on-premises address space, and the
 *   AllowAzureServices rule at priority 120 (source AzureCloud service tag).
 * - Deploy-VNet.ps1: the desired-state subnet semantics - the legacy removed
 *   subnets not in the desired list and added missing ones; an ARM VNet PUT
 *   with the full desired subnet array achieves exactly that in ONE request.
 *
 * Recorded deviations:
 * - Deployment order flips: NSGs deploy FIRST, then the VNet PUT carries the
 *   networkSecurityGroup association inline per subnet. The legacy created
 *   the VNet, then the NSGs, then re-wrote the VNet to associate - same end
 *   state, two fewer writes and no window where subnets sit unprotected.
 * - Placeholder on-premises address spaces (angle-bracketed template values
 *   like "<YOUR-ONPREM-CIDR>") are FILTERED OUT of the rule set; the legacy
 *   would have passed them to Azure and failed the whole NSG.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import type { LabSubnet } from "./lab-naming";
import { isValidLabCidr } from "./lab-validation";

/** ARM api-version for Microsoft.Network (VNets, NSGs). */
export const LAB_NETWORK_API_VERSION = "2023-09-01";

/** Network security posture (legacy infrastructure.networkSecurity). */
export interface LabNetworkSecuritySettings {
  /** Allow inbound from the on-premises address spaces (legacy default true). */
  allowOnPremisesTraffic: boolean;
  /** Allow inbound from the AzureCloud service tag (legacy default true). */
  allowAzureServices: boolean;
  /** On-premises CIDR blocks the allow rules cover (legacy onPremisesNetwork). */
  onPremisesAddressSpaces: readonly string[];
}

/** The legacy defaults; the on-prem list ships empty (placeholders dropped). */
export const DEFAULT_LAB_NETWORK_SECURITY: LabNetworkSecuritySettings = {
  allowOnPremisesTraffic: true,
  allowAzureServices: true,
  onPremisesAddressSpaces: [],
};

/** One inline NSG security rule (ARM securityRules entry). */
export interface LabNsgRule {
  name: string;
  properties: {
    priority: number;
    direction: "Inbound";
    access: "Allow";
    protocol: "*";
    sourceAddressPrefix: string;
    sourcePortRange: "*";
    destinationAddressPrefix: "*";
    destinationPortRange: "*";
  };
}

/**
 * The NSG rule set (legacy Deploy-NSGs.ps1, verbatim names/priorities):
 * AllowOnPremises_{100+i} per valid on-premises CIDR, then AllowAzureServices
 * at 120. Placeholder/malformed on-prem entries are dropped, never emitted.
 */
export function labNsgSecurityRules(
  security: LabNetworkSecuritySettings,
): LabNsgRule[] {
  const rules: LabNsgRule[] = [];
  if (security.allowOnPremisesTraffic) {
    let priority = 100;
    for (const addressSpace of security.onPremisesAddressSpaces) {
      if (!isValidLabCidr(addressSpace)) {
        continue;
      }
      rules.push({
        name: `AllowOnPremises_${priority}`,
        properties: {
          priority,
          direction: "Inbound",
          access: "Allow",
          protocol: "*",
          sourceAddressPrefix: addressSpace,
          sourcePortRange: "*",
          destinationAddressPrefix: "*",
          destinationPortRange: "*",
        },
      });
      priority++;
    }
  }
  if (security.allowAzureServices) {
    rules.push({
      name: "AllowAzureServices",
      properties: {
        priority: 120,
        direction: "Inbound",
        access: "Allow",
        protocol: "*",
        sourceAddressPrefix: "AzureCloud",
        sourcePortRange: "*",
        destinationAddressPrefix: "*",
        destinationPortRange: "*",
      },
    });
  }
  return rules;
}

function nsgPath(
  subscriptionId: string,
  resourceGroup: string,
  nsgName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Network/networkSecurityGroups/${nsgName}`
  );
}

/** GET one NSG (existence check). */
export function buildNsgGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  nsgName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: nsgPath(subscriptionId, resourceGroup, nsgName),
    apiVersion: LAB_NETWORK_API_VERSION,
  };
}

/** PUT one NSG with the lab rule set. */
export function buildNsgPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  nsgName: string,
  location: string,
  rules: readonly LabNsgRule[],
): AzureManagementRequest {
  return {
    method: "PUT",
    path: nsgPath(subscriptionId, resourceGroup, nsgName),
    apiVersion: LAB_NETWORK_API_VERSION,
    body: {
      location,
      properties: { securityRules: rules.map((rule) => ({ ...rule })) },
    },
  };
}

/** The full ARM id of an NSG in the lab resource group. */
export function labNsgResourceId(
  subscriptionId: string,
  resourceGroup: string,
  nsgName: string,
): string {
  return nsgPath(subscriptionId, resourceGroup, nsgName);
}

function vnetPath(
  subscriptionId: string,
  resourceGroup: string,
  vnetName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Network/virtualNetworks/${vnetName}`
  );
}

/** GET one VNet (existence + provisioningState). */
export function buildVnetGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  vnetName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: vnetPath(subscriptionId, resourceGroup, vnetName),
    apiVersion: LAB_NETWORK_API_VERSION,
  };
}

/** Inputs for {@link buildVnetPutRequest}. */
export interface VnetPutInput {
  subscriptionId: string;
  resourceGroup: string;
  vnetName: string;
  location: string;
  /** The VNet address space (legacy infrastructure.vnetAddressPrefix). */
  vnetCidr: string;
  /** The DESIRED subnet set - the PUT replaces whatever exists (legacy sync). */
  subnets: readonly LabSubnet[];
  /**
   * NSG name per subnet KEY (from LabResourceNames.nsgBySubnet). Subnets
   * without an entry (GatewaySubnet) get no association.
   */
  nsgNameBySubnetKey: Record<string, string>;
}

/**
 * PUT the VNet with the full desired subnet set and inline NSG associations.
 * ARM replaces the subnet collection with the body's array - exactly the
 * legacy remove-stale-add-missing synchronization, in one request.
 */
export function buildVnetPutRequest(input: VnetPutInput): AzureManagementRequest {
  const subnets = input.subnets.map((subnet) => {
    const nsgName = input.nsgNameBySubnetKey[subnet.key];
    return {
      name: subnet.name,
      properties: {
        addressPrefix: subnet.addressPrefix,
        ...(nsgName !== undefined
          ? {
              networkSecurityGroup: {
                id: labNsgResourceId(
                  input.subscriptionId,
                  input.resourceGroup,
                  nsgName,
                ),
              },
            }
          : {}),
      },
    };
  });
  return {
    method: "PUT",
    path: vnetPath(input.subscriptionId, input.resourceGroup, input.vnetName),
    apiVersion: LAB_NETWORK_API_VERSION,
    body: {
      location: input.location,
      properties: {
        addressSpace: { addressPrefixes: [input.vnetCidr] },
        subnets,
      },
    },
  };
}

/** The provisioningState of a VNet GET/PUT body ("" if absent). */
export function parseVnetProvisioningState(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const properties = (body as Record<string, unknown>)["properties"];
  if (typeof properties !== "object" || properties === null) {
    return "";
  }
  const state = (properties as Record<string, unknown>)["provisioningState"];
  return typeof state === "string" ? state : "";
}
