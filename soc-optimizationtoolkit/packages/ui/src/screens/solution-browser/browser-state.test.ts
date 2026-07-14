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
});
