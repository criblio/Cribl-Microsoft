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
 * THE LIVE PREVIEW (step 2 of the vendor field-definition plan) is the other
 * thing that lives here. {@link buildFieldPreview} is the SHARED surface every
 * input path renders into - the pasted header row, the pasted vendor feed
 * config, and the interactive mapper all hand it one array of names and get
 * back the same projection: each position's name beside the real value it takes,
 * plus the unmapped remainder counted. Positional mapping is easy to get subtly
 * wrong, and an off-by-one that is invisible in a list of names is obvious next
 * to values.
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
  isPositionalFieldName,
  parseCsvWithHeaders,
  parseFeedConfig,
  positionalFieldName,
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
  /**
   * The first few reconstructed data rows. Row 0 feeds the preview zip; the
   * rest feed the interactive mapper's per-position EXAMPLE VALUES, which is
   * why this is more than one row: a single `0` identifies nothing, while
   * `0, 0, 1, 0` beside `443, 80, 443, 22` identifies both columns at a glance.
   * Capped at {@link EXAMPLE_ROW_COUNT}.
   */
  firstRows: string[];
}

/**
 * How many data rows a {@link CsvResolutionItem} carries for display. Enough
 * that a repeated-value column (a flag, a constant) is visibly distinct from a
 * varying one, and few enough that the mapper grid stays readable.
 */
export const EXAMPLE_ROW_COUNT = 5;

/**
 * A first-in-first-out queue of headerless-CSV samples to resolve. `index` is
 * the position of the item currently in the dialog; the queue is DONE once
 * `index` reaches `items.length`.
 */
export interface CsvResolutionQueue {
  items: CsvResolutionItem[];
  index: number;
}

/**
 * One POSITION in the live preview: the name that position carries right now,
 * aligned to the real value sitting at it in a data row.
 *
 * There is a row here for every position in the union of the data's columns and
 * the operator's definition - NOT only for the names they supplied. That is the
 * whole point of the surface: a definition covering 12 of 38 columns has to look
 * like it covers 12 of 38, and 26 rows that read `_12 -> 192.168.0.2` are what
 * make that visible. Listing only the 12 supplied names would render a
 * quarter-finished definition indistinguishable from a complete one.
 */
export interface PreviewZipRow {
  /** Zero-based column position in the data row. */
  position: number;
  /**
   * The name this position carries: the operator's name when they supplied one,
   * otherwise the core {@link positionalFieldName} for this position.
   *
   * NEVER a guess. Nothing here infers a name from the value's shape - a
   * confident wrong name is worse than a visible `_17`, because a wrong name
   * silently survives into the destination schema whereas `_17` is obviously
   * unfinished (plan: "never invent a name").
   */
  header: string;
  /** The value at this position in the previewed data row ("" when absent). */
  value: string;
  /** False when the row had no value at this position (a surplus header). */
  hasValue: boolean;
  /**
   * True for a `future_use*` placeholder column: {@link parseCsvWithHeaders}
   * discards its value, so the preview marks it rather than implying a mapping.
   * A placeholder still counts as MAPPED - the operator has declared the column
   * meaningless, which is a decision, not an omission.
   */
  skipped: boolean;
  /**
   * True when no operator-supplied name covers this position, so it is still
   * carrying its positional name. Decided with the core
   * {@link isPositionalFieldName} rather than a local regex - the producer and
   * the test for it live together in core models.ts precisely because they had
   * drifted apart once (step 1 of the field-definition plan).
   *
   * A supplied name that is itself positional counts as unmapped. That is not a
   * hypothetical: the interactive per-column mapper holds ONE array for all
   * positions and parks the ones nobody has named yet at
   * {@link positionalFieldName}, so "is this position named?" must be answered
   * from the name, not from the array's length.
   */
  unmapped: boolean;
}

/**
 * The live preview of a column definition against real data - the shared
 * surface EVERY input path (pasted header row, pasted vendor feed config,
 * interactive mapper, a pre-filled bundled order) renders into.
 *
 * It carries two things the operator cannot get from a name list:
 *
 * 1. Each name beside the real value it will take. Positional mapping is easy
 *    to get subtly wrong and an off-by-one is INVISIBLE in a list of names.
 *    Beside values it is obvious. The live case that motivated this: PAN-OS
 *    CONFIG emits `1,2021/10/25 20:25:39,,CONFIG` with an EMPTY serial, so a
 *    definition written for the documented column order - which assumes serial
 *    is populated - shifts every name after position 2, and the shift shows up
 *    the instant `type` reads "" and `subtype` reads "CONFIG".
 *
 * 2. The unmapped remainder, COUNTED. See {@link unmappedCount}.
 */
export interface FieldDefinitionPreview {
  /**
   * The rendered rows, in position order, capped at the display limit. The cap
   * hides ROWS; it never hides the counts below - a definition covering 12 of
   * 38 columns still reports 26 unmapped even when only 15 rows fit.
   */
  rows: PreviewZipRow[];
  /**
   * Every position considered: the union of the data's columns and the supplied
   * names (`rows.length + hiddenCount`). Larger than {@link columnCount} when
   * the operator supplied MORE names than the data has columns.
   */
  totalPositions: number;
  /** How many positional columns the data actually has - the coverage denominator. */
  columnCount: number;
  /**
   * How many of the data's `columnCount` positions carry an operator-supplied
   * name. Surplus names beyond the data's columns are deliberately NOT counted
   * here - they map nothing, and inflating coverage with them would be the
   * exact false reassurance this surface exists to prevent. They are surfaced
   * by {@link mismatch} instead.
   */
  mappedCount: number;
  /** `columnCount - mappedCount`: positions still carrying a positional name. */
  unmappedCount: number;
  /** Positions past the display limit, reported rather than silently dropped. */
  hiddenCount: number;
  /**
   * The header-count-vs-column-count comparison. It SURVIVES alongside the
   * coverage counts rather than being replaced by them, because the two say
   * different things: coverage says "you have not named everything yet"
   * (expected, mid-edit), mismatch says "the set you pasted is the wrong SIZE
   * for this data" (usually the wrong feed config, or an off-by-one).
   */
  mismatch: CsvMismatch;
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
    firstRows: lines.slice(0, EXAMPLE_ROW_COUNT),
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
 * Clean ONE operator-supplied column name, verbatim from the legacy renderer's
 * header-file handling: trim, strip surrounding single/double quotes, sanitize
 * to an identifier (`[^A-Za-z0-9_]` -> `_`), drop leading underscores. Returns
 * "" when nothing survives (e.g. `"!!!"`), which every caller reads as "this
 * column is still unnamed".
 *
 * It is a NAMED, SHARED function rather than an inline chain because two input
 * paths now supply names - the pasted header row and the interactive per-column
 * mapper - and this app has already been bitten once by the same question ("what
 * is a legal column name?") being answered twice in two places (see
 * positionalFieldName in core models.ts). Both paths call this one.
 *
 * Note the useful consequence of dropping leading underscores: an operator
 * CANNOT type a name that collides with the positional `_N` namespace, so a
 * named column is never mistaken for an unnamed one.
 */
export function sanitizeColumnName(name: string): string {
  const trimmed = name.trim().replace(/^["']|["']$/g, "");
  // THE CANONICAL UNNAMED TOKEN SURVIVES, and it has to, because this function
  // sits on a ROUND TRIP as well as on operator input. A saved partial
  // definition is seeded back into the header-row textarea as ordinary text,
  // and it carries `_0`/`_5` for the positions nobody has named yet. Stripping
  // the underscore turned those placeholders into REAL names - `0`, `5` - so
  // reopening a half-finished definition reported "Names all 15 columns" when
  // 13 were unnamed, and applying it would have named columns after their own
  // index and made the sample stop looking headerless, which is precisely the
  // reopen trap this whole step exists to close. Seen in the live preview
  // 2026-08-25, not by a test: every pinned round-trip used a FULL vendor
  // dictionary, which contains no placeholders.
  //
  // The operator-collision guard this note used to claim now lives where the
  // operator actually types - see the mapper's own handling - because that is
  // the only place a `_5` can be a mistake rather than the app's own token.
  if (isPositionalFieldName(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "");
}

/**
 * Parse a pasted or uploaded header row into clean column names:
 *   - comma-separated when the text contains a comma, else newline-separated;
 *   - each name through {@link sanitizeColumnName};
 *   - empties dropped.
 */
export function parseHeaderFileText(content: string): string[] {
  const raw = content.includes(",")
    ? content.split(",")
    : content.split("\n");
  return raw.map(sanitizeColumnName).filter((h) => h !== "");
}

// ---------------------------------------------------------------------------
// Definition source: which input path the preview is currently showing
// ---------------------------------------------------------------------------

/**
 * The dialog tabs that supply column names from PASTED TEXT - a header row, or
 * a vendor output config. Both assume the operator HAS an artifact to paste.
 */
export type PastedDefinitionTab = "row" | "config";

/**
 * Every tab that can supply a definition. `"map"` is the interactive per-column
 * mapper (csv-column-mapping.ts), which exists for the operator who has NEITHER
 * artifact and names columns from their real values instead. It is in this union
 * because the preview surface treats all three as interchangeable suppliers of
 * one array; it is NOT in {@link PastedDefinitionTab} because it has no text to
 * parse, so {@link resolveDefinitionSource} cannot be handed it by mistake.
 */
export type DefinitionTab = PastedDefinitionTab | "map";

/** The column names an input path currently yields, plus what to call it. */
export interface DefinitionSource {
  /** The tab these names came from. */
  tab: DefinitionTab;
  /** The names, in column order. Empty when the text yields none (yet). */
  headers: string[];
  /**
   * What the dialog says about the parse: the recognized vendor and field count,
   * or why nothing was recognized. "" when the operator has typed nothing -
   * there is no news before there is input.
   */
  label: string;
  /** True once the active tab's text is non-blank. */
  hasInput: boolean;
}

/**
 * Derive the current definition from whichever tab is active. Called on EVERY
 * keystroke, which is the point: the preview is live, so the names it shows
 * beside the values are re-derived from the text as the operator types or
 * pastes rather than latched by a "parse this" button.
 *
 * That is why the two tabs no longer latch their result into component state.
 * They used to, and the consequence was that the preview showed a definition
 * the visible text no longer matched - the operator edited the header row,
 * the preview kept displaying the previous parse, and the mismatch warning
 * argued with the textarea. THE ACTIVE TAB IS THE DEFINITION: what is on screen
 * is what Apply applies.
 *
 * Both tabs return the same shape so the preview surface never branches on
 * where names came from - the header-row tab, the feed-config tab, and (next)
 * the interactive mapper are interchangeable suppliers of one array.
 */
export function resolveDefinitionSource(
  tab: PastedDefinitionTab,
  headerRowText: string,
  feedConfigText: string,
): DefinitionSource {
  const text = tab === "row" ? headerRowText : feedConfigText;
  if (text.trim() === "") {
    return { tab, headers: [], label: "", hasInput: false };
  }
  if (tab === "row") {
    const headers = parseHeaderFileText(text);
    return {
      tab,
      headers,
      label:
        headers.length > 0
          ? `Header row (${headers.length} column${headers.length === 1 ? "" : "s"})`
          : "No column names found - check the header row.",
      hasInput: true,
    };
  }
  const config = parseFeedConfig(text);
  return {
    tab,
    headers: config.fields,
    label:
      config.fields.length > 0
        ? `${config.vendor} ${config.feedType} (${config.fields.length} field${config.fields.length === 1 ? "" : "s"})`
        : "No fields detected - check the config format.",
    hasInput: true,
  };
}

// ---------------------------------------------------------------------------
// The live preview surface (name -> real value, plus the unmapped remainder)
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
 * True when `header` is a real operator-supplied name for a column, as opposed
 * to a placeholder for one nobody has named yet.
 *
 * Two things fail the test, and both mean "still unmapped":
 *   - nothing there at all (the definition is shorter than the data, or the
 *     entry is blank - {@link parseCsvWithHeaders} drops a blank name's value);
 *   - a name that IS a positional name, which is how the interactive mapper
 *     represents an un-named position inside a full-length array.
 */
function isSuppliedName(header: string | undefined): boolean {
  if (header === undefined) {
    return false;
  }
  const trimmed = header.trim();
  return trimmed !== "" && !isPositionalFieldName(trimmed);
}

/**
 * Zip a definition against one real data row, ONE ROW PER POSITION across the
 * union of the data's columns and the supplied names.
 *
 * Uncapped on purpose: the display cap is a rendering concern and belongs to
 * {@link buildFieldPreview}, which needs the full list to count the unmapped
 * remainder correctly. Capping here would make the count depend on how many
 * rows happened to fit, which is how "12 of 38" would quietly become "12 of 15".
 *
 * A position with no supplied name keeps {@link positionalFieldName} and is
 * flagged `unmapped`; a `future_use*` name is flagged `skipped` (its value is
 * discarded on apply); a position past the end of the row is `hasValue: false`.
 */
export function previewZip(
  headers: readonly string[],
  firstRow: string,
  columnCount: number,
): PreviewZipRow[] {
  // A blank row must contribute NO positions: "".split(",") is [""], which
  // would otherwise invent a column-zero that holds an empty value.
  const values = firstRow.trim() === "" ? [] : splitCsvRow(firstRow);
  const total = Math.max(columnCount, headers.length, values.length);
  const rows: PreviewZipRow[] = [];
  for (let i = 0; i < total; i += 1) {
    const supplied = headers[i];
    const named = isSuppliedName(supplied);
    const header = named
      ? (supplied as string).trim()
      : positionalFieldName(i);
    rows.push({
      position: i,
      header,
      value: values[i] ?? "",
      hasValue: i < values.length,
      skipped: named && header.startsWith("future_use"),
      unmapped: !named,
    });
  }
  return rows;
}

/** How many preview rows are rendered before the remainder is summarized. */
export const PREVIEW_ROW_LIMIT = 15;

/**
 * Build the live preview for `headers` against `item` - the one call every
 * input path makes, so the header-row tab, the feed-config tab and the
 * interactive mapper all show the same thing computed the same way.
 *
 * Which row is previewed is decided HERE rather than by each caller: the first
 * data row. One row is enough to expose an off-by-one (a timestamp under
 * `serial` needs no second opinion) and every caller showing the same row keeps
 * the surface comparable as the operator switches tabs.
 */
export function buildFieldPreview(
  headers: readonly string[],
  item: Pick<CsvResolutionItem, "columnCount" | "firstRows">,
  limit = PREVIEW_ROW_LIMIT,
): FieldDefinitionPreview {
  const all = previewZip(headers, item.firstRows[0] ?? "", item.columnCount);
  // Coverage is measured over the DATA's columns only. A definition with 40
  // names for 38 columns covers at most 38; the two surplus names are the
  // mismatch warning's business, not coverage's.
  const covered = all.slice(0, item.columnCount);
  const mappedCount = covered.filter((row) => !row.unmapped).length;
  return {
    rows: all.slice(0, limit),
    totalPositions: all.length,
    columnCount: item.columnCount,
    mappedCount,
    unmappedCount: covered.length - mappedCount,
    hiddenCount: Math.max(0, all.length - limit),
    mismatch: deriveMismatch(headers.length, item.columnCount),
  };
}

/**
 * The one-line coverage caption. A string, and therefore a decision about what
 * the operator is told, which is why it lives in the pure module beside the
 * counts rather than being assembled inline in the component.
 *
 * It always names the remainder explicitly, including the zero case ("Names all
 * 38 columns"), because "no warning shown" and "nothing left to map" have to be
 * distinguishable - silence is what let a 12-of-38 definition read as finished.
 */
export function coverageLine(preview: FieldDefinitionPreview): string {
  const { columnCount, mappedCount, unmappedCount, rows } = preview;
  if (columnCount === 0) {
    return "No columns to map.";
  }
  if (unmappedCount === 0) {
    return `Names all ${columnCount} columns.`;
  }
  const firstUnmapped = rows.find((row) => row.unmapped);
  // The example name is the first unmapped position that is actually RENDERED;
  // with a very short display cap there may be none, in which case the count
  // stands on its own rather than naming a row the operator cannot see.
  const example =
    firstUnmapped === undefined ? "" : ` (${firstUnmapped.header} and so on)`;
  return `Names ${mappedCount} of ${columnCount} columns - ${unmappedCount} still unmapped${example}.`;
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
 *
 * NOTE what happens to the unmapped remainder, because the preview and the
 * apply deliberately name it differently. While the definition is being
 * written, an uncovered position is `_N` - unnamed, and the preview says so.
 * Once applied, the core parser parks values beyond the supplied headers at
 * `_extra_N`, which is a DIFFERENT fact and stays different on purpose (core
 * models.ts): `_N` means nobody has named this column, `_extra_N` means the
 * definition the operator committed to was short. The mismatch warning is what
 * tells them that is about to happen, which is why it survives alongside the
 * coverage count instead of being folded into it.
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
