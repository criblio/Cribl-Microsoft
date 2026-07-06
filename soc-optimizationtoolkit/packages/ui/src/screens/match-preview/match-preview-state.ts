/**
 * Match-preview state - the PURE projection behind the minimal match-preview
 * view (porting-plan Unit 13 UI, ENG-04/05/03: "minimal match-preview view
 * (sample vs table -> matched/overflow/unmatched counts) as the seed of the
 * Unit 18 review screen"). Kept out of the component so the stat derivation,
 * per-field row projection, and warning surfacing are unit-testable without a
 * DOM.
 *
 * @soc/core's field matcher owns EVERY truth decision: name normalization,
 * the 6-phase scoring, the overflow routing, and the AdditionalData_d-missing
 * warning (all in domain/field-matcher). This module only PROJECTS the
 * resulting MatchResult into display shapes - it invents no counts and it
 * never re-derives a warning the core did not report (the task's "surface the
 * AdditionalData_d-missing WARNING honestly WHEN the core reports it").
 *
 * VOCABULARY: the legacy gap-analysis stat words where they apply
 * (docs/legacy-flow-analysis.md line 23: Source Fields / Dest Columns /
 * Passthrough / Overflow), kept minimal. The full six-tile crown jewel
 * (Passthrough / DCR Handles / Cribl Handles / Overflow ...) lands in Unit 18.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto, no Math.random.
 */

import type {
  FieldMatch,
  MatchAction,
  MatchConfidence,
  MatchResult,
  SourceField,
} from "@soc/core";

// ---------------------------------------------------------------------------
// Stat cards: the minimal count vocabulary
// ---------------------------------------------------------------------------

/** Stable identity for each stat card (also its render key). */
export type MatchStatKey =
  | "source-fields"
  | "dest-columns"
  | "passthrough"
  | "overflow"
  | "unmatched";

/** A stat card's visual emphasis (tint), derived from the counts. */
export type MatchStatTone = "neutral" | "ok" | "warn";

/** One stat card of the match-preview header. */
export interface MatchPreviewStat {
  key: MatchStatKey;
  /** The legacy stat word (Source Fields / Dest Columns / Passthrough / ...). */
  label: string;
  value: number;
  /** Point-of-decision help, one honest sentence. */
  hint: string;
  tone: MatchStatTone;
}

/**
 * Whether the fields routed to overflow will actually be preserved. Overflow
 * is only enabled when the table's catch-all column exists in the resolved
 * schema; when overflow fields exist but the column is absent, the core
 * reports the loss (and this flags the Overflow tile warn).
 */
function overflowIsLossy(result: MatchResult): boolean {
  return result.overflow.length > 0 && !result.overflowConfig.enabled;
}

/**
 * Derive the minimal stat cards from a MatchResult. Passthrough == matched
 * (source fields that reached a dedicated destination column); Overflow ==
 * fields folded into the catch-all column; Unmatched == fields dropped with
 * neither. Source Fields / Dest Columns are the totals the matcher reports.
 */
export function deriveMatchStats(result: MatchResult): MatchPreviewStat[] {
  const unmatched = result.unmatchedSource.length;
  return [
    {
      key: "source-fields",
      label: "Source Fields",
      value: result.totalSource,
      hint: "Fields discovered in the tagged sample.",
      tone: "neutral",
    },
    {
      key: "dest-columns",
      label: "Dest Columns",
      value: result.totalDest,
      hint: "Columns in the resolved destination table schema.",
      tone: "neutral",
    },
    {
      key: "passthrough",
      label: "Passthrough",
      value: result.matched.length,
      hint: "Source fields matched to a dedicated destination column.",
      tone: result.matched.length > 0 ? "ok" : "neutral",
    },
    {
      key: "overflow",
      label: "Overflow",
      value: result.overflow.length,
      hint: overflowIsLossy(result)
        ? "Unmatched fields that would overflow, but the catch-all column is absent - dropped."
        : "Unmatched fields collected into the table catch-all column.",
      tone: overflowIsLossy(result) ? "warn" : "neutral",
    },
    {
      key: "unmatched",
      label: "Unmatched",
      value: unmatched,
      hint: "Fields with no column and no overflow - dropped.",
      tone: unmatched > 0 ? "warn" : "neutral",
    },
  ];
}

/** Fraction of source fields matched or overflowed, as a 0-100 integer. */
export function matchRatePercent(result: MatchResult): number {
  return Math.round(result.matchRate * 100);
}

// ---------------------------------------------------------------------------
// Per-field rows: source field -> destination column, or overflow, or dropped
// ---------------------------------------------------------------------------

/** Which bucket a preview row came from. */
export type MatchRowKind = "matched" | "overflow" | "unmatched";

/** One source field's resolution, flattened for the expandable field list. */
export interface MatchPreviewRow {
  /** Stable render key (kind + source field name). */
  key: string;
  kind: MatchRowKind;
  sourceName: string;
  sourceType: string;
  /** The destination column (matched/overflow), or null when dropped. */
  destName: string | null;
  /** The destination column type (matched/overflow), or null when dropped. */
  destType: string | null;
  confidence: MatchConfidence;
  /** The pipeline action (matched/overflow), or null when dropped. */
  action: MatchAction | null;
  needsCoercion: boolean;
  description: string;
  /** The tie-break example value the matcher carried, when present. */
  sampleValue: string | null;
}

function rowFromMatch(
  match: FieldMatch,
  kind: "matched" | "overflow",
): MatchPreviewRow {
  return {
    key: `${kind}:${match.sourceName}`,
    kind,
    sourceName: match.sourceName,
    sourceType: match.sourceType,
    destName: match.destName,
    destType: match.destType,
    confidence: match.confidence,
    action: match.action,
    needsCoercion: match.needsCoercion,
    description: match.description,
    sampleValue: match.sampleValue ?? null,
  };
}

function rowFromUnmatched(field: SourceField): MatchPreviewRow {
  return {
    key: `unmatched:${field.name}`,
    kind: "unmatched",
    sourceName: field.name,
    sourceType: field.type,
    destName: null,
    destType: null,
    confidence: "unmatched",
    action: null,
    needsCoercion: false,
    description: "No destination column and not collected into overflow - dropped.",
    sampleValue: field.sampleValue ?? null,
  };
}

/**
 * Flatten a MatchResult into display rows in a stable, honest order: matched
 * first (already confidence-sorted by the core), then overflow, then the
 * truly-unmatched (dropped) source fields.
 */
export function deriveMatchRows(result: MatchResult): MatchPreviewRow[] {
  return [
    ...result.matched.map((match) => rowFromMatch(match, "matched")),
    ...result.overflow.map((match) => rowFromMatch(match, "overflow")),
    ...result.unmatchedSource.map(rowFromUnmatched),
  ];
}

/** A one-line route label for a row (ASCII arrow, no glyphs). */
export function formatRowRoute(row: MatchPreviewRow): string {
  if (row.kind === "unmatched") {
    return `${row.sourceName} (dropped)`;
  }
  if (row.kind === "overflow") {
    return `${row.sourceName} -> ${row.destName ?? ""} (overflow)`;
  }
  return row.sourceName === row.destName
    ? row.sourceName
    : `${row.sourceName} -> ${row.destName ?? ""}`;
}

// ---------------------------------------------------------------------------
// Warnings: surfaced honestly, classified for the component's tint
// ---------------------------------------------------------------------------

/** The kind of a surfaced warning (drives the display tint / emphasis). */
export type MatchWarningKind = "no-schema" | "overflow-loss" | "general";

/** One surfaced warning: the core's verbatim text plus a structural kind. */
export interface MatchPreviewWarning {
  key: string;
  kind: MatchWarningKind;
  /** The warning text exactly as the core reported it. */
  text: string;
}

/**
 * Classify the result's warning STRUCTURALLY (not by string matching): an
 * unresolved/empty schema yields the no-schema warning; a resolved schema
 * whose overflow column is absent yields the overflow-loss warning (the
 * AdditionalData_d-missing case). The core currently reports at most one
 * warning per result, and the structural condition uniquely determines it.
 */
function warningKind(result: MatchResult): MatchWarningKind {
  if (result.totalDest === 0) {
    return "no-schema";
  }
  if (overflowIsLossy(result)) {
    return "overflow-loss";
  }
  return "general";
}

/**
 * Surface the core's warnings verbatim as classified display warnings. Empty
 * on a clean match - this NEVER fabricates a warning the core did not report.
 */
export function deriveMatchWarnings(result: MatchResult): MatchPreviewWarning[] {
  const kind = warningKind(result);
  return result.warnings.map((text, index) => ({
    key: `match-warning-${index}`,
    kind,
    text,
  }));
}

// ---------------------------------------------------------------------------
// The composed view model + the always-visible-disabled empty state
// ---------------------------------------------------------------------------

/** Everything the match-preview component renders from one MatchResult. */
export interface MatchPreviewView {
  stats: MatchPreviewStat[];
  rows: MatchPreviewRow[];
  warnings: MatchPreviewWarning[];
  matchRatePercent: number;
  /** The table's catch-all column name (for the overflow explainer line). */
  overflowFieldName: string;
  /** Whether overflow fields are actually preserved (column present). */
  overflowEnabled: boolean;
}

/** Project a MatchResult into the full match-preview view model. */
export function deriveMatchPreview(result: MatchResult): MatchPreviewView {
  return {
    stats: deriveMatchStats(result),
    rows: deriveMatchRows(result),
    warnings: deriveMatchWarnings(result),
    matchRatePercent: matchRatePercent(result),
    overflowFieldName: result.overflowConfig.fieldName,
    overflowEnabled: result.overflowConfig.enabled,
  };
}

/** Inputs the empty-state predicate reads. */
export interface MatchPreviewInputs {
  /** At least one tagged sample is selectable. */
  hasSample: boolean;
  /** The destination table the user has chosen (may be blank). */
  tableName: string;
}

export const MATCH_PREVIEW_NO_SAMPLE_REASON =
  "Tag a sample in the section above, then choose a destination table to " +
  "preview the field match.";
export const MATCH_PREVIEW_NO_TABLE_REASON =
  "Choose a destination table to preview how the sample fields map to it.";

/**
 * The always-visible-disabled empty-state reason, or null when a preview can
 * render. Order: a sample must exist before a table choice matters (the
 * keep-list always-visible-disabled affordance, one missing thing at a time).
 */
export function matchPreviewEmptyReason(
  inputs: MatchPreviewInputs,
): string | null {
  if (!inputs.hasSample) {
    return MATCH_PREVIEW_NO_SAMPLE_REASON;
  }
  if (inputs.tableName.trim() === "") {
    return MATCH_PREVIEW_NO_TABLE_REASON;
  }
  return null;
}
