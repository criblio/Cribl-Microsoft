/**
 * Tests for the solution-browser pure decisions (porting-plan Unit 14 UI):
 * search/filter, deprecation display, the counts, and the PRESERVED
 * `#/?solution=` deep-link contract (Unit 26 relies on it).
 */
import { describe, expect, it } from "vitest";
import type { SolutionRef } from "@soc/core";
import {
  DEPRECATED_BADGE_LABEL,
  SOLUTION_DEEPLINK_PARAM,
  buildSolutionDeepLink,
  deprecationBadge,
  filterSolutions,
  parseSolutionDeepLink,
  resolveSelectedSolution,
  solutionCounts,
  solutionMatchesQuery,
} from "./browser-state";

const SOLUTIONS: SolutionRef[] = [
  { name: "CrowdStrike Falcon Endpoint Protection", path: "Solutions/CrowdStrike Falcon Endpoint Protection" },
  { name: "Cloudflare", path: "Solutions/Cloudflare" },
  {
    name: "Forescout (Legacy)",
    path: "Solutions/Forescout (Legacy)",
    deprecated: true,
    deprecationReason: "Solution marked as legacy",
  },
  { name: "Zscaler", path: "Solutions/Zscaler" },
];

describe("solutionMatchesQuery", () => {
  it("matches every solution on an empty or whitespace query", () => {
    expect(solutionMatchesQuery("Cloudflare", "")).toBe(true);
    expect(solutionMatchesQuery("Cloudflare", "   ")).toBe(true);
  });

  it("matches case-insensitively on a substring", () => {
    expect(solutionMatchesQuery("CrowdStrike Falcon", "crowd")).toBe(true);
    expect(solutionMatchesQuery("CrowdStrike Falcon", "FALCON")).toBe(true);
    expect(solutionMatchesQuery("Cloudflare", "zscaler")).toBe(false);
  });

  it("ignores separators, so a vendor typed as one word still matches", () => {
    // REGRESSION PIN (user report 2026-08-04): searching "checkpoint" returned
    // only the solutions spelled without the space, which made Check Point look
    // like an email-only vendor and hid everything else.
    expect(solutionMatchesQuery("Check Point", "checkpoint")).toBe(true);
    expect(solutionMatchesQuery("Check Point CloudGuard CNAPP", "checkpoint")).toBe(true);
    expect(solutionMatchesQuery("Checkpoint Email Security", "check point")).toBe(true);
    expect(solutionMatchesQuery("Palo Alto Networks", "paloalto")).toBe(true);
    expect(solutionMatchesQuery("Trend Micro Vision One", "trendmicro")).toBe(true);
  });

  it("does not turn a punctuation-only query into a match-everything", () => {
    // The collapsed form of "---" is "", and every string contains "" - so the
    // collapsed pass has to be skipped rather than allowed to match the catalog.
    expect(solutionMatchesQuery("Cloudflare", "---")).toBe(false);
    expect(solutionMatchesQuery("Cloudflare", "!!")).toBe(false);
  });

  it("still rejects a genuine non-match after collapsing", () => {
    expect(solutionMatchesQuery("Check Point", "zscaler")).toBe(false);
    expect(solutionMatchesQuery("Cloudflare", "checkpoint")).toBe(false);
  });
});

describe("filterSolutions", () => {
  it("filters by search text, preserving order (a stable projection, not a re-sort)", () => {
    // "o" appears in CrowdStrike (Falcon/Protection), Cloudflare, Forescout -
    // but not Zscaler - so the filtered view keeps the index order minus Zscaler.
    const out = filterSolutions(SOLUTIONS, { query: "o", hideDeprecated: false });
    expect(out.map((s) => s.name)).toEqual([
      "CrowdStrike Falcon Endpoint Protection",
      "Cloudflare",
      "Forescout (Legacy)",
    ]);
  });

  it("hides deprecated solutions when the toggle is on", () => {
    const out = filterSolutions(SOLUTIONS, { query: "", hideDeprecated: true });
    expect(out.some((s) => s.name === "Forescout (Legacy)")).toBe(false);
    expect(out).toHaveLength(3);
  });

  it("combines search and hide-deprecated", () => {
    const out = filterSolutions(SOLUTIONS, { query: "fore", hideDeprecated: true });
    expect(out).toHaveLength(0);
  });
});

describe("solutionCounts", () => {
  it("counts the whole index by deprecation status", () => {
    expect(solutionCounts(SOLUTIONS)).toEqual({
      total: 4,
      active: 3,
      deprecated: 1,
    });
  });

  it("is all-zero for an empty index", () => {
    expect(solutionCounts([])).toEqual({ total: 0, active: 0, deprecated: 0 });
  });
});

describe("deprecationBadge", () => {
  it("returns null for an active solution", () => {
    expect(deprecationBadge(SOLUTIONS[1])).toBeNull();
  });

  it("returns the DEPRECATED label and the index reason for a deprecated one", () => {
    const badge = deprecationBadge(SOLUTIONS[2]);
    expect(badge).toEqual({
      label: DEPRECATED_BADGE_LABEL,
      reason: "Solution marked as legacy",
    });
  });

  it("falls back to a neutral reason when the index carried none", () => {
    const badge = deprecationBadge({ name: "X", path: "Solutions/X", deprecated: true });
    expect(badge?.label).toBe(DEPRECATED_BADGE_LABEL);
    expect(badge?.reason.length).toBeGreaterThan(0);
  });
});

describe("deep-link contract (#/?solution=) - preserved for Unit 26", () => {
  it("uses the exact 'solution' param name", () => {
    expect(SOLUTION_DEEPLINK_PARAM).toBe("solution");
  });

  it("builds an encoded #/?solution= hash", () => {
    expect(buildSolutionDeepLink("Cloudflare")).toBe("#/?solution=Cloudflare");
    expect(buildSolutionDeepLink("Forescout (Legacy)")).toBe(
      "#/?solution=Forescout%20(Legacy)",
    );
  });

  it("round-trips build -> parse", () => {
    for (const s of SOLUTIONS) {
      expect(parseSolutionDeepLink(buildSolutionDeepLink(s.name))).toBe(s.name);
    }
  });

  it("parses the param out of the shapes the router produces", () => {
    expect(parseSolutionDeepLink("#/?solution=Zscaler")).toBe("Zscaler");
    expect(parseSolutionDeepLink("#/integrate?solution=Cloudflare")).toBe("Cloudflare");
    expect(parseSolutionDeepLink("#?solution=Zscaler")).toBe("Zscaler");
  });

  it("returns null when absent or empty", () => {
    expect(parseSolutionDeepLink("#/")).toBeNull();
    expect(parseSolutionDeepLink("#/integrate")).toBeNull();
    expect(parseSolutionDeepLink("#/?solution=")).toBeNull();
    expect(parseSolutionDeepLink("")).toBeNull();
  });
});

describe("resolveSelectedSolution", () => {
  it("resolves an exact name", () => {
    expect(resolveSelectedSolution(SOLUTIONS, "Zscaler")?.name).toBe("Zscaler");
  });

  it("falls back to a case-insensitive match (deep links may not preserve casing)", () => {
    expect(resolveSelectedSolution(SOLUTIONS, "cloudflare")?.name).toBe("Cloudflare");
  });

  it("returns null for no match or a null/empty name", () => {
    expect(resolveSelectedSolution(SOLUTIONS, "Nope")).toBeNull();
    expect(resolveSelectedSolution(SOLUTIONS, null)).toBeNull();
    expect(resolveSelectedSolution(SOLUTIONS, "")).toBeNull();
  });

  /**
   * DBT-28 defect (1). The resolver stopped at case-insensitive-exact while the
   * SEARCH BOX beside it already ignored separators, so a handoff naming a
   * solution that exists under different punctuation resolved to nothing and
   * was consumed in silence.
   *
   * THE FIXTURE IS A REAL FAILING PAIR, not an invented one. The SIEM
   * knowledge base sends a `cisco_` Splunk macro with no direct entry of its
   * own to the solution "Cisco ASA" (packages/core .../knowledge-bases.ts
   * SPLUNK_PREFIX_MAP) and the repo folder is "CiscoASA"; the fuzzy tier that
   * could have rewritten it never runs on a knowledge-base hit
   * (applyFuzzySolutionMap returns early unless confidence === "none").
   * Measured 2026-09-04 against the live Solutions listing: of the 26 distinct
   * names the knowledge bases carried at that moment, 17 match a folder
   * exactly, 1 case-insensitively, exactly this 1 only under the collapsing
   * pass, and 7 match nothing under any rule. The table was being edited that
   * day (DBT-103) and an earlier read gave 24 / 12 / 1 / 1 / 10; the
   * collapse-only entry was this same pair in both.
   *
   * The pair is HARD-CODED here rather than imported, so this pin keeps
   * describing the defect class after that row is corrected - the knowledge
   * bases are hand-maintained and being edited (DBT-103), and 332 of the 574
   * Solutions folders carry a separator, so the next such name is a question of
   * when rather than whether.
   */
  const PUNCTUATION_INDEX: SolutionRef[] = [
    { name: "CiscoASA", path: "Solutions/CiscoASA" },
    { name: "Palo Alto Networks", path: "Solutions/Palo Alto Networks" },
    { name: "Check Point", path: "Solutions/Check Point" },
    { name: "Cisco Umbrella", path: "Solutions/Cisco Umbrella" },
  ];

  it("resolves a name that differs from the index only in separators", () => {
    expect(resolveSelectedSolution(PUNCTUATION_INDEX, "Cisco ASA")?.name).toBe(
      "CiscoASA",
    );
    expect(
      resolveSelectedSolution(PUNCTUATION_INDEX, "PaloAltoNetworks")?.name,
    ).toBe("Palo Alto Networks");
    expect(resolveSelectedSolution(PUNCTUATION_INDEX, "checkpoint")?.name).toBe(
      "Check Point",
    );
  });

  it("uses collapsed EQUALITY, never a collapsed substring", () => {
    // The whole safety argument for the third pass is that a collapsed name is
    // an IDENTITY (measured 2026-09-04: 574 Solutions folders, 0 groups sharing
    // a collapsed form). A substring test would throw that away - "Cisco" would
    // claim CiscoASA, and "Cisco U" would claim it too while a real
    // "Cisco Umbrella" sits in the same index. Nothing here may resolve.
    expect(resolveSelectedSolution(PUNCTUATION_INDEX, "Cisco")).toBeNull();
    expect(resolveSelectedSolution(PUNCTUATION_INDEX, "Cisco A")).toBeNull();
    expect(resolveSelectedSolution(PUNCTUATION_INDEX, "CiscoASAExtra")).toBeNull();
    expect(resolveSelectedSolution(PUNCTUATION_INDEX, "Palo Alto")).toBeNull();
  });

  it("does not let an all-punctuation name match anything", () => {
    // "---" collapses to "", and so would a solution named "---". Matching them
    // to each other would be an accident rather than a resolution, so the pass
    // is skipped - the same guard solutionMatchesQuery carries.
    expect(resolveSelectedSolution(PUNCTUATION_INDEX, "---")).toBeNull();
    expect(resolveSelectedSolution(PUNCTUATION_INDEX, " ")).toBeNull();
    expect(
      resolveSelectedSolution([{ name: "-", path: "Solutions/-" }], "---"),
    ).toBeNull();
  });

  it("still prefers an EXACT name over a collapsed one", () => {
    // Ordering matters where two entries collapse to the same form. The live
    // index has no such pair, but the resolver must not depend on that: an
    // exact hit is never traded for a collapsed one.
    const ambiguous: SolutionRef[] = [
      { name: "CiscoASA", path: "Solutions/CiscoASA" },
      { name: "Cisco ASA", path: "Solutions/Cisco ASA" },
    ];
    expect(resolveSelectedSolution(ambiguous, "Cisco ASA")?.path).toBe(
      "Solutions/Cisco ASA",
    );
    expect(resolveSelectedSolution(ambiguous, "cisco asa")?.path).toBe(
      "Solutions/Cisco ASA",
    );
  });
});
