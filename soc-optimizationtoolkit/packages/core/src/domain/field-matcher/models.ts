/**
 * field-matcher domain MODELS - porting-plan Unit 13 (ENG-04/03).
 *
 * Ported VERBATIM from legacy field-matcher.ts (the type block, lines 23-65).
 * These shapes ARE the contract downstream pipeline generation (Unit 17) and
 * gap analysis (Unit 18) consume, so they are pinned, not "improved".
 *
 * ONE addition vs legacy: MatchResult.warnings (see the AdditionalData_d note
 * on overflowConfig). Legacy silently dropped overflow data when the overflow
 * column was absent from the schema; the warning surfaces that (fix + pin).
 *
 * Pure data: no IO, no fetch, no React, no Date/crypto.
 */

/** A source field discovered from sample data or vendor logs. */
export interface SourceField {
  name: string;
  type: string;
  sampleValue?: string;
}

/** A destination column of the resolved DCR/table schema. */
export interface DestField {
  name: string;
  type: string;
}

/** How confident the matcher is in a single field match. */
export type MatchConfidence = "exact" | "alias" | "fuzzy" | "unmatched";

/**
 * What the pipeline should do with a matched field. "decode" (2026-07-09):
 * the source carries the destination's data base64-ENCODED (e.g. Zscaler
 * b64url); the pipeline decodes it into the destination column - a plain
 * rename would put base64 text where rules expect decoded content.
 */
export type MatchAction =
  | "rename"
  | "keep"
  | "coerce"
  | "drop"
  | "overflow"
  | "decode";

/** One source field's resolution against the destination schema. */
export interface FieldMatch {
  sourceName: string;
  sourceType: string;
  destName: string;
  destType: string;
  confidence: MatchConfidence;
  action: MatchAction;
  /** sourceType != destType. */
  needsCoercion: boolean;
  /** Why this match was chosen. */
  description: string;
  sampleValue?: string;
}

/** How unmatched source fields are collected into a catch-all column. */
export interface OverflowConfig {
  enabled: boolean;
  /** Destination field to collect overflow into (e.g. "AdditionalExtensions"). */
  fieldName: string;
  /** dynamic = JSON object, string = key=value pairs. */
  fieldType: "dynamic" | "string";
  /** Source field names routed into overflow. */
  sourceFields: string[];
}

/** The full result of matching a source field set to a destination schema. */
export interface MatchResult {
  /** Source fields matched to a dedicated dest field. */
  matched: FieldMatch[];
  /** Source fields collected into the overflow field. */
  overflow: FieldMatch[];
  /** Source fields with no match and no overflow (dropped). */
  unmatchedSource: SourceField[];
  /** Dest fields with no source match. */
  unmatchedDest: DestField[];
  overflowConfig: OverflowConfig;
  totalSource: number;
  totalDest: number;
  /** 0-1, fraction of source fields matched or overflowed. */
  matchRate: number;
  /**
   * Non-fatal problems surfaced to the user. Empty on a clean match. The
   * load-bearing case: an overflow column named by the table's overflow config
   * is ABSENT from the resolved schema, so overflow fields cannot be preserved
   * (legacy dropped them silently). See match-fields.
   */
  warnings: string[];
}
