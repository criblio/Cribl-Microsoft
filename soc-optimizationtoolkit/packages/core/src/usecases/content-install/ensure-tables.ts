/**
 * Auto-create a rule's dependency tables (user direction 2026-07-16). Azure
 * validates an analytics rule's query at install time and rejects it when a
 * table it reads does not exist ("One of the tables does not exist."). When
 * that table is a custom (_CL) table the Azure-Sentinel CustomTables repo
 * defines, the toolkit can CREATE it from that authoritative schema first, so
 * the rule installs - instead of forcing the user to set up ingestion before
 * any content lands.
 *
 * Schema source: `.script/tests/KqlvalidationsTests/CustomTables/<Table>.json`
 * (the schemas Microsoft's own CI validates every solution's KQL against),
 * read through the SentinelContent port and parsed by parseKqlValidationTable.
 *
 * Pure orchestration over the AzureManagement + SentinelContent ports; never
 * throws (every path resolves an outcome).
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { SentinelContent } from "../../ports/sentinel-content";
import type { Logger } from "../../ports/logger";
import {
  buildTablePutRequest,
  LOG_ANALYTICS_TABLES_API_VERSION,
} from "../../domain/custom-table/index";
import {
  KQL_VALIDATION_TABLES_DIR,
  parseKqlValidationTable,
} from "../../domain/field-matcher/index";
import type { WorkspaceScope } from "./content-install";

/** The result of ensuring one dependency table. */
export interface EnsureTableOutcome {
  table: string;
  ok: boolean;
  /** created | already exists | a failure reason. */
  detail: string;
  /** True only when this call CREATED the table (vs it already existing). */
  created: boolean;
}

/** Attempt-bounded poll for the created table to read back terminal. */
const DEFAULT_TABLE_POLL_ATTEMPTS = 12;

function workspacePath(ws: WorkspaceScope): string {
  return (
    `/subscriptions/${ws.subscriptionId}/resourceGroups/${ws.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${ws.workspaceName}`
  );
}

function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Fetch a custom table's schema from the CustomTables repo (keyed by the
 * exact _CL table name). Returns null when the repo does not define it (a
 * native table, or one only ingestion creates). Never throws.
 */
export async function resolveCustomTableSchema(
  content: SentinelContent,
  tableName: string,
): Promise<{ name: string; type: string }[] | null> {
  try {
    const text = await content.readFile(
      `${KQL_VALIDATION_TABLES_DIR}/${tableName}.json`,
    );
    if (text === null) return null;
    return parseKqlValidationTable(text);
  } catch {
    return null;
  }
}

/** Does a Log Analytics table (native or custom) already exist? */
export async function customTableExists(
  azure: AzureManagement,
  ws: WorkspaceScope,
  tableName: string,
): Promise<boolean> {
  try {
    const res = await azure.request({
      method: "GET",
      path: `${workspacePath(ws)}/tables/${tableName}`,
      apiVersion: LOG_ANALYTICS_TABLES_API_VERSION,
    });
    return is2xx(res.status);
  } catch {
    return false;
  }
}

/**
 * Ensure the table a rule's `dataType` reads exists, creating the custom (_CL)
 * table from the CustomTables repo schema when it does not. `dataType` is the
 * rule's declared data type (e.g. "Cloudflare"); the table is that name with
 * "_CL" appended unless already suffixed. A native/existing table short-
 * circuits to "already exists"; a data type the repo does not define resolves
 * a clear non-fatal outcome (the caller still tries the rule).
 */
export async function ensureRuleDataTable(
  azure: AzureManagement,
  content: SentinelContent,
  ws: WorkspaceScope,
  dataType: string,
  logger?: Logger,
): Promise<EnsureTableOutcome> {
  const suffixed = /_CL$/i.test(dataType) ? dataType : `${dataType}_CL`;
  try {
    // Already present as the raw name (native/standard) or the _CL name.
    if (await customTableExists(azure, ws, dataType)) {
      return { table: dataType, ok: true, detail: "already exists", created: false };
    }
    if (suffixed !== dataType && (await customTableExists(azure, ws, suffixed))) {
      return { table: suffixed, ok: true, detail: "already exists", created: false };
    }
    // Missing: resolve the custom-table schema (repo keys by the _CL name).
    let columns = await resolveCustomTableSchema(content, suffixed);
    if (columns === null && suffixed !== dataType) {
      columns = await resolveCustomTableSchema(content, dataType);
    }
    if (columns === null || columns.length === 0) {
      return {
        table: suffixed,
        ok: false,
        created: false,
        detail:
          "not defined in the CustomTables repo (a native table, or one only " +
          "ingestion creates - set up ingestion first)",
      };
    }
    const req = buildTablePutRequest({
      subscriptionId: ws.subscriptionId,
      resourceGroup: ws.resourceGroup,
      workspaceName: ws.workspaceName,
      table: suffixed,
      columns: columns.map((c) => ({ name: c.name, type: c.type })),
    });
    const res = await azure.request({
      method: "PUT",
      path: req.path,
      apiVersion: req.apiVersion,
      body: req.body,
    });
    if (!is2xx(res.status)) {
      let body: string;
      try {
        body = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      } catch {
        body = String(res.body);
      }
      return {
        table: req.tableName,
        ok: false,
        created: false,
        detail: `create failed: HTTP ${res.status}${body && body !== "null" ? ` ${body}` : ""}`,
      };
    }
    logger?.info("content-install: created dependency table", {
      table: req.tableName,
      columns: columns.length,
    });
    // Attempt-bounded readback until the table provisions (no timers - the
    // adapter enforces per-request timeouts; table creation is fast).
    for (let attempt = 0; attempt < DEFAULT_TABLE_POLL_ATTEMPTS; attempt++) {
      const poll = await azure.request({
        method: "GET",
        path: `${workspacePath(ws)}/tables/${req.tableName}`,
        apiVersion: LOG_ANALYTICS_TABLES_API_VERSION,
      });
      if (!is2xx(poll.status)) continue;
      const state = prop(prop(poll.body, "properties"), "provisioningState");
      const stateText = typeof state === "string" ? state : "";
      if (/^succeeded$/i.test(stateText)) {
        return {
          table: req.tableName,
          ok: true,
          created: true,
          detail: `created (${columns.length} columns)`,
        };
      }
      if (/^(failed|canceled)$/i.test(stateText)) {
        return {
          table: req.tableName,
          ok: false,
          created: false,
          detail: `create ${stateText.toLowerCase()}`,
        };
      }
    }
    // Accepted but still provisioning after the bound - treat as created; the
    // rule install a moment later will find it (or report the table cleanly).
    return {
      table: req.tableName,
      ok: true,
      created: true,
      detail: `created (${columns.length} columns; still provisioning)`,
    };
  } catch (err) {
    return {
      table: suffixed,
      ok: false,
      created: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
