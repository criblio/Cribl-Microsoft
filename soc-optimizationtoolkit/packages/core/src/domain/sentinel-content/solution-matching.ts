/**
 * Fuzzy Sentinel-solution NAME matching - the ONE matcher (legacy had three
 * copies, consolidated in Unit 16).
 *
 * REHOMED 2026-08-18 (ADR 0003, sample-browser removal). {@link matchSolutionName}
 * lived in the sample-acquisition domain's solution-map.ts, alongside the curated
 * SOLUTION_SAMPLE_MAP the browser scored against. The map went with the browser;
 * the matcher did not, because it has a live consumer that never had anything to
 * do with browsing - analyze-samples reconciles a user-typed solution name
 * against the repo's solution list with it.
 *
 * Matching a solution NAME is a sentinel-content concern (that is where solution
 * discovery lives), which is why it landed here rather than in a new module.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** lowercase, non-alphanumerics removed (the legacy normalization). */
export function normalizeSolutionKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** lowercase words split on whitespace/-/_ , keeping only tokens >= 3 chars. */
function solutionWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((w) => w.length >= 3);
}

/**
 * The ONE fuzzy solution-name matcher. Returns true when `a` and `b` should be
 * treated as the same solution under the legacy fuzzy rules: a case-insensitive
 * alnum-equal, a substring either direction, or a shared >= 3-char word (via
 * bidirectional `includes`). Symmetric.
 */
export function matchSolutionName(a: string, b: string): boolean {
  const na = normalizeSolutionKey(a);
  const nb = normalizeSolutionKey(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = solutionWords(a);
  const wb = solutionWords(b);
  return wa.some((x) => wb.some((y) => y.includes(x) || x.includes(y)));
}

/**
 * A per-vendor pack that claims solutions by keyword. Both the field-matcher's
 * VendorMappingPack and the log-type catalog's DocumentedLogTypePack satisfy
 * it structurally, which is the point - see {@link packAppliesToSolution}.
 */
export interface SolutionKeywordedPack {
  /** Lowercased substrings matched against the solution name. */
  solutionKeywords: readonly string[];
  /**
   * Lowercased substrings that DISQUALIFY this pack even when a keyword hits.
   *
   * Needed because vendors ship several products under one brand and substring
   * containment cannot express "most specific wins": "Zscaler Private Access"
   * contains "zscaler", so a ZIA pack would otherwise claim a ZPA solution.
   * Claiming the WRONG product is worse than claiming nothing - it cites one
   * product's documentation for another product's data.
   */
  excludeKeywords?: readonly string[];
}

/**
 * Whether a vendor pack applies to a solution name. THE one implementation
 * (2026-08-20 audit found two, and they had already diverged).
 *
 * WHY IT LIVES HERE and not in either pack module: this asks a question about a
 * SOLUTION NAME, which is a sentinel-content concern for exactly the reason
 * {@link matchSolutionName} gives above - solution discovery lives here.
 * field-matcher already reaches into this module for normalizeSolutionKey, so
 * the dependency direction is established rather than invented.
 *
 * WHY IT IS SHARED AT ALL: the field matcher's mapping packs and the log-type
 * catalog's documented packs were the same four lines, until one of them
 * learned about {@link SolutionKeywordedPack.excludeKeywords} and the other did
 * not. Both answers land on one screen, so a ZPA operator was offered ZPA feeds
 * by the recommendation and Zscaler ZIA field mappings by the review table. The
 * exclusion is now DATA every pack kind can carry, not a rule one copy knows.
 */
export function packAppliesToSolution(
  solutionName: string,
  pack: SolutionKeywordedPack,
): boolean {
  const haystack = solutionName.trim().toLowerCase();
  if (haystack === "") return false;
  return (
    pack.solutionKeywords.some((k) => haystack.includes(k)) &&
    !(pack.excludeKeywords ?? []).some((k) => haystack.includes(k))
  );
}
