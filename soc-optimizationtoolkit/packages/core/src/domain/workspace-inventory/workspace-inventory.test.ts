/**
 * Pins for the workspace inventory fold (MIG-2).
 *
 * The fixtures are TRIMMED COPIES OF LIVE ANSWERS (law-jpederson-eastus,
 * 2026-10-29), not invented shapes: two of the parser's rules - make_set
 * arriving as a JSON string, and isfuzzy's missing-table warning - were only
 * learned by running the queries, and a hand-written fixture would have
 * encoded the wrong belief and passed.
 */
import { describe, expect, it } from "vitest";

import {
  answeredOutcome,
  chunk,
  INVENTORY_WINDOW_DAYS,
  inventoryTotals,
  kqlTableRef,
  parseQueryResult,
  parseSourceRows,
  parseUsageRows,
  sourceBreakdownQuery,
  sourcesFor,
  SOURCES_PER_TABLE,
  toInventoryTable,
  USAGE_QUERY,
} from "./workspace-inventory";

/** Live Usage answer, two of six rows kept. */
const LIVE_USAGE = {
  tables: [
    {
      name: "PrimaryResult",
      columns: [
        { name: "DataType", type: "string" },
        { name: "TotalMB", type: "real" },
        { name: "BillableMB", type: "real" },
        { name: "DaysWithData", type: "long" },
        { name: "Solutions", type: "dynamic" },
      ],
      rows: [
        ["WindowsEvent", 39.943737, 39.943737, 30,
          '["WindowsEventForwarding/CustomizedWindowsEventsFiltering/WEF_10x/SecurityInsights"]'],
        ["Heartbeat", 27.144239000000006, 0, 30, '["LogManagement"]'],
      ],
    },
  ],
};

/** Live breakdown answer with one deliberately missing table. */
const LIVE_SOURCES = {
  error: {
    code: "PartialError",
    message: "There were some errors when processing your query.",
    details: [
      {
        code: "EngineError",
        message: "Something went wrong processing your query on the server.",
        innererror: {
          code: "-2133196790",
          message: "'union' operator: Failed to resolve table expression named '[\"NoSuchTable_CL\"]'",
          severity: 3,
          severityName: "Warning",
        },
      },
    ],
  },
  tables: [
    {
      name: "PrimaryResult",
      columns: [
        { name: "SourceTable", type: "string" },
        { name: "Source", type: "string" },
        { name: "Attribution", type: "string" },
        { name: "Bytes", type: "real" },
        { name: "Events", type: "long" },
        { name: "Sources", type: "long" },
      ],
      rows: [
        ["AWSVPCFlow", "", "none", 1990908670, 14863708, 1],
        ["Heartbeat", "/subscriptions/s/resourcegroups/rg/providers/microsoft.hybridcompute/machines/ti-cef-collector", "resource", 959928, 1702, 1],
        ["Heartbeat", "/subscriptions/s/resourcegroups/rg/providers/microsoft.hybridcompute/machines/lab-wks-01", "resource", 26245466, 43238, 1],
      ],
    },
  ],
};

describe("the queries", () => {
  it("bounds both queries to 30 COMPLETE UTC days, so the average divides by 30", () => {
    expect(INVENTORY_WINDOW_DAYS).toBe(30);
    const window = "TimeGenerated >= startofday(now()) - 30d and TimeGenerated < startofday(now())";
    expect(USAGE_QUERY).toContain(window);
    expect(sourceBreakdownQuery(["A"])).toContain(window);
  });

  it("never references _ResourceId or Computer bare - a table without one fails the query (SEM0100)", () => {
    const q = sourceBreakdownQuery(["AWSVPCFlow"]);
    expect(q).toContain("column_ifexists('_ResourceId', '')");
    expect(q).toContain("column_ifexists('Computer', '')");
    expect(q.replace(/column_ifexists\('[^']+'/g, "")).not.toMatch(/_ResourceId|\bComputer\b/);
  });

  it("unions fuzzily so one unqueryable table does not fail the batch", () => {
    expect(sourceBreakdownQuery(["A", "B"])).toMatch(
      /^union isfuzzy=true withsource=SourceTable \['A'\], \['B'\]/,
    );
  });

  it("rolls sources past the cap into one row", () => {
    expect(sourceBreakdownQuery(["A"])).toContain(`Rank > ${SOURCES_PER_TABLE}`);
  });

  it("quotes table names so a quote cannot end the literal", () => {
    expect(kqlTableRef("My_CL")).toBe("['My_CL']");
    expect(kqlTableRef("a'b")).toBe("['a\\'b']");
  });

  it("refuses an empty batch rather than emitting `union` with nothing", () => {
    expect(() => sourceBreakdownQuery([])).toThrow(/no tables/);
  });
});

describe("parseQueryResult", () => {
  it("keys rows by column name", () => {
    const r = parseQueryResult(LIVE_USAGE);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1]).toMatchObject({ DataType: "Heartbeat", BillableMB: 0 });
    expect(r.warning).toBeNull();
  });

  it("reads isfuzzy's missing-table warning as an UNRESOLVED TABLE, not a partial answer", () => {
    const r = parseQueryResult(LIVE_SOURCES);
    expect(r.unresolvedTables).toEqual(["NoSuchTable_CL"]);
    expect(r.warning).toBeNull();
    expect(r.rows).toHaveLength(3);
  });

  it("keeps any OTHER partial error as a warning, with the detail text", () => {
    const body = {
      ...LIVE_SOURCES,
      error: {
        code: "PartialError",
        message: "There were some errors when processing your query.",
        details: [{ code: "x", innererror: { message: "Query result set has exceeded the limit" } }],
      },
    };
    expect(parseQueryResult(body).warning).toBe("Query result set has exceeded the limit");
  });

  it("throws on a body it does not understand - that is not zero rows", () => {
    expect(() => parseQueryResult({})).toThrow(/no primary table/);
    expect(() => parseQueryResult({ tables: [{ rows: [] }] })).toThrow(/no primary table/);
  });
});

describe("parseUsageRows", () => {
  it("decodes make_set's JSON STRING and splits Usage's '/'-joined solutions", () => {
    const [windows, heartbeat] = parseUsageRows(parseQueryResult(LIVE_USAGE).rows);
    expect(windows!.solutions).toEqual([
      "CustomizedWindowsEventsFiltering",
      "SecurityInsights",
      "WEF_10x",
      "WindowsEventForwarding",
    ]);
    expect(heartbeat!.solutions).toEqual(["LogManagement"]);
  });

  it("keeps billable and total apart - Heartbeat is free", () => {
    const [, heartbeat] = parseUsageRows(parseQueryResult(LIVE_USAGE).rows);
    expect(heartbeat).toMatchObject({ table: "Heartbeat", totalMB: 27.144239000000006, billableMB: 0 });
  });

  it("drops a nameless row and coerces a non-number to 0", () => {
    expect(parseUsageRows([{ DataType: "" }, { DataType: "T", TotalMB: "x" }])).toEqual([
      { table: "T", totalMB: 0, billableMB: 0, daysWithData: 0, solutions: [] },
    ]);
  });
});

describe("parseSourceRows and sourcesFor", () => {
  const outcome = answeredOutcome(parseQueryResult(LIVE_SOURCES));

  it("orders a table's sources by volume and computes each daily average in MB", () => {
    const heartbeat = parseSourceRows(parseQueryResult(LIVE_SOURCES).rows).get("heartbeat")!;
    expect(heartbeat.map((s) => s.bytes)).toEqual([26245466, 959928]);
    expect(heartbeat[0]!.dailyAverageMB).toBeCloseTo(26245466 / 1e6 / 30, 9);
  });

  it("puts the rolled-up `other` row last even when it is the biggest", () => {
    const rows = [
      { SourceTable: "T", Source: "a", Attribution: "computer", Bytes: 5, Events: 1, Sources: 1 },
      { SourceTable: "T", Source: "", Attribution: "other", Bytes: 50, Events: 9, Sources: 40 },
    ];
    const list = parseSourceRows(rows).get("t")!;
    expect(list.map((s) => s.attribution)).toEqual(["computer", "other"]);
    expect(list[1]!.sourceCount).toBe(40);
  });

  it("reports an UNATTRIBUTED source as such - AWS tables carry no resource or computer", () => {
    const aws = sourcesFor("AWSVPCFlow", outcome);
    expect(aws).toMatchObject({ kind: "read", sources: [{ source: "", attribution: "none" }] });
  });

  it("matches the table name case-insensitively", () => {
    expect(sourcesFor("heartbeat", outcome).kind).toBe("read");
  });

  it("says an unresolved table FAILED, naming why - not that it has no sources", () => {
    const missing = sourcesFor("NoSuchTable_CL", outcome);
    expect(missing.kind).toBe("failed");
    if (missing.kind !== "failed") throw new Error("unreachable");
    expect(missing.error).toMatch(/could not resolve/);
  });

  it("says a billed table with no rows back FAILED too", () => {
    const silent = sourcesFor("WindowsEvent", outcome);
    expect(silent.kind).toBe("failed");
    if (silent.kind !== "failed") throw new Error("unreachable");
    expect(silent.error).toMatch(/no rows .* although Usage billed it/);
  });

  it("marks sources from a partial answer PARTIAL", () => {
    const partial = { ...outcome, warning: "limit" } as typeof outcome;
    expect(sourcesFor("Heartbeat", partial)).toMatchObject({ kind: "partial", warning: "limit" });
  });

  it("carries a failed query's error onto the table", () => {
    expect(sourcesFor("X", { kind: "failed", error: "HTTP 504" })).toEqual({
      kind: "failed",
      error: "HTTP 504",
    });
  });
});

describe("totals", () => {
  it("averages over the WINDOW, not over the days a table had data", () => {
    const rows = parseUsageRows(parseQueryResult(LIVE_USAGE).rows);
    const totals = inventoryTotals(rows);
    expect(totals.totalMB).toBeCloseTo(39.943737 + 27.144239, 6);
    expect(totals.billableMB).toBeCloseTo(39.943737, 6);
    expect(totals.dailyAverageMB).toBeCloseTo((39.943737 + 27.144239) / 30, 6);
    expect(totals.billableDailyAverageMB).toBeCloseTo(39.943737 / 30, 6);

    const sparse = { table: "TI", totalMB: 90, billableMB: 90, daysWithData: 2, solutions: [] };
    expect(toInventoryTable(sparse, { kind: "failed", error: "" }).dailyAverageMB).toBe(3);
  });
});

describe("chunk", () => {
  it("splits into consecutive batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow();
  });
});
