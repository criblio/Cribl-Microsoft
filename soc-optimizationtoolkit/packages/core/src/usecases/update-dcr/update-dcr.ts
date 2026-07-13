/**
 * UPDATE A DCR IN PLACE - the per-row action of the DCR inventory (user
 * request 2026-07-13: the inventory listed DCRs but offered no way to
 * modify them). Rebuilds the Kind:Direct DCR body from the table's CURRENT
 * Log Analytics schema and PUTs it over the existing name - an ARM upsert,
 * so the immutableId and every ingestion client keep working.
 *
 * This is the schema-refresh HALF of updating; the full onboard flow
 * (Single tab with `updateExistingDcr`) additionally re-wires the Cribl
 * destination. Reuses the SAME builders as onboardTable
 * (selectSchemaColumns + buildDirectDcrRequest) so the updated body can
 * never drift from what a fresh deploy would create.
 *
 * Orchestration over the AzureManagement port; unit-tested with the
 * in-memory fake.
 */

import type { AzureManagement } from "../../ports";
import { buildDirectDcrRequest } from "../../domain/dcr-request";
import { selectSchemaColumns } from "../../domain/schema-mapping";
import type { LogAnalyticsColumn } from "../../domain/schema-mapping";
import { LOG_ANALYTICS_API_VERSION } from "../onboard-table";

export interface UpdateDcrInput {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  /** The EXISTING DCR's name - the PUT lands on it (upsert). */
  dcrName: string;
  /** The destination table whose current schema the DCR is rebuilt from. */
  table: string;
  /** The DCR's location (from the inventory row). */
  location: string;
  /** Poll attempts for provisioningState Succeeded (default 5). */
  maxPollAttempts?: number;
}

export interface UpdateDcrResult {
  dcrName: string;
  table: string;
  /** Columns in the refreshed stream declaration. */
  columnCount: number;
  provisioningState: string;
}

function prop(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Refresh one Kind:Direct DCR from its table's current schema. Throws with
 * the failing call's status on any error - the caller renders it verbatim.
 */
export async function updateDcrInPlace(
  azure: AzureManagement,
  input: UpdateDcrInput,
): Promise<UpdateDcrResult> {
  const workspacePath =
    `/subscriptions/${input.subscriptionId}` +
    `/resourceGroups/${input.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${input.workspaceName}`;
  const isCustom = input.table.endsWith("_CL");

  // 1. The table's CURRENT schema is the authority for the rebuilt body.
  const tableResponse = await azure.request({
    method: "GET",
    path: `${workspacePath}/tables/${input.table}`,
    apiVersion: LOG_ANALYTICS_API_VERSION,
  });
  if (tableResponse.status < 200 || tableResponse.status >= 300) {
    throw new Error(
      `fetch schema for table '${input.table}': HTTP ${tableResponse.status}`,
    );
  }
  const schema = prop(prop(tableResponse.body, "properties"), "schema");
  const columns = selectSchemaColumns(
    {
      columns: prop(schema, "columns") as LogAnalyticsColumn[] | undefined,
      standardColumns: prop(schema, "standardColumns") as
        | LogAnalyticsColumn[]
        | undefined,
    },
    isCustom ? "custom" : "native",
  );
  if (columns === null) {
    throw new Error(
      `table '${input.table}' has no usable column source in its schema response`,
    );
  }

  // 2. The SAME body a fresh deploy would create, PUT over the same name.
  const request = buildDirectDcrRequest({
    table: input.table,
    columns,
    location: input.location,
    workspaceResourceId: workspacePath,
    dcrName: input.dcrName,
    tableMode: isCustom ? "custom" : "native",
  });
  const putResponse = await azure.request({
    method: request.method,
    path: request.path,
    apiVersion: request.apiVersion,
    body: request.body,
  });
  if (putResponse.status < 200 || putResponse.status >= 300) {
    throw new Error(
      `update DCR '${input.dcrName}': HTTP ${putResponse.status} ` +
        JSON.stringify(putResponse.body).slice(0, 300),
    );
  }

  // 3. Poll to Succeeded (an upsert usually completes synchronously).
  let state = String(
    prop(prop(putResponse.body, "properties"), "provisioningState") ?? "",
  );
  const maxAttempts = input.maxPollAttempts ?? 5;
  let attempts = 0;
  while (state.toLowerCase() !== "succeeded") {
    if (/^(failed|canceled)$/i.test(state)) {
      throw new Error(
        `DCR '${input.dcrName}' provisioning ended in state '${state}'`,
      );
    }
    if (attempts >= maxAttempts) {
      throw new Error(
        `DCR '${input.dcrName}' did not reach Succeeded within ` +
          `${maxAttempts} poll attempts (last state '${state || "unknown"}')`,
      );
    }
    attempts++;
    const poll = await azure.request({
      method: "GET",
      path: request.path,
      apiVersion: request.apiVersion,
    });
    if (poll.status < 200 || poll.status >= 300) {
      throw new Error(`poll DCR '${input.dcrName}': HTTP ${poll.status}`);
    }
    state = String(
      prop(prop(poll.body, "properties"), "provisioningState") ?? "",
    );
  }

  return {
    dcrName: input.dcrName,
    table: input.table,
    columnCount: columns.length,
    provisioningState: state,
  };
}
