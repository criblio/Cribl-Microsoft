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
import { hasEffectiveAction } from "../../domain/azure-permissions";
import type { PermissionsResponse } from "../../domain/azure-permissions";
import { RBAC_PERMISSIONS_API_VERSION } from "../permission-preflight";
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
// Permission check: verify the write actions BEFORE attempting an update
// ---------------------------------------------------------------------------

/** The write action a DCR update PUTs with. */
export const DCR_WRITE_ACTION = "Microsoft.Insights/dataCollectionRules/write";
/** The write action a table schema edit PATCHes with. */
export const TABLE_WRITE_ACTION =
  "Microsoft.OperationalInsights/workspaces/tables/write";

/** Result of the pre-update permission check. */
export interface DcrUpdatePermissionCheck {
  /** True when every checked write action is granted. */
  granted: boolean;
  /** The missing actions, each with the scope it was checked at. */
  missing: Array<{ action: string; scope: string }>;
  /**
   * True when the RBAC permissions API itself was unreadable - the check is
   * FAIL-OPEN then (granted true, nothing blocked): the real update carries
   * its own ARM error, and an unreadable permissions endpoint must not
   * paralyze a principal that can in fact write.
   */
  indeterminate: boolean;
}

async function effectivePermissionsAt(
  azure: AzureManagement,
  scope: string,
): Promise<PermissionsResponse | null> {
  try {
    const response = await azure.request({
      method: "GET",
      path: `${scope}/providers/Microsoft.Authorization/permissions`,
      apiVersion: RBAC_PERMISSIONS_API_VERSION,
    });
    if (response.status < 200 || response.status >= 300) return null;
    const value = prop(response.body, "value");
    if (!Array.isArray(value)) return null;
    return {
      value: value.map((element) => ({
        actions: Array.isArray(prop(element, "actions"))
          ? (prop(element, "actions") as string[])
          : [],
        notActions: Array.isArray(prop(element, "notActions"))
          ? (prop(element, "notActions") as string[])
          : [],
        dataActions: [],
        notDataActions: [],
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Check the caller's effective RBAC permissions for a DCR update BEFORE
 * attempting it (user request 2026-07-13): dataCollectionRules/write at the
 * DCR's resource group, plus workspaces/tables/write at the workspace's
 * group when a table schema edit is part of the action.
 */
export async function checkDcrUpdatePermissions(
  azure: AzureManagement,
  input: {
    subscriptionId: string;
    /** The resource group the DCR lives in (the PUT scope). */
    dcrResourceGroup: string;
    /** The workspace's resource group (table edits land here). */
    workspaceResourceGroup?: string;
    /** Also require the table schema-edit action (add/remove field). */
    includeTableEdit?: boolean;
  },
): Promise<DcrUpdatePermissionCheck> {
  const rgScope = (rg: string) =>
    `/subscriptions/${input.subscriptionId}/resourceGroups/${rg}`;
  const dcrScope = rgScope(input.dcrResourceGroup);
  const missing: Array<{ action: string; scope: string }> = [];
  let indeterminate = false;

  const dcrPerms = await effectivePermissionsAt(azure, dcrScope);
  if (dcrPerms === null) {
    indeterminate = true;
  } else if (!hasEffectiveAction(dcrPerms, DCR_WRITE_ACTION)) {
    missing.push({ action: DCR_WRITE_ACTION, scope: dcrScope });
  }

  if (input.includeTableEdit === true && input.workspaceResourceGroup) {
    const tableScope = rgScope(input.workspaceResourceGroup);
    // Same scope: reuse the response instead of a second GET.
    const tablePerms =
      tableScope === dcrScope
        ? dcrPerms
        : await effectivePermissionsAt(azure, tableScope);
    if (tablePerms === null) {
      indeterminate = true;
    } else if (!hasEffectiveAction(tablePerms, TABLE_WRITE_ACTION)) {
      missing.push({ action: TABLE_WRITE_ACTION, scope: tableScope });
    }
  }

  return { granted: missing.length === 0, missing, indeterminate };
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
// Add a custom column to a table
// ---------------------------------------------------------------------------

/**
 * The tables API version for SCHEMA EDITS. Deliberately newer than the
 * schema-read version (research 2026-07-13): the 2023-09-01 reference
 * documents adding custom columns to built-in Microsoft tables, and
 * CommonSecurityLog went through a 2023 schema migration - edits against
 * the older 2022-10-01 version returned opaque InternalServerErrors.
 */
export const TABLES_EDIT_API_VERSION = "2023-09-01";

/**
 * Column types the Log Analytics tables API accepts for custom columns
 * (ColumnTypeEnum in the 2023-09-01 reference - note dateTime's casing).
 */
export const CUSTOM_COLUMN_TYPES = [
  "string",
  "int",
  "long",
  "real",
  "boolean",
  "dateTime",
  "dynamic",
] as const;

/**
 * Add one custom column to a table. Custom (_CL) tables take any valid
 * name; built-in Azure tables require the _CF suffix (appended
 * automatically). PATCHes only the schema columns (never plan/retention),
 * handling the 202 long-running response by polling the table's
 * provisioningState; the caller then re-previews and updates the DCR so
 * the new column becomes ingestable.
 */
export async function addTableColumn(
  azure: AzureManagement,
  input: {
    subscriptionId: string;
    resourceGroup: string;
    workspaceName: string;
    table: string;
    column: { name: string; type: string };
    /** Poll attempts for a 202 long-running schema update (default 5). */
    maxPollAttempts?: number;
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

  const read = await readTableCustomColumns(azure, input);
  const taken = new Set(
    [...read.existing, ...read.standard].map((c) => c.name.toLowerCase()),
  );
  if (taken.has(name.toLowerCase())) {
    throw new Error(`column '${name}' already exists on '${input.table}'`);
  }

  const columns = [
    ...read.existing.map((c) => ({ name: c.name, type: c.type })),
    { name, type: input.column.type },
  ];
  await patchTableColumns(azure, input, read.tablePath, columns, "add column", isCustomTable);
  return { table: input.table, columnName: name, columnCount: columns.length };
}

/** Scope shared by the table schema-edit operations. */
interface TableEditScope {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  table: string;
  maxPollAttempts?: number;
}

/** GET the table and split its column sources (custom vs standard). */
async function readTableCustomColumns(
  azure: AzureManagement,
  input: TableEditScope,
): Promise<{
  tablePath: string;
  existing: LogAnalyticsColumn[];
  standard: LogAnalyticsColumn[];
}> {
  const tablePath =
    `/subscriptions/${input.subscriptionId}` +
    `/resourceGroups/${input.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${input.workspaceName}` +
    `/tables/${input.table}`;
  const current = await azure.request({
    method: "GET",
    path: tablePath,
    apiVersion: TABLES_EDIT_API_VERSION,
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
  return { tablePath, existing, standard };
}

/**
 * PATCH the table's custom column set (the array REPLACES it) and, on a
 * 202 long-running response, poll until the table unlocks
 * (provisioningState Succeeded) so a follow-up DCR update sees the change.
 */
async function patchTableColumns(
  azure: AzureManagement,
  input: TableEditScope,
  tablePath: string,
  columns: Array<{ name: string; type: string }>,
  operation: string,
  isCustomTable: boolean,
): Promise<void> {
  const patch = await azure.request({
    method: "PATCH",
    path: tablePath,
    apiVersion: TABLES_EDIT_API_VERSION,
    body: { properties: { schema: { name: input.table, columns } } },
  });
  if (patch.status < 200 || patch.status >= 300) {
    // VERIFY the lock hypothesis instead of guessing (user request
    // 2026-07-13): the table's provisioningState says whether an
    // in-progress schema operation is holding it.
    let lockVerdict = "";
    try {
      const probe = await azure.request({
        method: "GET",
        path: tablePath,
        apiVersion: TABLES_EDIT_API_VERSION,
      });
      const state = String(
        prop(prop(probe.body, "properties"), "provisioningState") ?? "",
      );
      if (/^(updating|inprogress)$/i.test(state)) {
        lockVerdict =
          ` - VERIFIED: the table IS locked by an in-progress schema` +
          ` operation (provisioningState '${state}'); retry once it settles`;
      } else if (state !== "") {
        lockVerdict =
          ` - VERIFIED: the table is NOT locked (provisioningState` +
          ` '${state}'), so this operation appears to be RESTRICTED for` +
          ` this table`;
      }
    } catch {
      // The probe is best-effort; the generic hint below stands.
    }
    const nativeHint = !isCustomTable
      ? (lockVerdict ||
          " - the table may be locked by an in-progress schema operation" +
            " (retry shortly) or restricted") +
        "; the table's DeviceCustom*/Flex* fields or a custom (_CL) side" +
        " table are the fallback"
      : lockVerdict;
    throw new Error(
      `${operation} on '${input.table}': HTTP ${patch.status} ` +
        JSON.stringify(patch.body).slice(0, 300) +
        nativeHint,
    );
  }
  if (patch.status === 202) {
    const maxAttempts = input.maxPollAttempts ?? 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const poll = await azure.request({
        method: "GET",
        path: tablePath,
        apiVersion: TABLES_EDIT_API_VERSION,
      });
      const state = String(
        prop(prop(poll.body, "properties"), "provisioningState") ?? "",
      );
      if (state.toLowerCase() === "succeeded") break;
      if (attempt === maxAttempts - 1) {
        throw new Error(
          `table '${input.table}' schema update accepted but still ` +
            `'${state || "unknown"}' after ${maxAttempts} poll attempts - ` +
            "retry the DCR update once it settles",
        );
      }
    }
  }
}

/**
 * Remove one CUSTOM column from a table (user request 2026-07-13). Only
 * custom columns are removable - standard/built-in columns are Azure's,
 * and TimeGenerated is required on every table. The follow-up DCR update
 * (the caller's) drops the column from the stream declaration.
 */
export async function removeTableColumn(
  azure: AzureManagement,
  input: TableEditScope & { columnName: string },
): Promise<{ table: string; columnName: string; columnCount: number }> {
  const name = input.columnName.trim();
  if (name.toLowerCase() === "timegenerated") {
    throw new Error("TimeGenerated is required on every table and cannot be removed");
  }
  const read = await readTableCustomColumns(azure, input);
  const match = read.existing.find(
    (c) => c.name.toLowerCase() === name.toLowerCase(),
  );
  if (match === undefined) {
    const standardHit = read.standard.some(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
    throw new Error(
      standardHit
        ? `'${name}' is a standard column on '${input.table}' - only custom columns can be removed`
        : `'${name}' is not a custom column on '${input.table}'`,
    );
  }
  const columns = read.existing
    .filter((c) => c.name.toLowerCase() !== name.toLowerCase())
    .map((c) => ({ name: c.name, type: c.type }));
  await patchTableColumns(
    azure,
    input,
    read.tablePath,
    columns,
    "remove column",
    input.table.endsWith("_CL"),
  );
  return { table: input.table, columnName: match.name, columnCount: columns.length };
}
