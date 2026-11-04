/**
 * by-source - fold a workspace inventory into "which products and machines are
 * sending us data" (MIG-28). Pure: reads a WorkspaceInventory, returns rows and
 * the reconciliation between the two lenses (the rows' `_BilledSize` and the
 * `Usage` table). See docs/features/inventory-by-source.md, "Calls made after
 * the builder review".
 *
 * Only tables in the identity map contribute identity rows (call 7). A mapped
 * table's rows that carry no identity (fell through to the default order) and
 * its rolled-up `other` row share one "<table> (other sources)" row; every
 * unmapped table whose sources were read is ONE "(no product columns)" row; a
 * table whose sources were not read keeps its Usage volume as a "(sources not
 * read)" row with billed and free unknown.
 */

import { allowanceFor } from "../data-allowances/allowance-catalog";
import { listingRows, toListing } from "../inventory-listing";
import type { Listing } from "../inventory-listing";
import { SOURCE_IDENTITY_RULES } from "./source-identity";
import type { InventorySource, InventoryTable } from "./workspace-inventory";

export interface SourceViewRow {
  /** Merge key: kind plus the trimmed, case-folded identity (or table). */
  key: string;
  kind: "product" | "computer" | "table" | "not-read";
  label: string;
  tables: string[];
  dailyMB: number;
  /** True when the figure is `_BilledSize` from the rows; false for a `Usage` figure. */
  measured: boolean;
  billedDailyMB: number | null;
  freeDailyMB: number | null;
  /** Product rows only. */
  collectors: Array<{ name: string; dailyMB: number }>;
  /** Catalog-Free tables in which this row has billed volume. */
  freeTaggedTablesBilled: string[];
  /**
   * Catalog-Billable tables in which this row measured volume and none of it
   * billed (the reverse disagreement). Partial tables are never listed: their
   * figure is a floor, so "all free" is not established.
   */
  billableTaggedTablesFree: string[];
  /** Tables in this row whose breakdown was partial: the figure is a floor. */
  partialTables: string[];
  /** True when any contributing source was billed above its total (the free figure is clamped). */
  billedExceedsTotal: boolean;
}

export interface SourceViewReconciliation {
  /** Sum of the measured rows. */
  measuredDailyMB: number;
  /** `Usage` daily average of the tables whose sources were read. */
  usageDailyMB: number;
  /** `Usage` daily average of the tables whose sources were not read. */
  notReadDailyMB: number;
  notReadTables: number;
  /** 100 * min / max of measured and usage; null when both are 0. */
  agreementPct: number | null;
  /** Tables whose breakdown was partial; their measured volume is a floor. */
  partialTables: string[];
}

interface Accumulator {
  key: string;
  kind: SourceViewRow["kind"];
  casings: Map<string, number>;
  fixedLabel: string | null;
  tables: Set<string>;
  dailyMB: number;
  billedDailyMB: number;
  freeDailyMB: number;
  billedByTable: Map<string, number>;
  measuredByTable: Map<string, number>;
  collectors: Map<string, number>;
  partialTables: Set<string>;
  billedExceedsTotal: boolean;
}

/**
 * The one rule for "the catalog says Billable, but the rows billed none of it"
 * (architecture audit 2026-11-04). The By source rows and the By table flag
 * both ask it; they used to restate it, and a change to one would have made
 * the two views disagree about the same table. Callers own the partial check:
 * a partial breakdown is a floor, so "all free" is never established from it.
 */
export function billableTableMeasuredFree(
  table: string,
  measuredDailyMB: number,
  billedDailyMB: number,
): boolean {
  return measuredDailyMB > 0 && billedDailyMB === 0 && allowanceFor(table).kind === "billable";
}

export function bySource(inventory: { tables: Listing<InventoryTable> }): {
  /** `none` (verified) and `empty` (unverified) pass through from the tables listing. */
  rows: Listing<SourceViewRow>;
  reconciliation: SourceViewReconciliation;
} {
  const accumulators = new Map<string, Accumulator>();
  const notRead: SourceViewRow[] = [];
  let usageDailyMB = 0;
  let notReadDailyMB = 0;
  const partialTables: string[] = [];

  const accumulator = (key: string, kind: Accumulator["kind"], fixedLabel: string | null) => {
    let acc = accumulators.get(key);
    if (acc === undefined) {
      acc = {
        key,
        kind,
        casings: new Map(),
        fixedLabel,
        tables: new Set(),
        dailyMB: 0,
        billedDailyMB: 0,
        freeDailyMB: 0,
        billedByTable: new Map(),
        measuredByTable: new Map(),
        collectors: new Map(),
        partialTables: new Set(),
        billedExceedsTotal: false,
      };
      accumulators.set(key, acc);
    }
    return acc;
  };
  const add = (acc: Accumulator, table: string, source: InventorySource, partial: boolean) => {
    acc.tables.add(table);
    if (partial) acc.partialTables.add(table);
    if (source.billedExceedsTotal) acc.billedExceedsTotal = true;
    acc.dailyMB += source.dailyAverageMB;
    acc.billedDailyMB += source.billableDailyMB;
    acc.freeDailyMB += source.freeDailyMB;
    acc.billedByTable.set(table, (acc.billedByTable.get(table) ?? 0) + source.billableDailyMB);
    acc.measuredByTable.set(table, (acc.measuredByTable.get(table) ?? 0) + source.dailyAverageMB);
  };

  for (const table of listingRows(inventory.tables)) {
    if (table.sources.kind === "failed") {
      notRead.push({
        key: `not-read:${table.table.toLowerCase()}`,
        kind: "not-read",
        label: `${table.table} (sources not read)`,
        tables: [table.table],
        dailyMB: table.dailyAverageMB,
        measured: false,
        billedDailyMB: null,
        freeDailyMB: null,
        collectors: [],
        freeTaggedTablesBilled: [],
        billableTaggedTablesFree: [],
        partialTables: [],
        billedExceedsTotal: false,
      });
      notReadDailyMB += table.dailyAverageMB;
      continue;
    }
    usageDailyMB += table.dailyAverageMB;
    const partial = table.sources.kind === "partial";
    if (partial) partialTables.push(table.table);
    const rule = SOURCE_IDENTITY_RULES.find(
      (r) => r.table.toLowerCase() === table.table.toLowerCase(),
    );
    if (rule === undefined) {
      const acc = accumulator(
        `table:${table.table.toLowerCase()}`,
        "table",
        `${table.table} (no product columns)`,
      );
      for (const source of table.sources.sources) add(acc, table.table, source, partial);
      continue;
    }
    for (const source of table.sources.sources) {
      const name = source.source.trim();
      if (source.attribution !== rule.attribution || name === "") {
        add(
          accumulator(
            `table-other:${table.table.toLowerCase()}`,
            "table",
            `${table.table} (other sources)`,
          ),
          table.table,
          source,
          partial,
        );
        continue;
      }
      const acc = accumulator(`${rule.attribution}:${name.toLowerCase()}`, rule.attribution, null);
      acc.casings.set(name, (acc.casings.get(name) ?? 0) + 1);
      add(acc, table.table, source, partial);
      if (rule.keepsCollector && source.collector !== "") {
        acc.collectors.set(
          source.collector,
          (acc.collectors.get(source.collector) ?? 0) + source.dailyAverageMB,
        );
      }
    }
  }

  const measuredRows = [...accumulators.values()].map(toRow);
  const sorted = [...measuredRows, ...notRead].sort(
    (a, b) => b.dailyMB - a.dailyMB || compareCodeUnits(a.label, b.label),
  );
  const rows: Listing<SourceViewRow> =
    inventory.tables.kind === "rows" ? toListing(sorted) : { kind: inventory.tables.kind };
  const measuredDailyMB = measuredRows.reduce((sum, r) => sum + r.dailyMB, 0);
  const high = Math.max(measuredDailyMB, usageDailyMB);
  return {
    rows,
    reconciliation: {
      measuredDailyMB,
      usageDailyMB,
      notReadDailyMB,
      notReadTables: notRead.length,
      partialTables,
      agreementPct: high === 0 ? null : (100 * Math.min(measuredDailyMB, usageDailyMB)) / high,
    },
  };
}

function toRow(acc: Accumulator): SourceViewRow {
  return {
    key: acc.key,
    kind: acc.kind,
    label: acc.fixedLabel ?? commonestCasing(acc.casings),
    tables: [...acc.tables],
    dailyMB: acc.dailyMB,
    measured: true,
    billedDailyMB: acc.billedDailyMB,
    freeDailyMB: acc.freeDailyMB,
    collectors: [...acc.collectors]
      .map(([name, dailyMB]) => ({ name, dailyMB }))
      .sort((a, b) => b.dailyMB - a.dailyMB || compareCodeUnits(a.name, b.name)),
    freeTaggedTablesBilled: [...acc.billedByTable]
      .filter(([table, billed]) => billed > 0 && allowanceFor(table).kind === "free")
      .map(([table]) => table),
    billableTaggedTablesFree: [...acc.measuredByTable]
      .filter(
        ([table, measured]) =>
          !acc.partialTables.has(table) &&
          billableTableMeasuredFree(table, measured, acc.billedByTable.get(table) ?? 0),
      )
      .map(([table]) => table),
    partialTables: [...acc.partialTables],
    billedExceedsTotal: acc.billedExceedsTotal,
  };
}

/** The spelling seen most often; ties go to the code-unit-first one, so it is stable. */
function commonestCasing(casings: ReadonlyMap<string, number>): string {
  return [...casings].sort(([a, na], [b, nb]) => nb - na || compareCodeUnits(a, b))[0]![0];
}

/** Locale-independent ordering, so a tie breaks the same way on every machine. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
