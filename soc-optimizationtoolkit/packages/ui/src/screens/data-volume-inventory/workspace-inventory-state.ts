/**
 * Pure presentation for the workspace inventory panel (MIG-3): volume
 * formatting, source labels, and the headlines that must not turn an unknown
 * into a zero (docs/inventory-standard.md).
 *
 * Pure: no IO, no React.
 */

import { allowanceFor, listingRows, parseResourceId } from "@soc/core";
import type {
  DataAllowances,
  SourceViewReconciliation,
  DiscoveredWorkspace,
  InventorySource,
  InventoryTable,
  WorkspaceDiscovery,
  WorkspaceInventory,
} from "@soc/core";
import type { SelectOption } from "../../components/searchable-select";
import { allowanceCsvCells } from "./allowance-state";
import { formatMB } from "./format-mb";

export { formatMB } from "./format-mb";

/** What the source cell says, and the full value or meaning for its InfoTip. */
export interface SourceLabel {
  text: string;
  tip: string;
  kind: string;
  /** The collector that carried a product's rows; '' for every other kind. */
  via: string;
}

export function sourceLabel(source: InventorySource): SourceLabel {
  switch (source.attribution) {
    case "resource": {
      // The one ARM id parser (core azure-resource-id), not a second copy.
      const parsed = parseResourceId(source.source);
      return {
        text: parsed.name || source.source,
        tip: source.source,
        kind: parsed.resourceType || "Azure resource",
        via: "",
      };
    }
    case "product":
      return {
        text: source.source,
        kind: "Product",
        via: source.collector,
        tip:
          source.collector === ""
            ? `${source.source}, named by the product field the rows carry`
            : `${source.source}, named by the product field the rows carry, ` +
              `received through ${source.collector}`,
      };
    case "computer":
      return { text: source.source, tip: source.source, kind: "Computer", via: "" };
    case "device":
      return { text: source.source, tip: source.source, kind: "CEF device", via: "" };
    case "other":
      return {
        text: `${source.sourceCount} other sources`,
        tip: "Every source past the largest 25 of this table, summed",
        kind: "Remainder",
        via: "",
      };
    default:
      return {
        text: "Unattributed",
        tip:
          "These rows carry no _ResourceId, Computer or DeviceVendor/DeviceProduct, " +
          "so nothing in the row says where it came from (typical of SaaS and AWS connectors)",
        kind: "None",
        via: "",
      };
  }
}

/**
 * MIG-8: one workspace as a filterable picker option. The filter matches the
 * label, the hint AND the value, so the ARM id as value makes the resource
 * group and subscription id searchable too, and the hint adds the
 * subscription name and Sentinel state.
 */
export function workspaceSelectOption(ws: DiscoveredWorkspace): SelectOption {
  const sentinel =
    ws.sentinel === "enabled"
      ? "Sentinel"
      : ws.sentinel === "unknown"
        ? "Sentinel unknown"
        : "Log Analytics only";
  return {
    value: ws.id,
    label: ws.name,
    hint: `${ws.subscriptionName || ws.subscriptionId} / ${ws.resourceGroup} - ${sentinel}`,
  };
}

/** The line under the discovery button. Never says "none" for an RBAC-filtered list. */
export function discoveryHeadline(discovery: WorkspaceDiscovery): string {
  const subs = `${discovery.subscriptionsSearched} subscription(s)`;
  const failed =
    discovery.failures.length > 0
      ? ` ${discovery.failures.length} subscription(s) could not be listed and are not included.`
      : "";
  if (discovery.workspaces.kind !== "rows") {
    return (
      `Found no workspace this identity can see across ${subs}. ARM answers a list it ` +
      "filtered by permission with an empty result, not an error, so this does not show " +
      `that none exist - only that none are visible to the connected identity.${failed}`
    );
  }
  const rows = discovery.workspaces.rows;
  const sentinel = rows.filter((w) => w.sentinel === "enabled").length;
  return `Found ${rows.length} workspace(s) across ${subs}, ${sentinel} with Sentinel enabled.${failed}`;
}

/** The inventory's headline; `null` when the table renders the answer itself. */
export function inventoryEmptyText(inventory: WorkspaceInventory): string | null {
  if (inventory.tables.kind === "none") {
    return (
      `The Usage table answered and reports no ingested data in the last ` +
      `${inventory.windowDays} complete days.`
    );
  }
  if (inventory.tables.kind === "empty") {
    return (
      "The Usage query returned no usable rows, but the answer was incomplete or " +
      "unreadable, so this is not a measured zero."
    );
  }
  return null;
}

/** A workspace's name from its ARM id (the last path segment). */
export function workspaceNameOf(id: string): string {
  return parseResourceId(id).name || id;
}

/**
 * MIG-7: the shown inventory survives a selection change, so the page does not
 * collapse under the pointer - which makes it ESSENTIAL to say when what is
 * shown is not what is selected. Null when they agree.
 */
export function staleInventoryNote(inventoryId: string, selectedId: string): string | null {
  if (inventoryId === selectedId) return null;
  return (
    `Showing the inventory of ${workspaceNameOf(inventoryId)}, not the selected ` +
    `workspace. Press Inventory this workspace to read ${workspaceNameOf(selectedId)}.`
  );
}

/** How many tables' source breakdowns did not come back whole. */
export function sourceGaps(inventory: WorkspaceInventory): { failed: number; partial: number } {
  const rows = listingRows(inventory.tables);
  return {
    failed: rows.filter((t) => t.sources.kind === "failed").length,
    partial: rows.filter((t) => t.sources.kind === "partial").length,
  };
}

/** Number of distinct sources a table's breakdown names (the `other` row counts its members). */
export function sourceCount(table: InventoryTable): number | null {
  if (table.sources.kind === "failed") return null;
  return table.sources.sources.reduce((sum, s) => sum + s.sourceCount, 0);
}

/**
 * One source's drill-down line: "Cisco ASA via localhost - 45.2 MB/day (billed
 * 45.2 MB, free 0 MB), 1,200 events". Non-product kinds keep their kind in
 * brackets. A source billed above its total reads "free not known", matching
 * the CSV's empty cell: the clamped 0 is not a measurement.
 */
export function sourceLineText(source: InventorySource): string {
  const label = sourceLabel(source);
  const who =
    source.attribution === "product"
      ? `${label.text}${label.via === "" ? "" : ` via ${collectorDisplay(label.via)}`}`
      : `${label.text} (${label.kind})`;
  return (
    `${who} - ${formatMB(source.dailyAverageMB)}/day ` +
    `(billed ${formatMB(source.billableDailyMB)}, ${freeText(source)}), ` +
    `${source.events.toLocaleString()} events`
  );
}

/**
 * A collector name as shown. A name with no letter or digit (":", "-") or with
 * leading or trailing spaces would read as punctuation in a sentence, so it is
 * quoted; plain names are shown as they are.
 */
export function collectorDisplay(name: string): string {
  const plain = /[\p{L}\p{N}]/u.test(name) && name === name.trim();
  return plain ? name : `"${name}"`;
}

function freeText(source: InventorySource): string {
  return source.billedExceedsTotal ? "free not known" : `free ${formatMB(source.freeDailyMB)}`;
}

/** What the per-table reconciliation line compares; the InfoTip on that line. */
export const RECONCILE_TIP =
  "Source figures are _BilledSize summed from the rows over 30 days; the table figure " +
  "is the Usage table's. They are separate measurements, so a small gap is expected. " +
  "Billed is what counts toward ingestion; free is the part the rows say is not billed.";

/** Why a source's billed figure is shown with a flag; the InfoTip on the note. */
export const BILLED_EXCEEDS_TIP =
  "The rows report more billable bytes than total bytes, which cannot happen " +
  "(billable is a subset of total). Free cannot be worked out from such rows, so " +
  "it reads not known; treat this source's billed and free split as unreliable.";

/**
 * The line under a table's sources: what its named sources add up to against
 * what Usage reports for the table. Null for a failed breakdown, which the
 * caller already states.
 */
export function tableReconciliation(table: InventoryTable): string | null {
  if (table.sources.kind === "failed") return null;
  const total = table.sources.sources.reduce((sum, s) => sum + s.dailyAverageMB, 0);
  const figures = `${formatMB(total)}/day of the ${formatMB(table.dailyAverageMB)}/day Usage reports for this table`;
  if (table.sources.kind === "partial") {
    return (
      `This breakdown is partial (${table.sources.warning}), so the sources shown ` +
      `(measured from the rows) total ${figures}.`
    );
  }
  return `Sources (measured from the rows) total ${figures}.`;
}

/**
 * A CSV of the inventory, one row per table source, for the migration ticket.
 * The allowance columns repeat the grant-level figures per row; with no
 * allowance result (or an unknown figure) those cells are empty, never 0.
 * AllowanceFigures says whether they are exact or lower bounds.
 */
export function inventoryCsv(inventory: WorkspaceInventory, allowances: DataAllowances | null): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    [
      "Table", "TableDailyAvgMB", "TableBillableMB", "DaysWithData", "Solutions",
      "Source", "SourceKind", "SourceDailyAvgMB", "SourceEvents", "SourceStatus",
      "Allowance", "AllowanceEligibleDailyMB", "AllowanceUsedDailyMB", "AllowanceOverDailyMB",
      "AllowanceFigures", "SourceIdentity", "Collector", "BillableDailyMB", "FreeDailyMB",
    ].join(","),
  ];
  for (const t of listingRows(inventory.tables)) {
    const head = [
      t.table, t.dailyAverageMB.toFixed(3), t.billableMB.toFixed(3), t.daysWithData,
      t.solutions.join(" "),
    ];
    const allowance = allowanceCsvCells(t.table, allowances);
    if (t.sources.kind === "failed") {
      lines.push([...head, "", "", "", "", `failed: ${t.sources.error}`, ...allowance, "", "", "", ""].map(esc).join(","));
      continue;
    }
    const status = t.sources.kind === "partial" ? `partial: ${t.sources.warning}` : "read";
    for (const s of t.sources.sources) {
      const label = sourceLabel(s);
      lines.push(
        [...head, s.source || label.text, label.kind, s.dailyAverageMB.toFixed(3), s.events, status, ...allowance,
          s.source, s.collector, s.billableDailyMB.toFixed(3),
          // Billed above total is a broken answer: the free figure is not knowable, so it is empty, never 0.
          s.billedExceedsTotal ? "" : s.freeDailyMB.toFixed(3)]
          .map(esc)
          .join(","),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/*
 * By source (MIG-30): the tips on each figure name the lens it comes from -
 * the rows' _BilledSize, or the Usage table - and the sentence under the view
 * compares the two lenses rather than subtracting one from the other.
 */

/** The Source column header. */
export const BY_SOURCE_SOURCE_TIP =
  "Products are named by the fields the rows carry: DeviceVendor and DeviceProduct in " +
  "CommonSecurityLog, ProductName (else ProviderName) in SecurityAlert; Syslog by " +
  "Computer and Facility. Every other table is one row, \"(no product columns)\" - its " +
  "resource and computer detail is under By table. Rows past a table's largest 25 " +
  "sources, or with no identity, are \"(other sources)\".";

/** The Daily avg column header. */
export const BY_SOURCE_DAILY_TIP =
  "From the rows: sum(_BilledSize) of this source's rows over the last 30 complete UTC " +
  "days, divided by 30, summed across the tables it lands in. A \"(sources not read)\" " +
  "row has no rows to measure, so it shows that table's daily average from the Usage " +
  "table instead.";

/** The Billed / Free column header. */
export const BY_SOURCE_SPLIT_TIP =
  "From the rows: billed is sum(_BilledSize) where _IsBillable is true; free is the rest " +
  "of the same rows. The bar shows billed (first segment) against free. \"not read\" means " +
  "the table's source breakdown failed or was not requested, so the split is unknown, " +
  "not zero.";

/** The Collectors column header. */
export const BY_SOURCE_COLLECTORS_TIP =
  "Product sources only: the machine or Azure resource that carried the product's rows " +
  "(the _ResourceId name, else Computer), with the daily _BilledSize it carried. Other " +
  "sources have no separate collector and read \"-\".";

/** The Allowance column header and the catalog flag. */
export const BY_SOURCE_ALLOWANCE_TIP =
  "The allowance catalog's tag for each table this source lands in. The flag appears when " +
  "the rows say this source was billed (_IsBillable true) in a table the catalog tags " +
  "Free, or measured entirely free in a table the catalog tags Billable: the catalog and " +
  "the bill disagree, so check that table's billing before relying on the tag.";

/** The note on a source whose figure includes a partial breakdown. */
export const BY_SOURCE_PARTIAL_TIP =
  "At least one table this source lands in returned only part of its source breakdown, " +
  "so this figure is a floor: the true volume is at least this much.";

/** The reconciliation sentence under the view. */
export const BY_SOURCE_RECONCILE_TIP =
  "Compares two separate measurements of the same tables: _BilledSize summed from the " +
  "rows, and the Usage table's daily average. A small gap is expected. Tables whose " +
  "sources were not read have only the Usage figure, so they are named separately and " +
  "left out of the comparison.";

/** A source's free figure in words: "not known" when its billed figure exceeds its total. */
export function bySourceFreeText(row: { freeDailyMB: number | null; billedExceedsTotal: boolean }): string {
  if (row.freeDailyMB === null) return "not read";
  return row.billedExceedsTotal ? "not known" : formatMB(row.freeDailyMB);
}

/** The catalog flag on a By source row; null when no Free-tagged table was billed. */
export function catalogFlagText(freeTaggedTablesBilled: readonly string[]): string | null {
  if (freeTaggedTablesBilled.length === 0) return null;
  return `billed in a table the catalog tags Free (${freeTaggedTablesBilled.join(", ")})`;
}

/** The reverse flag on a By source row; null when no Billable-tagged table measured all free. */
export function catalogBillableFlagText(billableTaggedTablesFree: readonly string[]): string | null {
  if (billableTaggedTablesFree.length === 0) return null;
  return `measured free; the catalog tags ${billableTaggedTablesFree.join(", ")} Billable`;
}

/**
 * The same flag on a By table row: set when the catalog tags the table Billable
 * and every source read in it measured free. A partial or failed breakdown is
 * never flagged (a floor, or nothing measured).
 */
export function tableBillableFreeFlag(table: InventoryTable): string | null {
  if (table.sources.kind !== "read" || table.sources.sources.length === 0) return null;
  if (allowanceFor(table.table).kind !== "billable") return null;
  const { sources } = table.sources;
  const allFree =
    sources.every((s) => s.billableDailyMB === 0) && sources.some((s) => s.dailyAverageMB > 0);
  return allFree ? catalogBillableFlagText([table.table]) : null;
}

/**
 * The sentence under By source. It COMPARES the two lenses ("agree within
 * Z%", rounded up so it never overstates the agreement); Usage volume of the
 * tables whose sources were not read is named on its own, never subtracted.
 */
export function bySourceReconciliationText(r: SourceViewReconciliation): string {
  const tables = (n: number) => `${n} ${n === 1 ? "table" : "tables"}`;
  const notRead =
    r.notReadTables > 0
      ? `${formatMB(r.notReadDailyMB)}/day from ${tables(r.notReadTables)} whose sources were not read`
      : null;
  const partial =
    r.partialTables.length > 0
      ? ` ${tables(r.partialTables.length)} returned a partial breakdown ` +
        `(${r.partialTables.join(", ")}), so the measured total is a floor.`
      : "";
  if (r.agreementPct === null) {
    return notRead === null
      ? "Sources (measured from the rows) total 0 MB/day; Usage reports 0 MB/day for the same tables."
      : `No table's sources were read, so there is nothing to compare. Usage reports ${notRead}.`;
  }
  // toFixed(6) first: float noise (100 - 99.99999999) must not round up to 0.1%.
  const within = (Math.ceil(Number(((100 - r.agreementPct) * 10).toFixed(6))) / 10).toFixed(1);
  const compared =
    `Sources (measured from the rows) total ${formatMB(r.measuredDailyMB)}/day; ` +
    `Usage reports ${formatMB(r.usageDailyMB)}/day for the same tables; ` +
    `they agree within ${within}%.`;
  return `${compared}${notRead === null ? "" : ` Usage also reports ${notRead}, left out of that comparison.`}${partial}`;
}
