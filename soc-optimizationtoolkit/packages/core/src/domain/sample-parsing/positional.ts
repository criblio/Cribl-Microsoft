/**
 * Whitespace-positional logs: fields separated by spaces, in a fixed order,
 * with no header and no delimiters to key on (DBT-77).
 *
 * WHY THIS EXISTS. A user uploaded a 22-line AWS VPC Flow Logs sample to
 * Sentinel Integration and got nothing: format `unknown`, 0 records, 0 fields.
 * Their file was correct - it was the canonical v2 default format, which is
 * what AWS writes to S3 unless someone defines a custom one. Nothing was
 * broken; `SampleFormat` simply had no positional member, so detection fell
 * through and `parseByFormat` yielded nothing.
 *
 * WHAT MADE IT A DEFECT rather than a missing feature: the app CLAIMED the
 * source. `sentinel-ingestion-classification.json` carries "AWS VPC Flow Logs"
 * at tier `supported`, `source-types.ts` declares an `aws_vpc_flow` preset, and
 * `AWSVPCFlow` is in the bundled destination catalog. The destination existed
 * and the source was advertised, so the operator did the intended thing and got
 * zero events - the confident wrong answer, in the product catalog rather than
 * in a listing.
 *
 * THE HARD PART IS NAMING, NOT SPLITTING. Splitting on whitespace is trivial;
 * knowing what column 7 MEANS is not, because a positional format carries its
 * schema out of band. VPC Flow's field order is version-dependent - v2 is the
 * 14 fields below, v3+ adds more, and a custom format can reorder them
 * arbitrarily. So this module does two separate things and keeps them separate:
 * it always splits, and it names ONLY when it can recognise the shape. An
 * unrecognised positional file still parses, into `field1..fieldN`, which is
 * honest: we read your events and we do not know what the columns are.
 */

/** One positional line, split and named. */
export interface PositionalRecord {
  readonly [field: string]: string;
}

/**
 * The AWS VPC Flow Logs VERSION 2 default field order, verbatim from AWS's
 * published default. Exactly 14 fields, and the count is load-bearing - see
 * {@link isVpcFlowV2}.
 */
export const VPC_FLOW_V2_FIELDS: readonly string[] = Object.freeze([
  "version",
  "account_id",
  "interface_id",
  "srcaddr",
  "dstaddr",
  "srcport",
  "dstport",
  "protocol",
  "packets",
  "bytes",
  "start",
  "end",
  "action",
  "log_status",
]);

/**
 * AWS's own spelling, kept so the mapping table can show an operator the name
 * they will recognise from the AWS documentation.
 *
 * WHY THE TWO DIFFER, and it is not cosmetic. AWS writes `account-id`,
 * `interface-id` and `log-status` with HYPHENS. Cribl parses a rename's
 * `currentName` as a PROPERTY ACCESSOR PATH, and `account-id` is not one - it
 * reads as `account` minus `id`. A pipeline built with the hyphenated names
 * loads and then fails at runtime with:
 *
 *   Failed to build property accessor, path="account-id",
 *   err=invalid property accessor path="account-id"
 *
 * which is what a user hit. So the parsed field names use `_`, which is a valid
 * accessor and still obviously the same field, and the AWS spelling lives here
 * for display only. Renaming to the destination column (AccountId) is
 * unaffected either way.
 */
export const VPC_FLOW_V2_AWS_NAMES: Readonly<Record<string, string>> =
  Object.freeze({
    account_id: "account-id",
    interface_id: "interface-id",
    log_status: "log-status",
  });

/**
 * VPC Flow's `log-status` vocabulary - a closed set, and the strongest single
 * signal after the column count.
 */
const VPC_LOG_STATUS: ReadonlySet<string> = new Set([
  "OK",
  "NODATA",
  "SKIPDATA",
]);

/**
 * AWS writes a bare `-` for any field unavailable for a record, so a
 * NODATA/SKIPDATA row is mostly dashes. Numeric checks must accept it.
 */
const UNAVAILABLE = "-";

/**
 * Split a line on runs of whitespace, dropping empties.
 *
 * AWS pads nothing and uses single spaces, but a hand-edited sample may carry
 * tabs or doubled spaces, and splitting on a run rather than a single space
 * costs nothing and avoids empty columns that would shift every field right.
 */
export function splitPositional(line: string): string[] {
  return line.trim().split(/\s+/).filter((part) => part !== "");
}

/**
 * Is this a VPC Flow Logs v2 default-format sample?
 *
 * DELIBERATELY STRICT, and each condition earns its place. A positional file
 * has no header to confirm against, so the only evidence available is the
 * SHAPE - and a wrong guess here does not fail loudly, it silently names
 * somebody else's column `srcaddr` and carries that lie into a DCR. Refusing to
 * name is recoverable; naming wrongly is not.
 *
 * The conditions, in order of how much they rule out:
 *   - EXACTLY 14 columns on every row. v3+ and custom formats have different
 *     counts, so this alone rejects them rather than mis-naming them.
 *   - `version` is literally "2". The field exists precisely to say which
 *     layout follows, so trusting it is not a guess.
 *   - `log-status` is drawn from AWS's closed vocabulary.
 *   - the two ports and the byte/packet counts are numeric OR `-`.
 *
 * EVERY row must qualify, not a sampled majority. A file where row 9 disagrees
 * is not a v2 file with a typo; it is a file we have not understood, and the
 * whole point of this function is to decline those.
 *
 * WHAT THE REPORTED FILE TAUGHT THIS FUNCTION, recorded because the first draft
 * was wrong in a way only real data exposes. It also required `action` to be
 * ACCEPT or REJECT, and required the numerics to be digits. The reported sample
 * has a row reading
 * `2 <acct> <eni> - - - - - - - <start> <end> NODATA SKIPDATA`,
 * and that one row made the whole 22-line file decline to be named.
 *
 * Two corrections came out of it. AWS writes a bare `-` for every field
 * unavailable for a record, which is documented behaviour and not corruption,
 * so numeric checks accept it. And the `action` check was DROPPED entirely
 * rather than widened: `log-status` already carries the closed vocabulary, so
 * the action test added no discrimination while being the thing that failed.
 * Strictness is worth having where it prevents mis-naming - the column count
 * and the version - and not where it merely rejects real data.
 */
export function isVpcFlowV2(lines: readonly string[]): boolean {
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const parts = splitPositional(line);
    if (parts.length !== VPC_FLOW_V2_FIELDS.length) return false;
    if (parts[0] !== "2") return false;
    if (!VPC_LOG_STATUS.has(parts[13] ?? "")) return false;
    // srcport, dstport, packets, bytes - numeric, or `-` when unavailable.
    return [5, 6, 8, 9].every((i) => {
      const v = parts[i] ?? "";
      return v === UNAVAILABLE || /^\d+$/.test(v);
    });
  });
}

/**
 * Do these lines look like ONE positional format?
 *
 * The test is a CONSISTENT column count of at least four across every
 * non-empty line. Consistency is what separates a positional log from prose:
 * free text varies line to line, a positional format cannot. Four is the floor
 * because two or three whitespace-separated tokens describe far too much
 * ordinary text to be worth claiming.
 *
 * This is the LAST resort in detection and must stay that way - syslog, CEF,
 * LEEF and key=value lines are all whitespace-separated too, and each has a
 * real fingerprint that should win first.
 */
export function looksPositional(lines: readonly string[]): boolean {
  const rows = lines.filter((l) => l.trim() !== "");
  // AT LEAST TWO ROWS, and this is the whole safety argument rather than a
  // detail. The evidence this function relies on is CONSISTENCY of column
  // count - and one row is trivially consistent with itself, so a single line
  // carries no evidence at all.
  //
  // Two existing characterization pins caught the first draft doing exactly
  // that: `{not json at all` and `this is just some text` are four and five
  // whitespace-separated tokens, so a one-row rule claimed both as positional
  // logs when they had always been `unknown`. The pins were right and the
  // detector was greedy. Prose lines rarely share an exact word count, and the
  // more rows there are the less likely it becomes, which is why the evidence
  // only starts existing at two.
  if (rows.length < 2) return false;
  const width = splitPositional(rows[0] ?? "").length;
  if (width < 4) return false;
  return rows.every((l) => splitPositional(l).length === width);
}

/**
 * Parse positional lines into records, naming the columns when the shape is
 * recognised and numbering them when it is not.
 *
 * The unnamed case is not a failure mode - it is the honest answer for a format
 * whose schema lives outside the file. The operator can still see their events,
 * see the column count, and map the fields themselves.
 *
 * ORIGINAL-LINE CAPTURE. `sourceLines` is the same accumulator every other
 * line-oriented parser takes (see the header on parsers.ts): the input line is
 * pushed AT THE POINT the record is emitted, so a filtered line cannot drift the
 * pairing. It was MISSING here until 2026-09-03, and the cost was not cosmetic -
 * `rawEventsFor` pairs all-or-nothing on length, so an empty accumulator sent
 * every positional sample down the `JSON.stringify(record)` fallback and the
 * generated pack was previewed, and shipped, against a JSON object string
 * instead of the vendor's whitespace-separated line. Running the pack's own
 * positional extract over that string recovers ONE field of fourteen, because
 * `JSON.stringify` emits no spaces for the split to find.
 *
 * THE LINE IS PUSHED UNTRIMMED, which is why the trim moved off the filter and
 * onto {@link splitPositional} (where it already was) rather than being applied
 * up front. `sourceLines` becomes `rawEvents`, i.e. what we claim the vendor
 * sent, and the records are byte-identical either way - `splitPositional` trims
 * before splitting, so leading or trailing whitespace was never data here. A
 * carriage return is the exception and is dropped with the newline, as framing.
 */
export function parsePositional(
  content: string,
  sourceLines?: string[],
): PositionalRecord[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];

  const named = isVpcFlowV2(lines);
  return lines.map((line) => {
    const parts = splitPositional(line);
    const record: Record<string, string> = {};
    parts.forEach((value, i) => {
      const key = named
        ? (VPC_FLOW_V2_FIELDS[i] ?? `field${i + 1}`)
        : `field${i + 1}`;
      record[key] = value;
    });
    sourceLines?.push(line);
    return record;
  });
}

/**
 * The note shown beside a positional sample.
 *
 * Returns null when the columns were named - there is nothing to explain, and a
 * note on a working parse is noise. When they were not, it says the three
 * things the old "Could not parse any events" failed to: that we DID read the
 * events, that the file is not at fault, and what the operator can do.
 */
export function positionalNote(content: string): string | null {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0 || isVpcFlowV2(lines)) return null;
  const width = splitPositional(lines[0] ?? "").length;
  return (
    `Read as a positional log: ${width} whitespace-separated columns per line, ` +
    "named field1 to " +
    `field${width}. Positional formats carry their column names outside the ` +
    "file, so the names are not in the sample to read - map the fields you need " +
    "below."
  );
}
