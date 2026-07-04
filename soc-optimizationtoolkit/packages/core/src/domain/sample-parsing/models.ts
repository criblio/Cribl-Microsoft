/**
 * sample-parsing shared domain MODELS - porting-plan Unit 11 (ENG-14/15/18).
 *
 * These three shapes (ParsedSample, DiscoveredField, TaggedSample) are the
 * shared vocabulary every downstream sample consumer (field matcher, pipeline
 * generator, gap analysis) depends on, so they land BEFORE any consumer port
 * (porting-plan Unit 11: "ParsedSample/DiscoveredField/TaggedSample become
 * shared core domain models BEFORE any consumer ports").
 *
 * Pure data + constants: no IO, no fetch, no React, no Date/crypto.
 *
 * Redesign notes vs the legacy sample-parser.ts shapes:
 * - 'xml' is DROPPED from the format union. Legacy detected 'xml' but never
 *   had an xml parser (the parseContent switch fell through to the try-each
 *   default), so xml was a detect-only quirk with no capability behind it. The
 *   Unit 11 format list (CEF/LEEF/CSV/KV/JSON/NDJSON/syslog) is authoritative;
 *   xml-looking content resolves to 'unknown'. Pinned by format-detection tests.
 * - DiscoveredField gains `types` (the distinct observed types feeding the
 *   merge lattice) alongside the single merged `type`; `sampleValues` is
 *   renamed to `examples`.
 * - ParsedSample exposes the parsed `records` as a first-class field (legacy
 *   only surfaced the JSON-stringified `rawEvents`).
 */

/**
 * The sample formats the parser understands. 'unknown' means detection could
 * not classify the content (and, for parsing, the try-each fallback applies).
 */
export type SampleFormat =
  | "json"
  | "ndjson"
  | "csv"
  | "kv"
  | "cef"
  | "leef"
  | "syslog"
  | "unknown";

/**
 * The Azure/KQL-flavored value types the inference lattice produces. These are
 * the merge lattice's nodes (see mergeFieldType): string is the top (any
 * disagreement collapses to it), int and real reconcile to real.
 */
export type FieldType =
  | "string"
  | "int"
  | "real"
  | "boolean"
  | "datetime"
  | "dynamic";

/** A field discovered across the parsed records of one sample. */
export interface DiscoveredField {
  /** Field name exactly as it appears in the records. */
  name: string;
  /**
   * The single best type for this field, folded through the merge lattice
   * across every observed value (see mergeFieldType).
   */
  type: FieldType;
  /**
   * The distinct observed types that fed the lattice, in first-seen order.
   * Usually length 1; length > 1 means the field held mixed types across
   * records (which is why `type` may have collapsed to "string").
   */
  types: FieldType[];
  /** Up to a few distinct non-empty example values (legacy: sampleValues). */
  examples: string[];
  /** How many records contained this field. */
  occurrence: number;
  /** True when the field appeared in at least 90% of the records. */
  required: boolean;
}

/** The result of parsing one sample (a file, a paste, or a capture). */
export interface ParsedSample {
  /** The format the content was parsed as (post capture-unwrap). */
  format: SampleFormat;
  /** The parsed record objects, in file order. */
  records: Array<Record<string, unknown>>;
  /** Convenience count === records.length. */
  eventCount: number;
  /** The fields discovered across all records. */
  fields: DiscoveredField[];
  /**
   * The first {@link RAW_EVENTS_CAP} records, JSON-stringified, for pack
   * sample data. Capped so a huge upload never blows the KV size budget.
   */
  rawEvents: string[];
  /** Filename or "pasted"/"auto-detect" label the caller supplied. */
  sourceName: string;
  /** Best-guess timestamp field name, or undefined when none was found. */
  timestampField?: string;
  /** Non-fatal parse problems; empty on a clean parse. */
  errors: string[];
}

/**
 * A sample the user has associated with a log type. The tagged-sample store
 * (see ports/tagged-sample-store) keys these by {@link logType}, replacing any
 * existing entry for the same log type on upsert.
 */
export interface TaggedSample {
  /** The user-chosen log-type label; the store's replace key. */
  logType: string;
  /** The detected format of the sample content. */
  format: SampleFormat;
  /**
   * The raw event lines kept for this log type (already capped to
   * {@link RAW_EVENTS_CAP}). Pack sample-file generation re-extracts fields
   * from these, so the ORIGINAL vendor bytes matter (see log-type helpers).
   */
  rawEvents: string[];
  /** The full parse result behind this tag. */
  parsed: ParsedSample;
}

/**
 * How many records are retained in {@link ParsedSample.rawEvents} and
 * {@link TaggedSample.rawEvents}. 200 keeps a KV-stored tagged sample small
 * while preserving enough events to discover every field (legacy cap).
 */
export const RAW_EVENTS_CAP = 200;

/**
 * How many distinct example values {@link DiscoveredField.examples} retains
 * per field. Legacy default was 3.
 */
export const MAX_FIELD_EXAMPLES = 3;
