/**
 * Contract tests for the browse-samples pure decision layer (porting-plan Unit
 * 16 UI, GUI-06). Covers the four decisions the plan calls out - tier
 * projection, the indeterminate select-all state, load-summary derivation, and
 * the ENG-42 preIngested message selection - plus the stable-id selection
 * toggles and the resolved -> TaggedSample load conversion.
 */
import { describe, expect, it } from "vitest";
import type {
  AvailableSample,
  RepoSampleResult,
  ResolvedSample,
} from "@soc/core";
import {
  BROWSE_TIER_ORDER,
  countSelected,
  loadSummary,
  plannedTagged,
  projectTiers,
  repoNotice,
  resolvedLogType,
  taggedFromResolved,
  tierLabel,
  tierSelectionState,
  toggleOne,
  toggleTier,
  type BrowseTier,
} from "./browse-samples-state";

function entry(
  tier: BrowseTier,
  logType: string,
  eventCount = 2,
  preview: string[] = [],
): AvailableSample {
  return {
    id: `${tier}:${logType}`,
    tier,
    source: `${tier} source`,
    logType,
    format: "json",
    eventCount,
    fileName: `${logType}.json`,
    preview,
  };
}

function repoResult(over: Partial<RepoSampleResult>): RepoSampleResult {
  return {
    success: true,
    samples: [],
    skippedPreIngested: 0,
    filesSearched: 0,
    message: "",
    ...over,
  };
}

describe("projectTiers", () => {
  it("groups by tier in the display order, excluding empty tiers", () => {
    const available = [
      entry("elastic", "TRAFFIC"),
      entry("sentinel-repo", "threat"),
      entry("elastic", "DNS"),
    ];
    const groups = projectTiers(available);
    expect(groups.map((g) => g.tier)).toEqual(["sentinel-repo", "elastic"]);
    // sentinel-repo sorts before elastic per BROWSE_TIER_ORDER
    expect(BROWSE_TIER_ORDER.indexOf("sentinel-repo")).toBeLessThan(
      BROWSE_TIER_ORDER.indexOf("elastic"),
    );
    // input order preserved within a tier
    expect(groups[1].entries.map((e) => e.logType)).toEqual(["TRAFFIC", "DNS"]);
    expect(groups[1].eventTotal).toBe(4);
    expect(groups[0].label).toBe(tierLabel("sentinel-repo"));
  });

  it("returns [] for no samples", () => {
    expect(projectTiers([])).toEqual([]);
  });

  it("appends unknown/forward-compat tiers after the known ones", () => {
    const weird = { ...entry("elastic", "X"), tier: "future" as BrowseTier };
    const groups = projectTiers([weird, entry("sentinel-repo", "a")]);
    expect(groups.map((g) => g.tier)).toEqual(["sentinel-repo", "future"]);
  });
});

describe("select-all indeterminate state", () => {
  const entries = [
    entry("elastic", "a"),
    entry("elastic", "b"),
    entry("elastic", "c"),
  ];

  it("is neither checked nor indeterminate when none selected", () => {
    expect(tierSelectionState(entries, new Set())).toEqual({
      checked: false,
      indeterminate: false,
    });
  });

  it("is indeterminate when some but not all selected", () => {
    const state = tierSelectionState(entries, new Set(["elastic:a"]));
    expect(state).toEqual({ checked: false, indeterminate: true });
  });

  it("is checked when all selected", () => {
    const all = new Set(entries.map((e) => e.id));
    expect(tierSelectionState(entries, all)).toEqual({
      checked: true,
      indeterminate: false,
    });
  });

  it("is neither for an empty tier", () => {
    expect(tierSelectionState([], new Set(["x"]))).toEqual({
      checked: false,
      indeterminate: false,
    });
  });

  it("counts selected entries", () => {
    expect(countSelected(entries, new Set(["elastic:a", "elastic:c", "z"]))).toBe(
      2,
    );
  });
});

describe("selection toggles (stable-id keyed)", () => {
  const entries = [entry("elastic", "a"), entry("elastic", "b")];

  it("adds all tier ids on select, preserving other selections", () => {
    const next = toggleTier(entries, new Set(["other"]), true);
    expect([...next].sort()).toEqual(["elastic:a", "elastic:b", "other"]);
  });

  it("removes all tier ids on deselect", () => {
    const next = toggleTier(entries, new Set(["elastic:a", "elastic:b", "keep"]), false);
    expect([...next]).toEqual(["keep"]);
  });

  it("does not mutate the input set (purity)", () => {
    const input = new Set(["elastic:a"]);
    toggleTier(entries, input, true);
    toggleOne(input, "elastic:a");
    expect([...input]).toEqual(["elastic:a"]);
  });

  it("toggleOne flips a single id", () => {
    expect([...toggleOne(new Set(), "x")]).toEqual(["x"]);
    expect([...toggleOne(new Set(["x"]), "x")]).toEqual([]);
  });
});

describe("loadSummary", () => {
  it("derives per-tier and grand totals from the selection", () => {
    const available = [
      entry("sentinel-repo", "a", 3),
      entry("elastic", "b", 5),
      entry("elastic", "c", 7),
    ];
    const groups = projectTiers(available);
    const summary = loadSummary(groups, new Set(["sentinel-repo:a", "elastic:b"]));
    expect(summary.totalSelected).toBe(2);
    expect(summary.totalEvents).toBe(8);
    const repoLine = summary.tiers.find((t) => t.tier === "sentinel-repo");
    expect(repoLine).toMatchObject({ total: 1, selectedCount: 1, selectedEventTotal: 3 });
    const elasticLine = summary.tiers.find((t) => t.tier === "elastic");
    expect(elasticLine).toMatchObject({ total: 2, selectedCount: 1, selectedEventTotal: 5 });
  });
});

describe("repoNotice (the honest ENG-42 messages)", () => {
  it("is null when there were no candidates to resolve", () => {
    expect(repoNotice(null)).toBeNull();
  });

  it("classifies a usable result as found/ok", () => {
    const notice = repoNotice(
      repoResult({
        samples: [{ logType: "x" } as unknown as RepoSampleResult["samples"][number]],
        message: "Found 1 sample(s) with 5 total events.",
      }),
    );
    expect(notice).toMatchObject({ kind: "found", tone: "ok" });
  });

  it("classifies an all-pre-ingested result as warn", () => {
    const notice = repoNotice(
      repoResult({
        samples: [],
        skippedPreIngested: 3,
        filesSearched: 3,
        message: "All 3 sample(s) are in Sentinel schema format. Upload raw vendor samples or capture live data.",
      }),
    );
    expect(notice).toMatchObject({ kind: "all-preingested", tone: "warn" });
    expect(notice?.message).toMatch(/Sentinel schema/);
  });

  it("classifies matched-but-none-parsed as info", () => {
    const notice = repoNotice(
      repoResult({ samples: [], filesSearched: 2, message: "Found 2 matching file(s) but none could be parsed." }),
    );
    expect(notice).toMatchObject({ kind: "none-parsed", tone: "info" });
  });

  it("classifies a no-match result as info", () => {
    const notice = repoNotice(repoResult({ message: 'No sample data found for "X".' }));
    expect(notice).toMatchObject({ kind: "no-match", tone: "info" });
  });
});

describe("resolved -> tagged conversion (the load step)", () => {
  function resolved(over: Partial<ResolvedSample>): ResolvedSample {
    return {
      tableName: "CommonSecurityLog",
      format: "json",
      rawEvents: ['{"a":1}'],
      source: "sentinel-repo:x",
      tier: "sentinel-repo",
      ...over,
    };
  }

  it("uses logType when present, else the destination table", () => {
    expect(resolvedLogType(resolved({ logType: "Traffic" }))).toBe("Traffic");
    expect(resolvedLogType(resolved({ logType: "  " }))).toBe("CommonSecurityLog");
    expect(resolvedLogType(resolved({}))).toBe("CommonSecurityLog");
  });

  it("tags a resolved sample by re-parsing its raw events", () => {
    const tagged = taggedFromResolved(
      resolved({ logType: "Traffic", rawEvents: ['{"src":"1.1.1.1"}', '{"src":"2.2.2.2"}'] }),
    );
    expect(tagged.logType).toBe("Traffic");
    expect(tagged.parsed.eventCount).toBe(2);
  });

  it("dedupes a batch by log type, last wins, first-seen order preserved", () => {
    const batch = plannedTagged([
      resolved({ logType: "A", rawEvents: ['{"x":1}'] }),
      resolved({ logType: "B", rawEvents: ['{"y":1}'] }),
      resolved({ logType: "A", rawEvents: ['{"x":1}', '{"x":2}'] }),
    ]);
    expect(batch.map((t) => t.logType)).toEqual(["A", "B"]);
    expect(batch[0].parsed.eventCount).toBe(2);
  });
});
