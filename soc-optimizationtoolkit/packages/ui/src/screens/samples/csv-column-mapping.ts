/**
 * Pure decision logic for the INTERACTIVE column-mapping tab of the CSV
 * header-resolution dialog (vendor-field-definition-plan "Gap 2").
 *
 * WHY A THIRD INPUT PATH EXISTS. The dialog's other two tabs both assume the
 * operator HAS an artifact - a header row to paste, or a vendor output config
 * (Zscaler NSS, PAN-OS syslog profile, FortiGate, Cloudflare Logpush,
 * CrowdStrike) for core parseFeedConfig to read. When they have neither there
 * was no path at all, and "no path at all" is the common case for the six
 * PAN-OS log types the live lake carries with no recorded column order.
 *
 * THE DESIGN POINT: the EXAMPLE VALUES are the affordance, not decoration.
 * Naming a column labelled `_7` is guesswork. Naming the column that reads
 * `192.168.0.2` is not. So {@link buildColumnMappingRows} puts each position's
 * real values from the operator's own sample right beside the input box for
 * that position, and it shows SEVERAL rows' worth rather than one, because one
 * value is often ambiguous: a lone `0` says nothing, while `0, 0, 1, 0` sitting
 * next to `443, 80, 443, 22` identifies both columns at a glance. The values
 * are kept in ROW ORDER, repeats and blanks included - deliberately unlike
 * core's DiscoveredField.examples (distinct, non-empty), because here the
 * repetition IS the signal and the shared row order lets a reader scan one
 * record across positions.
 *
 * NEVER INVENT A NAME. Nothing here infers a name from a value's shape. A
 * position the operator has not named keeps the core positionalFieldName - it
 * stays `_7`, it is counted as unmapped, and it is rendered as unmapped. A
 * confident wrong name is worse than an obvious blank, and an operator who
 * names 6 of 38 columns must get 6 named columns and 32 still positional, not
 * an error and not a refusal to apply.
 *
 * VALIDATION IS BORROWED, NOT INVENTED. Names go through the shared
 * {@link sanitizeColumnName} - the same cleaning the pasted-header-row path
 * applies - and the duplicate/short-header consequences reported here are the
 * ones core parseCsvWithHeaders actually produces, not new rules of our own.
 * Since 2026-08-26 the duplicate SENTENCE is borrowed too: this tab still marks
 * the offending inputs row by row (only it has inputs to mark), but the summary
 * warning is csv-resolution-state's duplicateSentence, on the shared preview,
 * so the two pasted tabs inherit a check they never had.
 *
 * IT DOES NOT GROW ITS OWN PREVIEW. {@link resolvedColumnNames} is the single
 * seam to the rest of the dialog: one name per position, positional where
 * unnamed. That array is what Apply hands to core parseCsvWithHeaders AND what
 * the SHARED live-preview surface in csv-resolution-state renders, so this tab,
 * the pasted header row and the pasted feed config all confirm their work
 * through the same eyes. The per-position example values below are the INPUT
 * affordance - the values you name a box by - not a second preview of the
 * result.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto, no Math.random.
 */

import { isPositionalFieldName, positionalFieldName } from "@soc/core";
import { sanitizeColumnName, splitCsvRow } from "./csv-resolution-state";
import type {
  CsvResolutionItem,
  DefinitionSource,
} from "./csv-resolution-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What the mapper needs from a {@link CsvResolutionItem}: how many positions
 * there are, and some real rows to draw example values from. Narrowed so the
 * rules can be exercised against a literal without building a tagged sample.
 */
export type MappableItem = Pick<CsvResolutionItem, "columnCount" | "firstRows">;

/**
 * The operator's in-progress names, keyed by 0-based column index. SPARSE on
 * purpose: an absent key means "this position has not been named", which is the
 * legitimate resting state for most positions in a partial definition.
 */
export type ColumnDrafts = Readonly<Record<number, string>>;

/** The starting point: nothing named. */
export const EMPTY_COLUMN_DRAFTS: ColumnDrafts = Object.freeze({});

/** One column position as the mapper grid renders it. */
export interface ColumnMappingRow {
  /** 0-based position in the CSV row. */
  index: number;
  /** What this column is called while unnamed - core {@link positionalFieldName}. */
  positionalName: string;
  /** Exactly what the operator typed, unmodified, for the input's value. */
  draft: string;
  /**
   * The cleaned name this position will resolve to, or "" when the position is
   * still unmapped (never typed in, or typed something that sanitized away).
   */
  name: string;
  /**
   * The real values at this position across the sample's first rows, in row
   * order. "" for a row that had no value at this position - kept rather than
   * dropped, because "this column is usually blank" is itself worth seeing.
   */
  examples: string[];
  /** True once this position has a usable name. */
  mapped: boolean;
  /**
   * True when the operator typed something that did not survive sanitizing
   * (`"!!!"`, `"___"`). The position stays unmapped; the UI says so rather than
   * quietly accepting the keystrokes.
   */
  invalid: boolean;
  /**
   * True when this position's name is also used by another mapped position.
   * core parseCsvWithHeaders assigns by name, so duplicates COLLAPSE - the last
   * position with the name wins and the earlier column's values are lost.
   */
  duplicate: boolean;
}

/** The counted state of a mapping, for the progress line and the warnings. */
export interface ColumnMappingSummary {
  /** How many positions have a usable name. */
  namedCount: number;
  /** How many positions are still positional. namedCount + unnamedCount === totalCount. */
  unnamedCount: number;
  /** How many positions the CSV has. */
  totalCount: number;
  /** Names used by more than one position, in first-seen order. */
  duplicateNames: string[];
  /** Positions whose typed text sanitized away to nothing, ascending. */
  invalidPositions: number[];
  /**
   * True when there is at least one name to apply. A mapping with nothing named
   * resolves to exactly the sample that is already stored, so applying it is
   * indistinguishable from Skip - the dialog keeps Apply disabled until here.
   */
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Draft edits (pure updaters)
// ---------------------------------------------------------------------------

/**
 * Record what the operator typed at `index`. Clearing an input REMOVES the key
 * rather than storing "", so an emptied cell returns the position to genuinely
 * unmapped and it round-trips as positional - the same state it was in before
 * anyone touched it.
 */
export function setColumnDraft(
  drafts: ColumnDrafts,
  index: number,
  text: string,
): ColumnDrafts {
  const next: Record<number, string> = { ...drafts };
  if (text === "") {
    delete next[index];
  } else {
    next[index] = text;
  }
  return next;
}

/** Drop every name, returning the mapping to fully positional. */
export function clearColumnDrafts(): ColumnDrafts {
  return EMPTY_COLUMN_DRAFTS;
}

// ---------------------------------------------------------------------------
// Example values
// ---------------------------------------------------------------------------

/**
 * The real values at column `index` across `rows`, in row order. Each row is
 * split the SAME way core parseCsvWithHeaders will split it (shared
 * {@link splitCsvRow}), so what the operator names is what the apply will
 * actually key - including the shared naive-comma-split limitation, which is
 * better seen here than discovered after applying.
 */
export function columnExamples(
  rows: readonly string[],
  index: number,
): string[] {
  return rows.map((row) => splitCsvRow(row)[index] ?? "");
}

// ---------------------------------------------------------------------------
// Row derivation
// ---------------------------------------------------------------------------

/**
 * The operator's typed name for a position, or "" when they have not named it.
 *
 * A NAME THAT IS THE POSITIONAL TOKEN MEANS UNNAMED, which is the only reading
 * that is both honest and safe. `sanitizeColumnName` deliberately preserves an
 * exact `_N` token, because a saved partial definition round-trips through the
 * pasted-header textarea carrying placeholders for the positions nobody named -
 * and stripping the underscore there turned those placeholders into real names,
 * so reopening a half-finished definition claimed every column was named.
 *
 * That preservation is right for the round trip and wrong for a person typing,
 * so the collision guard lives HERE, where the text really is operator input:
 * typing `_5` cannot mint a name the shared preview would then have to decide
 * was unmapped. It reads as "leave this one alone", which is what it looks like.
 */
function operatorName(draft: string): string {
  const name = sanitizeColumnName(draft);
  return isPositionalFieldName(name) ? "" : name;
}

/**
 * Project the item plus the operator's drafts into one row per column position.
 * Always `item.columnCount` rows: every position is offered a name, and the
 * ones without a name are visible as unmapped rather than hidden.
 */
export function buildColumnMappingRows(
  item: MappableItem,
  drafts: ColumnDrafts,
): ColumnMappingRow[] {
  const names = new Map<string, number>();
  for (let i = 0; i < item.columnCount; i += 1) {
    const name = operatorName(drafts[i] ?? "");
    if (name !== "") {
      names.set(name, (names.get(name) ?? 0) + 1);
    }
  }

  const rows: ColumnMappingRow[] = [];
  for (let i = 0; i < item.columnCount; i += 1) {
    const draft = drafts[i] ?? "";
    const name = operatorName(draft);
    rows.push({
      index: i,
      positionalName: positionalFieldName(i),
      draft,
      name,
      examples: columnExamples(item.firstRows, i),
      mapped: name !== "",
      invalid: draft.trim() !== "" && name === "",
      duplicate: name !== "" && (names.get(name) ?? 0) > 1,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Resolved names + summary
// ---------------------------------------------------------------------------

/**
 * The header list to hand to core parseCsvWithHeaders: the operator's name at
 * every mapped position, and the core {@link positionalFieldName} at every one
 * they left alone.
 *
 * THE POSITIONAL FILL-IN IS LOAD-BEARING, not tidiness. parseCsvWithHeaders
 * DISCARDS the value under an empty header name, so handing it "" for the
 * positions nobody named would delete those columns from the sample - a partial
 * definition would silently destroy the data it did not describe. Naming them
 * `_7` keeps the value, keeps the position addressable, and keeps the re-parsed
 * sample recognisable to isHeaderlessCsv so it can be resolved again later.
 *
 * Always length `item.columnCount`, so this path never triggers the
 * header-count mismatch warning - there is one name per column by construction.
 *
 * It is also the array the shared live preview reads, which is why "is this
 * position named?" must be answered from the NAME (core isPositionalFieldName)
 * rather than from the array's length: every position is present here whether
 * or not anyone has named it.
 */
export function resolvedColumnNames(
  rows: readonly ColumnMappingRow[],
): string[] {
  return rows.map((row) => (row.mapped ? row.name : row.positionalName));
}

/** Count the mapping and collect the problems worth showing. */
export function deriveColumnMappingSummary(
  rows: readonly ColumnMappingRow[],
): ColumnMappingSummary {
  const duplicateNames: string[] = [];
  const invalidPositions: number[] = [];
  let namedCount = 0;

  for (const row of rows) {
    if (row.mapped) {
      namedCount += 1;
      if (row.duplicate && !duplicateNames.includes(row.name)) {
        duplicateNames.push(row.name);
      }
    }
    if (row.invalid) {
      invalidPositions.push(row.index);
    }
  }

  return {
    namedCount,
    unnamedCount: rows.length - namedCount,
    totalCount: rows.length,
    duplicateNames,
    invalidPositions,
    ready: namedCount > 0,
  };
}

/**
 * The progress caption - "6 of 38 columns named, 32 stay positional". The plan's
 * requirement in one sentence: a definition that covers 6 of 38 columns has to
 * LOOK like it covers 6 of 38.
 */
export function columnMappingProgressLabel(
  summary: ColumnMappingSummary,
): string {
  if (summary.namedCount === 0) {
    return `No columns named yet - all ${summary.totalCount} stay positional (_0, _1, ...).`;
  }
  return `${summary.namedCount} of ${summary.totalCount} columns named, ${summary.unnamedCount} stay positional.`;
}

// ---------------------------------------------------------------------------
// The seam: this tab as one more supplier of a definition
// ---------------------------------------------------------------------------

/**
 * Present the current mapping as a {@link DefinitionSource}, the same shape the
 * pasted-header-row and pasted-feed-config tabs return. That is what lets the
 * dialog render all three through ONE live preview without branching on where
 * the names came from - this tab adds an input path, not a second preview.
 *
 * `headers` is EMPTY until at least one column is named. A mapping that names
 * nothing resolves to exactly the sample already in the store, so offering Apply
 * for it would offer a no-op dressed as a decision; the dialog keeps Apply
 * disabled while `headers` is empty, exactly as it does for an empty textarea.
 * Once anything IS named, the array is full-length with positional names parked
 * at the untouched positions - never blanks, which the core parser would read as
 * "discard this column".
 */
export function mapperDefinitionSource(
  item: MappableItem,
  drafts: ColumnDrafts,
): DefinitionSource {
  const rows = buildColumnMappingRows(item, drafts);
  const summary = deriveColumnMappingSummary(rows);
  const problems: string[] = [];
  // NO DUPLICATE SENTENCE HERE ANY MORE. It moved to buildFieldPreview's
  // duplicateSentence, on the SHARED preview surface, because a repeated name
  // is a fact about the definition rather than about the tab that typed it -
  // and the two pasted tabs, which ran no duplicate check at all, needed it
  // more than this one did. Row-level marking (ColumnMappingRow.duplicate,
  // rendered against the offending inputs) stays here where the inputs are:
  // that is the part only this tab can do. What used to be said twice inside
  // this tab is now said once, on the surface every tab reads.
  if (summary.invalidPositions.length > 0) {
    problems.push(
      `Unusable name${summary.invalidPositions.length === 1 ? "" : "s"} at ${summary.invalidPositions.map(positionalFieldName).join(", ")} - those columns stay unmapped.`,
    );
  }
  return {
    tab: "map",
    headers: summary.ready ? resolvedColumnNames(rows) : [],
    label: summary.ready
      ? [columnMappingProgressLabel(summary), ...problems].join(" ")
      : problems.join(" "),
    hasInput: summary.namedCount > 0 || summary.invalidPositions.length > 0,
  };
}
