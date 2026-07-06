/**
 * Pure decision logic for the CSV header-resolution dialog (porting-plan Unit 12
 * UI, GUI-07), kept out of the component so the queue navigation, header-file
 * parsing, preview-zip projection, mismatch derivation, and the re-parse are
 * unit-testable without a DOM or a store.
 *
 * THE CRITICAL FIX (pinned by csv-resolution-state.test.ts): when a multi-file
 * upload contains a headerless CSV, the legacy renderer opened the dialog on the
 * FIRST one and `return`ed from the upload loop - SILENTLY DROPPING every file
 * after it (both other headerless CSVs and ordinary samples). Here the whole
 * batch is tagged up front and EVERY headerless CSV is QUEUED for its own
 * resolution turn: {@link buildResolutionQueue} collects them all in order and
 * {@link advanceQueue} steps through them, so Apply and Skip both move to the
 * next queued file instead of ending the batch.
 *
 * All CSV parsing is @soc/core: {@link isHeaderlessCsv} decides what needs
 * resolving, {@link parseCsvWithHeaders} re-parses once headers are supplied
 * (syslog prefix stripped before split, future_use skipped, _extra_N overflow),
 * and {@link stripSyslogPrefix} keeps the preview aligned with what the re-parse
 * will actually produce. Detection stays content-first: this module never
 * re-detects a format, it only applies operator-supplied column names to a
 * sample already detected as CSV.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto, no Math.random. (The
 * @soc/core helpers it calls are themselves pure.)
 */

import {
  isHeaderlessCsv,
  parseCsvWithHeaders,
  stripSyslogPrefix,
} from "@soc/core";
import type { TaggedSample } from "@soc/core";
import { buildTaggedSample, normalizeLogType } from "./sample-intake-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One headerless-CSV sample awaiting column names in the resolution dialog. */
export interface CsvResolutionItem {
  /** The log type the sample is (already) tagged under; the re-parse re-keys it. */
  logType: string;
  /** Source label (filename or "pasted") carried onto the re-parsed sample. */
  sourceName: string;
  /**
   * The reconstructed CSV content (one comma-joined row per line) that
   * {@link parseCsvWithHeaders} re-parses once headers are resolved. Rebuilt
   * from the positional (_0, _1, ...) records the headerless parse produced.
   */
  csvContent: string;
  /** How many positional columns the headerless parse discovered. */
  columnCount: number;
  /** The first few reconstructed data rows, for the preview zip. */
  firstRows: string[];
}

/**
 * A first-in-first-out queue of headerless-CSV samples to resolve. `index` is
 * the position of the item currently in the dialog; the queue is DONE once
 * `index` reaches `items.length`.
 */
export interface CsvResolutionQueue {
  items: CsvResolutionItem[];
  index: number;
}

/** One row of the preview zip: a header aligned to its first-row value. */
export interface PreviewZipRow {
  /** The supplied column name. */
  header: string;
  /** The value at this position in the first data row ("" when absent). */
  value: string;
  /** False when the first row had no value at this position (surplus header). */
  hasValue: boolean;
  /**
   * True for a `future_use*` placeholder column: {@link parseCsvWithHeaders}
   * discards its value, so the preview marks it rather than implying a mapping.
   */
  skipped: boolean;
}

/** The header-count-vs-column-count comparison behind the mismatch warning. */
export interface CsvMismatch {
  /** True when headers exist and their count differs from the CSV columns. */
  mismatch: boolean;
  /** How many headers the operator supplied. */
  headerCount: number;
  /** How many positional columns the headerless parse discovered. */
  columnCount: number;
}

// ---------------------------------------------------------------------------
// Headerless-CSV detection + queue building
// ---------------------------------------------------------------------------

/**
 * True when a tagged sample is headerless positional CSV and therefore a
 * candidate for header resolution: its discovered fields are the `_0`, `_1`,
 * ... positional names the Unit 11 headerless CSV parse produces (via {@link
 * isHeaderlessCsv}).
 *
 * The signal is the FIELDS, not the format label - deliberately. Unit 11's
 * content detector only labels a first-line-all-identifiers CSV as "csv"; a
 * real headerless feed (IPs, dates, numbers on the first row) is labeled
 * "unknown" yet still parses to positional `_N` records through the parseByFormat
 * fallback. `isHeaderlessCsv` uniquely fingerprints that positional shape (no
 * other parser emits `_0`, `_1`, ... names), so it is the reliable trigger the
 * plan names ("Unit 11 isHeaderlessCsv / the '1,' fingerprint"). A CSV that
 * already carried a header row yields named fields and is NOT a candidate.
 */
export function isHeaderlessCsvSample(sample: TaggedSample): boolean {
  return isHeaderlessCsv(sample.parsed.fields);
}

/**
 * Reconstruct the comma-joined CSV lines for a headerless sample from its
 * stored raw events. The headerless parse produced positional (`_0`, `_1`, ...)
 * records whose JSON-stringified form is `rawEvents`; joining each record's
 * values with commas recovers the original row. Mirrors the legacy renderer's
 * `Object.values(obj).join(',')` reconstruction, including its fallback of
 * using the raw string verbatim when it is not JSON.
 */
export function reconstructCsvLines(rawEvents: readonly string[]): string[] {
  const lines: string[] = [];
  for (const raw of rawEvents) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      lines.push(
        Object.values(obj)
          .map((v) => String(v))
          .join(","),
      );
    } catch {
      lines.push(raw);
    }
  }
  return lines;
}

/** Project a headerless-CSV tagged sample into a {@link CsvResolutionItem}. */
export function toResolutionItem(sample: TaggedSample): CsvResolutionItem {
  const lines = reconstructCsvLines(sample.rawEvents);
  return {
    logType: sample.logType,
    sourceName: sample.parsed.sourceName,
    csvContent: lines.join("\n"),
    columnCount: sample.parsed.fields.length,
    firstRows: lines.slice(0, 3),
  };
}

/**
 * Build the resolution queue for a batch of just-tagged samples: EVERY
 * headerless CSV in the batch, in intake order (the critical fix - not just the
 * first). Non-headerless samples are left out (they need no resolution). The
 * returned queue starts at index 0.
 */
export function buildResolutionQueue(
  samples: readonly TaggedSample[],
): CsvResolutionQueue {
  const items = samples.filter(isHeaderlessCsvSample).map(toResolutionItem);
  return { items, index: 0 };
}

/** A single-item queue for the per-chip "Resolve headers" affordance. */
export function singleItemQueue(sample: TaggedSample): CsvResolutionQueue {
  return { items: [toResolutionItem(sample)], index: 0 };
}

// ---------------------------------------------------------------------------
// Queue navigation (next-in-queue, apply-advances, skip-advances)
// ---------------------------------------------------------------------------

/** The item currently in the dialog, or null when the queue is exhausted. */
export function currentItem(queue: CsvResolutionQueue): CsvResolutionItem | null {
  return queue.index < queue.items.length ? queue.items[queue.index] : null;
}

/**
 * Advance to the next queued item. BOTH Apply and Skip call this: resolving or
 * skipping the current file moves to the next one rather than ending the batch
 * (the legacy silent-drop fix). A no-op copy once the queue is already done.
 */
export function advanceQueue(queue: CsvResolutionQueue): CsvResolutionQueue {
  if (queue.index >= queue.items.length) {
    return { items: queue.items, index: queue.items.length };
  }
  return { items: queue.items, index: queue.index + 1 };
}

/** True once every queued item has been resolved or skipped. */
export function isQueueDone(queue: CsvResolutionQueue): boolean {
  return queue.index >= queue.items.length;
}

/** How many items (including the current one) still await resolution. */
export function remainingCount(queue: CsvResolutionQueue): number {
  return Math.max(0, queue.items.length - queue.index);
}

/**
 * The 1-based position of the current item and the queue total, for a
 * "Resolving file 2 of 3" caption. `current` is 0 when the queue is done.
 */
export function queuePosition(queue: CsvResolutionQueue): {
  current: number;
  total: number;
} {
  return {
    current: isQueueDone(queue) ? 0 : queue.index + 1,
    total: queue.items.length,
  };
}

// ---------------------------------------------------------------------------
// Header-file parsing (mined from the legacy handleUploadHeaderFile)
// ---------------------------------------------------------------------------

/**
 * Parse a pasted or uploaded header row into clean column names. Verbatim from
 * the legacy renderer's header-file handling:
 *   - comma-separated when the text contains a comma, else newline-separated;
 *   - each name trimmed and stripped of surrounding single/double quotes;
 *   - each name sanitized to an identifier (`[^A-Za-z0-9_]` -> `_`), leading
 *     underscores removed;
 *   - empties dropped.
 */
export function parseHeaderFileText(content: string): string[] {
  const raw = content.includes(",")
    ? content.split(",")
    : content.split("\n");
  return raw
    .map((h) => h.trim().replace(/^["']|["']$/g, ""))
    .map((h) => h.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, ""))
    .filter((h) => h !== "");
}

// ---------------------------------------------------------------------------
// Preview zip + mismatch
// ---------------------------------------------------------------------------

/**
 * Split one reconstructed CSV row into values the SAME way
 * {@link parseCsvWithHeaders} will: strip the syslog prefix first (a no-op on
 * an already-reconstructed row, kept for parity), then a naive comma split with
 * trim and surrounding-quote removal. Shares the documented quoted-comma
 * limitation of the core parser.
 */
export function splitCsvRow(row: string): string[] {
  return stripSyslogPrefix(row)
    .split(",")
    .map((v) => v.trim().replace(/^"|"$/g, ""));
}

/**
 * Zip the supplied `headers` against the first data row so the operator sees
 * name -> value alignment before applying. Capped at `limit` rows for display;
 * a `future_use*` header is marked `skipped` (its value is discarded on apply),
 * and a header with no corresponding value is marked `hasValue: false`.
 */
export function previewZip(
  headers: readonly string[],
  firstRow: string,
  limit = 15,
): PreviewZipRow[] {
  const values = splitCsvRow(firstRow);
  return headers.slice(0, limit).map((header, i) => ({
    header,
    value: values[i] ?? "",
    hasValue: i < values.length,
    skipped: header.startsWith("future_use"),
  }));
}

/**
 * Derive the header-count-vs-column-count mismatch. Only a warning when headers
 * exist: with no headers yet there is nothing to compare, so `mismatch` is
 * false. A mismatch does not block Apply (surplus values spill to `_extra_N`,
 * missing ones are simply unnamed) - it is surfaced so the operator can catch a
 * wrong header set first.
 */
export function deriveMismatch(
  headerCount: number,
  columnCount: number,
): CsvMismatch {
  return {
    mismatch: headerCount > 0 && headerCount !== columnCount,
    headerCount,
    columnCount,
  };
}

// ---------------------------------------------------------------------------
// Apply (re-parse via the core parser, re-key onto the same log type)
// ---------------------------------------------------------------------------

/**
 * Re-parse a queued item with the supplied `headers` through the core
 * {@link parseCsvWithHeaders} and rebuild the {@link TaggedSample} under the
 * item's existing log type (so the store upsert REPLACES the positional-named
 * entry - the Unit 11 replace-by-logType contract). `skipFirstRow` drops a
 * leading self-header row when the pasted CSV still carried one. Detection stays
 * content-first: the format remains CSV; only the column NAMES change.
 */
export function resolveHeaders(
  item: CsvResolutionItem,
  headers: readonly string[],
  skipFirstRow = false,
): TaggedSample {
  const parsed = parseCsvWithHeaders(item.csvContent, headers, {
    skipFirstRow,
    sourceName: item.sourceName,
  });
  return buildTaggedSample(normalizeLogType(item.logType), parsed);
}
