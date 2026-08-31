/**
 * workspace-tables - LISTING the Log Analytics workspace's tables so an operator
 * can pick any one of them to run DCR gap analysis against.
 *
 * THE CALL ALREADY EXISTED AND WAS THROWN AWAY. permission-preflight issues this
 * exact GET as its `table.read` probe and reads only the status code, discarding
 * the body. This keeps the body. The probe stays as it is - it answers "can we
 * read tables at all", which is a different question from "which tables are
 * there", and collapsing the two would make a permission check depend on a
 * feature's data shape.
 *
 * WHY THE SHAPE IS COARSE. The tables API returns a large per-table blob
 * (schema, retention, plan, provisioning state, solution mappings). Gap analysis
 * needs identity and enough to choose sensibly; the full schema is fetched per
 * table when one is actually selected, by the code that already does that for
 * custom tables. Listing 500 tables' full schemas to populate a picker would be
 * a lot of payload for a list nobody reads in full.
 *
 * CAPABILITY NOTE (capability-model-plan): this needs `table.read`, which the
 * audit already measures. A DENIED verdict must NOT hide the picker - the audit
 * informs and offers, and Azure's own 403 is the real gate - and reads have no
 * fallback artifact, so an honest annotation is the whole answer. That gating
 * belongs to the caller; this usecase just reports what it found or throws.
 *
 * Pure orchestration over the AzureManagement port: no clock, no IO of its own.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { Logger } from "../../ports/logger";
import { isCustomTableName } from "../../domain/custom-table";
import { listingCount, toListing } from "../../domain/inventory-listing";
import type { Listing } from "../../domain/inventory-listing";
import type { DestField } from "../../domain/field-matcher";
import { selectSchemaColumns } from "../../domain/schema-mapping";
import type { LogAnalyticsColumn } from "../../domain/schema-mapping";
import { listAllPages, WORKSPACE_API_VERSION } from "../azure-discovery";
import { asString, httpErrorText, is2xx, prop } from "../arm-http";

/** How a table came to exist, as far as the list response reveals. */
export type WorkspaceTableKind = "custom" | "native";

/** One table in the workspace, at picker granularity. */
export interface WorkspaceTable {
  /** Table name exactly as ARM reports it (e.g. "SecurityEvent", "App_CL"). */
  name: string;
  /**
   * Custom tables are the `_CL` ones the toolkit can create; everything else is
   * native. Derived from the NAME via domain/custom-table's isCustomTableName -
   * the SAME predicate the onboarding path routes on, imported rather than
   * restated. It is deliberately case-INSENSITIVE, so "app_cl" reads as an
   * attempted custom table here exactly as it does there.
   */
  kind: WorkspaceTableKind;
  /** Retention in days when reported, else null (the workspace default). */
  retentionInDays: number | null;
  /** Table plan ("Analytics", "Basic", ...) when reported, else "". */
  plan: string;
}

/** The workspace a listing targets. */
export interface WorkspaceTablesTarget {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
}

/** A number field, or null when absent or not a number. */
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Project one ARM list element into a {@link WorkspaceTable}, or null when it
 * carries no usable name.
 *
 * Tolerant by design: a surprising element shape drops that one row rather than
 * failing the whole listing, because a picker missing one table is far better
 * than a picker that will not open.
 */
export function parseWorkspaceTable(element: unknown): WorkspaceTable | null {
  const name = asString(prop(element, "name"));
  if (name === "") {
    return null;
  }
  const properties = prop(element, "properties");
  return {
    name,
    kind: isCustomTableName(name) ? "custom" : "native",
    retentionInDays: numberOrNull(prop(properties, "retentionInDays")),
    plan: asString(prop(properties, "plan")),
  };
}

/** Build the ARM path for a workspace's tables collection. */
export function workspaceTablesPath(target: WorkspaceTablesTarget): string {
  return (
    `/subscriptions/${target.subscriptionId}` +
    `/resourceGroups/${target.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${target.workspaceName}` +
    `/tables`
  );
}

/**
 * List every table in the workspace, sorted by name.
 *
 * Sorted here rather than at the call site so every surface shows the same
 * order; ARM's own ordering is not documented as stable. Throws on a non-2xx
 * (via listAllPages) so the caller can render the real reason - a 403 here is
 * meaningful, and swallowing it would leave an empty picker that looks like an
 * empty workspace.
 */
export async function listWorkspaceTables(
  azure: AzureManagement,
  target: WorkspaceTablesTarget,
  logger?: Logger,
): Promise<Listing<WorkspaceTable>> {
  const items = await listAllPages(
    azure,
    {
      method: "GET",
      path: workspaceTablesPath(target),
      apiVersion: WORKSPACE_API_VERSION,
    },
    `list tables in workspace '${target.workspaceName}'`,
  );

  const tables: WorkspaceTable[] = [];
  for (const item of items) {
    const table = parseWorkspaceTable(item);
    if (table !== null) {
      tables.push(table);
    }
  }
  tables.sort((a, b) => a.name.localeCompare(b.name));

  // DBT-61: `listing` sits beside `total` so the log itself cannot be read as
  // a measured zero. An RBAC-filtered workspace lists 200-with-nothing exactly
  // as an empty workspace does, and a bare `total: 0` in a log is the same
  // confident wrong answer as one on screen, just somewhere quieter.
  const listing = toListing(tables);
  logger?.info("workspace-tables: listed", {
    workspace: target.workspaceName,
    listing: listing.kind,
    total: listingCount(listing, 0),
    custom: tables.filter((table) => table.kind === "custom").length,
  });
  return listing;
}

// ---------------------------------------------------------------------------
// Selecting a table: its LIVE schema becomes the destination schema
// ---------------------------------------------------------------------------

/**
 * Fetch the live schema of ONE table, as destination fields.
 *
 * User decision 2026-08-10: the selected table's live schema REPLACES the
 * derived `destSchema` outright - it is not reconciled against it. The derived
 * path exists for tables that do not materialize until a connector is enabled;
 * once a real table is named, ARM is the better authority and blending the two
 * would produce a schema matching neither.
 *
 * THE CALLER MUST RE-RUN THE GAP ANALYSIS (same decision). Selecting a table is
 * not a data swap - the previous analysis was computed against a different
 * destination and every mapping, coverage and overflow verdict in it is now
 * about the wrong schema. Replacing the schema without re-deriving would leave
 * results on screen that silently describe the old target, which is worse than
 * showing none.
 *
 * The column-source choice is NOT made here: {@link selectSchemaColumns} owns
 * the columns-vs-standardColumns rule (custom prefers `columns` and falls back
 * to the MMA-legacy `standardColumns`; native the reverse), and it is imported
 * rather than restated.
 *
 * Returns null when the table exists but exposes no usable column source - a
 * real state for a table provisioned but not yet materialized, and distinct
 * from a throw, which means the fetch itself failed.
 */
export async function fetchWorkspaceTableSchema(
  azure: AzureManagement,
  target: WorkspaceTablesTarget,
  tableName: string,
  logger?: Logger,
): Promise<DestField[] | null> {
  const path = `${workspaceTablesPath(target)}/${tableName}`;
  const response = await azure.request({
    method: "GET",
    path,
    apiVersion: WORKSPACE_API_VERSION,
  });
  if (!is2xx(response.status)) {
    throw new Error(
      httpErrorText(`read schema of table '${tableName}'`, response.status, response.body),
    );
  }

  const schema = prop(prop(response.body, "properties"), "schema");
  const columns = selectSchemaColumns(
    {
      columns: asColumns(prop(schema, "columns")),
      standardColumns: asColumns(prop(schema, "standardColumns")),
    },
    isCustomTableName(tableName) ? "custom" : "native",
  );
  if (columns === null) {
    logger?.info("workspace-tables: table has no usable columns", { table: tableName });
    return null;
  }

  const fields = columns.map((column) => ({ name: column.name, type: column.type }));
  logger?.info("workspace-tables: schema fetched", {
    table: tableName,
    fields: fields.length,
  });
  return fields;
}

/** Coerce an ARM column array, dropping entries with no usable name. */
function asColumns(value: unknown): LogAnalyticsColumn[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const columns: LogAnalyticsColumn[] = [];
  for (const entry of value) {
    const name = asString(prop(entry, "name"));
    if (name !== "") {
      columns.push({ name, type: asString(prop(entry, "type")) });
    }
  }
  return columns.length > 0 ? columns : null;
}
