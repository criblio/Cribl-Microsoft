/**
 * CLOSE-MATCH suggester - "this rule needs a field your mappings do not
 * produce; here is what in your SAMPLES looks close" (user request
 * 2026-07-09). Powers the clickable missing-field buttons in the rule /
 * workbook coverage sections, and (suggestForDestColumn) the unmapped
 * destination column panel of the Field Mappings table.
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
 * Ranking (DBT-195, 2026-10-29). The UAT found the name-only ranking offering
 * PanOSPacketsReceived (a packet count) for ReceivedBytes while omitting the
 * CEF-documented `in`, and five already-mapped ids for SourceUserID. Order:
 *   1. DOCUMENTED first: a hand-verified / CEF / Sentinel-DCR pack entry, or
 *      an alias-table entry, that names this exact column for the field.
 *   2. Unmapped before already-mapped (a field that already fills another
 *      column is a "move", which costs that column).
 *   3. Score: the matcher's own scoreMatch (exact/alias/fuzzy, 50-100), then
 *      token overlap with abbreviation expansion (src/dst/in/out/..., and
 *      CEF lumps like suser = source + user; a shared direction qualifier
 *      alone does not count), scored
 *      by the fraction of the column's tokens covered: 20 + 29 * fraction.
 *      Always below the matcher's 50 acceptance floor - a suggestion is
 *      never mistaken for a match - yet PanSrcMac (source + mac) outranks
 *      PanDstMac (mac only) for SourceMACAddress.
 *   4. Source name, for a stable order.
 * typeMismatch is a MARK, not a filter: the reviewer decides whether the
 * coercion is acceptable.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import { scoreMatch } from "./scoring";
import { VENDOR_MAPPING_PACKS } from "./vendor-mapping-packs";

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
  /** The field's sample type (e.g. "int", "string"), when known. */
  sourceType?: string;
  /**
   * The dedicated destination column this field fills today. Absent when it
   * fills none (overflow, dropped, unmatched); only a present value makes the
   * candidate `alreadyMapped`.
   */
  currentDest?: string;
}

/** A suggested candidate for a missing field. */
export interface CloseMatchCandidate extends CloseMatchRow {
  /**
   * 20-100; >= 50 came from the matcher's own ladder or a documented
   * mapping, below 50 is token overlap only.
   */
  score: number;
  /** Why it was suggested. */
  reason: string;
  /** A documented mapping (vendor/CEF pack or alias table) names this column. */
  documented: boolean;
  /** The field already fills another column (applying it is a move). */
  alreadyMapped: boolean;
  /** Both types are known and the destination cannot take the source as-is. */
  typeMismatch: boolean;
}

/**
 * Split a field name into comparison tokens: camelCase humps, acronym runs
 * ("MACAddress" -> mac, address), separators, and letter/digit boundaries,
 * lowercased, tokens shorter than 2 dropped.
 * "b64url" -> ["64", "url"]; "RequestURL" -> ["request", "url"].
 */
export function nameTokens(name: string): string[] {
  const spaced = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/[_\-.\s]+/g, " ")
    .toLowerCase();
  return [...new Set(spaced.split(" ").filter((t) => t.length >= 2))];
}

/**
 * Abbreviation expansion for token overlap: every spelling maps to one
 * canonical token, so PanSrcMac's `src` meets SourceMACAddress's `source`
 * and CEF's `in` meets ReceivedBytes's `received`.
 */
const TOKEN_SYNONYMS: Readonly<Record<string, string>> = {
  src: "source",
  dst: "destination",
  dest: "destination",
  in: "inbound",
  rcvd: "inbound",
  recv: "inbound",
  received: "inbound",
  rx: "inbound",
  out: "outbound",
  sent: "outbound",
  snd: "outbound",
  tx: "outbound",
  hst: "host",
  macaddr: "mac",
  usr: "user",
};

function canonicalToken(token: string): string {
  return TOKEN_SYNONYMS[token] ?? token;
}

/**
 * CEF's one-letter direction keys are single lowercase lumps nameTokens
 * cannot split: `suser` is source + user, `dhost` destination + host.
 */
const COMPOUND_TOKENS: Readonly<Record<string, readonly string[]>> = {
  suser: ["source", "user"],
  duser: ["destination", "user"],
  suid: ["source", "user", "id"],
  duid: ["destination", "user", "id"],
  shost: ["source", "host"],
  dhost: ["destination", "host"],
  smac: ["source", "mac"],
  dmac: ["destination", "mac"],
};

function sourceCanonicalTokens(name: string): string[] {
  return nameTokens(name).flatMap(
    (t) => COMPOUND_TOKENS[t] ?? [canonicalToken(t)],
  );
}

/**
 * Direction qualifiers: sharing ONLY one of these says nothing about the
 * data (PanSrcHostname is not a SourceUserID candidate), so an overlap must
 * include at least one other token. They still count toward the score once
 * it does, which is what ranks PanSrcMac above PanDstMac.
 */
const QUALIFIER_TOKENS: ReadonlySet<string> = new Set(["source", "destination"]);

/**
 * Reverse index of DOCUMENTED mappings: destination column (lowercased) ->
 * source field (lowercased) -> citation. Only entries carrying a `doc` count
 * (hand-verified vendor packs, the CEF catalog, Microsoft's Sentinel DCR
 * transforms); Elastic-mined value-vote entries carry no `doc` and stay out,
 * because without a solution to scope them a generic name like `host` would
 * read as documented for every vendor. First entry wins (authority order).
 */
const DOCUMENTED: ReadonlyMap<string, ReadonlyMap<string, string>> = (() => {
  const index = new Map<string, Map<string, string>>();
  // A decode entry (Zscaler b64url) documents where the data lives, but a
  // rename would land encoded text: the citation says so.
  for (const pack of VENDOR_MAPPING_PACKS) {
    for (const entry of pack.mappings) {
      if (entry.doc === undefined) continue;
      const dest = entry.destName.toLowerCase();
      let bySource = index.get(dest);
      if (bySource === undefined) {
        bySource = new Map();
        index.set(dest, bySource);
      }
      const source = entry.sourceName.toLowerCase();
      if (!bySource.has(source)) {
        bySource.set(
          source,
          entry.action === "decode"
            ? `${entry.doc} (needs a decode, not a rename)`
            : entry.doc,
        );
      }
    }
  }
  return index;
})();

/** Score given to a documented mapping the name ladder scores lower. */
const DOCUMENTED_SCORE = 90;

const TYPE_FAMILIES: Readonly<Record<string, string>> = {
  int: "number",
  integer: "number",
  long: "number",
  real: "number",
  double: "number",
  float: "number",
  decimal: "number",
  number: "number",
  bool: "bool",
  boolean: "bool",
  datetime: "datetime",
  date: "datetime",
  timestamp: "datetime",
  string: "string",
  guid: "guid",
  uuid: "guid",
  dynamic: "dynamic",
  object: "dynamic",
  array: "dynamic",
};

/**
 * True only when both types are known and the destination cannot take the
 * source unchanged. A string or dynamic column takes anything; a guid column
 * takes a string (ADR 0004: guids are declared string and converted).
 */
export function isTypeMismatch(
  sourceType: string | undefined,
  destType: string | undefined,
): boolean {
  const src = TYPE_FAMILIES[(sourceType ?? "").toLowerCase()];
  const dst = TYPE_FAMILIES[(destType ?? "").toLowerCase()];
  if (src === undefined || dst === undefined) return false;
  if (src === dst || dst === "string" || dst === "dynamic") return false;
  if (dst === "guid" && src === "string") return false;
  return true;
}

function rankCandidates(
  destName: string,
  destType: string | undefined,
  rows: readonly CloseMatchRow[],
  limit: number,
): CloseMatchCandidate[] {
  const destLower = destName.toLowerCase();
  const destTokens = nameTokens(destName);
  const documentedHere = DOCUMENTED.get(destLower);
  const seen = new Set<string>();
  const out: CloseMatchCandidate[] = [];
  for (const row of rows) {
    const key = `${row.sourceName.toLowerCase()}|${row.logType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A field already filling this very column is not a suggestion for it.
    if (row.currentDest?.toLowerCase() === destLower) continue;

    const ladder = scoreMatch(row.sourceName, destName);
    let score = ladder.score;
    let reason = ladder.reason;
    let documented = ladder.confidence === "alias";
    const citation = documentedHere?.get(row.sourceName.toLowerCase());
    if (citation !== undefined) {
      documented = true;
      if (score < DOCUMENTED_SCORE) {
        score = DOCUMENTED_SCORE;
        reason = `Documented: ${citation}`;
      }
    }
    if (score === 0) {
      // Token overlap on canonical tokens: exact hits, or containment
      // between tokens of length >= 3 (catches unsplittable lumps like
      // "urlclass" vs "url"). Reported in the column's own spelling.
      const sourceTokens = sourceCanonicalTokens(row.sourceName);
      const shared = destTokens.filter((raw) => {
        const dt = canonicalToken(raw);
        return sourceTokens.some(
          (st) =>
            st === dt ||
            (dt.length >= 3 && st.includes(dt)) ||
            (st.length >= 3 && dt.includes(st)),
        );
      });
      if (shared.every((t) => QUALIFIER_TOKENS.has(canonicalToken(t)))) {
        continue;
      }
      score = 20 + Math.round((29 * shared.length) / destTokens.length);
      reason = `Shares "${shared.join('", "')}" with ${destName}`;
    }
    out.push({
      ...row,
      score,
      reason,
      documented,
      alreadyMapped: row.currentDest !== undefined && row.currentDest !== "",
      typeMismatch: isTypeMismatch(row.sourceType, destType),
    });
  }
  out.sort(
    (a, b) =>
      Number(b.documented) - Number(a.documented) ||
      Number(a.alreadyMapped) - Number(b.alreadyMapped) ||
      b.score - a.score ||
      a.sourceName.localeCompare(b.sourceName),
  );
  return out.slice(0, limit);
}

/**
 * The suggester's rows from gap-report mapping rows (matched AND overflow),
 * structurally typed so this module need not import gap-analysis. Only a
 * field filling a dedicated column gets `currentDest`: an overflow or drop
 * row fills none, so it ranks as unmapped.
 */
export function closeMatchRowsFromReports(
  reports: ReadonlyArray<{
    logType: string;
    fieldMappings: ReadonlyArray<{
      source: string;
      dest: string;
      sourceType: string;
      action: string;
      sampleValue?: string;
    }>;
  }>,
): CloseMatchRow[] {
  return reports.flatMap((r) =>
    r.fieldMappings.map((m) => {
      const fillsColumn = m.action !== "overflow" && m.action !== "drop";
      return {
        sourceName: m.source,
        logType: r.logType,
        disposition: m.action + " -> " + m.dest,
        ...(m.sampleValue !== undefined ? { sampleValue: m.sampleValue } : {}),
        ...(m.sourceType !== "" ? { sourceType: m.sourceType } : {}),
        ...(fillsColumn && m.dest !== "" ? { currentDest: m.dest } : {}),
      };
    }),
  );
}

/**
 * Suggest the sample fields closest to a missing destination field, best
 * first (the Rule / Workbook Coverage chips, which know only the name).
 * Rows whose names share nothing with the field are dropped; at most
 * `limit` candidates return, deduplicated by source name + log type.
 */
export function suggestCloseMatches(
  missingField: string,
  rows: readonly CloseMatchRow[],
  limit = 5,
): CloseMatchCandidate[] {
  return rankCandidates(missingField, undefined, rows, limit);
}

/**
 * Suggest the sample fields that could fill one unmapped destination column
 * (the Field Mappings panel knows the column's type, so its candidates carry
 * a real typeMismatch mark). Same ranking as suggestCloseMatches.
 */
export function suggestForDestColumn(
  dest: { name: string; type: string },
  rows: readonly CloseMatchRow[],
  limit = 5,
): CloseMatchCandidate[] {
  return rankCandidates(dest.name, dest.type, rows, limit);
}
