/**
 * Lab flow-log request builders - roadmap Phase 5 (LAB-08: vNet flow logs
 * through the regional Network Watcher).
 *
 * Ported from the legacy UnifiedLab Phase6-NetworkMonitoring/Deploy-FlowLogs.ps1:
 * - Network Watcher resolution order, verbatim: the lab's own named watcher
 *   in the lab resource group first, then Azure's auto-created
 *   NetworkWatcherRG/NetworkWatcher_{location}, else create the lab's own.
 * - The dual-level flow-log layout: one vNet-level flow log (the fallback,
 *   7-day retention) plus per-subnet overrides exploiting Azure's
 *   NIC > Subnet > VNet precedence (gateway 1d, security 7d, o11y 7d,
 *   privatelink 1d in the shipped config).
 * - Flow-log names, verbatim: FlowLog-{vnet} / FlowLog-{vnet}-{subnet}.
 * - "CannotCreateMoreThanOneFlowLogPerTargetResource" is an idempotent HIT
 *   (the legacy treated it as already-exists), surfaced via
 *   {@link isFlowLogAlreadyExistsError} for the engine to branch on.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import { LAB_NETWORK_API_VERSION } from "./lab-networking";

/** Azure's auto-created Network Watcher resource group (well-known name). */
export const AZURE_NETWORK_WATCHER_RG = "NetworkWatcherRG";

/** Azure's auto-created per-region Network Watcher name. */
export function azureDefaultNetworkWatcherName(location: string): string {
  return `NetworkWatcher_${location}`;
}

/** Per-level flow-log retention settings (legacy monitoring.flowLogging). */
export interface LabFlowLogSettings {
  /** vNet-level fallback flow log (legacy vnetLevel). */
  vnetLevel: { enabled: boolean; retentionDays: number };
  /** Per-subnet overrides keyed by subnet KEY (legacy subnetLevel). */
  subnetLevel: Record<string, { enabled: boolean; retentionDays: number }>;
}

/** The legacy shipped retention layout, verbatim. */
export const DEFAULT_LAB_FLOW_LOG_SETTINGS: LabFlowLogSettings = {
  vnetLevel: { enabled: true, retentionDays: 7 },
  subnetLevel: {
    gateway: { enabled: true, retentionDays: 1 },
    security: { enabled: true, retentionDays: 7 },
    o11y: { enabled: true, retentionDays: 7 },
    privatelink: { enabled: true, retentionDays: 1 },
  },
};

/** Flow-log resource names (legacy, verbatim). */
export function labFlowLogName(vnetName: string, subnetName?: string): string {
  return subnetName === undefined
    ? `FlowLog-${vnetName}`
    : `FlowLog-${vnetName}-${subnetName}`;
}

function networkWatcherPath(
  subscriptionId: string,
  resourceGroup: string,
  watcherName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Network/networkWatchers/${watcherName}`
  );
}

/** GET one Network Watcher. */
export function buildNetworkWatcherGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  watcherName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: networkWatcherPath(subscriptionId, resourceGroup, watcherName),
    apiVersion: LAB_NETWORK_API_VERSION,
  };
}

/** PUT the lab's own Network Watcher (the legacy create fallback). */
export function buildNetworkWatcherPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  watcherName: string,
  location: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: networkWatcherPath(subscriptionId, resourceGroup, watcherName),
    apiVersion: LAB_NETWORK_API_VERSION,
    body: { location, properties: {} },
  };
}

/** Inputs for {@link buildFlowLogPutRequest}. */
export interface FlowLogPutInput {
  subscriptionId: string;
  /** The RESOLVED Network Watcher's resource group (may be NetworkWatcherRG). */
  networkWatcherResourceGroup: string;
  networkWatcherName: string;
  flowLogName: string;
  location: string;
  /** The VNet or subnet resource id the flow log targets. */
  targetResourceId: string;
  /** The lab storage account resource id the logs land in. */
  storageAccountResourceId: string;
  retentionDays: number;
}

/** GET one flow log on the resolved Network Watcher. */
export function buildFlowLogGetRequest(
  subscriptionId: string,
  networkWatcherResourceGroup: string,
  networkWatcherName: string,
  flowLogName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      networkWatcherPath(
        subscriptionId,
        networkWatcherResourceGroup,
        networkWatcherName,
      ) + `/flowLogs/${flowLogName}`,
    apiVersion: LAB_NETWORK_API_VERSION,
  };
}

/**
 * PUT one flow log (the legacy Set-AzNetworkWatcherFlowLog): enabled, JSON
 * format version 2, retention from the level's settings.
 */
export function buildFlowLogPutRequest(input: FlowLogPutInput): AzureManagementRequest {
  return {
    method: "PUT",
    path:
      networkWatcherPath(
        input.subscriptionId,
        input.networkWatcherResourceGroup,
        input.networkWatcherName,
      ) + `/flowLogs/${input.flowLogName}`,
    apiVersion: LAB_NETWORK_API_VERSION,
    body: {
      location: input.location,
      properties: {
        targetResourceId: input.targetResourceId,
        storageId: input.storageAccountResourceId,
        enabled: true,
        retentionPolicy: { days: input.retentionDays, enabled: true },
        format: { type: "JSON", version: 2 },
      },
    },
  };
}

/**
 * True when an ARM error body is the one-flow-log-per-target conflict the
 * legacy treated as already-exists (a target resource can carry only ONE
 * flow log; a second PUT under a different name conflicts).
 */
export function isFlowLogAlreadyExistsError(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const error = (body as Record<string, unknown>)["error"];
  const code =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)["code"]
      : (body as Record<string, unknown>)["code"];
  return (
    typeof code === "string" &&
    code.toLowerCase() === "cannotcreatemorethanoneflowlogpertargetresource"
  );
}
