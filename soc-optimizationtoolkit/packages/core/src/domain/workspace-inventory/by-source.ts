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
import { listingRows } from "../inventory-listing";
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
  collectors: Map<string, number>;
}

export function bySource(inventory: { tables: Listing<InventoryTable> }): {
  rows: SourceViewRow[];
  reconciliation: SourceViewReconciliation;
} {
  const accumulators = new Map<string, Accumulator>();
  const notRead: SourceViewRow[] = [];
  let usageDailyMB = 0;
  let notReadDailyMB = 0;

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
        collectors: new Map(),
      };
      accumulators.set(key, acc);
    }
    return acc;
  };
  const add = (acc: Accumulator, table: string, source: InventorySource) => {
    acc.tables.add(table);
    acc.dailyMB += source.dailyAverageMB;
    acc.billedDailyMB += source.billableDailyMB;
    acc.freeDailyMB += source.freeDailyMB;
    acc.billedByTable.set(table, (acc.billedByTable.get(table) ?? 0) + source.billableDailyMB);
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
      });
      notReadDailyMB += table.dailyAverageMB;
      continue;
    }
    usageDailyMB += table.dailyAverageMB;
    const rule = SOURCE_IDENTITY_RULES.find(
      (r) => r.table.toLowerCase() === table.table.toLowerCase(),
    );
    if (rule === undefined) {
      const acc = accumulator(
        `table:${table.table.toLowerCase()}`,
        "table",
        `${table.table} (no product columns)`,
      );
      for (const source of table.sources.sources) add(acc, table.table, source);
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
        );
        continue;
      }
      const acc = accumulator(`${rule.attribution}:${name.toLowerCase()}`, rule.attribution, null);
      acc.casings.set(name, (acc.casings.get(name) ?? 0) + 1);
      add(acc, table.table, source);
      if (rule.keepsCollector && source.collector !== "") {
        acc.collectors.set(
          source.collector,
          (acc.collectors.get(source.collector) ?? 0) + source.dailyAverageMB,
        );
      }
    }
  }

  const measuredRows = [...accumulators.values()].map(toRow);
  const rows = [...measuredRows, ...notRead].sort(
    (a, b) => b.dailyMB - a.dailyMB || a.label.localeCompare(b.label),
  );
  const measuredDailyMB = measuredRows.reduce((sum, r) => sum + r.dailyMB, 0);
  const high = Math.max(measuredDailyMB, usageDailyMB);
  return {
    rows,
    reconciliation: {
      measuredDailyMB,
      usageDailyMB,
      notReadDailyMB,
      notReadTables: notRead.length,
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
    collectors: [...acc.collectors].map(([name, dailyMB]) => ({ name, dailyMB })),
    freeTaggedTablesBilled: [...acc.billedByTable]
      .filter(([table, billed]) => billed > 0 && allowanceFor(table).kind === "free")
      .map(([table]) => table),
  };
}

/** The spelling seen most often; ties go to the code-unit-first one, so it is stable. */
function commonestCasing(casings: ReadonlyMap<string, number>): string {
  return [...casings].sort(([a, na], [b, nb]) => nb - na || (a < b ? -1 : a > b ? 1 : 0))[0]![0];
}
