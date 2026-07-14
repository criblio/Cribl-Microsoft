/**
 * Solution-browser pure decision logic (porting-plan Unit 14 UI; GUI-04
 * redesigned, GUI-05). Kept out of the component so search/sort, deprecation
 * display, the deep-link contract, and the counts are unit-testable without a
 * DOM.
 *
 * The legacy flagship browsed a LOCAL MIRROR of every solution; here the list is
 * the lazy index from the SentinelContent port (one contents call) and
 * selecting a solution triggers an on-demand per-solution fetch (the component's
 * job). This module owns only the pure projections over the already-fetched
 * index.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto.
 */

import type { SolutionRef } from "@soc/core";

/**
 * The deep-link query parameter Unit 26 (SIEM migration) relies on:
 * `#/?solution=<name>` deep-links into the guided flow with a solution
 * preselected. This contract is PRESERVED verbatim - do not rename it.
 */
export const SOLUTION_DEEPLINK_PARAM = "solution";

/** The badge label shown on a deprecated solution (verbatim vocabulary). */
export const DEPRECATED_BADGE_LABEL = "DEPRECATED";

/** Inputs to {@link filterSolutions}. */
export interface SolutionFilter {
  /** Free-text search; matched case-insensitively as a substring of the name. */
  query: string;
  /** When true, deprecated solutions are hidden from the list. */
  hideDeprecated: boolean;
}

/** Whether a solution's name matches a (trimmed, lower-cased) search query. */
export function solutionMatchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return true;
  }
  return name.toLowerCase().includes(q);
}

/**
 * Filter the solution index by search text and the hide-deprecated toggle.
 * Order is preserved (the adapter already sorts by name), so this is a stable
 * projection - never a re-sort.
 */
export function filterSolutions(
  solutions: readonly SolutionRef[],
  filter: SolutionFilter,
): SolutionRef[] {
  return solutions.filter((s) => {
    if (filter.hideDeprecated && s.deprecated === true) {
      return false;
    }
    return solutionMatchesQuery(s.name, filter.query);
  });
}

/** Aggregate counts for the browser header (total / active / deprecated). */
export interface SolutionCounts {
  total: number;
  active: number;
  deprecated: number;
}

/** Count the whole index (not the filtered view) by deprecation status. */
export function solutionCounts(
  solutions: readonly SolutionRef[],
): SolutionCounts {
  let deprecated = 0;
  for (const s of solutions) {
    if (s.deprecated === true) {
      deprecated += 1;
    }
  }
  return {
    total: solutions.length,
    active: solutions.length - deprecated,
    deprecated,
  };
}

/** The deprecation badge for a solution, or null when it is active. */
export interface DeprecationBadge {
  label: string;
  reason: string;
}

/**
 * The deprecation badge for a solution, or null when the solution is active.
 * The reason falls back to a neutral sentence when the index did not carry one
 * (index-time deprecation is name-based, so a reason is usually present).
 */
export function deprecationBadge(
  solution: SolutionRef,
): DeprecationBadge | null {
  if (solution.deprecated !== true) {
    return null;
  }
  return {
    label: DEPRECATED_BADGE_LABEL,
    reason:
      solution.deprecationReason ?? "This solution is flagged as deprecated.",
  };
}

/**
 * Build the deep-link hash for a solution: `#/?solution=<encoded name>`. The
 * PRESERVED Unit 26 contract - the same shape the SIEM migration deep link and
 * the guided flow router already parse.
 */
export function buildSolutionDeepLink(name: string): string {
  return `#/?${SOLUTION_DEEPLINK_PARAM}=${encodeURIComponent(name)}`;
}

/**
 * Parse a `?solution=<name>` value out of a location hash, or null when absent.
 * Tolerant of the shapes the router produces: `#/?solution=Foo`,
 * `#/integrate?solution=Foo`, a bare `#?solution=Foo`, and percent-encoding.
 * Returns the decoded solution name (empty string is treated as absent).
 */
export function parseSolutionDeepLink(hash: string): string | null {
  const q = hash.indexOf("?");
  if (q === -1) {
    return null;
  }
  const params = new URLSearchParams(hash.slice(q + 1));
  const raw = params.get(SOLUTION_DEEPLINK_PARAM);
  if (raw === null || raw === "") {
    return null;
  }
  return raw;
}

/**
 * Resolve a deep-linked / selected solution NAME to the index entry: an exact
 * match first, then a case-insensitive fallback (the deep link may not preserve
 * the exact casing). Returns null when nothing matches.
 */
export function resolveSelectedSolution(
  solutions: readonly SolutionRef[],
  name: string | null,
): SolutionRef | null {
  if (name === null || name === "") {
    return null;
  }
  const exact = solutions.find((s) => s.name === name);
  if (exact !== undefined) {
    return exact;
  }
  const lower = name.toLowerCase();
  return solutions.find((s) => s.name.toLowerCase() === lower) ?? null;
}
