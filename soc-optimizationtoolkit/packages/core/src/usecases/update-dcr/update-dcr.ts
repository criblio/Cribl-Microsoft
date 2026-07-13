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
import {
  buildDceDcrRequest,
  buildDirectDcrRequest,
} from "../../domain/dcr-request";
import { selectSchemaColumns } from "../../domain/schema-mapping";
import type { LogAnalyticsColumn } from "../../domain/schema-mapping";
import { LOG_ANALYTICS_API_VERSION } from "../onboard-table";

export interface UpdateDcrInput {
  subscriptionId: string;
  /** The WORKSPACE's resource group (table schema reads live here). */
  resourceGroup: string;
  workspaceName: string;
  /** The EXISTING DCR's name - the PUT lands on it (upsert). */
  dcrName: string;
  /** The destination table whose current schema the DCR is rebuilt from. */
  table: string;
  /** The DCR's location (from the inventory row). */
  location: string;
  /**
   * The resource group the DCR LIVES IN when it differs from the
   * workspace's (the inventory can browse any group in the subscription,
   * 2026-07-13). Defaults to {@link resourceGroup}.
   */
  dcrResourceGroup?: string;
  /**
   * The DCE resource id for a DCE-BASED DCR (they carry no kind but do
   * carry this id + stream declarations). Present = the rebuilt body is
   * the DCE variant with this endpoint preserved; absent = Kind:Direct.
   */
  dceResourceId?: string;
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
 * The table's ingestable columns for a DCR rebuild. NATIVE tables can carry
 * custom `_CF` columns (user correction 2026-07-13) - they live in the
 * schema's `columns` array while the built-ins live in `standardColumns`,
 * and selectSchemaColumns picks ONE source; the rebuild needs BOTH, so the
 * custom columns are merged in after the standard selection.
 */
function resolveTableColumns(
  schema: unknown,
  isCustom: boolean,
): LogAnalyticsColumn[] | null {
  const columns = prop(schema, "columns") as LogAnalyticsColumn[] | undefined;
  const standardColumns = prop(schema, "standardColumns") as
    | LogAnalyticsColumn[]
    | undefined;
  const selected = selectSchemaColumns(
    { columns, standardColumns },
    isCustom ? "custom" : "native",
  );
  if (selected === null) return null;
  if (isCustom || !Array.isArray(columns)) return selected;
  const present = new Set(selected.map((c) => c.name.toLowerCase()));
  const merged = [...selected];
  for (const column of columns) {
    if (
      typeof column?.name === "string" &&
      !present.has(column.name.toLowerCase())
    ) {
      merged.push(column);
    }
  }
  return merged;
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
  const columns = resolveTableColumns(schema, isCustom);
  if (columns === null) {
    throw new Error(
      `table '${input.table}' has no usable column source in its schema response`,
    );
  }

  // 2. The SAME body a fresh deploy would create, PUT over the same name -
  // the DCE variant (endpoint preserved) when the DCR is DCE-based. The
  // path targets the DCR's OWN resource group (which can differ from the
  // workspace's) - the builder derives its path from the workspace, so it
  // is overridden here.
  const requestInput = {
    table: input.table,
    columns,
    location: input.location,
    workspaceResourceId: workspacePath,
    dcrName: input.dcrName,
    tableMode: isCustom ? ("custom" as const) : ("native" as const),
  };
  const request =
    input.dceResourceId !== undefined && input.dceResourceId !== ""
      ? buildDceDcrRequest({
          ...requestInput,
          dataCollectionEndpointId: input.dceResourceId,
        })
      : buildDirectDcrRequest(requestInput);
  const dcrPath =
    `/subscriptions/${input.subscriptionId}` +
    `/resourceGroups/${input.dcrResourceGroup ?? input.resourceGroup}` +
    `/providers/Microsoft.Insights/dataCollectionRules/${input.dcrName}`;
  const putResponse = await azure.request({
    method: request.method,
    path: dcrPath,
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
      path: dcrPath,
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

// ---------------------------------------------------------------------------
// Preview: current vs rebuilt schema, with the differences named
// ---------------------------------------------------------------------------

/** The named differences between two column sets. */
export interface ColumnDiff {
  added: LogAnalyticsColumn[];
  removed: LogAnalyticsColumn[];
  retyped: Array<{ name: string; from: string; to: string }>;
  unchanged: number;
}

/** Diff two column lists by (case-insensitive) name. Pure. */
export function diffColumns(
  before: readonly LogAnalyticsColumn[],
  after: readonly LogAnalyticsColumn[],
): ColumnDiff {
  const beforeByName = new Map(before.map((c) => [c.name.toLowerCase(), c]));
  const afterByName = new Map(after.map((c) => [c.name.toLowerCase(), c]));
  const added: LogAnalyticsColumn[] = [];
  const retyped: Array<{ name: string; from: string; to: string }> = [];
  let unchanged = 0;
  for (const column of after) {
    const prior = beforeByName.get(column.name.toLowerCase());
    if (prior === undefined) {
      added.push(column);
    } else if (prior.type !== column.type) {
      retyped.push({ name: column.name, from: prior.type, to: column.type });
    } else {
      unchanged++;
    }
  }
  const removed = before.filter(
    (c) => !afterByName.has(c.name.toLowerCase()),
  );
  return { added, removed, retyped, unchanged };
}

/** The before/after view of one DCR update (user request 2026-07-13). */
export interface DcrUpdatePreview {
  dcrName: string;
  table: string;
  /** The table's current Log Analytics schema columns. */
  tableColumns: LogAnalyticsColumn[];
  /** The DCR's CURRENT stream-declaration columns (before). */
  currentDcrColumns: LogAnalyticsColumn[];
  /** The stream-declaration columns an update would install (after). */
  rebuiltDcrColumns: LogAnalyticsColumn[];
  /** rebuilt vs current - what the update would change in the DCR. */
  diff: ColumnDiff;
}

function declarationColumns(dcrBody: unknown): LogAnalyticsColumn[] {
  const declarations = prop(prop(dcrBody, "properties"), "streamDeclarations");
  if (typeof declarations !== "object" || declarations === null) return [];
  // A Direct DCR carries ONE declaration; tolerate several by concatenating.
  const out: LogAnalyticsColumn[] = [];
  for (const declaration of Object.values(
    declarations as Record<string, unknown>,
  )) {
    const columns = prop(declaration, "columns");
    if (!Array.isArray(columns)) continue;
    for (const column of columns) {
      const name = prop(column, "name");
      const type = prop(column, "type");
      if (typeof name === "string" && typeof type === "string") {
        out.push({ name, type });
      }
    }
  }
  return out;
}

/**
 * Compute the before/after of updating a DCR from its table's current
 * schema WITHOUT changing anything: the DCR's live stream declaration vs
 * the declaration a rebuild would install, with the differences named.
 */
export async function previewDcrUpdate(
  azure: AzureManagement,
  input: UpdateDcrInput,
): Promise<DcrUpdatePreview> {
  const workspacePath =
    `/subscriptions/${input.subscriptionId}` +
    `/resourceGroups/${input.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${input.workspaceName}`;
  const isCustom = input.table.endsWith("_CL");

  const dcrResponse = await azure.request({
    method: "GET",
    path:
      `/subscriptions/${input.subscriptionId}` +
      `/resourceGroups/${input.dcrResourceGroup ?? input.resourceGroup}` +
      `/providers/Microsoft.Insights/dataCollectionRules/${input.dcrName}`,
    apiVersion: "2023-03-11",
  });
  if (dcrResponse.status < 200 || dcrResponse.status >= 300) {
    throw new Error(
      `fetch DCR '${input.dcrName}': HTTP ${dcrResponse.status}`,
    );
  }
  const currentDcrColumns = declarationColumns(dcrResponse.body);

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
  const tableColumns = resolveTableColumns(schema, isCustom);
  if (tableColumns === null) {
    throw new Error(
      `table '${input.table}' has no usable column source in its schema response`,
    );
  }

  const previewInput = {
    table: input.table,
    columns: tableColumns,
    location: input.location,
    workspaceResourceId: workspacePath,
    dcrName: input.dcrName,
    tableMode: isCustom ? ("custom" as const) : ("native" as const),
  };
  const request =
    input.dceResourceId !== undefined && input.dceResourceId !== ""
      ? buildDceDcrRequest({
          ...previewInput,
          dataCollectionEndpointId: input.dceResourceId,
        })
      : buildDirectDcrRequest(previewInput);
  const rebuiltDcrColumns = declarationColumns(request.body);

  return {
    dcrName: input.dcrName,
    table: input.table,
    tableColumns,
    currentDcrColumns,
    rebuiltDcrColumns,
    diff: diffColumns(currentDcrColumns, rebuiltDcrColumns),
  };
}

// ---------------------------------------------------------------------------
// Add a custom column to a custom (_CL) table
// ---------------------------------------------------------------------------

/** Column types the Log Analytics tables API accepts for custom columns. */
export const CUSTOM_COLUMN_TYPES = [
  "string",
  "int",
  "long",
  "real",
  "boolean",
  "datetime",
  "dynamic",
] as const;

/**
 * Add one custom column to a CUSTOM (_CL) table. Native Azure table schemas
 * are fixed - this throws for them with the reason. PATCHes only the schema
 * columns (never plan/retention), then the caller re-previews and updates
 * the DCR so the new column becomes ingestable.
 */
export async function addTableColumn(
  azure: AzureManagement,
  input: {
    subscriptionId: string;
    resourceGroup: string;
    workspaceName: string;
    table: string;
    column: { name: string; type: string };
  },
): Promise<{ table: string; columnName: string; columnCount: number }> {
  // Native tables DO accept custom columns (user correction 2026-07-13) -
  // Azure requires their names to end in _CF; custom (_CL) tables have no
  // suffix rule. The suffix is appended automatically when missing.
  const isCustomTable = input.table.endsWith("_CL");
  let name = input.column.name.trim();
  if (!isCustomTable && !name.endsWith("_CF")) {
    name = `${name}_CF`;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `column name '${name}' is invalid - letters, digits, and underscores only, not starting with a digit`,
    );
  }
  if (!(CUSTOM_COLUMN_TYPES as readonly string[]).includes(input.column.type)) {
    throw new Error(
      `column type '${input.column.type}' is not one of: ${CUSTOM_COLUMN_TYPES.join(", ")}`,
    );
  }

  const tablePath =
    `/subscriptions/${input.subscriptionId}` +
    `/resourceGroups/${input.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${input.workspaceName}` +
    `/tables/${input.table}`;
  const current = await azure.request({
    method: "GET",
    path: tablePath,
    apiVersion: LOG_ANALYTICS_API_VERSION,
  });
  if (current.status < 200 || current.status >= 300) {
    throw new Error(`fetch table '${input.table}': HTTP ${current.status}`);
  }
  const schema = prop(prop(current.body, "properties"), "schema");
  const existing = (
    Array.isArray(prop(schema, "columns"))
      ? (prop(schema, "columns") as LogAnalyticsColumn[])
      : []
  ).filter((c) => typeof c?.name === "string");
  const standard = Array.isArray(prop(schema, "standardColumns"))
    ? (prop(schema, "standardColumns") as LogAnalyticsColumn[])
    : [];
  const taken = new Set(
    [...existing, ...standard].map((c) => c.name.toLowerCase()),
  );
  if (taken.has(name.toLowerCase())) {
    throw new Error(`column '${name}' already exists on '${input.table}'`);
  }

  const columns = [...existing.map((c) => ({ name: c.name, type: c.type })), { name, type: input.column.type }];
  const patch = await azure.request({
    method: "PATCH",
    path: tablePath,
    apiVersion: LOG_ANALYTICS_API_VERSION,
    body: { properties: { schema: { name: input.table, columns } } },
  });
  if (patch.status < 200 || patch.status >= 300) {
    // Azure rejects schema changes on SOME built-in tables with an opaque
    // InternalServerError (live 2026-07-13: CommonSecurityLog) - the
    // security-solution tables do not accept custom columns.
    const nativeHint = !isCustomTable
      ? " - note: some built-in tables, notably the security tables" +
        " (CommonSecurityLog, SecurityEvent), do not accept custom columns;" +
        " use the table's DeviceCustom*/FlexString fields or a custom (_CL)" +
        " side table instead"
      : "";
    throw new Error(
      `add column to '${input.table}': HTTP ${patch.status} ` +
        JSON.stringify(patch.body).slice(0, 300) +
        nativeHint,
    );
  }
  return { table: input.table, columnName: name, columnCount: columns.length };
}
