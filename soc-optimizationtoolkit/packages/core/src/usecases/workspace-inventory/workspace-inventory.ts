/**
 * workspace-inventory - discover the Log Analytics / Sentinel workspaces the
 * identity can see across the tenant, and inventory one of them: tables with
 * data in the last 30 days, the sources feeding each, and the daily average
 * volume (MIG-2). The KQL and the fold live in domain/workspace-inventory.
 *
 * QUERY TRANSPORT (MIG-1, measured 2026-08-31 and again 2026-10-29): queries go
 * through the ARM PASSTHROUGH, `POST {workspace ARM id}/query?api-version=
 * 2017-10-01`, so the app's existing management.azure.com proxy and its ARM
 * token are enough. The direct api.loganalytics.io endpoint answers 403 for a
 * management-audience token. Server-side execution of a 30-day breakdown over
 * 14.4M rows measured 0.8s, well inside the proxy's 30s timeout; a far larger
 * workspace may not be, which is why a failed batch falls back to one query per
 * table rather than losing every table in it.
 *
 * UNKNOWN IS NOT ZERO (docs/inventory-standard.md):
 *  - a subscription whose workspace list fails is REPORTED, never dropped;
 *  - a refused or unreadable Usage query THROWS - there is no inventory to
 *    show, and an empty one would be a confident wrong answer;
 *  - a Usage answer with no rows is a VERIFIED `none`. Unlike an ARM list, a
 *    query is not RBAC-filtered into a 200: workspace-context queries need
 *    `workspaces/query/read` and are refused without it. That belief is
 *    MIG-4's to confirm live with a reader-less identity;
 *  - a table whose source breakdown failed keeps its Usage volume and says
 *    the breakdown failed.
 *
 * Pure orchestration over the AzureManagement port; no clock, no timers. Calls
 * are sequential on purpose: the Cribl proxy budget is 100 requests a minute.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { Logger } from "../../ports/logger";
import { asString, httpErrorText, is2xx, prop } from "../arm-http";
import {
  listAllPages,
  listSubscriptions,
  listWorkspaces,
  SENTINEL_SOLUTION_API_VERSION,
} from "../azure-discovery";
import { listingRows, toListing } from "../../domain/inventory-listing";
import type { Listing } from "../../domain/inventory-listing";
import {
  answeredOutcome,
  chunk,
  INVENTORY_TIMESPAN,
  INVENTORY_WINDOW_DAYS,
  inventoryTotals,
  parseQueryResult,
  parseUsageRows,
  sourceBreakdownQuery,
  sourcesFor,
  toInventoryTable,
  USAGE_QUERY,
} from "../../domain/workspace-inventory";
import type {
  InventoryTable,
  InventoryTotals,
  QueryResult,
  SourceReadOutcome,
} from "../../domain/workspace-inventory";

/** api-version of the ARM query passthrough (measured, MIG-1). */
export const WORKSPACE_QUERY_API_VERSION = "2017-10-01";

/** Tables per source-breakdown query before the batch is split. */
export const SOURCE_BATCH_SIZE = 10;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Whether Sentinel is on a workspace; `unknown` when the solutions list failed. */
export type SentinelState = "enabled" | "not-enabled" | "unknown";

export interface DiscoveredWorkspace {
  /** Full ARM resource id - what the query passthrough is addressed by. */
  id: string;
  name: string;
  subscriptionId: string;
  subscriptionName: string;
  resourceGroup: string;
  location: string;
  sentinel: SentinelState;
}

/** A subscription whose workspaces could not be listed. */
export interface DiscoveryFailure {
  subscriptionId: string;
  subscriptionName: string;
  error: string;
}

export interface WorkspaceDiscovery {
  /** `empty` when subscriptions were listed but none had a readable workspace. */
  workspaces: Listing<DiscoveredWorkspace>;
  subscriptionsSearched: number;
  failures: DiscoveryFailure[];
}

export function workspaceArmId(
  subscriptionId: string,
  resourceGroup: string,
  name: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${name}`
  );
}

/**
 * The workspace ids (lower-cased) carrying a SecurityInsights solution in one
 * subscription. Throws when the list cannot be read; the caller maps that to
 * `unknown`, never to `not-enabled`.
 */
async function sentinelWorkspaceIds(
  azure: AzureManagement,
  subscriptionId: string,
): Promise<Set<string>> {
  const items = await listAllPages(
    azure,
    {
      method: "GET",
      path: `/subscriptions/${subscriptionId}/providers/Microsoft.OperationsManagement/solutions`,
      apiVersion: SENTINEL_SOLUTION_API_VERSION,
    },
    `list solutions in subscription '${subscriptionId}'`,
  );
  const ids = new Set<string>();
  for (const item of items) {
    if (!asString(prop(item, "name")).startsWith("SecurityInsights(")) continue;
    const workspaceId = asString(prop(prop(item, "properties"), "workspaceResourceId"));
    if (workspaceId !== "") ids.add(workspaceId.toLowerCase());
  }
  return ids;
}

/**
 * Every workspace the identity can see across its enabled subscriptions,
 * Sentinel-enabled first. A subscription that fails is recorded in `failures`
 * and the search goes on; a failed subscriptions list throws.
 */
export async function discoverWorkspaces(
  azure: AzureManagement,
  options: { logger?: Logger; onProgress?: (message: string) => void } = {},
): Promise<WorkspaceDiscovery> {
  const subscriptions = listingRows(await listSubscriptions(azure, options.logger));
  const workspaces: DiscoveredWorkspace[] = [];
  const failures: DiscoveryFailure[] = [];

  for (const [index, sub] of subscriptions.entries()) {
    const label = sub.displayName || sub.subscriptionId;
    options.onProgress?.(
      `Listing workspaces in ${label} (${index + 1} of ${subscriptions.length})`,
    );
    let listed;
    try {
      listed = await listWorkspaces(azure, sub.subscriptionId, options.logger);
    } catch (error) {
      failures.push({
        subscriptionId: sub.subscriptionId,
        subscriptionName: sub.displayName,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (listed.length === 0) continue;

    let sentinelIds: Set<string> | null = null;
    try {
      sentinelIds = await sentinelWorkspaceIds(azure, sub.subscriptionId);
    } catch (error) {
      options.logger?.warn("workspace-inventory: solutions list failed", {
        subscriptionId: sub.subscriptionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    for (const ws of listed) {
      const id = workspaceArmId(sub.subscriptionId, ws.resourceGroup, ws.name);
      workspaces.push({
        id,
        name: ws.name,
        subscriptionId: sub.subscriptionId,
        subscriptionName: sub.displayName,
        resourceGroup: ws.resourceGroup,
        location: ws.location,
        sentinel:
          sentinelIds === null
            ? "unknown"
            : sentinelIds.has(id.toLowerCase())
              ? "enabled"
              : "not-enabled",
      });
    }
  }

  const rank = (s: SentinelState) => (s === "enabled" ? 0 : s === "unknown" ? 1 : 2);
  workspaces.sort(
    (a, b) => rank(a.sentinel) - rank(b.sentinel) || a.name.localeCompare(b.name),
  );
  return {
    workspaces: toListing(workspaces),
    subscriptionsSearched: subscriptions.length,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface WorkspaceInventory {
  workspaceId: string;
  windowDays: number;
  /** `none` = Usage answered and billed nothing in the window (verified zero). */
  tables: Listing<InventoryTable>;
  totals: InventoryTotals;
  /** Set when the Usage answer itself was partial - the totals are a floor. */
  usageWarning: string | null;
  /** The queries that produced the numbers, for the info affordances. */
  queries: { usage: string; sourcesExample: string | null };
}

/** One query through the ARM passthrough. Throws with greppable text on non-2xx. */
async function runWorkspaceQuery(
  azure: AzureManagement,
  workspaceId: string,
  query: string,
  context: string,
): Promise<QueryResult> {
  const response = await azure.request({
    method: "POST",
    path: `${workspaceId}/query`,
    apiVersion: WORKSPACE_QUERY_API_VERSION,
    body: { query, timespan: INVENTORY_TIMESPAN },
  });
  if (!is2xx(response.status)) {
    throw new Error(httpErrorText(context, response.status, response.body));
  }
  try {
    return parseQueryResult(response.body);
  } catch (error) {
    throw new Error(
      `${context}: HTTP ${response.status} ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readSources(
  azure: AzureManagement,
  workspaceId: string,
  tables: readonly string[],
): Promise<SourceReadOutcome> {
  try {
    const result = await runWorkspaceQuery(
      azure,
      workspaceId,
      sourceBreakdownQuery(tables),
      `source breakdown for ${tables.join(", ")}`,
    );
    return answeredOutcome(result);
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Inventory one workspace. Throws when Usage cannot be read; every later
 * failure is carried on the table it affects.
 */
export async function inventoryWorkspace(
  azure: AzureManagement,
  workspaceId: string,
  options: { logger?: Logger; onProgress?: (message: string) => void } = {},
): Promise<WorkspaceInventory> {
  options.onProgress?.("Reading 30 days of billed volume from the Usage table");
  const usage = await runWorkspaceQuery(azure, workspaceId, USAGE_QUERY, "read Usage");
  const usageRows = parseUsageRows(usage.rows);
  const totals = inventoryTotals(usageRows);

  if (usageRows.length === 0) {
    return {
      workspaceId,
      windowDays: INVENTORY_WINDOW_DAYS,
      // A Usage answer with rows dropped as nameless is still not a verified zero.
      tables: usage.rows.length === 0 && usage.warning === null ? { kind: "none" } : { kind: "empty" },
      totals,
      usageWarning: usage.warning,
      queries: { usage: USAGE_QUERY, sourcesExample: null },
    };
  }

  const tables: InventoryTable[] = [];
  const batches = chunk(
    usageRows.map((r) => r.table),
    SOURCE_BATCH_SIZE,
  );
  const byTable = new Map(usageRows.map((r) => [r.table, r]));
  for (const [index, batch] of batches.entries()) {
    options.onProgress?.(
      `Reading sources for tables ${index * SOURCE_BATCH_SIZE + 1}-` +
        `${index * SOURCE_BATCH_SIZE + batch.length} of ${usageRows.length}`,
    );
    const outcome = await readSources(azure, workspaceId, batch);
    if (outcome.kind === "failed" && batch.length > 1) {
      // One slow or unreadable table must not cost the batch its breakdown.
      options.logger?.warn("workspace-inventory: source batch failed, splitting", {
        tables: batch.length,
        error: outcome.error,
      });
      for (const table of batch) {
        const single = await readSources(azure, workspaceId, [table]);
        tables.push(toInventoryTable(byTable.get(table)!, sourcesFor(table, single)));
      }
      continue;
    }
    for (const table of batch) {
      tables.push(toInventoryTable(byTable.get(table)!, sourcesFor(table, outcome)));
    }
  }

  options.logger?.info("workspace-inventory: inventory read", {
    tables: tables.length,
    sourceFailures: tables.filter((t) => t.sources.kind === "failed").length,
    dailyAverageMB: Math.round(totals.dailyAverageMB),
  });
  return {
    workspaceId,
    windowDays: INVENTORY_WINDOW_DAYS,
    tables: toListing(tables),
    totals,
    usageWarning: usage.warning,
    queries: { usage: USAGE_QUERY, sourcesExample: sourceBreakdownQuery(batches[0]!) },
  };
}
