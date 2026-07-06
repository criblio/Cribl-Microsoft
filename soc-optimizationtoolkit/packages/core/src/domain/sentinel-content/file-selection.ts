/**
 * File-selection filter - which repo paths are worth fetching/persisting
 * (porting-plan Unit 14; verbatim from sentinel-repo.ts 326-384).
 *
 * These extension/dir sets are a CHARACTERIZATION PIN: they are the exact sets
 * the legacy used to decide what content to pull from the repo. Two purposes,
 * both preserved:
 *   - Relevance: only text the app reads (INCLUDED_EXTENSIONS) is kept.
 *   - EDR safety: BLOCKED_EXTENSIONS are the script/binary/archive types that
 *     EDR products (CrowdStrike Falcon, SentinelOne, ...) hash and terminate on
 *     when written to disk. On the cloud shell nothing is written to disk so
 *     this is pure bandwidth hygiene; on a local-shell disk-persistence path it
 *     is a MANDATORY guard (compose with the EDR solution filter in edr-filter).
 *
 * The MIRROR-AND-SCAN driver that used this (cloneRepo walking the whole tree)
 * does NOT port; the SETS do, as a lazy-fetch persistence filter.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto. Uses a local extname helper
 * rather than node:path so core stays dependency-free.
 */

/**
 * Executable/archive content - NEVER fetched. These are what EDR products hash
 * and block on disk write (sentinel-repo.ts 326-332).
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".py",
  ".ps1",
  ".psm1",
  ".psd1", // scripts
  ".sh",
  ".bat",
  ".cmd", // shell
  ".exe",
  ".dll",
  ".msi",
  ".scr", // binaries
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar", // archives
  ".jar",
  ".war", // Java archives
]);

/** Media/binary content - safe but useless for the app (sentinel-repo.ts 335-340). */
export const SKIP_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".bmp",
  ".mp4",
  ".mp3",
  ".mov",
  ".avi",
  ".pdf",
  ".bacpac",
  ".bin",
]);

/**
 * Directory segments with nothing the app needs AND possibly risky content.
 * Matched case-insensitively against any path segment (sentinel-repo.ts 344-347).
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "images",
  "media",
  "screenshots", // image directories
  "node_modules",
  ".vscode",
  ".github", // build artifacts / workflow YAMLs
]);

/** Text content the app reads or may read (sentinel-repo.ts 350-357). */
export const INCLUDED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".yaml",
  ".yml", // analytic rules, hunting queries, parsers, ASIM schemas
  ".json", // data connectors, workbooks, playbook ARM templates, solution metadata
  ".csv", // sample data, schema files
  ".txt",
  ".log", // sample data, raw log files
  ".md", // readme files (small, useful for context)
  ".kql", // standalone KQL files if present
]);

/**
 * Lowercased extension including the leading dot, or "" when the final path
 * segment has no dot (node path.extname semantics for the cases that matter
 * here: a leading-dot file like ".github" is a segment, handled by SKIP_DIRS,
 * not by extension).
 */
export function extname(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // No dot, or a dotfile whose only dot is at index 0 (e.g. ".vscode") -> no ext.
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/**
 * The persistence/relevance filter (sentinel-repo.ts isIncluded, minus the EDR
 * solution-blocklist branch, which lives in edr-filter as an OPTIONAL filter).
 *
 * Returns true only for a `Solutions/` or repo-root `Sample Data/` path whose
 * extension is in INCLUDED_EXTENSIONS, is not BLOCKED/SKIP, and whose segments
 * avoid SKIP_DIRS. This is the EXACT extension/dir gate the legacy applied
 * before writing a file; a disk-persistence path in the local shell composes it
 * with the EDR solution filter.
 */
export function isContentPathIncluded(filePath: string): boolean {
  // Solutions/ content and repo-root Sample Data/ only (sentinel-repo.ts 361).
  if (!filePath.startsWith("Solutions/") && !filePath.startsWith("Sample Data/")) {
    return false;
  }

  const ext = extname(filePath);

  // Hard-block executable/archive content (EDR triggers).
  if (BLOCKED_EXTENSIONS.has(ext)) return false;
  // Skip media/binary content (safe but not useful).
  if (SKIP_EXTENSIONS.has(ext)) return false;

  // Skip whole directories that are useless (images, node_modules) or risky.
  const segments = filePath.split("/").map((s) => s.toLowerCase());
  for (const segment of segments) {
    if (SKIP_DIRS.has(segment)) return false;
  }

  // Only known text content types.
  return INCLUDED_EXTENSIONS.has(ext);
}
