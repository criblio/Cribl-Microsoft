/**
 * DCR INVENTORY - list the resource group's existing Data Collection Rules
 * with the details an operator needs to audit and update them (user request
 * 2026-07-13: "inventory existing DCRs and update them" on the DCR
 * Automation page). Updating rides the existing onboardTable usecase with
 * its `updateExistingDcr` flag - this module is the READ side.
 *
 * Orchestration over the AzureManagement port; unit-tested with the
 * in-memory fake (constructor init `{dataCollectionRulesList}`).
 */

import type { AzureManagement } from "../../ports";

/** ARM api-version for Microsoft.Insights dataCollectionRules. */
const DCR_API_VERSION = "2023-03-11";

/** One inventoried Data Collection Rule. */
export interface DcrInventoryEntry {
  name: string;
  location: string;
  /** "Direct" for Kind:Direct DCRs; "" when ARM reports no kind. */
  kind: string;
  immutableId: string;
  /** The logs ingestion endpoint (Direct DCRs); "" when absent. */
  ingestionEndpoint: string;
  /** Destination tables, from each dataFlow's outputStream (prefix stripped). */
  tables: string[];
  provisioningState: string;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Parse one ARM DCR resource into an inventory entry (defensive). */
export function parseDcrInventoryEntry(item: unknown): DcrInventoryEntry | null {
  const resource = rec(item);
  if (resource === null || str(resource["name"]) === "") return null;
  const props = rec(resource["properties"]) ?? {};
  const endpoints = rec(props["endpoints"]) ?? {};
  const flows = Array.isArray(props["dataFlows"]) ? props["dataFlows"] : [];
  const tables: string[] = [];
  for (const flow of flows) {
    const outputStream = str(rec(flow)?.["outputStream"]);
    if (outputStream === "") continue;
    const table = outputStream.replace(/^(Custom|Microsoft)-/, "");
    if (!tables.includes(table)) tables.push(table);
  }
  return {
    name: str(resource["name"]),
    location: str(resource["location"]),
    kind: str(resource["kind"]),
    immutableId: str(props["immutableId"]),
    ingestionEndpoint: str(endpoints["logsIngestion"]),
    tables,
    provisioningState: str(props["provisioningState"]),
  };
}

/**
 * List the resource group's DCRs. Throws on a failed listing (an inventory
 * must never silently read as empty - the pack pre-check taught us that).
 */
export async function listDcrInventory(
  azure: AzureManagement,
  scope: { subscriptionId: string; resourceGroup: string },
): Promise<DcrInventoryEntry[]> {
  const response = await azure.request({
    method: "GET",
    path:
      `/subscriptions/${scope.subscriptionId}` +
      `/resourceGroups/${scope.resourceGroup}` +
      `/providers/Microsoft.Insights/dataCollectionRules`,
    apiVersion: DCR_API_VERSION,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `list DCRs in '${scope.resourceGroup}': HTTP ${response.status}`,
    );
  }
  const value = rec(response.body)?.["value"];
  if (!Array.isArray(value)) return [];
  const entries: DcrInventoryEntry[] = [];
  for (const item of value) {
    const entry = parseDcrInventoryEntry(item);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}
