/**
 * workspace-inventory - what an EXISTING Log Analytics / Sentinel workspace
 * ingests: every table with data in the window, the sources feeding each
 * table, and the daily average volume (MIG-2). Pure: the KQL text, the
 * query-response parser and the fold that turns rows into an inventory. The
 * usecase in usecases/workspace-inventory runs the queries.
 *
 * TWO VOLUME SOURCES, ON PURPOSE (measured 2026-10-29, MIG-1):
 *  - TABLE totals come from the `Usage` table - Microsoft's own billing
 *    aggregate, `Quantity` in MB (10^6 bytes), per `DataType` (= table). One
 *    cheap query covers the whole workspace.
 *  - SOURCE splits come from `_BilledSize` (bytes) on the rows themselves,
 *    because `Usage` has no per-source dimension. The two agreed to 0.06% on
 *    the measured workspace (AWSVPCFlow: 1,932,250,284 bytes vs 1931.0 MB), but
 *    they are different measurements and the UI must not subtract one from the
 *    other.
 *
 * THE WINDOW is the last {@link INVENTORY_WINDOW_DAYS} COMPLETE UTC days -
 * today is excluded, so the daily average is total / 30 exactly and a table's
 * "days with data" can never read 31 (the measured `ago(30d)` form spans 31
 * daily bins).
 *
 * WHAT A SOURCE IS. There is no single "source" column across Log Analytics
 * tables, so each row is attributed to the first non-empty of: `_ResourceId`
 * (the Azure resource that emitted it - diagnostics, AMA, Arc), `Computer`
 * (agent and Syslog/WEF data), `DeviceVendor DeviceProduct` (CEF). A row with
 * none of them is UNATTRIBUTED, and that is reported as such: the measured AWS
 * connector tables carry neither `_ResourceId` nor `Computer`. `column_ifexists`
 * is required, not defensive - `_ResourceId` is absent from some tables and a
 * bare reference fails the whole query with SEM0100 (measured).
 */

/** The inventory window, in complete UTC days. */
export const INVENTORY_WINDOW_DAYS = 30;

/**
 * Sources listed per table before the rest roll into one "other" row. A
 * workspace with thousands of agents would otherwise return a row per agent
 * per table.
 */
export const SOURCES_PER_TABLE = 25;

/** Bytes in a Usage MB. `Usage.Quantity` is decimal MB (measured: see above). */
export const BYTES_PER_MB = 1_000_000;

/** ISO-8601 timespan sent with every query; wider than the KQL filter, which is the real bound. */
export const INVENTORY_TIMESPAN = `P${INVENTORY_WINDOW_DAYS + 1}D`;

const WINDOW_FILTER =
  `TimeGenerated >= startofday(now()) - ${INVENTORY_WINDOW_DAYS}d ` +
  "and TimeGenerated < startofday(now())";

/** The one query behind every table total. */
export const USAGE_QUERY = [
  "Usage",
  `| where ${WINDOW_FILTER}`,
  "| summarize TotalMB = sum(Quantity), BillableMB = sumif(Quantity, IsBillable == true),",
  "    DaysWithData = dcount(startofday(TimeGenerated)), Solutions = make_set(Solution, 20)",
  "    by DataType",
  "| order by TotalMB desc",
].join("\n");

/** How a row's source was identified. `other` is the rolled-up remainder row. */
export type SourceAttribution = "resource" | "computer" | "device" | "none" | "other";

const ATTRIBUTIONS: readonly SourceAttribution[] = [
  "resource",
  "computer",
  "device",
  "none",
  "other",
];

/**
 * A table name as a KQL entity reference. `['name']` quoting accepts any
 * character a table name can hold; a quote inside would end the literal, so it
 * is escaped rather than trusted (the names come from a query result).
 */
export function kqlTableRef(table: string): string {
  return `['${table.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
}

/**
 * The source breakdown for a batch of tables.
 *
 * `isfuzzy=true` so one table that cannot be queried under its Usage name
 * (Basic/Auxiliary plan tables, retired DataTypes) does not fail the other
 * tables in the batch - the fold reports a billed table with no rows back as
 * unreadable rather than as having no sources.
 */
export function sourceBreakdownQuery(tables: readonly string[]): string {
  if (tables.length === 0) {
    throw new Error("sourceBreakdownQuery: no tables");
  }
  return [
    `union isfuzzy=true withsource=SourceTable ${tables.map(kqlTableRef).join(", ")}`,
    `| where ${WINDOW_FILTER}`,
    "| extend _rid = tostring(column_ifexists('_ResourceId', '')),",
    "    _comp = tostring(column_ifexists('Computer', '')),",
    "    _dev = trim(' ', strcat(tostring(column_ifexists('DeviceVendor', '')), ' ',",
    "        tostring(column_ifexists('DeviceProduct', ''))))",
    "| extend Source = case(isnotempty(_rid), _rid, isnotempty(_comp), _comp,",
    "        isnotempty(_dev), _dev, ''),",
    "    Attribution = case(isnotempty(_rid), 'resource', isnotempty(_comp), 'computer',",
    "        isnotempty(_dev), 'device', 'none')",
    "| summarize Bytes = sum(_BilledSize), Events = count() by SourceTable, Source, Attribution",
    "| order by SourceTable asc, Bytes desc",
    "| extend Rank = row_number(1, prev(SourceTable) != SourceTable)",
    `| extend Source = iff(Rank > ${SOURCES_PER_TABLE}, '', Source),`,
    `    Attribution = iff(Rank > ${SOURCES_PER_TABLE}, 'other', Attribution)`,
    "| summarize Bytes = sum(Bytes), Events = sum(Events), Sources = count()",
    "    by SourceTable, Source, Attribution",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Query response parsing
// ---------------------------------------------------------------------------

/**
 * One parsed query answer.
 *
 * Log Analytics returns 200 with an `error` object (code `PartialError`) beside
 * `tables` when something went wrong mid-query. Measured 2026-10-29, ONE kind
 * of partial error is not partial at all: `union isfuzzy=true` over a table
 * that does not exist answers with a Warning-severity detail "'union' operator:
 * Failed to resolve table expression named '["X"]'" and full rows for every
 * other table. Those names land in `unresolvedTables`; anything else is a
 * `warning`, and rows that came with one must not be presented as the whole.
 */
export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  warning: string | null;
  unresolvedTables: string[];
}

const UNRESOLVED_TABLE = /Failed to resolve table expression named '\["?(.+?)"?\]'/;

/**
 * Parse a Log Analytics query response (`{tables: [{columns, rows}]}`) into
 * records keyed by column name. Throws on a body without a primary table: that
 * is a response we did not understand, not zero rows (DBT-148's rule).
 */
export function parseQueryResult(body: unknown): QueryResult {
  const tables = field(body, "tables");
  const primary = Array.isArray(tables) ? tables[0] : undefined;
  const columns = field(primary, "columns");
  const rows = field(primary, "rows");
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    throw new Error("query response has no primary table with columns and rows");
  }
  const names = columns.map((c) => text(field(c, "name")));
  const records = rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => {
      const record: Record<string, unknown> = {};
      names.forEach((name, i) => {
        record[name] = row[i];
      });
      return record;
    });
  const error = field(body, "error");
  if (error === undefined || error === null) {
    return { rows: records, warning: null, unresolvedTables: [] };
  }
  const details = field(error, "details");
  const messages: string[] = [];
  const unresolvedTables: string[] = [];
  for (const detail of Array.isArray(details) ? details : []) {
    const message =
      text(field(field(detail, "innererror"), "message")) || text(field(detail, "message"));
    const unresolved = UNRESOLVED_TABLE.exec(message);
    if (unresolved !== null) unresolvedTables.push(unresolved[1]!);
    else if (message !== "") messages.push(message);
  }
  const onlyUnresolved = unresolvedTables.length > 0 && messages.length === 0;
  const warning = onlyUnresolved
    ? null
    : messages.join("; ") ||
      text(field(error, "message")) ||
      text(field(error, "code")) ||
      "partial result";
  return { rows: records, warning, unresolvedTables };
}

// ---------------------------------------------------------------------------
// The inventory model
// ---------------------------------------------------------------------------

/** One table's billed volume, from `Usage`. */
export interface UsageRow {
  table: string;
  totalMB: number;
  billableMB: number;
  daysWithData: number;
  /** Solution names Usage attributes the table to, split and de-duplicated. */
  solutions: string[];
}

/** One source of one table, from `_BilledSize`. */
export interface InventorySource {
  /** The resource id, computer or device; '' for unattributed and `other`. */
  source: string;
  attribution: SourceAttribution;
  bytes: number;
  events: number;
  /** How many distinct sources this row stands for (more than 1 only for `other`). */
  sourceCount: number;
  dailyAverageMB: number;
}

/**
 * What is known about a table's sources. `failed` is not "no sources": the
 * breakdown query was refused, timed out, or returned nothing for a table
 * Usage says was billed.
 */
export type TableSources =
  | { kind: "read"; sources: InventorySource[] }
  | { kind: "partial"; sources: InventorySource[]; warning: string }
  | { kind: "failed"; error: string };

export interface InventoryTable extends UsageRow {
  dailyAverageMB: number;
  sources: TableSources;
}

/** Parse Usage rows; rows with no table name are dropped, numbers coerce to 0. */
export function parseUsageRows(rows: ReadonlyArray<Record<string, unknown>>): UsageRow[] {
  const out: UsageRow[] = [];
  for (const row of rows) {
    const table = text(row.DataType);
    if (table === "") continue;
    out.push({
      table,
      totalMB: num(row.TotalMB),
      billableMB: num(row.BillableMB),
      daysWithData: num(row.DaysWithData),
      solutions: splitSolutions(row.Solutions),
    });
  }
  return out;
}

/**
 * `Usage.Solution` is a '/'-joined list (measured: "WindowsEventForwarding/
 * CustomizedWindowsEventsFiltering/.../SecurityInsights"), and make_set returns
 * each distinct joined string - flatten and de-duplicate. The set arrives as a
 * JSON-ENCODED STRING, not an array (dynamic columns serialize that way;
 * measured 2026-10-29), so a string is parsed before it is split.
 */
function splitSolutions(value: unknown): string[] {
  let decoded = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      decoded = [value];
    }
  }
  const raw = Array.isArray(decoded) ? decoded : typeof decoded === "string" ? [decoded] : [];
  const seen = new Set<string>();
  for (const entry of raw) {
    for (const part of text(entry).split("/")) {
      const name = part.trim();
      if (name !== "") seen.add(name);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Parse source-breakdown rows into a map keyed by lower-cased table name. */
export function parseSourceRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): Map<string, InventorySource[]> {
  const byTable = new Map<string, InventorySource[]>();
  for (const row of rows) {
    const table = text(row.SourceTable);
    if (table === "") continue;
    const raw = text(row.Attribution) as SourceAttribution;
    const attribution: SourceAttribution = ATTRIBUTIONS.includes(raw) ? raw : "none";
    const bytes = num(row.Bytes);
    const entry: InventorySource = {
      source: text(row.Source),
      attribution,
      bytes,
      events: num(row.Events),
      sourceCount: Math.max(1, num(row.Sources)),
      dailyAverageMB: bytes / BYTES_PER_MB / INVENTORY_WINDOW_DAYS,
    };
    const key = table.toLowerCase();
    const list = byTable.get(key) ?? [];
    list.push(entry);
    byTable.set(key, list);
  }
  // `other` last, everything else by volume.
  for (const list of byTable.values()) {
    list.sort(
      (a, b) =>
        Number(a.attribution === "other") - Number(b.attribution === "other") ||
        b.bytes - a.bytes,
    );
  }
  return byTable;
}

/** The outcome of the breakdown for one table, as the usecase observed it. */
export type SourceReadOutcome =
  | {
      kind: "answered";
      sources: Map<string, InventorySource[]>;
      warning: string | null;
      /** Lower-cased names the query reported it could not resolve. */
      unresolved: ReadonlySet<string>;
    }
  | { kind: "failed"; error: string };

/** Fold a parsed breakdown answer into the outcome {@link sourcesFor} reads. */
export function answeredOutcome(result: QueryResult): SourceReadOutcome {
  return {
    kind: "answered",
    sources: parseSourceRows(result.rows),
    warning: result.warning,
    unresolved: new Set(result.unresolvedTables.map((t) => t.toLowerCase())),
  };
}

/**
 * Attach a table's sources from the breakdown outcome that covered it. An
 * answered query with no rows for a table Usage billed is NOT an empty source
 * list - the table did not resolve, or returned nothing under that name.
 */
export function sourcesFor(table: string, outcome: SourceReadOutcome): TableSources {
  if (outcome.kind === "failed") {
    return { kind: "failed", error: outcome.error };
  }
  const key = table.toLowerCase();
  if (outcome.unresolved.has(key)) {
    return {
      kind: "failed",
      error:
        "the query could not resolve this table by its Usage name - Basic and " +
        "Auxiliary plan tables, and retired data types, are not queryable this way",
    };
  }
  const sources = outcome.sources.get(key);
  if (sources === undefined || sources.length === 0) {
    return {
      kind: "failed",
      error:
        "the source query returned no rows for this table although Usage billed it " +
        "in the same window",
    };
  }
  return outcome.warning === null
    ? { kind: "read", sources }
    : { kind: "partial", sources, warning: outcome.warning };
}

/** Workspace-wide totals over the window. */
export interface InventoryTotals {
  totalMB: number;
  billableMB: number;
  dailyAverageMB: number;
  billableDailyAverageMB: number;
}

export function inventoryTotals(rows: readonly UsageRow[]): InventoryTotals {
  const totalMB = rows.reduce((sum, r) => sum + r.totalMB, 0);
  const billableMB = rows.reduce((sum, r) => sum + r.billableMB, 0);
  return {
    totalMB,
    billableMB,
    dailyAverageMB: totalMB / INVENTORY_WINDOW_DAYS,
    billableDailyAverageMB: billableMB / INVENTORY_WINDOW_DAYS,
  };
}

/** A table row with its daily average, before its sources are known. */
export function toInventoryTable(row: UsageRow, sources: TableSources): InventoryTable {
  return { ...row, dailyAverageMB: row.totalMB / INVENTORY_WINDOW_DAYS, sources };
}

/** Split `items` into consecutive chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk: size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Local coercions (domain modules stay dependency-free; see usecases/arm-http)
// ---------------------------------------------------------------------------

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}
