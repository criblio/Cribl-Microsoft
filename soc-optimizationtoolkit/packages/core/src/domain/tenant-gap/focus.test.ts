import { describe, expect, it } from "vitest";
import { focusSummary, gapSourceIds } from "./focus";
import { GAP_SOURCES, type GapCell, type GapIndicator, type TenantGapRow } from "./tenant-gap";

const G: GapIndicator = { state: "green", reason: "green reason" };
const R: GapIndicator = { state: "red", reason: "red reason" };
const U: GapIndicator = { state: "unknown", reason: "unknown reason" };

function rowOf(cells: readonly GapCell[]): TenantGapRow {
  return {
    profileId: "pa",
    tenantId: "t",
    cells,
    status: { state: "green", reason: "" },
    warnings: [],
    plannedReads: 0,
    cancelled: false,
  };
}

const [S0, S1, S2, S3, S4] = GAP_SOURCES;

describe("focusSummary", () => {
  it("puts every catalog source in exactly one bucket", () => {
    const row = rowOf([
      { sourceId: S0!.id, azure: R, cribl: G },
      { sourceId: S1!.id, azure: G, cribl: R },
      { sourceId: S2!.id, azure: U, cribl: G },
      { sourceId: S3!.id, azure: G, cribl: G },
      { sourceId: S4!.id, azure: R, cribl: U },
    ]);
    const f = focusSummary(row);
    expect(f.gaps.map((g) => g.sourceId)).toEqual([S0!.id, S1!.id, S4!.id]);
    expect(f.okSources).toEqual([S3!.id]);
    // S2 is unknown; the three sources with no cell are unknown too, never OK.
    expect(f.unknownSources).toEqual([S2!.id, ...GAP_SOURCES.slice(5).map((s) => s.id)]);
    expect(f.gaps.length + f.okSources.length + f.unknownSources.length).toBe(GAP_SOURCES.length);
  });

  it("lists each red indicator with its own reason, and names an unknown other side", () => {
    const f = focusSummary(
      rowOf([
        { sourceId: S0!.id, azure: R, cribl: { state: "red", reason: "cribl red" } },
        { sourceId: S1!.id, azure: R, cribl: U },
      ]),
    );
    expect(f.gaps[0]).toEqual({
      sourceId: S0!.id,
      title: S0!.title,
      red: [
        { side: "azure", indicator: R },
        { side: "cribl", indicator: { state: "red", reason: "cribl red" } },
      ],
      unknownSide: null,
    });
    expect(f.gaps[1]!.red).toEqual([{ side: "azure", indicator: R }]);
    expect(f.gaps[1]!.unknownSide).toEqual({ side: "cribl", indicator: U });
  });

  it("an all-unknown row has no gap and no OK", () => {
    const f = focusSummary(rowOf(GAP_SOURCES.map((s) => ({ sourceId: s.id, azure: U, cribl: U }))));
    expect(f.gaps).toEqual([]);
    expect(f.okSources).toEqual([]);
    expect(f.unknownSources.length).toBe(GAP_SOURCES.length);
  });
});

describe("gapSourceIds", () => {
  it("is the red sources only, and empty without a row", () => {
    const row = rowOf([
      { sourceId: S0!.id, azure: R, cribl: G },
      { sourceId: S1!.id, azure: U, cribl: G },
    ]);
    expect([...gapSourceIds(row)]).toEqual([S0!.id]);
    expect(gapSourceIds(null).size).toBe(0);
  });
});
