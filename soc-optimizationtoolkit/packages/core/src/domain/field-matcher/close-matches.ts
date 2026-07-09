/**
 * CLOSE-MATCH suggester - "this rule needs a field your mappings do not
 * produce; here is what in your SAMPLES looks close" (user request
 * 2026-07-09). Powers the clickable missing-field buttons in the rule /
 * workbook coverage sections.
 *
 * Deliberately LOOSER than the matcher: the matcher must be conservative
 * (a wrong automatic mapping corrupts data), but a SUGGESTION is reviewed by
 * a human, so it may propose what the matcher correctly refused. The founding
 * case: Zscaler web logs carry the URL only base64-encoded as `b64url` - the
 * matcher must NOT rename that onto RequestURL (rules match on decoded URL
 * text), but the suggester SHOULD surface it, with its sample value, so the
 * operator sees where the data lives and can decide (decode in the pipeline,
 * or reconfigure the NSS feed to emit `url` plainly).
 *
 * Scoring ladder: the matcher's own scoreMatch first (exact/alias/fuzzy,
 * 50-100); below that, shared-token overlap (20 + 15 per shared token,
 * capped at 45 - always below the matcher's 50 acceptance floor so a
 * suggestion is never mistaken for a match).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import { scoreMatch } from "./scoring";

/** One sample field offered to the suggester (a GapReport mapping row). */
export interface CloseMatchRow {
  /** Source field name as discovered in the sample. */
  sourceName: string;
  /** The sample's log type (names the card the row lives in). */
  logType: string;
  /** Human disposition today (e.g. "mapped to X", "overflow"). */
  disposition: string;
  /** An example value, when the sample carried one. */
  sampleValue?: string;
}

/** A suggested candidate for a missing field. */
export interface CloseMatchCandidate extends CloseMatchRow {
  /** 20-100; >= 50 came from the matcher's own ladder, below is token overlap. */
  score: number;
  /** Why it was suggested. */
  reason: string;
}

/**
 * Split a field name into comparison tokens: camelCase humps, separators,
 * and letter/digit boundaries, lowercased, tokens shorter than 2 dropped.
 * "b64url" -> ["64", "url"]; "RequestURL" -> ["request", "url"].
 */
export function nameTokens(name: string): string[] {
  const spaced = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/[_\-.\s]+/g, " ")
    .toLowerCase();
  return [...new Set(spaced.split(" ").filter((t) => t.length >= 2))];
}

/**
 * Suggest the sample fields closest to a missing destination field, best
 * first. Rows whose names share nothing with the field are dropped; at most
 * `limit` candidates return, deduplicated by source name + log type.
 */
export function suggestCloseMatches(
  missingField: string,
  rows: readonly CloseMatchRow[],
  limit = 5,
): CloseMatchCandidate[] {
  const destTokens = new Set(nameTokens(missingField));
  const seen = new Set<string>();
  const out: CloseMatchCandidate[] = [];
  for (const row of rows) {
    const key = `${row.sourceName.toLowerCase()}|${row.logType}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const ladder = scoreMatch(row.sourceName, missingField);
    let score = ladder.score;
    let reason = ladder.reason;
    if (score === 0) {
      // Token overlap: exact token hits, or containment between tokens of
      // length >= 3 (catches unsplittable lumps like "urlclass" vs "url").
      const sourceTokens = nameTokens(row.sourceName);
      const shared = [...destTokens].filter((dt) =>
        sourceTokens.some(
          (st) =>
            st === dt ||
            (dt.length >= 3 && st.includes(dt)) ||
            (st.length >= 3 && dt.includes(st)),
        ),
      );
      if (shared.length === 0) continue;
      score = Math.min(45, 20 + 15 * shared.length);
      reason = `Shares "${shared.join('", "')}" with ${missingField}`;
    }
    out.push({ ...row, score, reason });
  }
  out.sort(
    (a, b) => b.score - a.score || a.sourceName.localeCompare(b.sourceName),
  );
  return out.slice(0, limit);
}
