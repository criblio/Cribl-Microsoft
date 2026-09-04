/**
 * parseSampleContent and its field-discovery helpers - the heart of Unit 11.
 *
 * Ported from legacy sample-parser.ts: detect the format, parse to records,
 * apply the FIRST-CLASS Cribl-capture inner-_raw unwrap (ENG-15), then discover
 * fields with type inference + the merge lattice and guess the timestamp field.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import {
  MAX_FIELD_EXAMPLES,
  RAW_EVENTS_CAP,
  type DiscoveredField,
  type FieldType,
  type ParsedSample,
  type SampleFormat,
} from "./models";
import { parseByFormat } from "./parsers";
import { positionalNote } from "./positional";
import { unaddressableFieldNote } from "./accessor-names";
import { detectCaptureInnerFormat, detectSampleFormat } from "./format-detection";
import type { DetectMode } from "./format-detection";

// ---------------------------------------------------------------------------
// Type inference + merge lattice
// ---------------------------------------------------------------------------

/**
 * Infer the {@link FieldType} of a single value. Ported verbatim from legacy
 * inferType: null/undefined and unrecognized strings are "string"; numeric
 * strings under 16 digits are "int"; decimal strings are "real"; ISO and RFC
 * 3164 date shapes are "datetime"; objects are "dynamic".
 */
export function inferFieldType(value: unknown): FieldType {
  if (value === null || value === undefined) {
    return "string";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "real";
  }
  if (typeof value === "object") {
    return "dynamic";
  }
  const str = String(value);
  if (str === "true" || str === "false") {
    return "boolean";
  }
  if (/^\d+$/.test(str) && str.length < 16) {
    return "int";
  }
  if (/^\d+\.\d+$/.test(str)) {
    return "real";
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(str)) {
    return "datetime";
  }
  if (/^\w{3}\s+\d+\s+\d+:\d+:\d+/.test(str)) {
    return "datetime";
  }
  return "string";
}

/**
 * Fold two observed types to their common type (the merge lattice). Verbatim
 * from legacy mergeType: equal types pass through; int and real reconcile to
 * real; any other disagreement collapses to string (the lattice top).
 */
export function mergeFieldType(existing: FieldType, incoming: FieldType): FieldType {
  if (existing === incoming) {
    return existing;
  }
  if (existing === "string" || incoming === "string") {
    return "string";
  }
  if (
    (existing === "int" && incoming === "real") ||
    (existing === "real" && incoming === "int")
  ) {
    return "real";
  }
  return "string";
}

// ---------------------------------------------------------------------------
// Field discovery
// ---------------------------------------------------------------------------

interface FieldAccumulator {
  types: FieldType[];
  examples: Set<string>;
  count: number;
}

/**
 * Discover the fields across `records`: for each key, fold every value's type
 * through the merge lattice, collect up to {@link MAX_FIELD_EXAMPLES} distinct
 * non-empty example values, and mark the field required when it appears in at
 * least 90% of the records.
 */
export function collectFields(
  records: ReadonlyArray<Record<string, unknown>>,
  maxExamples: number = MAX_FIELD_EXAMPLES,
): DiscoveredField[] {
  const fieldMap = new Map<string, FieldAccumulator>();

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      let field = fieldMap.get(key);
      if (field === undefined) {
        field = { types: [], examples: new Set(), count: 0 };
        fieldMap.set(key, field);
      }
      field.types.push(inferFieldType(value));
      field.count += 1;
      if (
        field.examples.size < maxExamples &&
        value !== null &&
        value !== undefined
      ) {
        const str =
          typeof value === "object" ? JSON.stringify(value) : String(value);
        if (str.length < 200) {
          field.examples.add(str);
        }
      }
    }
  }

  const fields: DiscoveredField[] = [];
  for (const [name, data] of fieldMap.entries()) {
    let type: FieldType = data.types[0] ?? "string";
    for (const observed of data.types) {
      type = mergeFieldType(type, observed);
    }
    fields.push({
      name,
      type,
      types: distinctTypes(data.types),
      examples: [...data.examples],
      occurrence: data.count,
      required: data.count >= records.length * 0.9,
    });
  }
  return fields;
}

/** Distinct observed types in first-seen order. */
function distinctTypes(types: readonly FieldType[]): FieldType[] {
  const seen: FieldType[] = [];
  for (const type of types) {
    if (!seen.includes(type)) {
      seen.push(type);
    }
  }
  return seen;
}

/**
 * The candidate names a timestamp field is likely to answer to. VERBATIM from
 * legacy guessTimestampField, order included - the order is a ranking (the most
 * unambiguous names first) and {@link candidateRank} still reads it that way.
 *
 * MATCHED LOOSELY since 2026-08-26, which the exact-string version was not: a
 * FortiGate event carries `eventtime` and this list carries `eventTime`, so the
 * epoch second sitting right there was invisible and the picker fell through to
 * `time`. Case and separators are noise in a field name, so both are collapsed
 * before comparing (see {@link candidateKey}) and the list is left alone.
 */
const TIMESTAMP_CANDIDATE_NAMES = [
  "timestamp", "Timestamp", "time", "Time", "datetime", "DateTime",
  "EventTime", "eventTime", "TimeGenerated", "created_at", "createdAt",
  "date", "Date", "EdgeStartTimestamp", "Datetime", "start_time",
  "event_time", "log_time", "receive_time", "_time",
];

/** A field name reduced to what actually identifies it: letters and digits. */
function candidateKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const CANDIDATE_RANK: ReadonlyMap<string, number> = new Map(
  // First occurrence wins, so "timestamp"/"Timestamp" collapse to rank 0 and the
  // list's ordering survives the collapse intact.
  [...TIMESTAMP_CANDIDATE_NAMES].reverse().map((name, i) => [
    candidateKey(name),
    TIMESTAMP_CANDIDATE_NAMES.length - 1 - i,
  ]),
);

/** Position in {@link TIMESTAMP_CANDIDATE_NAMES}, or Infinity for a non-candidate. */
function candidateRank(name: string): number {
  return CANDIDATE_RANK.get(candidateKey(name)) ?? Infinity;
}

/**
 * A clock reading with NO DATE: "21:15:15", "9:05", "23:59:59.250".
 *
 * FortiGate emits exactly this in its `time` field, beside a separate `date`,
 * and it is why type evidence has to be able to overrule a name. A time of day
 * cannot order two events a day apart and cannot become a TimeGenerated, so a
 * field whose values all look like this is not a timestamp field however
 * perfectly it is named - and a pack or DCR built on it is wrong in production
 * while looking right in the preview.
 */
const TIME_OF_DAY_ONLY = /^\d{1,2}:\d{2}(:\d{2})?([.,]\d{1,9})?$/;

/**
 * Whether this field's OWN VALUES rule it out as a timestamp.
 *
 * Judged on the examples the parser actually collected, and only when it
 * collected some: a field with no examples is unknown, not disqualified. Every
 * example must look like a bare clock reading before the field is refused, so a
 * column that is sometimes "21:15:15" and sometimes a full ISO stamp survives.
 */
function isDisqualified(field: DiscoveredField): boolean {
  if (field.type === "boolean" || field.type === "dynamic") return true;
  return (
    field.examples.length > 0 &&
    field.examples.every((value) => TIME_OF_DAY_ONLY.test(value.trim()))
  );
}

/**
 * Fields the SEARCH ENGINE added, not the vendor - `_time`, `_raw`, and the `_N`
 * columns our own headerless-CSV parser mints.
 *
 * A LEADING UNDERSCORE IS THE CONVENTION in both Cribl Search and Splunk, and
 * the distinction is not cosmetic: `_time` exists in a Lake-sourced sample and
 * will NOT exist on events arriving from the real source, so a pipeline or DCR
 * keyed on it previews perfectly here and breaks the moment live data flows.
 * The legacy list already knew this much - `_time` sat LAST in it - but a
 * position in one list only helps against the names in that list, and `_time`
 * was still beating Okta's `published`, which is not in it at all.
 */
function isSyntheticField(name: string): boolean {
  return name.startsWith("_");
}

/**
 * Where a field sits in the evidence order; LOWER IS STRONGER.
 *
 * Plain constants rather than an enum because this package compiles under
 * `erasableSyntaxOnly`.
 *
 *   NAMED_AND_TYPED  named like a timestamp AND typed datetime. Nothing beats
 *                    the two kinds of evidence agreeing.
 *   NAMED            named like a timestamp and its type does not object - an
 *                    epoch int, a date-shaped string. This outranks TYPED on
 *                    purpose; see the note on guessTimestampField.
 *   TYPED            typed datetime under a name this app does not recognize.
 *                    Okta's `published`.
 *   TIMEISH          nothing but "time" somewhere in the name. The weakest
 *                    thing still worth guessing from.
 *   NONE             not a candidate at all; never returned.
 */
const TIER_NAMED_AND_TYPED = 0;
const TIER_NAMED = 1;
const TIER_TYPED = 2;
const TIER_TIMEISH = 3;
const TIER_NONE = 4;

function tierOf(field: DiscoveredField): number {
  const named = candidateRank(field.name) !== Infinity;
  if (field.type === "datetime") {
    return named ? TIER_NAMED_AND_TYPED : TIER_TYPED;
  }
  if (named) return TIER_NAMED;
  if (field.name.toLowerCase().includes("time")) return TIER_TIMEISH;
  return TIER_NONE;
}

/**
 * Best-guess the timestamp field.
 *
 * TYPE EVIDENCE OUTRANKS A NAME GUESS (2026-08-26). This used to walk the
 * candidate-name list FIRST and only fall through to a datetime-typed field if
 * no name matched, so the two things the parser KNOWS about a field - what it is
 * called and what its values look like - were never weighed against each other.
 * Both live consequences were observed in the running app:
 *
 *   FORTIGATE  picked `time`, a `string` holding "21:15:15" - a clock reading
 *              with no date - while `eventtime` (a real epoch second) and `date`
 *              sat unused beside it. The name matched; the VALUE said the field
 *              cannot be a timestamp, and nothing was listening.
 *   OKTA       picked `_time` (last in the list) over `published`, typed
 *              `datetime` and holding a full ISO stamp. `_time` is Cribl
 *              Search's own field: it exists in a Lake-sourced sample and not on
 *              events from the real Okta source, so the pack built from it looks
 *              right here and breaks in production.
 *
 * THE ORDER IS FOUR KEYS, and each one exists because of a case above:
 *
 *   1. SYNTHETIC     OUTERMOST, so `_time` is the LAST RESORT it should always
 *                    have been: ANY real field with any timestamp evidence at
 *                    all beats it. It has to sit above the tier rather than
 *                    inside it, because `_time` is a strong NAME - it is in the
 *                    candidate list - and would otherwise outrank Okta's
 *                    `published` on the name alone, which is the exact bug.
 *                    Demoted, never excluded: a sample carrying nothing else is
 *                    better served by a guess it can override than by silence.
 *   2. TIER          agreement (named AND typed datetime) > named with a type
 *                    that does not object > typed datetime alone > "time"
 *                    somewhere in the name. See the TIER_ constants above.
 *   3. CANDIDATE RANK the legacy list, unchanged, breaking ties between equally
 *                    evidenced fields - which is the job it is actually good at.
 *   4. FIELD ORDER   first seen wins, so the answer is stable for one input.
 *
 * DISQUALIFICATION IS SEPARATE from ranking and comes first: a field whose
 * values are all bare clock readings, or that is typed boolean or dynamic,
 * CANNOT be an event timestamp and is not a candidate at any tier
 * ({@link isDisqualified}). Returning it would be a confident wrong answer; with
 * it gone, FortiGate's `eventtime` wins on its own merits and a sample that
 * really has nothing usable gets `undefined` and an operator's own choice.
 *
 * A NAME STILL BEATS A STRANGER'S TYPE, deliberately, and that is what tier 1
 * over tier 2 says: `timestamp` holding an epoch-ms string is the event time,
 * and some unrelated `other` field that happens to be ISO-shaped is not.
 * Pinned in sample-parsing.test.ts, and unchanged since legacy.
 */
export function guessTimestampField(
  fields: ReadonlyArray<DiscoveredField>,
): string | undefined {
  let best: { field: DiscoveredField; key: readonly number[] } | undefined;
  fields.forEach((field, index) => {
    if (isDisqualified(field)) return;
    const tier = tierOf(field);
    if (tier === TIER_NONE) return;
    const key = [
      isSyntheticField(field.name) ? 1 : 0,
      tier,
      candidateRank(field.name),
      index,
    ];
    if (best === undefined || isLower(key, best.key)) {
      best = { field, key };
    }
  });
  return best?.field.name;
}

/** Lexicographic compare of two equal-length ranking keys. */
function isLower(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

// ---------------------------------------------------------------------------
// parseSampleContent
// ---------------------------------------------------------------------------

/** Options for {@link parseSampleContent}. */
export interface ParseSampleOptions {
  /** Label recorded on the result (filename or "pasted"). */
  sourceName?: string;
  /** Detection mode; defaults to "lenient" (content-aware). */
  mode?: DetectMode;
}

/**
 * Parse `content` into a {@link ParsedSample}. Detects the format, parses to
 * records, applies the Cribl-capture inner-_raw unwrap, then discovers fields
 * and guesses the timestamp field.
 *
 * RAW EVENTS ARE THE ORIGINAL BYTES where the format is line-oriented (CEF,
 * LEEF, syslog, KV, headerless CSV) or the input was a Cribl capture. This used
 * to be `records.map(JSON.stringify)` unconditionally, which meant a LEEF, a
 * syslog or a PAN-OS CSV sample reached pack generation as JSON and shipped a
 * JSON object in the pack's `_raw` - so the pack's own pipeline previewed
 * against data shaped nothing like what the source actually sends. (CEF alone
 * escaped, because pack-assembly reconstructs a CEF line from the parsed object.)
 * See docs/sample-acquisition-phase0.md (0.3) and {@link rawEventsFor} for why
 * the pairing cannot silently mis-align.
 *
 * Capture unwrap (ENG-15): when the outer parse is JSON/NDJSON and the first
 * record carries a `_raw` field, the inner vendor format is detected from the
 * `_raw` CONTENT and the sample is re-parsed from it - the wrapper fields are
 * REPLACED by the vendor fields (format-replacement). If the inner parse yields
 * nothing usable, the outer parse is kept silently (silent-wrapper-fallback).
 * Both branches are pinned by capture.test.ts.
 */
export function parseSampleContent(
  content: string,
  options: ParseSampleOptions = {},
): ParsedSample {
  const sourceName = options.sourceName ?? "pasted";
  const errors: string[] = [];
  let format = detectSampleFormat(content, { mode: options.mode });
  let records: Array<Record<string, unknown>> = [];
  // The ORIGINAL input line behind each record, for line-oriented formats.
  // Empty for JSON/NDJSON (and whenever a parser could not pair them).
  let sourceLines: string[] = [];

  try {
    records = parseByFormat(content, format, sourceLines);
  } catch (err) {
    errors.push(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (records.length === 0 && errors.length === 0) {
    errors.push("Could not parse any events from the provided content");
  }

  // DBT-77: a positional file parsed, but its columns may be unnamed. That is
  // not an error and must not read like one - the events ARE here and the file
  // is not at fault. The note says so, and says why the names are missing,
  // because a positional format keeps its schema outside the file. It is
  // omitted entirely when the shape was recognised and the columns carry real
  // names, since a note on a working parse is noise.
  const unwrapped = unwrapCapture(records, format);
  records = unwrapped.records;
  format = unwrapped.format;
  if (unwrapped.sourceLines !== undefined) {
    sourceLines = unwrapped.sourceLines;
  }

  // AFTER THE UNWRAP, AND SOURCED FROM THE UNWRAPPED LINES. Both halves are
  // load-bearing and DBT-108 got both wrong, in a way that was unreachable
  // until DBT-108 itself made it reachable.
  //
  // The block used to sit ABOVE unwrapCapture and read `content`. A Cribl
  // capture's OUTER format is "ndjson" - the file starts with `{` - so the
  // guard was false, and by the time `format` became "positional" the block had
  // already run. Before DBT-108 no capture could ever be positional, so the
  // case could not arise; teaching the detector about positional opened it.
  // Measured, the same two lines both ways: as a plain upload, field1..field10
  // WITH the note; inside a capture, field1..field10 and errors [].
  //
  // Reading `content` is the other half, and moving the block alone does not
  // fix it: on the capture path `content` is the WRAPPER JSON, whose own
  // whitespace (a value like "AWS Ruleset:AWS VPC Flow" carries spaces) makes
  // positionalNote describe the envelope rather than the events. `sourceLines`
  // is what parsePositional filled with the vendor's own lines.
  //
  // Note DBT-78's unaddressableFieldNote was already correctly on this side;
  // positionalNote was the only one stranded above.
  if (format === "positional") {
    const note = positionalNote(
      sourceLines.length > 0 ? sourceLines.join("\n") : content,
    );
    if (note !== null) errors.push(note);
  }

  const fields = collectFields(records);
  const timestampField = guessTimestampField(fields);
  const rawEvents = rawEventsFor(records, sourceLines);

  // DBT-78: the sample carries field names Cribl cannot build an accessor for.
  // Said HERE, beside the field list the operator is reading, because pack-build
  // is both too late and - depending on what the matcher does with the field -
  // never.
  //
  // checkCriblYaml refuses a hyphen or a dot only on a field the matcher
  // RENAMES. It reads names off `name:`/`currentName:`/`newName:` lines, and a
  // rename is the only thing that puts a VENDOR name on one - the other such
  // lines a conf carries hold names this app minted, which are addressable by
  // construction. A field with no destination column leaves only a bullet in
  // the cleanup eval's `remove:` list, and a field kept under its own name
  // leaves nothing at all. Measured end to end, both of those build
  // clean, as does any name containing whitespace even on a rename line. See
  // the tables in accessor-names.ts and in the KNOWN GAPS note in
  // pipeline-generation/cribl-yaml-validator.ts.
  //
  // Not a complaint about the build message, which does quote the field by name
  // and echo the offending line. The point is WHEN - section 2 of the Integrate
  // page rather than section 9 - and, for an unmatched or kept name, WHETHER
  // there is any message at all. For a DOTTED name nothing fails anywhere until
  // production data arrives renamed to nothing. See accessor-names.ts for why
  // the parser reports these rather than quietly rewriting them to safe names.
  //
  // AFTER the unwrap, deliberately: a Cribl capture's wrapper fields are
  // replaced by the vendor's, and it is the vendor's names that reach a rename.
  const accessorNote = unaddressableFieldNote(fields.map((f) => f.name));
  if (accessorNote !== null) errors.push(accessorNote);

  return {
    format,
    records,
    eventCount: records.length,
    fields,
    rawEvents,
    sourceName,
    ...(timestampField !== undefined ? { timestampField } : {}),
    errors,
  };
}

/**
 * The raw event strings stored for a parse: the ORIGINAL vendor lines when the
 * parser could pair one to every record, otherwise a re-serialization.
 *
 * The length equality is the whole safety argument. Every line-oriented parser
 * pushes its source line at the point it emits a record, so a full-length
 * accumulator is index-aligned BY CONSTRUCTION; anything else (a JSON input, a
 * parser that filtered, a capture unwrap that could not pair) fails the check
 * and falls back to the shape this function always produced. There is no case
 * where a MIS-aligned pairing can be stored - it is all-or-nothing per sample.
 */
function rawEventsFor(
  records: ReadonlyArray<Record<string, unknown>>,
  sourceLines: readonly string[],
): string[] {
  if (sourceLines.length === records.length && records.length > 0) {
    return [...sourceLines].slice(0, RAW_EVENTS_CAP);
  }
  return records.slice(0, RAW_EVENTS_CAP).map((record) => JSON.stringify(record));
}

/**
 * Apply the Cribl-capture inner-_raw unwrap. Only JSON/NDJSON wrappers whose
 * first record has a non-empty-eligible `_raw` are candidates; on a usable
 * inner parse the records and format are replaced, otherwise the input is
 * returned unchanged (silent fallback).
 *
 * ORIGINAL LINES (2026-08-18): the wrapper's `_raw` values ARE the vendor's own
 * bytes - the exact thing the operator's Cribl source delivered - so on a
 * successful unwrap they become the sample's raw events. Before this, unwrapping
 * REPLACED the wrapper records with the inner parse and the `_raw` was dropped
 * outright, which meant a Cribl capture (the most likely input this app sees)
 * was the format that lost the most. Returned only when they pair 1:1 with the
 * inner records; `sourceLines` is undefined whenever the caller should keep
 * whatever it already had.
 */
export function unwrapCapture(
  records: Array<Record<string, unknown>>,
  format: SampleFormat,
): {
  records: Array<Record<string, unknown>>;
  format: SampleFormat;
  sourceLines?: string[];
} {
  const isWrapper =
    (format === "ndjson" || format === "json") &&
    records.length > 0 &&
    records[0]._raw !== undefined;
  if (!isWrapper) {
    return { records, format };
  }

  const rawValues = records
    .map((record) => String(record._raw ?? ""))
    .filter(Boolean);
  if (rawValues.length === 0) {
    return { records, format };
  }

  const innerFormat = detectCaptureInnerFormat(rawValues);
  if (!innerFormat || innerFormat === "unknown") {
    return { records, format };
  }

  let innerRecords: Array<Record<string, unknown>> = [];
  const innerLines: string[] = [];
  try {
    innerRecords = parseByFormat(rawValues.join("\n"), innerFormat, innerLines);
  } catch {
    // Inner parse threw; fall back to the outer parse (silent).
    return { records, format };
  }

  if (innerRecords.length > 0 && Object.keys(innerRecords[0]).length > 1) {
    // Prefer the line-oriented parser's own pairing; fall back to the wrapper
    // `_raw` values, which pair when the inner parse dropped nothing.
    const lines =
      innerLines.length === innerRecords.length
        ? innerLines
        : rawValues.length === innerRecords.length
          ? rawValues
          : [];
    return { records: innerRecords, format: innerFormat, sourceLines: lines };
  }
  return { records, format };
}
