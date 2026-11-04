import { describe, expect, it } from "vitest";
import { listingRows } from "@soc/core";
import type { InventorySource, WorkspaceDiscovery, WorkspaceInventory } from "@soc/core";
import {
  bySourceReconciliationText,
  catalogFlagText,
  discoveryHeadline,
  formatMB,
  inventoryCsv,
  sourceLabel,
  sourceLineText,
  tableReconciliation,
  staleInventoryNote,
  workspaceNameOf,
} from "./workspace-inventory-state";

function source(partial: Partial<InventorySource>): InventorySource {
  return {
    source: "",
    attribution: "none",
    collector: "",
    bytes: 0,
    billableBytes: 0,
    events: 0,
    sourceCount: 1,
    dailyAverageMB: 0,
    billableDailyMB: 0,
    freeDailyMB: 0,
    billedExceedsTotal: false,
    ...partial,
  };
}

describe("formatMB", () => {
  it("uses decimal units, matching Usage and the portal", () => {
    expect(formatMB(0)).toBe("0 MB");
    expect(formatMB(0.5)).toBe("500.0 KB");
    expect(formatMB(66.4)).toBe("66.4 MB");
    expect(formatMB(1932.25)).toBe("1.93 GB");
    expect(formatMB(2_500_000)).toBe("2.50 TB");
  });
});

describe("sourceLabel", () => {
  it("shows a resource by name and type, with the full id in its tip", () => {
    const id =
      "/subscriptions/s/resourcegroups/rg/providers/microsoft.hybridcompute/machines/lab-wks-01";
    expect(sourceLabel(source({ source: id, attribution: "resource" }))).toEqual({
      text: "lab-wks-01",
      tip: id,
      kind: "machines",
      via: "",
    });
  });

  it("names an unattributed source as such, not as blank", () => {
    const label = sourceLabel(source({ attribution: "none" }));
    expect(label.text).toBe("Unattributed");
    expect(label.tip).toMatch(/_ResourceId, Computer or DeviceVendor/);
  });

  it("counts the members of the rolled-up row", () => {
    expect(sourceLabel(source({ attribution: "other", sourceCount: 40 })).text).toBe(
      "40 other sources",
    );
  });
});

describe("discoveryHeadline", () => {
  const base: WorkspaceDiscovery = { workspaces: { kind: "empty" }, subscriptionsSearched: 3, failures: [] };

  it("does NOT say there are none when nothing was visible", () => {
    const text = discoveryHeadline(base);
    expect(text).toMatch(/no workspace this identity can see across 3 subscription/);
    expect(text).toMatch(/does not show that none exist/);
  });

  it("names the subscriptions that could not be listed", () => {
    const text = discoveryHeadline({
      ...base,
      failures: [{ subscriptionId: "s", subscriptionName: "x", error: "403" }],
    });
    expect(text).toMatch(/1 subscription\(s\) could not be listed and are not included/);
  });
});

describe("inventoryCsv", () => {
  it("writes a failed breakdown as a row with its reason, so the table is not lost", () => {
    const csv = inventoryCsv({
      workspaceId: "/w",
      windowDays: 30,
      tables: {
        kind: "rows",
        rows: [
          {
            table: "Big_CL",
            totalMB: 30,
            billableMB: 30,
            daysWithData: 30,
            solutions: [],
            dailyAverageMB: 1,
            sources: { kind: "failed", error: "HTTP 504, timeout" },
          },
        ],
      },
      totals: { totalMB: 30, billableMB: 30, dailyAverageMB: 1, billableDailyAverageMB: 1 },
      usageWarning: null,
      queries: { usage: "", sourcesExample: null },
    }, null);
    // MIG-15: a Billable table's allowance figures are empty, never 0.
    expect(csv.split("\n")[1]).toBe(
      'Big_CL,1.000,30.000,30,,,,,,"failed: HTTP 504, timeout",Billable,,,,,,,,',
    );
  });
});

describe("by-source labels, lines, reconciliation and CSV (MIG-29)", () => {
  const cisco = source({
    source: "Cisco ASA",
    attribution: "product",
    collector: "localhost",
    bytes: 45.2e6 * 30,
    billableBytes: 45.2e6 * 30,
    dailyAverageMB: 45.2,
    billableDailyMB: 45.2,
    freeDailyMB: 0,
    events: 10,
  });
  const other = source({
    source: "",
    attribution: "other",
    sourceCount: 40,
    dailyAverageMB: 10,
    billableDailyMB: 4,
    freeDailyMB: 6,
  });
  const inv = (sources: InventorySource[], kind: "read" | "partial" | "failed" = "read") => ({
    workspaceId: "/w",
    windowDays: 30,
    tables: {
      kind: "rows" as const,
      rows: [
        {
          table: "CommonSecurityLog",
          totalMB: 1,
          billableMB: 1,
          daysWithData: 30,
          solutions: [],
          dailyAverageMB: 60,
          sources:
            kind === "failed"
              ? { kind: "failed" as const, error: "x" }
              : kind === "partial"
                ? { kind: "partial" as const, sources, warning: "one batch timed out" }
                : { kind: "read" as const, sources },
        },
      ],
    },
    totals: { totalMB: 1, billableMB: 1, dailyAverageMB: 1, billableDailyAverageMB: 1 },
    usageWarning: null,
    queries: { usage: "", sourcesExample: null },
  }) as unknown as WorkspaceInventory;

  it("labels a product with its collector and kind", () => {
    const label = sourceLabel(cisco);
    expect(label).toMatchObject({ text: "Cisco ASA", kind: "Product", via: "localhost" });
    expect(label.tip).toContain("localhost");
  });

  it("reads Cisco ASA via localhost with billed and free", () => {
    expect(sourceLineText(cisco)).toBe(
      "Cisco ASA via localhost - 45.2 MB/day (billed 45.2 MB, free 0 MB), 10 events",
    );
  });

  it("reads free as not known when billed exceeds total, never as 0 MB", () => {
    const broken = source({ ...cisco, billedExceedsTotal: true, billableDailyMB: 50, freeDailyMB: 0 });
    expect(sourceLineText(broken)).toBe(
      "Cisco ASA via localhost - 45.2 MB/day (billed 50.0 MB, free not known), 10 events",
    );
  });

  it("reconciles a table's own sources against its Usage average", () => {
    expect(tableReconciliation(listingRows(inv([cisco, other]).tables)[0]!)).toBe(
      "Sources (measured from the rows) total 55.2 MB of the 60.0 MB/day Usage reports for this table.",
    );
  });

  it("says a partial breakdown is partial and a failed one has no line", () => {
    expect(tableReconciliation(listingRows(inv([cisco], "partial").tables)[0]!)).toContain(
      "partial (one batch timed out)",
    );
    expect(tableReconciliation(listingRows(inv([], "failed").tables)[0]!)).toBeNull();
  });

  it("appends the four columns to the old header in order, with other's billed and free", () => {
    const lines = inventoryCsv(inv([cisco, other]), null).split("\n");
    expect(lines[0]).toBe(
      "Table,TableDailyAvgMB,TableBillableMB,DaysWithData,Solutions,Source,SourceKind," +
        "SourceDailyAvgMB,SourceEvents,SourceStatus,Allowance,AllowanceEligibleDailyMB," +
        "AllowanceUsedDailyMB,AllowanceOverDailyMB,AllowanceFigures," +
        "SourceIdentity,Collector,BillableDailyMB,FreeDailyMB",
    );
    expect(lines[1]!.endsWith(",Cisco ASA,localhost,45.200,0.000")).toBe(true);
    expect(lines[2]!.endsWith(",,,4.000,6.000")).toBe(true);
    // Billed above total: the free figure is not knowable, so it is empty, never 0.
    const broken = source({ ...cisco, billedExceedsTotal: true, billableDailyMB: 50, freeDailyMB: 0 });
    expect(inventoryCsv(inv([broken]), null).split("\n")[1]!.endsWith(",Cisco ASA,localhost,50.000,")).toBe(true);
  });
});

describe("staleInventoryNote (MIG-7)", () => {
  const A = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law-a";
  const B = A.replace(/law-a$/, "law-b");

  it("is silent when the shown inventory is the selected workspace", () => {
    expect(staleInventoryNote(A, A)).toBeNull();
  });

  it("names both workspaces when they differ", () => {
    expect(staleInventoryNote(A, B)).toBe(
      "Showing the inventory of law-a, not the selected workspace. " +
        "Press Inventory this workspace to read law-b.",
    );
  });
});

describe("ARM id parsing goes through core parseResourceId (audit 2026-10-30)", () => {
  it("names a resource with no providers section by its own name, with no made-up type", () => {
    const label = sourceLabel(
      source({ source: "/subscriptions/s/resourceGroups/rg-lab", attribution: "resource" }),
    );
    // A hand split used to call this kind "resourceGroups".
    expect(label).toEqual({
      text: "rg-lab",
      tip: "/subscriptions/s/resourceGroups/rg-lab",
      kind: "Azure resource",
      via: "",
    });
  });

  it("takes a workspace's name from its ARM id", () => {
    expect(
      workspaceNameOf(
        "/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law-1",
      ),
    ).toBe("law-1");
  });
});

describe("bySourceReconciliationText (MIG-30)", () => {
  const base = {
    measuredDailyMB: 14,
    usageDailyMB: 14.5,
    notReadDailyMB: 0,
    notReadTables: 0,
    partialTables: [] as string[],
    agreementPct: (100 * 14) / 14.5,
  };

  it("compares the two lenses, rounding the gap up", () => {
    // 96.55% agreement: a 3.45% gap reads as within 3.5%, never 3.4%.
    expect(bySourceReconciliationText(base)).toBe(
      "Sources (measured from the rows) total 14.0 MB/day; Usage reports 14.5 MB/day for " +
        "the same tables; they agree within 3.5%.",
    );
  });

  it("reads exact agreement as 0.0%, not float noise", () => {
    expect(
      bySourceReconciliationText({ ...base, usageDailyMB: 14, agreementPct: 100 - 1e-12 }),
    ).toContain("they agree within 0.0%.");
  });

  it("names not-read volume separately and says when the measured total is a floor", () => {
    expect(
      bySourceReconciliationText({
        ...base,
        notReadDailyMB: 3,
        notReadTables: 2,
        partialTables: ["Syslog"],
      }),
    ).toBe(
      "Sources (measured from the rows) total 14.0 MB/day; Usage reports 14.5 MB/day for " +
        "the same tables; they agree within 3.5%. Usage also reports 3.0 MB/day from 2 " +
        "tables whose sources were not read, left out of that comparison. 1 table returned " +
        "a partial breakdown (Syslog), so the measured total is a floor.",
    );
  });

  it("says there is nothing to compare when no table's sources were read", () => {
    expect(
      bySourceReconciliationText({
        ...base,
        measuredDailyMB: 0,
        usageDailyMB: 0,
        notReadDailyMB: 3,
        notReadTables: 1,
        agreementPct: null,
      }),
    ).toBe(
      "No table's sources were read, so there is nothing to compare. Usage reports " +
        "3.0 MB/day from 1 table whose sources were not read.",
    );
  });
});

describe("catalogFlagText (MIG-30)", () => {
  it("names every Free-tagged table billed, and is absent otherwise", () => {
    expect(catalogFlagText(["SecurityAlert", "AzureActivity"])).toBe(
      "billed in a table the catalog tags Free (SecurityAlert, AzureActivity)",
    );
    expect(catalogFlagText([])).toBeNull();
  });
});
