/**
 * EDR content filter - the OPTIONAL solution blocklist (porting-plan Unit 14;
 * ENG-22 content-filter data ONLY; the fetching.json crash detection is
 * DROPPED, catalog line 208).
 *
 * The legacy ran a two-layer blocklist (built-in edr-blocklist.json + a local,
 * per-user file auto-populated by CRASH DETECTION: a "fetching marker" written
 * before each solution fetch and, on the next startup, any solution whose
 * marker survived a <60s process death was auto-blocked as an EDR kill). That
 * crash-detection machinery has NO target in the browser/host shells - nothing
 * writes IOC-laden scripts to disk, so nothing crashes - and does not port.
 *
 * What SURVIVES is the DATA: the built-in blocklist entries (BloodHound
 * Enterprise, FalconFriday, ...) as an OPTIONAL content filter that drops entire
 * flagged solutions. This filter is MANDATORY on any LOCAL-SHELL disk-
 * persistence path (if a shell ever writes rule content to disk, compose this
 * with file-selection's isContentPathIncluded before writing); on the cloud
 * shell nothing hits disk, so it is advisory - surfaced as a "deprecated/risky"
 * style badge, never a hard block the user cannot override.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import builtinBlocklistData from "./edr-blocklist.json";

/** Provenance of a blocklist entry (the legacy three-source union). */
export type BlockedSolutionSource = "built-in" | "auto-detected" | "user";

/** One blocked solution: the name, why, and where the entry came from. */
export interface BlockedSolution {
  name: string;
  reason: string;
  source: BlockedSolutionSource;
}

interface RawBlockedSolution {
  name: string;
  reason: string;
}

/**
 * The built-in blocklist, loaded from the vendored edr-blocklist.json (byte-
 * faithful copy of the legacy IS/edr-blocklist.json). Every entry is
 * source:"built-in". Frozen - it is shipped data, not mutable state.
 */
export const BUILTIN_EDR_BLOCKLIST: readonly BlockedSolution[] = Object.freeze(
  ((builtinBlocklistData.solutions as RawBlockedSolution[]) ?? []).map((s) =>
    Object.freeze({
      name: s.name,
      reason: s.reason,
      source: "built-in" as const,
    }),
  ),
);

/**
 * Merge the built-in blocklist with `extra` user-supplied entries, deduplicated
 * by name (built-in wins on a name clash) - the legacy getMergedBlocklist,
 * minus the auto-detected disk layer. Order: built-in first, then new names.
 */
export function mergeBlocklist(
  extra: readonly BlockedSolution[] = [],
): BlockedSolution[] {
  const merged = [...BUILTIN_EDR_BLOCKLIST];
  const names = new Set(merged.map((s) => s.name));
  for (const entry of extra) {
    if (!names.has(entry.name)) {
      merged.push(entry);
      names.add(entry.name);
    }
  }
  return merged;
}

/** The set of blocked solution NAMES for O(1) lookup (legacy getBlockedSolutionNames). */
export function blockedSolutionNames(
  extra: readonly BlockedSolution[] = [],
): Set<string> {
  return new Set(mergeBlocklist(extra).map((s) => s.name));
}

/** True when `solutionName` is NOT on the (merged) blocklist. */
export function isSolutionAllowed(
  solutionName: string,
  blockedNames: ReadonlySet<string>,
): boolean {
  return !blockedNames.has(solutionName);
}

/**
 * The solution name embedded in a `Solutions/<name>/...` path, or null when the
 * path is not under Solutions/ (legacy: filePath.split('/')[1]).
 */
export function solutionNameFromPath(filePath: string): string | null {
  if (!filePath.startsWith("Solutions/")) return null;
  return filePath.split("/")[1] || null;
}

/**
 * The composed persistence guard the legacy isIncluded applied: a `Solutions/`
 * path whose owning solution is blocklisted is dropped. Returns true when the
 * path's solution is NOT blocked (paths outside Solutions/ are unaffected, so
 * they pass this EDR gate and are judged by file-selection alone).
 */
export function isPathAllowedByEdr(
  filePath: string,
  blockedNames: ReadonlySet<string>,
): boolean {
  const sol = solutionNameFromPath(filePath);
  if (sol === null) return true;
  return isSolutionAllowed(sol, blockedNames);
}
