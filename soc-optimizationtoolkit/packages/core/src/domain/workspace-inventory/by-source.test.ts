import { describe, expect, it } from "vitest";

import { listingRows, toListing } from "../inventory-listing";
import { bySource } from "./by-source";
import { BYTES_PER_MB, INVENTORY_WINDOW_DAYS } from "./workspace-inventory";
import type { InventorySource, InventoryTable, TableSources } from "./workspace-inventory";

const DAY = BYTES_PER_MB * INVENTORY_WINDOW_DAYS; // bytes for 1 MB/day

/** A source of `mb` MB/day, `billedMb` of it billed. */
function src(
  source: string,
  attribution: InventorySource["attribution"],
  mb: number,
  extra: Partial<InventorySource> & { billedMb?: number } = {},
): InventorySource {
  const { billedMb: billedOverride, ...rest } = extra;
  const billedMb = billedOverride ?? mb;
  return {
    source,
    attribution,
    collector: "",
    bytes: mb * DAY,
    billableBytes: billedMb * DAY,
    events: 1,
    sourceCount: 1,
    dailyAverageMB: mb,
    billableDailyMB: billedMb,
    freeDailyMB: mb - billedMb,
    billedExceedsTotal: false,
    ...rest,
  };
}

function table(name: string, usageMb: number, sources: TableSources): InventoryTable {
  return {
    table: name,
    totalMB: usageMb * INVENTORY_WINDOW_DAYS,
    billableMB: usageMb * INVENTORY_WINDOW_DAYS,
    daysWithData: 30,
    solutions: [],
    dailyAverageMB: usageMb,
    sources,
  };
}

const read = (...sources: InventorySource[]): TableSources => ({ kind: "read", sources });
const inv = (...tables: InventoryTable[]) => ({ tables: toListing(tables) });

/** bySource with the rows unwrapped, for tests that know there are some. */
const run = (input: Parameters<typeof bySource>[0]) => {
  const result = bySource(input);
  return { rows: listingRows(result.rows), reconciliation: result.reconciliation };
};

describe("bySource", () => {
  it("makes ONE product row of Cisco ASA through three collectors, listing each", () => {
    const { rows } = run(
      inv(
        table(
          "CommonSecurityLog",
          10,
          read(
            src("Cisco ASA", "product", 6, { collector: "fw-a" }),
            src("Cisco ASA", "product", 3, { collector: "fw-b" }),
            src("Cisco ASA", "product", 1, { collector: "localhost" }),
          ),
        ),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "product",
      label: "Cisco ASA",
      tables: ["CommonSecurityLog"],
      dailyMB: 10,
      measured: true,
      billedDailyMB: 10,
      freeDailyMB: 0,
      collectors: [
        { name: "fw-a", dailyMB: 6 },
        { name: "fw-b", dailyMB: 3 },
        { name: "localhost", dailyMB: 1 },
      ],
    });
  });

  it("merges 'Cisco ASA' and 'cisco asa ' on a trimmed, case-folded key; label is the commonest casing", () => {
    const { rows } = run(
      inv(
        table(
          "CommonSecurityLog",
          9,
          read(
            src("cisco asa ", "product", 2, { collector: "a" }),
            src("Cisco ASA", "product", 3, { collector: "b" }),
            src("Cisco ASA", "product", 4, { collector: "c" }),
          ),
        ),
      ),
    );
    expect(rows.map((r) => [r.label, r.dailyMB])).toEqual([["Cisco ASA", 9]]);
  });

  it("merges a product across tables, but never a product with a computer of the same name", () => {
    const { rows } = run(
      inv(
        table("CommonSecurityLog", 5, read(src("Palo Alto", "product", 5))),
        table("SecurityAlert", 2, read(src("Palo Alto", "product", 2))),
        table("Syslog", 4, read(src("Palo Alto", "computer", 4))),
      ),
    );
    expect(rows.map((r) => [r.kind, r.tables, r.dailyMB])).toEqual([
      ["product", ["CommonSecurityLog", "SecurityAlert"], 7],
      ["computer", ["Syslog"], 4],
    ]);
    expect(rows[1]!.collectors).toEqual([]);
  });

  it("makes an unmapped table with read sources ONE '(no product columns)' row", () => {
    const { rows } = run(
      inv(table("AWSCloudTrail", 8, read(src("", "none", 5), src("arn:x", "resource", 3)))),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "table",
        label: "AWSCloudTrail (no product columns)",
        dailyMB: 8,
        measured: true,
        collectors: [],
      }),
    ]);
  });

  it("makes a table whose sources were not requested a '(sources not read)' row with Usage volume and null billed/free", () => {
    const { rows } = run(
      inv(table("Heartbeat", 3, { kind: "failed", error: "source breakdown not requested" })),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "not-read",
        label: "Heartbeat (sources not read)",
        dailyMB: 3,
        measured: false,
        billedDailyMB: null,
        freeDailyMB: null,
        freeTaggedTablesBilled: [],
      }),
    ]);
  });

  it("puts a mapped table's `other` source in '<table> (other sources)', never into a product", () => {
    const { rows } = run(
      inv(
        table(
          "CommonSecurityLog",
          12,
          read(src("Cisco ASA", "product", 10), src("", "other", 2, { sourceCount: 40 })),
        ),
      ),
    );
    expect(rows.map((r) => [r.kind, r.label, r.dailyMB])).toEqual([
      ["product", "Cisco ASA", 10],
      ["table", "CommonSecurityLog (other sources)", 2],
    ]);
  });

  it("flags a Free-tagged table billed through a named source", () => {
    const { rows } = run(
      inv(
        table(
          "SecurityAlert",
          4,
          read(
            src("Defender XDR", "product", 3, { billedMb: 1 }),
            src("MCAS", "product", 1, { billedMb: 0 }),
          ),
        ),
      ),
    );
    expect(rows.find((r) => r.label === "Defender XDR")!.freeTaggedTablesBilled).toEqual([
      "SecurityAlert",
    ]);
    expect(rows.find((r) => r.label === "MCAS")!.freeTaggedTablesBilled).toEqual([]);
  });

  it("flags a Free-tagged table whose billed volume sits in the `other` row", () => {
    const { rows } = run(
      inv(
        table(
          "SecurityAlert",
          4,
          read(
            src("Defender XDR", "product", 3, { billedMb: 0 }),
            src("", "other", 1, { billedMb: 1, sourceCount: 30 }),
          ),
        ),
      ),
    );
    expect(rows.find((r) => r.label === "Defender XDR")!.freeTaggedTablesBilled).toEqual([]);
    expect(
      rows.find((r) => r.label === "SecurityAlert (other sources)")!.freeTaggedTablesBilled,
    ).toEqual(["SecurityAlert"]);
  });

  it("does not flag a billed table the catalog does not tag Free", () => {
    const { rows } = run(inv(table("AWSCloudTrail", 2, read(src("", "none", 2)))));
    expect(rows[0]!.freeTaggedTablesBilled).toEqual([]);
  });

  it("flags a catalog-Billable table whose measured volume is all free (MIG-32)", () => {
    const { rows } = run(
      inv(
        table("SecurityCaseEvent", 1, read(src("Case Mgmt", "product", 1, { billedMb: 0 }))),
        table("AWSCloudTrail", 2, read(src("", "none", 2, { billedMb: 0 }))),
        table("Syslog", 3, read(src("web-1", "computer", 3, { billedMb: 1 }))),
        table("SecurityAlert", 1, read(src("Defender", "product", 1, { billedMb: 0 }))),
      ),
    );
    expect(rows.find((r) => r.label === "SecurityCaseEvent (no product columns)")!.billableTaggedTablesFree).toEqual([
      "SecurityCaseEvent",
    ]);
    expect(
      rows.find((r) => r.label === "AWSCloudTrail (no product columns)")!.billableTaggedTablesFree,
    ).toEqual(["AWSCloudTrail"]);
    // Partly billed: not flagged. Free-tagged and free: nothing to explain.
    expect(rows.find((r) => r.label === "web-1")!.billableTaggedTablesFree).toEqual([]);
    expect(rows.find((r) => r.label === "Defender")!.billableTaggedTablesFree).toEqual([]);
  });

  it("does not flag a Billable table that is partial, not read, or measured zero (MIG-32)", () => {
    const { rows } = run(
      inv(
        table("AWSCloudTrail", 2, {
          kind: "partial",
          warning: "w",
          sources: [src("", "none", 2, { billedMb: 0 })],
        }),
        table("SecurityCaseEvent", 1, { kind: "failed", error: "x" }),
        table("Syslog", 0, read(src("web-1", "computer", 0, { billedMb: 0 }))),
      ),
    );
    for (const r of rows) expect(r.billableTaggedTablesFree).toEqual([]);
  });

  it("reconciles the two lenses exactly and sorts by volume then label", () => {
    const { rows, reconciliation } = run(
      inv(
        table(
          "CommonSecurityLog",
          10.5,
          read(src("Cisco ASA", "product", 8), src("Fortinet FortiGate", "product", 2)),
        ),
        table("AWSCloudTrail", 4, read(src("", "none", 4))),
        table("Heartbeat", 3, { kind: "failed", error: "x" }),
        table("Perf", 1, { kind: "failed", error: "y" }),
      ),
    );
    expect(reconciliation).toEqual({
      measuredDailyMB: 14,
      usageDailyMB: 14.5,
      notReadDailyMB: 4,
      notReadTables: 2,
      agreementPct: (100 * 14) / 14.5,
      partialTables: [],
    });
    expect(rows.map((r) => r.label)).toEqual([
      "Cisco ASA",
      "AWSCloudTrail (no product columns)",
      "Heartbeat (sources not read)",
      "Fortinet FortiGate",
      "Perf (sources not read)",
    ]);
  });

  it("gives a null agreement when nothing was measured and nothing read", () => {
    const { reconciliation } = run(inv(table("Heartbeat", 3, { kind: "failed", error: "x" })));
    expect(reconciliation).toMatchObject({ measuredDailyMB: 0, usageDailyMB: 0, agreementPct: null });
  });

  it("keeps the tables listing's kind: verified none stays none, unverified empty stays empty", () => {
    expect(bySource({ tables: { kind: "none" } }).rows).toEqual({ kind: "none" });
    expect(bySource({ tables: { kind: "empty" } }).rows).toEqual({ kind: "empty" });
    expect(bySource(inv(table("AWSCloudTrail", 2, read(src("", "none", 2))))).rows.kind).toBe("rows");
  });

  it("marks rows and the reconciliation with the tables whose breakdown was PARTIAL", () => {
    const partial: TableSources = {
      kind: "partial",
      warning: "timeout",
      sources: [src("Cisco ASA", "product", 2)],
    };
    const result = bySource(
      inv(
        table("CommonSecurityLog", 5, partial),
        table("SecurityAlert", 1, read(src("Cisco ASA", "product", 1))),
        table("AWSCloudTrail", 4, read(src("", "none", 4))),
      ),
    );
    const rows = listingRows(result.rows);
    expect(rows.find((r) => r.kind === "product")).toMatchObject({
      measured: true,
      dailyMB: 3,
      partialTables: ["CommonSecurityLog"],
    });
    expect(rows.find((r) => r.kind === "table")!.partialTables).toEqual([]);
    expect(result.reconciliation.partialTables).toEqual(["CommonSecurityLog"]);
  });

  it("carries billedExceedsTotal onto the row when any contributing source had it", () => {
    const { rows } = run(
      inv(
        table(
          "CommonSecurityLog",
          5,
          read(
            src("Cisco ASA", "product", 2, { collector: "a", billedExceedsTotal: true }),
            src("Cisco ASA", "product", 3, { collector: "b" }),
            src("Fortinet", "product", 1),
          ),
        ),
      ),
    );
    expect(rows.map((r) => [r.label, r.billedExceedsTotal])).toEqual([
      ["Cisco ASA", true],
      ["Fortinet", false],
    ]);
  });

  it("sorts a row's collectors by volume, highest first, across merged tables", () => {
    const { rows } = run(
      inv(
        table("CommonSecurityLog", 3, read(src("Cisco ASA", "product", 1, { collector: "small" }))),
        table("SecurityAlert", 6, read(src("Cisco ASA", "product", 5, { collector: "big" }))),
      ),
    );
    expect(rows[0]!.collectors.map((c) => c.name)).toEqual(["big", "small"]);
  });

  it("puts a computer-attributed fall-through row in CommonSecurityLog into '(other sources)'", () => {
    const { rows } = run(
      inv(
        table(
          "CommonSecurityLog",
          5,
          read(src("Cisco ASA", "product", 3), src("collector-1", "computer", 2)),
        ),
      ),
    );
    expect(rows.map((r) => [r.kind, r.label, r.dailyMB])).toEqual([
      ["product", "Cisco ASA", 3],
      ["table", "CommonSecurityLog (other sources)", 2],
    ]);
  });
});
