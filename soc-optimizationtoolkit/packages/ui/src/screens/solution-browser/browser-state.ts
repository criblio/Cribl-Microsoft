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
// One separator-insensitive matching rule, shared with the searchable selects.
import { collapseForSearch } from "../../components/searchable-select-filter";

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

/**
 * Whether a solution's name matches a (trimmed, lower-cased) search query.
 *
 * Matches on the raw name first, then on both sides collapsed to alphanumerics.
 * The collapsed pass is what makes "checkpoint" find "Check Point": a plain
 * substring test missed it, so searching the vendor as one word returned only
 * the solutions that happen to spell it without the space ("Checkpoint Email
 * Security", "Checkpoint Harmony Email and Collaboration") and hid the rest.
 * That read as "Check Point is only an email vendor" (user report 2026-08-04).
 */
export function solutionMatchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return true;
  }
  if (name.toLowerCase().includes(q)) {
    return true;
  }
  const collapsedQuery = collapseForSearch(q);
  // An all-punctuation query collapses to "" - which every name "contains",
  // so it would match the whole catalog. The raw test above is its only pass.
  if (collapsedQuery === "") {
    return false;
  }
  return collapseForSearch(name).includes(collapsedQuery);
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
 * match, then case-insensitive, then SEPARATOR-INSENSITIVE equality. Returns
 * null when nothing matches.
 *
 * WHY THE THIRD PASS EXISTS (DBT-28 defect (1)). Until 2026-09-04 this stopped
 * at case-insensitive-exact, while the search box beside it already collapsed
 * separators (solutionMatchesQuery above) - so a name that differs from the
 * folder only in punctuation resolved to NOTHING, and the caller consumed the
 * handoff in silence.
 *
 * That is not hypothetical. Measured 2026-09-04 against the live Solutions
 * listing, of the 26 distinct solution names the SIEM-migration knowledge
 * bases carried at that moment, 17 matched a folder exactly, 1
 * case-insensitively, 1 ONLY under this new pass, and 7 matched nothing at all
 * under any rule - which is why the caller must also SAY SO when this returns
 * null. Those counts are a SNAPSHOT of a table being edited the same day
 * (DBT-103): an earlier read hours before gave 24 / 12 / 1 / 1 / 10. What did
 * not move across either read is the collapse-only entry, and it is the only
 * part of the count this function depends on.
 * That entry is "Cisco ASA" - the SPLUNK_PREFIX_MAP target for a
 * `cisco_` macro with no direct SPLUNK_MACRO_MAP entry of its own, since
 * resolveSplunkMacro tries the exact table first - against the folder
 * "CiscoASA". Nothing downstream rescued it: the fuzzy tier returns early
 * unless confidence === "none", so a knowledge-base hit reaches the pivot
 * verbatim.
 *
 * TREAT THAT ROW AS EVIDENCE, NOT AS THE REASON. The knowledge bases are hand-
 * maintained and under active correction (DBT-103 is in flight against a
 * neighbouring row in the same table), so a later reader may well find
 * "Cisco ASA" gone - that would fix ONE instance and not the class. The class
 * survives every such correction: a hand-written name still has to hit a
 * 574-folder catalog of which 332 names carry a separator, and the deep link is
 * not only the pivot's - it is also what select() writes and what a refresh
 * reads back, so any producer of a name reaches this function.
 *
 * EQUALITY, NEVER SUBSTRING. The collapsed form is used as an identity here,
 * not as a search: substring would let "Cisco" claim "CiscoASA". The identity
 * is safe because it does not collide - measured 2026-09-04 by listing
 * github.com/Azure/Azure-Sentinel/contents/Solutions: 574 folders, 332 of them
 * carrying a separator, and 0 groups of two or more names sharing a collapsed
 * form (0 sharing a lower-cased form either). An earlier version of this claim
 * covered only the 436 names in the shipped classification asset; this one is
 * the full index.
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
  const insensitive = solutions.find((s) => s.name.toLowerCase() === lower);
  if (insensitive !== undefined) {
    return insensitive;
  }
  const collapsed = collapseForSearch(name);
  // An all-punctuation name collapses to "", and so would a hypothetical
  // all-punctuation solution name - matching them to each other would be an
  // accident, not a resolution. Same guard solutionMatchesQuery uses.
  if (collapsed === "") {
    return null;
  }
  return (
    solutions.find((s) => collapseForSearch(s.name) === collapsed) ?? null
  );
}
