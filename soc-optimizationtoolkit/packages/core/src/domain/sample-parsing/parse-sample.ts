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
 * Best-guess the timestamp field: a known candidate name wins first, then the
 * first datetime-typed field, then the first field whose name contains "time".
 * Returns undefined when nothing qualifies. Candidate list verbatim from legacy
 * guessTimestampField.
 */
export function guessTimestampField(
  fields: ReadonlyArray<DiscoveredField>,
): string | undefined {
  const candidates = [
    "timestamp", "Timestamp", "time", "Time", "datetime", "DateTime",
    "EventTime", "eventTime", "TimeGenerated", "created_at", "createdAt",
    "date", "Date", "EdgeStartTimestamp", "Datetime", "start_time",
    "event_time", "log_time", "receive_time", "_time",
  ];
  for (const candidate of candidates) {
    if (fields.some((f) => f.name === candidate)) {
      return candidate;
    }
  }
  const datetimeField = fields.find((f) => f.type === "datetime");
  if (datetimeField) {
    return datetimeField.name;
  }
  const timeish = fields.find((f) => f.name.toLowerCase().includes("time"));
  if (timeish) {
    return timeish.name;
  }
  return undefined;
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

  try {
    records = parseByFormat(content, format);
  } catch (err) {
    errors.push(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (records.length === 0 && errors.length === 0) {
    errors.push("Could not parse any events from the provided content");
  }

  const unwrapped = unwrapCapture(records, format);
  records = unwrapped.records;
  format = unwrapped.format;

  const fields = collectFields(records);
  const timestampField = guessTimestampField(fields);
  const rawEvents = records
    .slice(0, RAW_EVENTS_CAP)
    .map((record) => JSON.stringify(record));

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
 * Apply the Cribl-capture inner-_raw unwrap. Only JSON/NDJSON wrappers whose
 * first record has a non-empty-eligible `_raw` are candidates; on a usable
 * inner parse the records and format are replaced, otherwise the input is
 * returned unchanged (silent fallback).
 */
export function unwrapCapture(
  records: Array<Record<string, unknown>>,
  format: SampleFormat,
): { records: Array<Record<string, unknown>>; format: SampleFormat } {
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
  try {
    innerRecords = parseByFormat(rawValues.join("\n"), innerFormat);
  } catch {
    // Inner parse threw; fall back to the outer parse (silent).
    return { records, format };
  }

  if (innerRecords.length > 0 && Object.keys(innerRecords[0]).length > 1) {
    return { records: innerRecords, format: innerFormat };
  }
  return { records, format };
}
