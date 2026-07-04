/**
 * Sample intake state - the PURE decisions behind the Integrate page's Sample
 * Data section (porting-plan Unit 11 UI, ENG-14/15/18), kept out of the
 * component so they are unit-testable without a DOM or a store.
 *
 * @soc/core owns ALL parsing (parseSampleContent detects the format from the
 * CONTENT - Cribl capture events are unwrapped to their inner _raw first-class -
 * and discovers fields/timestamp) and the log-type heuristics (detectLogType).
 * This module only shapes those results for the UI and models the in-memory
 * tagged-sample list the section renders over the TaggedSampleStore:
 *
 *   - chip derivation: one CHIP per tagged sample (detected format + counts).
 *   - field-table + raw-preview projections.
 *   - buildTaggedSample: the STORAGE object (records capped to RAW_EVENTS_CAP so
 *     a huge upload never blows the KV/host size budget).
 *   - dedupe-by-logType and upsert: the "one chip per log type" replace model
 *     that mirrors the store's replace-by-logType semantics.
 *   - rename RE-KEY: renaming a log type moves BOTH its tagged-sample entry AND
 *     any downstream edits keyed by that log type to the new key. This fixes the
 *     legacy orphaning bug (the renderer renamed the sample's logType but left
 *     the mapping edit stranded under the OLD key). reKeyByLogType is the one
 *     re-key primitive; mapping edits (Unit 18) are an opaque Record here, so
 *     the fix is pinned now and reused verbatim when mappings land.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto. (parseSampleContent and
 * detectLogType from @soc/core are themselves pure.)
 */

import {
  RAW_EVENTS_CAP,
  detectLogType,
  parseSampleContent,
} from "@soc/core";
import type {
  ParsedSample,
  SampleFormat,
  TaggedSample,
} from "@soc/core";

/** Trim a raw log-type input to its stored/keyed form (no other rewriting). */
export function normalizeLogType(raw: string): string {
  return raw.trim();
}

/**
 * Validate a log-type name for tagging. Returns the single reason it is not
 * usable, or null when it is fine. Only emptiness is rejected here - any
 * non-empty label is a valid log type (the store keys on it verbatim).
 */
export function validateLogType(raw: string): string | null {
  return normalizeLogType(raw) === "" ? "Enter a log type name." : null;
}

/**
 * The result of validating a rename. `collision` is true when `to` already
 * names another tagged sample - allowed (the renamed sample REPLACES it, the
 * "one chip per log type" rule), surfaced so the UI can warn first.
 */
export type RenameCheck =
  | { ok: true; collision: boolean }
  | { ok: false; reason: string };

/** Validate renaming the sample currently tagged `from` to `to`. */
export function validateRename(
  samples: readonly TaggedSample[],
  from: string,
  to: string,
): RenameCheck {
  const target = normalizeLogType(to);
  if (target === "") {
    return { ok: false, reason: "Enter a new log type name." };
  }
  if (target === from) {
    return { ok: false, reason: "The new name matches the current one." };
  }
  const collision = samples.some((s) => s.logType === target);
  return { ok: true, collision };
}

// ---------------------------------------------------------------------------
// Chip + field-table + raw-preview projections
// ---------------------------------------------------------------------------

/** One chip summarising a tagged sample (detected format + discovered shape). */
export interface SampleChip {
  logType: string;
  /** The format detected FROM THE CONTENT (post capture-unwrap). */
  format: SampleFormat;
  /** Events discovered in the sample (the true observed total). */
  eventCount: number;
  /** Distinct fields discovered across the events. */
  fieldCount: number;
  /** The best-guess timestamp field, or undefined when none was found. */
  timestampField?: string;
}

/** Derive the display chip for a tagged sample. */
export function chipFromTagged(sample: TaggedSample): SampleChip {
  const { logType, format } = sample;
  const parsed = sample.parsed;
  const chip: SampleChip = {
    logType,
    format,
    eventCount: parsed.eventCount,
    fieldCount: parsed.fields.length,
  };
  if (parsed.timestampField !== undefined) {
    chip.timestampField = parsed.timestampField;
  }
  return chip;
}

/** One row of the per-sample field table: name, inferred type, one example. */
export interface SampleFieldRow {
  name: string;
  /** The merged inferred type (@soc/core merge lattice). */
  type: string;
  /** A representative example value ("" when the field had none). */
  example: string;
  /** True when the field appeared in >= 90% of the events. */
  required: boolean;
}

/**
 * Project a parsed sample's discovered fields into table rows (name + inferred
 * type + first example). `limit` caps how many rows render; the default keeps
 * the table readable while still covering a wide vendor schema.
 */
export function fieldRows(
  parsed: ParsedSample,
  limit = 200,
): SampleFieldRow[] {
  return parsed.fields.slice(0, limit).map((field) => ({
    name: field.name,
    type: field.type,
    example: field.examples[0] ?? "",
    required: field.required,
  }));
}

/**
 * The raw-preview lines for a tagged sample: the first `maxLines` stored raw
 * events (already capped to {@link RAW_EVENTS_CAP} on tag). These are the
 * ORIGINAL vendor bytes when the sample was a non-JSON format, which is why the
 * preview shows them rather than a re-serialization.
 */
export function rawPreviewLines(
  sample: TaggedSample,
  maxLines = 20,
): string[] {
  return sample.rawEvents.slice(0, maxLines);
}

// ---------------------------------------------------------------------------
// Building + tagging
// ---------------------------------------------------------------------------

/**
 * Build the STORAGE {@link TaggedSample} for `logType` from a parse result.
 *
 * `parsed.records` is capped to {@link RAW_EVENTS_CAP} so a huge upload never
 * blows the KV/host size budget (`rawEvents` is already capped by
 * parseSampleContent). `eventCount` is left at the TRUE observed total so the
 * chip can report how many events the sample actually held - a deliberate
 * storage decision: for a stored tagged sample, records.length may be less than
 * eventCount when the sample exceeded the cap.
 */
export function buildTaggedSample(
  logType: string,
  parsed: ParsedSample,
): TaggedSample {
  const records =
    parsed.records.length > RAW_EVENTS_CAP
      ? parsed.records.slice(0, RAW_EVENTS_CAP)
      : parsed.records;
  return {
    logType: normalizeLogType(logType),
    format: parsed.format,
    rawEvents: parsed.rawEvents,
    parsed: { ...parsed, records },
  };
}

/**
 * Suggest a log-type name for an uploaded sample when the user did not name it,
 * via @soc/core detectLogType (filename keyword -> sourcetype example ->
 * sanitized filename). Pure; the UI still lets the user override the suggestion.
 */
export function suggestLogType(
  parsed: ParsedSample,
  sourceName: string,
): string {
  return detectLogType({
    sourceName,
    fields: parsed.fields.map((f) => ({ name: f.name, examples: f.examples })),
  });
}

/**
 * Parse `content` and tag it to `logType` in one step. The format is ALWAYS
 * detected from the content (never a declared format); capture inner-_raw is
 * unwrapped first-class by parseSampleContent. Returns the storage tagged
 * sample; inspect `.parsed.errors` for non-fatal parse problems.
 */
export function tagSampleFromContent(
  logType: string,
  content: string,
  sourceName?: string,
): TaggedSample {
  const parsed = parseSampleContent(
    content,
    sourceName !== undefined ? { sourceName } : {},
  );
  return buildTaggedSample(logType, parsed);
}

/**
 * Tag an uploaded FILE: parse it (format detected from content), SUGGEST a log
 * type from the filename/content, and build the storage tagged sample. The UI
 * lets the user rename the suggested log type afterwards.
 */
export function tagFileContent(
  content: string,
  fileName: string,
): TaggedSample {
  const parsed = parseSampleContent(content, { sourceName: fileName });
  return buildTaggedSample(suggestLogType(parsed, fileName), parsed);
}

// ---------------------------------------------------------------------------
// In-memory list model (mirrors the store's replace-by-logType semantics)
// ---------------------------------------------------------------------------

/**
 * Collapse a list to one entry per log type. The LAST value for a log type
 * wins (re-tagging replaces), kept at the FIRST occurrence's position - exactly
 * the semantics of the store's Map.set (update in place, append when new).
 */
export function dedupeByLogType(
  samples: readonly TaggedSample[],
): TaggedSample[] {
  const order: string[] = [];
  const byType = new Map<string, TaggedSample>();
  for (const sample of samples) {
    if (!byType.has(sample.logType)) {
      order.push(sample.logType);
    }
    byType.set(sample.logType, sample);
  }
  return order.map((logType) => byType.get(logType) as TaggedSample);
}

/**
 * Upsert `sample` into `list`: replace the entry with the same log type in
 * place, or append when the log type is new. Mirrors TaggedSampleStore.upsert.
 */
export function upsertSample(
  list: readonly TaggedSample[],
  sample: TaggedSample,
): TaggedSample[] {
  const index = list.findIndex((s) => s.logType === sample.logType);
  if (index === -1) {
    return [...list, sample];
  }
  const next = [...list];
  next[index] = sample;
  return next;
}

/** Remove the entry tagged `logType`, if present. */
export function removeByLogType(
  list: readonly TaggedSample[],
  logType: string,
): TaggedSample[] {
  return list.filter((s) => s.logType !== logType);
}

/**
 * Rename the sample tagged `from` to `to` in the list, RE-KEYING its log type.
 * If `to` already exists, the renamed sample replaces it (one chip per log
 * type); the renamed entry keeps `from`'s position. A no-op when nothing is
 * tagged `from`.
 */
export function renameInList(
  list: readonly TaggedSample[],
  from: string,
  to: string,
): TaggedSample[] {
  const target = normalizeLogType(to);
  if (from === target) {
    return [...list];
  }
  const fromIndex = list.findIndex((s) => s.logType === from);
  if (fromIndex === -1) {
    return [...list];
  }
  const result: TaggedSample[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (i === fromIndex) {
      result.push({ ...entry, logType: target });
    } else if (entry.logType === target) {
      // Drop the pre-existing `to` entry - the renamed sample replaces it.
      continue;
    } else {
      result.push(entry);
    }
  }
  return result;
}

/**
 * Re-key a Record keyed by log type when a log type is renamed: move the value
 * under `from` to `to` (overwriting any existing `to`) and drop `from`. All
 * other keys are preserved.
 *
 * This is the fix for the legacy orphaning bug (the renderer renamed a sample's
 * log type but left its mapping edit stranded under the old key). Downstream
 * mapping edits (Unit 18) are keyed by log type, so the section calls this on
 * every rename via the onRenameLogType contract - the fix is pinned here and
 * reused verbatim once mappings land. A no-op copy when `from === to` or `from`
 * is absent.
 */
export function reKeyByLogType<T>(
  record: Readonly<Record<string, T>>,
  from: string,
  to: string,
): Record<string, T> {
  const target = normalizeLogType(to);
  const result: Record<string, T> = {};
  const hasFrom = Object.prototype.hasOwnProperty.call(record, from);
  for (const [key, value] of Object.entries(record)) {
    if (key === from) {
      // Skip here; the moved value is written under `target` below so it wins
      // over any pre-existing `to` entry.
      continue;
    }
    if (hasFrom && from !== target && key === target) {
      // Drop the pre-existing `to` entry - the moved value replaces it.
      continue;
    }
    result[key] = value;
  }
  if (hasFrom) {
    result[target] = record[from];
  }
  return result;
}
