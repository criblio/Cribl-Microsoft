/**
 * ContentCache key derivation (porting-plan Unit 14; ENG-52 superseded).
 *
 * REDESIGN: the legacy refreshed content by re-mirroring the whole repo on a 12h
 * timer (autoUpdate). That is replaced by LAZY per-solution fetch with a KV
 * cache keyed by solution + commit SHA. Because the commit SHA is EMBEDDED in
 * the key, a new upstream commit yields new keys and stale entries simply miss -
 * there is no explicit invalidation pass and no stale-read window (the "12h
 * staleness" idea survives only as an optional adapter-side TTL). Content at a
 * given commit is immutable, so a solution is parsed at most once per commit.
 *
 * Keys are stable, deterministic, and KV-safe (only [A-Za-z0-9_.~-]). The
 * segment separator is "~" (a URI-unreserved char), NOT ":": a colon is a URI
 * reserved gen-delim, so it survives in the KV path as "%3A" and the Cribl KV
 * store route rejects the request with HTTP 404. "~" is also illegal-filename-
 * safe for the local host on Windows (":" is not). sanitizeSegment strips "~"
 * from every segment, so it can never collide with segment content.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** Namespace prefix so content keys never collide with other KV entries. */
export const CONTENT_CACHE_NAMESPACE = "sentinel-content";

/** The parsed-result categories cached per solution+commit. */
export type ContentCacheKind =
  | "solution-index" // the listSolutions result (no per-solution segment)
  | "connectors" // decoded connector schemas for a solution
  | "rules" // parsed analytic rules for a solution
  | "samples" // resolved samples for a solution
  | "file"; // a single raw file's parsed result (extra = its path)

/** Commit SHA shortened to 12 hex chars (the legacy lastCommit convention). */
export function shortCommitSha(sha: string): string {
  return (sha || "").slice(0, 12);
}

/** Replace every run of KV-unsafe characters with a single "_". */
function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

/** Parameters for a content cache key. */
export interface ContentCacheKeyParams {
  /** The cache category. */
  kind: ContentCacheKind;
  /** The current HEAD commit SHA (from SentinelContent.getCommitSha). */
  commitSha: string;
  /** The solution name; omit only for the repo-wide "solution-index" kind. */
  solution?: string;
  /** A discriminator within (solution, kind) - e.g. the file path for "file". */
  extra?: string;
}

/**
 * Derive the ContentCache key for a parsed result. Shape:
 *   sentinel-content~<kind>~<shortSha>~<solution?>~<extra?>
 * Two calls with the same params produce the same key; changing the commit,
 * solution, kind, or extra produces a different key.
 */
export function contentCacheKey(params: ContentCacheKeyParams): string {
  const parts = [
    CONTENT_CACHE_NAMESPACE,
    params.kind,
    shortCommitSha(params.commitSha),
  ];
  if (params.solution !== undefined) parts.push(sanitizeSegment(params.solution));
  if (params.extra !== undefined) parts.push(sanitizeSegment(params.extra));
  return parts.join("~");
}

/** Convenience: the per-solution connectors key. */
export function connectorsCacheKey(solution: string, commitSha: string): string {
  return contentCacheKey({ kind: "connectors", solution, commitSha });
}

/** Convenience: the repo-wide solution index key (no solution segment). */
export function solutionIndexCacheKey(commitSha: string): string {
  return contentCacheKey({ kind: "solution-index", commitSha });
}
