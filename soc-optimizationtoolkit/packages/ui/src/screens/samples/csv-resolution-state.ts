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
 * next queued log type instead of ending the batch.
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
 * THE PREVIEW'S PROMISE IS THE APPLY'S CONTRACT (2026-08-26). {@link
 * applicableHeaders} builds the one array both sides use: {@link previewZip}
 * renders it and {@link resolveHeaders} hands the same array to the core
 * parser. They cannot drift, because there is nothing to keep in step - what
 * the operator reads beside the values is literally what is applied. See
 * {@link applicableHeaders} for what that changed and why.
 *
 * TERMINOLOGY, settled 2026-08-26 across this module, csv-column-mapping,
 * csv-header-dialog and sample-intake-section:
 *   - the UNIT being resolved is a LOG TYPE. Never "file" (a queued sample may
 *     be an upload, a paste, or a Lake dataset - `lake:AUTH` is not a file),
 *     never "feed" (that word is reserved for the VENDOR ARTIFACT the
 *     feed-config tab parses), never "sourcetype" (a Cribl field, not ours).
 *   - the ACTION is NAMING COLUMNS. The chip affordance, the mapper tab and the
 *     coverage line all say "name"; "resolve" survives only in the internal
 *     names of this module's queue types, and "map"/"unmapped" only as the
 *     state of a POSITION that carries no operator-supplied name.
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
  isOverflowFieldName,
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
   * Names carried by MORE THAN ONE of the data's columns, in first-seen order.
   *
   * DETECTED HERE, on the shared surface, because it is a fact about the
   * definition and not about which tab typed it. It used to be checked only by
   * the interactive mapper, so a pasted header row - or a vendor feed config -
   * containing a repeated name lost a column in silence and the coverage line
   * still said "Names all 38 columns". core parseCsvWithHeaders assigns by
   * NAME, so the last column with a given name simply overwrites the earlier
   * ones: the loss is real, total, and invisible in a list of names.
   *
   * Only the DATA's columns are considered (the same denominator coverage
   * uses), and `future_use*` placeholders are excluded - the parser discards
   * their values rather than keying them, so two placeholders never collide.
   */
  duplicateNames: string[];
  /**
   * How many of the data's columns are LOST to {@link duplicateNames} - one per
   * colliding position after the first, i.e. exactly how far
   * {@link mappedCount} over-states what will reach the sample.
   */
  collapsedCount: number;
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

// The overflow spelling core parseCsvWithHeaders parks a surplus value at
// (`_extra_12`) now lives in core beside its producer, as isOverflowFieldName.
// It is read here ONLY to recognise a sample some earlier build applied a short
// definition to, so its columns can still be named - applicableHeaders means
// this app no longer PRODUCES such a sample. That is exactly why the local copy
// this replaced was dangerous: no test creates such a sample, so a rename in
// core would have left this matching nothing, silently.

/**
 * The name of the first column NOBODY HAS NAMED, or "" when every column has a
 * name. Both the answer to "should this chip offer the naming dialog?" and the
 * example the chip's hint quotes, which is why it returns a NAME rather than a
 * boolean: the hint can then point at a column really in THIS sample ("_7 and
 * so on") instead of illustrating with a `_0` that may well already be named.
 *
 * WHY THIS IS NOT {@link isHeaderlessCsvSample}. That one answers "did this
 * arrive with no header row at all?" - the right question for whether to
 * VOLUNTEER the dialog on intake, and it is still what builds the queue. It is
 * the wrong question for the per-chip affordance, because it needs a MAJORITY
 * of positional fields (core isHeaderlessCsv: more than half). Apply a
 * definition covering 12 of 38 columns and 26 stay unnamed, which is a majority
 * and still qualifies; apply one covering 30 and only 8 stay unnamed, which is
 * not - so the button and the hint vanished with the job unfinished and no
 * route back to the dialog. A dead end reached by a normal action.
 *
 * The honest test is "is any column still unnamed", asked of the FIELDS, and it
 * covers both spellings of unnamed: the positional `_12` this app now applies,
 * and the `_extra_12` an older build left behind.
 */
export function firstUnnamedColumn(sample: TaggedSample): string {
  // A headerless sample is positional by definition, but not necessarily CSV
  // by LABEL: Unit 11's content detector calls a numeric-first-row feed
  // "unknown" while still parsing it to positional records, so the format gate
  // below would wrongly exclude the very samples this dialog exists for.
  if (!isHeaderlessCsvSample(sample) && sample.format !== "csv") {
    return "";
  }
  const unnamed = sample.parsed.fields.find(
    (field) =>
      isPositionalFieldName(field.name) ||
      isOverflowFieldName(field.name),
  );
  return unnamed === undefined ? "" : unnamed.name;
}

/**
 * True when `columns` ACCOUNTS FOR the names this sample carries: every named
 * field appears in the order, and they appear in the order's own sequence.
 *
 * WHY IT EXISTS. The chip renders a PROVENANCE sentence for a sample whose
 * columns came from a bundled dictionary or from the operator's own remembered
 * order. But a remembered order exists per VENDOR + LOG TYPE whether or not
 * THIS sample was ever named from it, so rendering it unconditionally would
 * caption a hand-typed - or an entirely unrelated - sample with somebody else's
 * provenance. Unmatched means SILENT: "we do not know where these names came
 * from" is a true answer, and a confident wrong one is the same failure as
 * inventing a column name.
 *
 * THE TEST RUNS FROM THE SAMPLE TO THE ORDER, not the other way round, because
 * a real sample is routinely NARROWER than the order that named it - a PAN-OS
 * TRAFFIC export truncated to nine columns is still a PAN-OS TRAFFIC export.
 * Requiring the order's names to all be present would have silenced the notice
 * for exactly the samples operators actually paste.
 *
 * SEQUENCE IS CHECKED, not just membership, because the subject is POSITIONAL
 * data: names that appear shuffled did not come from this order, whatever they
 * are spelled. Positional and `_extra_N` fields are skipped (nobody named
 * them), and so are the `future_use*` entries in the order - the parser keys
 * none of the three, so none can be required to line up.
 */
export function columnOrderMatchesSample(
  columns: readonly string[],
  sample: TaggedSample,
): boolean {
  const order = columns
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const carried = sample.parsed.fields
    .map((field) => field.name)
    .filter(
      (name) =>
        !isPositionalFieldName(name) &&
        !isOverflowFieldName(name),
    );
  if (carried.length === 0) {
    return false;
  }
  let at = 0;
  for (const name of carried) {
    const found = order.indexOf(name, at);
    if (found === -1) {
      return false;
    }
    at = found + 1;
  }
  return true;
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

/** A single-item queue for the per-chip "Name columns" affordance. */
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
 * skipping the current log type moves to the next one rather than ending the batch
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
 * "Naming log type 2 of 3" caption - LOG TYPE, not file: a queued sample may
 * have arrived as an upload, a paste, or a Lake dataset. `current` is 0 when
 * the queue is done.
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
 * THE ONE ARRAY, built once and used by both halves of this module: the name
 * every position will carry, with {@link positionalFieldName} parked at each
 * position the operator has not named and the whole thing extended to cover the
 * data's columns.
 *
 * WHY IT EXISTS - the defect it closes (2026-08-26). The preview promised one
 * thing and Apply produced another. A definition covering 12 of 38 columns
 * rendered `_12` in the coverage line and `_12 (unmapped)` in the preview rows,
 * and then core parseCsvWithHeaders - handed the 12 names verbatim - parked
 * every surplus VALUE at `_extra_12`. Three names for the same 26 positions on
 * one screen, and the operator had no way to know which was the truth.
 *
 * Worse than the noise: `_extra_12` is not a positional name, so a sample with
 * 12 named columns and 26 overflow ones stopped satisfying core isHeaderlessCsv
 * and the affordance to FINISH the definition disappeared. Applying a partial
 * definition - a normal, encouraged action - destroyed the way back to the
 * dialog. The interactive mapper never had that problem because
 * resolvedColumnNames already padded with positional names; the two pasted tabs
 * did, so the same half-finished definition was resumable from one tab and
 * terminal from the other two, with nothing on screen saying which you were in.
 *
 * WHAT WAS GIVEN UP, deliberately. This module used to document the divergence
 * as meaningful: `_N` says nobody named this column, `_extra_N` says the
 * definition the operator COMMITTED TO was short. The distinction is real and
 * is not worth its price. The "was short" fact is told twice already at the
 * moment it can still be acted on - by the coverage line and by
 * {@link mismatchLine} - and afterwards by the chip continuing to show 26
 * unnamed columns and continuing to offer to name them, which says "your
 * definition was short" far better than a name that reads like a parser
 * artifact. The two spellings even denote the SAME position (`_extra_N` uses
 * the absolute value index), so nothing was distinguished by the numbers. And
 * the one fact `_extra_N` recorded was precisely the fact that made it
 * unfixable. core's overflow behaviour is untouched and still right for a
 * caller whose header set is authoritative; this app simply never hands it a
 * short one.
 *
 * A BLANK entry is filled in too, not just a missing one. parseCsvWithHeaders
 * DISCARDS the value under an empty name, so forwarding a blank would delete a
 * column the preview had just shown carrying its value - the same broken
 * promise in a rarer costume. Nothing the dialog can produce contains a blank
 * (parseHeaderFileText drops them, the mapper never emits one), which is why
 * this had gone unnoticed; the guarantee is cheap and does not depend on that
 * staying true.
 *
 * SURPLUS NAMES SURVIVE unchanged past the data's columns: they map nothing,
 * the preview shows them holding no value, and {@link mismatchLine} says so.
 */
export function applicableHeaders(
  headers: readonly string[],
  columnCount: number,
): string[] {
  const total = Math.max(columnCount, headers.length);
  const applied: string[] = [];
  for (let i = 0; i < total; i += 1) {
    const supplied = headers[i];
    applied.push(
      isSuppliedName(supplied)
        ? (supplied as string).trim()
        : positionalFieldName(i),
    );
  }
  return applied;
}

/**
 * Zip a definition against one real data row, ONE ROW PER POSITION across the
 * union of the data's columns and the supplied names.
 *
 * The names come from {@link applicableHeaders} - the SAME call
 * {@link resolveHeaders} makes - so what is rendered beside the values is
 * literally the array that will be applied, not a parallel derivation of it.
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
  const applied = applicableHeaders(
    headers,
    Math.max(columnCount, values.length),
  );
  return applied.map((header, i) => {
    const named = isSuppliedName(headers[i]);
    return {
      position: i,
      header,
      value: values[i] ?? "",
      hasValue: i < values.length,
      skipped: named && header.startsWith("future_use"),
      unmapped: !named,
    };
  });
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
  const { duplicateNames, collapsedCount } = findDuplicates(covered);
  return {
    rows: all.slice(0, limit),
    totalPositions: all.length,
    columnCount: item.columnCount,
    mappedCount,
    unmappedCount: covered.length - mappedCount,
    hiddenCount: Math.max(0, all.length - limit),
    duplicateNames,
    collapsedCount,
    mismatch: deriveMismatch(headers.length, item.columnCount),
  };
}

/**
 * Names used by more than one of the data's columns, and how many columns that
 * costs. Mirrors what core parseCsvWithHeaders ACTUALLY does rather than a rule
 * invented here: it assigns `record[name]`, so N columns sharing a name yield
 * ONE field and N-1 columns are lost. Unmapped positions cannot collide (their
 * positional names are unique by construction) and `skipped` placeholders are
 * never keyed, so neither participates.
 */
function findDuplicates(covered: readonly PreviewZipRow[]): {
  duplicateNames: string[];
  collapsedCount: number;
} {
  const counts = new Map<string, number>();
  for (const row of covered) {
    if (row.unmapped || row.skipped) {
      continue;
    }
    counts.set(row.header, (counts.get(row.header) ?? 0) + 1);
  }
  const duplicateNames: string[] = [];
  let collapsedCount = 0;
  for (const [name, count] of counts) {
    if (count > 1) {
      duplicateNames.push(name);
      collapsedCount += count - 1;
    }
  }
  return { duplicateNames, collapsedCount };
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
  const sentences: string[] = [];
  if (unmappedCount === 0) {
    sentences.push(`Names all ${columnCount} columns.`);
  } else {
    const firstUnmapped = rows.find((row) => row.unmapped);
    // The example name is the first unmapped position that is actually
    // RENDERED; with a very short display cap there may be none, in which case
    // the count stands on its own rather than naming a row the operator cannot
    // see. It is the name the APPLY will use too - see applicableHeaders.
    const example =
      firstUnmapped === undefined ? "" : ` (${firstUnmapped.header} and so on)`;
    sentences.push(
      `Names ${mappedCount} of ${columnCount} columns - ${unmappedCount} still unmapped${example}.`,
    );
  }
  // THE CORRECTION, and the reason it is appended rather than folded in: the
  // sentence above counts columns that carry a NAME, which is not the same as
  // columns that survive. Two columns named `src` are both "named" and one of
  // them is about to be overwritten, so "Names all 38 columns" over-stated the
  // result by exactly collapsedCount. Saying the surviving number out loud is
  // what stops it over-claiming.
  const duplicates = duplicateSentence(preview);
  if (duplicates !== "") {
    sentences.push(duplicates);
  }
  return sentences.join(" ");
}

/**
 * The duplicate-name warning, or "" when there is none. Shared by every input
 * path because it hangs off {@link buildFieldPreview}: the pasted header row and
 * the pasted feed config used to run no duplicate check at all, so a header row
 * repeating a name lost a column silently while the coverage line reported full
 * coverage. Only the interactive mapper warned, which made the same mistake
 * catchable in one tab and invisible in the other two.
 */
export function duplicateSentence(preview: FieldDefinitionPreview): string {
  const { duplicateNames, collapsedCount, columnCount } = preview;
  if (collapsedCount === 0) {
    return "";
  }
  return (
    `Duplicate name${duplicateNames.length === 1 ? "" : "s"}: ` +
    `${duplicateNames.join(", ")} - each keeps only the last column that uses ` +
    `it, so only ${columnCount - collapsedCount} of the ${columnCount} columns ` +
    `reach the sample.`
  );
}

/**
 * The mismatch warning, or "" when the counts agree.
 *
 * IT STATES THE CLAUSE THAT APPLIES, not both. The warning used to read
 * "Surplus values spill to _extra_N; extra headers stay unmapped" for every
 * mismatch, but a given mismatch has a DIRECTION and only one half can ever be
 * true of it - so half the sentence was always describing something that was
 * not happening, and (until applicableHeaders) the half that was describing
 * this app's behaviour was the wrong one anyway.
 */
export function mismatchLine(mismatch: CsvMismatch): string {
  if (!mismatch.mismatch) {
    return "";
  }
  const { headerCount, columnCount } = mismatch;
  const counts = `Header count ${headerCount} differs from CSV columns ${columnCount}.`;
  const tail = "Apply anyway or correct the header set.";
  if (headerCount < columnCount) {
    const short = columnCount - headerCount;
    return (
      `${counts} The last ${short} column${short === 1 ? "" : "s"} stay${short === 1 ? "s" : ""} ` +
      `unnamed (${positionalFieldName(headerCount)} and so on) - no values are ` +
      `lost. ${tail}`
    );
  }
  const extra = headerCount - columnCount;
  return (
    `${counts} The last ${extra} name${extra === 1 ? "" : "s"} ` +
    `map${extra === 1 ? "s" : ""} nothing - this data has no column there. ${tail}`
  );
}

/**
 * Derive the header-count-vs-column-count mismatch. Only a warning when headers
 * exist: with no headers yet there is nothing to compare, so `mismatch` is
 * false. A mismatch does not block Apply - a short header set leaves the rest of
 * the columns unnamed and a long one has names that map nothing, and neither
 * loses data ({@link applicableHeaders}). It is surfaced so the operator can
 * catch a wrong header set first; {@link mismatchLine} says which of the two
 * this one is.
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
 * WHAT IT APPLIES IS {@link applicableHeaders}, NOT `headers` VERBATIM, and that
 * is the whole of the fix: the array the preview rendered is the array the core
 * parser is handed, so an unnamed position lands as the `_12` it was shown as
 * and the sample stays recognisable to isHeaderlessCsv - resumable later
 * instead of terminal. It used to pass `headers` through, which parked every
 * surplus value at `_extra_12` and stranded a half-finished definition with no
 * route back to the dialog. See {@link applicableHeaders} for what that traded
 * away and why the trade is worth making.
 *
 * The mismatch warning still survives alongside the coverage count instead of
 * being folded into it - it says the header set is the wrong SIZE for this
 * data, which coverage does not.
 */
export function resolveHeaders(
  item: CsvResolutionItem,
  headers: readonly string[],
  skipFirstRow = false,
): TaggedSample {
  const parsed = parseCsvWithHeaders(
    item.csvContent,
    applicableHeaders(headers, item.columnCount),
    {
      skipFirstRow,
      sourceName: item.sourceName,
    },
  );
  return buildTaggedSample(normalizeLogType(item.logType), parsed);
}
