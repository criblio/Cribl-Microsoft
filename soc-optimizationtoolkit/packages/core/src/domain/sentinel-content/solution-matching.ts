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
