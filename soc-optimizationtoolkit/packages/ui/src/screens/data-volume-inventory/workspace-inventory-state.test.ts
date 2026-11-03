import { describe, expect, it } from "vitest";
import type { InventorySource, WorkspaceDiscovery } from "@soc/core";
import {
  discoveryHeadline,
  formatMB,
  inventoryCsv,
  sourceLabel,
  staleInventoryNote,
  workspaceNameOf,
} from "./workspace-inventory-state";

function source(partial: Partial<InventorySource>): InventorySource {
  return {
    source: "",
    attribution: "none",
    bytes: 0,
    events: 0,
    sourceCount: 1,
    dailyAverageMB: 0,
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
  it("shows a resource by name and type, with the full id in the title", () => {
    const id =
      "/subscriptions/s/resourcegroups/rg/providers/microsoft.hybridcompute/machines/lab-wks-01";
    expect(sourceLabel(source({ source: id, attribution: "resource" }))).toEqual({
      text: "lab-wks-01",
      title: id,
      kind: "machines",
    });
  });

  it("names an unattributed source as such, not as blank", () => {
    const label = sourceLabel(source({ attribution: "none" }));
    expect(label.text).toBe("Unattributed");
    expect(label.title).toMatch(/_ResourceId, Computer or DeviceVendor/);
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
    });
    expect(csv.split("\n")[1]).toBe('Big_CL,1.000,30.000,30,,,,,,"failed: HTTP 504, timeout"');
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
      title: "/subscriptions/s/resourceGroups/rg-lab",
      kind: "Azure resource",
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
