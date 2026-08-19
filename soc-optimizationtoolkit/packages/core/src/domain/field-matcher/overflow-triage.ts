/**
 * Overflow TRIAGE - distinguishes UNMAPPABLE from OUTRANKED (user request
 * 2026-07-12, after the Zscaler review: "26 of 170" reads as failure when
 * 136 of the 142 overflow fields have no CommonSecurityLog column at all).
 *
 * Every overflow field is scored against EVERY destination column with the
 * same scoring ladder the matcher uses, then classified:
 *
 *  - NO EQUIVALENT: no column shows even weak name similarity (score 0).
 *    Nothing any mapper could do - the destination schema has no home for
 *    the field. It is preserved in the catch-all column, not lost.
 *  - OUTRANKED: the closest column is already claimed by a better source
 *    field (Zscaler's upload_filename loses FileName to filename; refererhost
 *    loses RequestContext to the decoded b64referer). Correct behavior, but
 *    worth naming so the reviewer sees WHY the field overflowed.
 *
 * There is deliberately NO "missed" category: the matcher's accept threshold
 * (50) equals the ladder's minimum nonzero score, and global assignment lets
 * a source that loses its best column compete for its next-best - so a
 * close-named column can never be left unclaimed while a scoring source
 * overflows. Every overflow candidate is outranked BY CONSTRUCTION; if the
 * ladder ever changes, the outranked list is where a gap would surface.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { DestField, MatchResult } from "./models";
import { scoreMatch } from "./scoring";

/** One outranked overflow field. */
export interface OverflowTriageEntry {
  sourceName: string;
  /** The closest destination column by name score. */
  column: string;
  /** The scoring-ladder score for that column (never 0 here). */
  score: number;
  /** The source field that already claimed the column. */
  claimedBy: string;
}

/** The per-table overflow triage attached to every gap report. */
export interface OverflowTriage {
  /** Overflow fields with no name-similar destination column at all. */
  noEquivalentCount: number;
  /**
   * The NAMES of those fields, not just how many (user request 2026-08-18).
   *
   * A count cannot be acted on. The names can: they are what tells an operator
   * whether the sample simply carries vendor detail this table has no room for,
   * or whether the sample does not belong to this table at all. Measured live -
   * an ASim authentication sample pointed at CrowdStrikeAlerts left 161 fields
   * with no equivalent among 108 columns, and the field names are what make
   * that diagnosable rather than merely large.
   */
  noEquivalent: string[];
  /** Closest column exists but a better source field already claimed it. */
  outranked: OverflowTriageEntry[];
  /**
   * The "check the sample" recommendation, or "" when the pairing looks fine.
   *
   * SEPARATE FROM {@link summary} ON PURPOSE. The card renders its own terse
   * overflow line and keeps the full summary in a hover tip - which is a fine
   * home for the counts, and the wrong home for a recommendation nobody would
   * hover to find. Exposing it as its own field lets the UI show it as a
   * visible warning WITHOUT re-deriving the heuristic; the threshold stays
   * decided in exactly one place.
   */
  pairingWarning: string;
  /** The rendered honesty line ("" when there is no overflow). */
  summary: string;
}

/** Triage with empty inputs (no overflow, or no schema to check against). */
export const EMPTY_OVERFLOW_TRIAGE: OverflowTriage = {
  noEquivalentCount: 0,
  noEquivalent: [],
  outranked: [],
  pairingWarning: "",
  summary: "",
};

/**
 * Classify every overflow field of `matchResult` against `destSchema`.
 * `tableName` only feeds the summary text.
 */
export function triageOverflow(
  matchResult: MatchResult,
  destSchema: readonly DestField[],
  tableName: string,
): OverflowTriage {
  const overflow = matchResult.overflow;
  if (overflow.length === 0 || destSchema.length === 0) {
    return EMPTY_OVERFLOW_TRIAGE;
  }

  // Columns already claimed by a matched source field (drop rows have no
  // column). The catch-all column is not an "equivalent" - exclude it.
  const claimedBy = new Map<string, string>();
  for (const m of matchResult.matched) {
    if (m.destName !== "") claimedBy.set(m.destName.toLowerCase(), m.sourceName);
  }
  const catchAll = matchResult.overflowConfig.fieldName.toLowerCase();

  const noEquivalent: string[] = [];
  const outranked: OverflowTriageEntry[] = [];

  for (const of of overflow) {
    let best: { column: string; score: number } | undefined;
    for (const col of destSchema) {
      if (col.name.toLowerCase() === catchAll) continue;
      const { score } = scoreMatch(of.sourceName, col.name);
      if (score > 0 && (best === undefined || score > best.score)) {
        best = { column: col.name, score };
      }
    }
    if (best === undefined) {
      noEquivalent.push(of.sourceName);
    } else {
      // An unclaimed best column cannot happen under the current ladder (see
      // header); the fallback keeps a future gap VISIBLE instead of silently
      // folding it into the no-equivalent count.
      outranked.push({
        sourceName: of.sourceName,
        ...best,
        claimedBy:
          claimedBy.get(best.column.toLowerCase()) ??
          "(unclaimed - possible missed mapping)",
      });
    }
  }

  const noEquivalentCount = noEquivalent.length;
  // WHEN ALMOST NOTHING FITS, THE PAIRING IS THE SUSPECT (user, 2026-08-18).
  //
  // A few unmappable fields is normal - vendors carry detail a curated table
  // has no column for. Most of them unmappable is a different claim: it says
  // this sample probably does not belong to this table. Measured live, an ASim
  // authentication sample pointed at CrowdStrikeAlerts left 161 of 161 with no
  // equivalent among 108 columns, and the useful next step there is not "add a
  // column" or "accept the loss" - it is to check the sample is the right one
  // for this destination.
  //
  // Two thirds, and at least a handful, so a small sample with two odd fields
  // does not accuse the operator of picking the wrong table.
  const mostlyUnmappable =
    noEquivalent.length >= 5 && noEquivalent.length >= overflow.length * (2 / 3);
  const pairingWarning = mostlyUnmappable
    ? `Most of this sample has no ${tableName} equivalent (` +
      `${noEquivalentCount} of ${overflow.length} overflow fields). Check the ` +
      `sample is the right one for this table before continuing.`
    : "";

  const parts = [
    `${noEquivalentCount} of ${overflow.length} overflow fields have no ` +
      `${tableName} equivalent (checked against all ${destSchema.length} ` +
      `destination columns)`,
  ];
  if (outranked.length > 0) {
    parts.push(
      `${outranked.length} outranked: the closest column is already claimed ` +
        `by a better source field`,
    );
  }
  return {
    noEquivalentCount,
    noEquivalent,
    outranked,
    pairingWarning,
    // The warning is appended VERBATIM rather than restated, so the hover tip
    // and the visible line can never drift into two different sentences.
    summary: parts.join(". ") + "." + (pairingWarning === "" ? "" : ` ${pairingWarning}`),
  };
}
