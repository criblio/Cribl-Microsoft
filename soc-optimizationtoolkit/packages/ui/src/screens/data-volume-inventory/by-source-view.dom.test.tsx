// @vitest-environment happy-dom
/**
 * MIG-30: the By source view. Pins what fails silently if it regresses: a
 * product merged across collectors is ONE row, a table whose sources were not
 * read keeps its Usage volume and says "not read" (never zero, never dropped),
 * the catalog flag names the Free-tagged table, and the reconciliation sentence
 * compares the two lenses exactly.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { InventorySource, InventoryTable, Listing } from "@soc/core";
import { BySourceView } from "./by-source-view";

afterEach(cleanup);

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

function cisco(collector: string, mb: number): InventorySource {
  return source({
    source: "Cisco ASA",
    attribution: "product",
    collector,
    dailyAverageMB: mb,
    billableDailyMB: mb,
  });
}

function tableOf(name: string, dailyAverageMB: number, sources: InventoryTable["sources"]): InventoryTable {
  return {
    table: name,
    totalMB: dailyAverageMB * 30,
    billableMB: dailyAverageMB * 30,
    daysWithData: 30,
    solutions: [],
    dailyAverageMB,
    sources,
  };
}

const TABLES: Listing<InventoryTable> = {
  kind: "rows",
  rows: [
    tableOf("CommonSecurityLog", 36, {
      kind: "read",
      sources: [cisco("fw-a", 20), cisco("fw-b", 10), cisco("fw-c", 5)],
    }),
    tableOf("SecurityAlert", 2, {
      kind: "read",
      sources: [
        source({
          source: "Microsoft Defender",
          attribution: "product",
          dailyAverageMB: 1.5,
          billableDailyMB: 1,
          freeDailyMB: 0.5,
        }),
      ],
    }),
    tableOf("Heartbeat", 3, { kind: "failed", error: "not requested" }),
  ],
};

/** The body row whose first cell starts with `label`. */
function rowFor(label: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((r) => r.querySelector("td")?.textContent?.startsWith(label));
  if (row === undefined) throw new Error(`no row for ${label}`);
  return row;
}

describe("BySourceView", () => {
  it("lists Cisco ASA once, with its three collectors and their volumes", () => {
    render(<BySourceView inventory={{ tables: TABLES }} />);
    expect(screen.getAllByText("Cisco ASA")).toHaveLength(1);
    const row = rowFor("Cisco ASA");
    expect(within(row).getByText("3 collectors")).toBeTruthy();
    expect(within(row).getByText("fw-a - 20.0 MB/day")).toBeTruthy();
    expect(within(row).getByText("fw-c - 5.0 MB/day")).toBeTruthy();
    expect(row.textContent).toContain("35.0 MB");
    expect(row.textContent).toContain("billed 35.0 MB");
    expect(row.textContent).toContain("free 0 MB");
    // The rows are sorted by daily volume, Cisco ASA first.
    expect(screen.getAllByRole("row")[1]).toBe(row);
  });

  it("keeps a not-read table's Usage volume and reads its split as not read", () => {
    render(<BySourceView inventory={{ tables: TABLES }} />);
    const row = rowFor("Heartbeat (sources not read)");
    expect(row.textContent).toContain("3.0 MB");
    expect(within(row).getByText("not read")).toBeTruthy();
    expect(row.querySelector(".by-source-split-bar")).toBeNull();
  });

  it("flags billed volume in a table the catalog tags Free, naming the table", () => {
    render(<BySourceView inventory={{ tables: TABLES }} />);
    const row = rowFor("Microsoft Defender");
    expect(
      within(row).getByText("billed in a table the catalog tags Free (SecurityAlert)"),
    ).toBeTruthy();
    expect(rowFor("Cisco ASA").textContent).not.toContain("catalog tags Free");
  });

  it("flags a Billable-tagged table measured all free, and quotes a punctuation collector (MIG-32)", () => {
    const tables: Listing<InventoryTable> = {
      kind: "rows",
      rows: [
        tableOf("CommonSecurityLog", 6, { kind: "read", sources: [cisco(":", 6)] }),
        tableOf("SecurityCaseEvent", 1, {
          kind: "read",
          sources: [
            source({
              source: "Case Mgmt",
              attribution: "product",
              dailyAverageMB: 1,
              billableDailyMB: 0,
              freeDailyMB: 1,
            }),
          ],
        }),
      ],
    };
    render(<BySourceView inventory={{ tables }} />);
    expect(
      within(rowFor("SecurityCaseEvent (no product columns)")).getByText("measured free; not in the catalog's free list (SecurityCaseEvent)"),
    ).toBeTruthy();
    expect(rowFor("Cisco ASA").textContent).not.toContain("measured free");
    expect(within(rowFor("Cisco ASA")).getByText('":" - 6.0 MB/day')).toBeTruthy();
    // Heartbeat is on Microsoft's never-billed list: measured free is expected, not a flag.
    const withHeartbeat: Listing<InventoryTable> = {
      kind: "rows",
      rows: [
        tableOf("Heartbeat", 1, {
          kind: "read",
          sources: [source({ source: "vm-1", attribution: "computer", dailyAverageMB: 1, freeDailyMB: 1 })],
        }),
      ],
    };
    cleanup();
    render(<BySourceView inventory={{ tables: withHeartbeat }} />);
    expect(screen.queryByText(/measured free/)).toBeNull();
  });

  it("draws the billed and free bar in proportion", () => {
    render(<BySourceView inventory={{ tables: TABLES }} />);
    const bar = rowFor("Microsoft Defender").querySelector(".by-source-split-bar")!;
    const billed = bar.querySelector<HTMLElement>(".by-source-split-billed")!;
    const free = bar.querySelector<HTMLElement>(".by-source-split-free")!;
    expect(billed.style.flexGrow).toBe("1");
    expect(free.style.flexGrow).toBe("0.5");
  });

  it("states the reconciliation sentence exactly", () => {
    render(<BySourceView inventory={{ tables: TABLES }} />);
    // Measured 35 + 1.5 = 36.5 against Usage 36 + 2 = 38: 96.05% agreement, so within 4.0%.
    expect(
      screen.getByText(
        "Sources (measured from the rows) total 36.5 MB/day; Usage reports 38.0 MB/day for " +
          "the same tables; they agree within 4.0%. Usage also reports 3.0 MB/day from 1 table " +
          "whose sources were not read, left out of that comparison.",
      ),
    ).toBeTruthy();
  });

  it("reads free as not known for a source billed above its total", () => {
    const broken: Listing<InventoryTable> = {
      kind: "rows",
      rows: [
        tableOf("CommonSecurityLog", 4, {
          kind: "read",
          sources: [
            source({
              source: "Palo Alto",
              attribution: "product",
              collector: "edge-1",
              dailyAverageMB: 3,
              billableDailyMB: 4,
              billedExceedsTotal: true,
            }),
          ],
        }),
      ],
    };
    render(<BySourceView inventory={{ tables: broken }} />);
    const row = rowFor("Palo Alto");
    expect(row.textContent).toContain("free not known");
    expect(row.textContent).not.toContain("free 0 MB");
    expect(row.querySelector(".by-source-split-bar")).toBeNull();
  });

  it("says a verified empty answer and an unverified one differently, and counts neither", () => {
    render(<BySourceView inventory={{ tables: { kind: "none" } }} />);
    expect(screen.getByText(/Usage billed nothing/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    cleanup();
    render(<BySourceView inventory={{ tables: { kind: "empty" } }} />);
    expect(screen.getByText(/could not be confirmed/)).toBeTruthy();
    expect(screen.queryByText(/Usage billed nothing/)).toBeNull();
    expect(screen.queryByText(/\b0 sources?\b/)).toBeNull();
  });

  it("uses no native title tooltips", () => {
    render(<BySourceView inventory={{ tables: TABLES }} />);
    expect(document.querySelector("[title]")).toBeNull();
  });
});
