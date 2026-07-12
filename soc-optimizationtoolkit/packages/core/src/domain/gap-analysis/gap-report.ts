/**
 * Gap REPORT - the TYPED RESULT OBJECT that replaces the legacy .txt side files
 * (porting-plan Unit 18 task item 5). The legacy runDcrGapAnalysis wrote
 * `DCR_GAP_ANALYSIS_<table>.txt` into the pack directory (and shipped it inside
 * every .crbl). This module produces a typed object instead: the UI renders it,
 * and the shell can export it via ArtifactSink - no filesystem, no bytes baked
 * into packs.
 *
 * THE SIX STAT TILES (docs/legacy-flow-analysis.md line 23 - "domain gold, keep
 * it verbatim"): Source Fields / Dest Columns / Passthrough / DCR Handles /
 * Cribl Handles / Overflow, plus the "Cribl handles: N rename(s), M
 * coercion(s)" and "DCR handles: ..." summary strings. The tiles are FIELDS on
 * this result, each carrying its verbatim InfoTip domain text.
 *
 * DUAL-ENGINE COMPOSITION (Unit 18 contract): the tiles blend the two engines
 * exactly as the legacy analyze-samples handler did -
 *   - Source Fields / Dest Columns / Passthrough / Cribl Handles / Overflow come
 *     from the FIELD MATCHER's MatchResult (Unit 13) - the alias/fuzzy-aware,
 *     user-facing truth.
 *   - DCR Handles comes from the GAP ANALYSIS DcrGapAnalysis (this unit) - the
 *     DCR-side count of transforms Cribl must not duplicate.
 * The matcher, NOT the exact-name gap partitioner, drives the reviewer-facing
 * counts (the legacy comment: "Derive summary counts from the field matcher ...
 * rather than from analyzeDcrGap which only does exact name matching and misses
 * aliases like src->SourceIP").
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type {
  FieldMatch,
  MatchAction,
  MatchConfidence,
  MatchResult,
} from "../field-matcher/models";
import { triageOverflow } from "../field-matcher/overflow-triage";
import type { OverflowTriage } from "../field-matcher/overflow-triage";
import {
  COLLISION_PRONE_INTERNAL_FIELDS,
  internalCollisionWarning,
} from "./analyze-dcr-gap";
import type { DcrGapAnalysis, FieldRef } from "./models";

/** Stable id for each of the six stat tiles (also its render key). */
export type GapStatKey =
  | "source-fields"
  | "dest-columns"
  | "passthrough"
  | "dcr-handles"
  | "cribl-handles"
  | "overflow";

/** A stat tile's visual emphasis. */
export type GapStatTone = "neutral" | "ok" | "info" | "warn";

/** One of the six gap-analysis stat tiles. */
export interface GapReportStat {
  key: GapStatKey;
  /** The VERBATIM legacy stat word. */
  label: string;
  value: number;
  /** VERBATIM InfoTip domain text (the point-of-decision help). */
  hint: string;
  tone: GapStatTone;
}

/** One editable field-mapping row (matched or overflow), legacy shape. */
export interface GapFieldMapping {
  source: string;
  dest: string;
  sourceType: string;
  destType: string;
  confidence: MatchConfidence;
  action: MatchAction;
  needsCoercion: boolean;
  description: string;
  sampleValue?: string;
}

/** The full typed gap-analysis result for ONE table. */
export interface GapReport {
  tableName: string;
  logType: string;
  /** The six stat tiles, in canonical order. */
  stats: GapReportStat[];
  // The tile values, also flat for convenience / export.
  sourceFieldCount: number;
  destFieldCount: number;
  passthroughCount: number;
  dcrHandledCount: number;
  criblHandledCount: number;
  overflowCount: number;
  /** DCR-side renames (the DCR does these; Cribl must not duplicate). */
  dcrRenames: Array<{ source: string; dest: string }>;
  /** DCR-side coercions. */
  dcrCoercions: Array<{ field: string; toType: string }>;
  /** Cribl-side renames the pipeline performs. */
  criblRenames: Array<{ source: string; dest: string; reason: string }>;
  /** Cribl-side coercions the pipeline performs. */
  criblCoercions: Array<{ field: string; fromType: string; toType: string }>;
  /** "DCR handles: N rename(s), M coercion(s)". */
  dcrHandlesSummary: string;
  /** "Cribl handles: N rename(s), M coercion(s)". */
  criblHandlesSummary: string;
  /** The mirrored Cribl route condition for this table. */
  routeCondition: string;
  /** matched + overflow rows, the editable mapping table's data. */
  fieldMappings: GapFieldMapping[];
  /** The resolved destination schema (the dest-column dropdown's options). */
  destSchema: FieldRef[];
  /**
   * True when fields would overflow but the table's catch-all column is absent
   * (the AdditionalData_d-missing case) - overflow is lossy.
   */
  overflowLossy: boolean;
  /**
   * UNMAPPABLE vs MISSED: every overflow field triaged against every
   * destination column (no-equivalent / outranked / reviewable).
   */
  overflowTriage: OverflowTriage;
  /** Combined matcher + gap warnings (incl. the data-loss footgun). */
  warnings: string[];
}

// VERBATIM InfoTip domain text from the legacy SentinelIntegration.tsx tiles.
const HINT_SOURCE_FIELDS =
  "Total unique fields discovered in your sample data for this table.";
const HINT_DEST_COLUMNS =
  "Total columns defined in the Sentinel destination table schema " +
  "(e.g., CommonSecurityLog has 80+ columns).";
const HINT_PASSTHROUGH =
  "Fields that match both name and type exactly -- no transformation needed. " +
  "These flow directly through the DCR.";
const HINT_DCR_HANDLES =
  "Fields that the Azure Data Collection Rule transforms (renames or type " +
  "coercions). These are handled server-side by Azure, not by Cribl.";
const HINT_CRIBL_HANDLES =
  "Fields that require Cribl pipeline transformation -- renames or type " +
  "coercions that the DCR does not cover. These are the fields the generated " +
  "pack pipeline will process.";
const HINT_OVERFLOW =
  "Source fields with no matching destination column. These are collected into " +
  "an overflow field (e.g., AdditionalExtensions for CommonSecurityLog) as " +
  "key=value pairs so no data is lost.";

function mappingFromMatch(match: FieldMatch): GapFieldMapping {
  const mapping: GapFieldMapping = {
    source: match.sourceName,
    dest: match.destName,
    sourceType: match.sourceType,
    destType: match.destType,
    confidence: match.confidence,
    action: match.action,
    needsCoercion: match.needsCoercion,
    description: match.description,
  };
  if (match.sampleValue !== undefined) mapping.sampleValue = match.sampleValue;
  return mapping;
}

function mappingFromOverflow(match: FieldMatch): GapFieldMapping {
  const mapping: GapFieldMapping = {
    source: match.sourceName,
    dest: match.destName,
    sourceType: match.sourceType,
    destType: match.destType,
    confidence: "unmatched",
    action: "overflow",
    needsCoercion: false,
    description: "Collected into overflow field",
  };
  if (match.sampleValue !== undefined) mapping.sampleValue = match.sampleValue;
  return mapping;
}

/** Inputs for {@link buildGapReport}. */
export interface BuildGapReportInput {
  tableName: string;
  logType: string;
  /** The field matcher's result (owns the user-facing counts). */
  matchResult: MatchResult;
  /** The DCR-side partitioning (owns the DCR Handles count + dcr renames/coercions). */
  gap: DcrGapAnalysis;
  /** The mirrored Cribl route condition (default "true"). */
  routeCondition?: string;
  /** The resolved destination schema for the dest-column dropdown. */
  destSchema: FieldRef[];
}

/**
 * Compose a {@link MatchResult} (user-facing) and a {@link DcrGapAnalysis}
 * (DCR-side) into the typed six-tile gap report. The count derivation mirrors
 * the legacy analyze-samples handler exactly, so the numbers a reviewer sees
 * are unchanged.
 */
export function buildGapReport(input: BuildGapReportInput): GapReport {
  const { matchResult, gap } = input;

  // User-facing counts from the matcher (alias/fuzzy-aware).
  const passthroughCount = matchResult.matched.filter(
    (m) => m.action === "keep" && !m.needsCoercion,
  ).length;
  const renameCount = matchResult.matched.filter(
    (m) => m.action === "rename",
  ).length;
  const coerceCount = matchResult.matched.filter(
    (m) => m.action === "coerce" || (m.action === "keep" && m.needsCoercion),
  ).length;
  const overflowCount = matchResult.overflow.length;
  const criblHandledCount = renameCount + coerceCount;

  const criblRenames = matchResult.matched
    .filter((m) => m.action === "rename")
    .map((m) => ({ source: m.sourceName, dest: m.destName, reason: m.description }));
  const criblCoercions = matchResult.matched
    .filter((m) => m.needsCoercion)
    .map((m) => ({ field: m.destName, fromType: m.sourceType, toType: m.destType }));

  const dcrRenames = gap.dcrHandles.renames.map((r) => ({ ...r }));
  const dcrCoercions = gap.dcrHandles.coercions.map((c) => ({ ...c }));

  const fieldMappings: GapFieldMapping[] = [
    ...matchResult.matched.map(mappingFromMatch),
    ...matchResult.overflow.map(mappingFromOverflow),
  ];

  const overflowLossy =
    matchResult.overflow.length > 0 && !matchResult.overflowConfig.enabled;

  const overflowTriage = triageOverflow(
    matchResult,
    input.destSchema,
    input.tableName,
  );

  const stats: GapReportStat[] = [
    {
      key: "source-fields",
      label: "Source Fields",
      value: matchResult.totalSource,
      hint: HINT_SOURCE_FIELDS,
      tone: "neutral",
    },
    {
      key: "dest-columns",
      label: "Dest Columns",
      value: matchResult.totalDest,
      hint: HINT_DEST_COLUMNS,
      tone: "neutral",
    },
    {
      key: "passthrough",
      label: "Passthrough",
      value: passthroughCount,
      hint: HINT_PASSTHROUGH,
      tone: passthroughCount > 0 ? "ok" : "neutral",
    },
    {
      key: "dcr-handles",
      label: "DCR Handles",
      value: gap.dcrHandledCount,
      hint: HINT_DCR_HANDLES,
      tone: gap.dcrHandledCount > 0 ? "info" : "neutral",
    },
    {
      key: "cribl-handles",
      label: "Cribl Handles",
      value: criblHandledCount,
      hint: HINT_CRIBL_HANDLES,
      tone: criblHandledCount > 0 ? "info" : "neutral",
    },
    {
      key: "overflow",
      label: "Overflow",
      value: overflowCount,
      hint: HINT_OVERFLOW,
      tone: overflowCount > 0 ? "warn" : "neutral",
    },
  ];

  // A collision-prone internal name (host/source/port...) the MATCHER claimed
  // is renamed in the enrich group BEFORE the cleanup drop, so the vendor
  // value survives - the gap engine's data-loss warning would be a false
  // alarm. Resolve it into the informational note instead (keyed on the exact
  // warning text, which internalCollisionWarning is the only producer of).
  const resolvedCollisions = new Map(
    matchResult.matched
      .filter(
        (m) =>
          m.destName !== "" &&
          COLLISION_PRONE_INTERNAL_FIELDS.has(m.sourceName),
      )
      .map((m) => [
        internalCollisionWarning(m.sourceName),
        `Source field "${m.sourceName}" shares a Cribl-internal field name, ` +
          `but the pipeline maps it to ${m.destName} before the internal ` +
          `cleanup, so the vendor value is preserved.`,
      ]),
  );

  // Combined warnings: gap-side (data-loss footgun) then matcher-side
  // (AdditionalData_d-missing), de-duplicated while preserving order.
  const warnings: string[] = [];
  for (const w of [...gap.warnings, ...matchResult.warnings]) {
    const resolved = resolvedCollisions.get(w) ?? w;
    if (!warnings.includes(resolved)) warnings.push(resolved);
  }

  return {
    tableName: input.tableName,
    logType: input.logType,
    stats,
    sourceFieldCount: matchResult.totalSource,
    destFieldCount: matchResult.totalDest,
    passthroughCount,
    dcrHandledCount: gap.dcrHandledCount,
    criblHandledCount,
    overflowCount,
    dcrRenames,
    dcrCoercions,
    criblRenames,
    criblCoercions,
    dcrHandlesSummary: `DCR handles: ${dcrRenames.length} rename(s), ${dcrCoercions.length} coercion(s)`,
    criblHandlesSummary: `Cribl handles: ${criblRenames.length} rename(s), ${criblCoercions.length} coercion(s)`,
    routeCondition: input.routeCondition ?? "true",
    fieldMappings,
    destSchema: input.destSchema.map((c) => ({ ...c })),
    overflowLossy,
    overflowTriage,
    warnings,
  };
}
