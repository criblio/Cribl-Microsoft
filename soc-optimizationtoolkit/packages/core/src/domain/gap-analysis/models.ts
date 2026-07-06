/**
 * gap-analysis domain MODELS - porting-plan Unit 18 (ENG-12).
 *
 * Ported from legacy kql-parser.ts (the type block + DcrGapAnalysis). These
 * shapes are the DCR-SIDE half of the dual-engine split this unit formalizes:
 *
 *   THE DUAL-ENGINE SPLIT (Unit 18 contract).
 *   - The FIELD MATCHER (Unit 13, domain/field-matcher) owns the USER-FACING
 *     counts: which source fields reached a dedicated destination column, which
 *     fell to overflow, which were dropped. It is the truth for Passthrough /
 *     Cribl Handles / Overflow tiles because it does the alias/fuzzy matching a
 *     human reviews.
 *   - GAP ANALYSIS (this module) owns the DCR-SIDE PARTITIONING: given a DCR's
 *     transformKql, it decides which transforms the DCR ALREADY performs
 *     (project-rename, extend toType(), the event_simpleName route) so the Cribl
 *     pipeline never DUPLICATES that work. It is the truth for the DCR Handles
 *     tile.
 *   The two engines must AGREE on the shared totals (source/dest counts) and on
 *   the overflow set; that agreement is the pinned consistency contract (the
 *   legacy test-uat-transformations TEST 8, re-expressed as a vitest spec).
 *
 * Pure data: no IO, no fetch, no React, no Date/crypto.
 */

/** A minimal name/type field reference (source field OR destination column). */
export interface FieldRef {
  name: string;
  type: string;
}

/**
 * ONE dataFlow of a Data Collection Rule, decoded from its transformKql.
 * `columns` is the DCR's declared/derived column set (renames + coercions +
 * TimeGenerated + any vendor common fields injected when the flow is
 * event_simpleName-routed).
 */
export interface DcrFlow {
  /** e.g. "Custom-CrowdStrike_Process_Events_CL". */
  outputStream: string;
  /** e.g. "CrowdStrike_Process_Events_CL" (Custom-/Microsoft- prefix stripped). */
  tableName: string;
  /** event_simpleName values that route to this table (empty for stream-routed DCRs). */
  eventSimpleNames: string[];
  /** project-rename pairs the DCR performs (Cribl must NOT duplicate). */
  renames: Array<{ dest: string; source: string }>;
  /** extend toType() coercions the DCR performs (Cribl must NOT duplicate). */
  typeConversions: Array<{ field: string; toType: string }>;
  /** The DCR's derived column set (see above). */
  columns: FieldRef[];
}

/** The result of decoding every dataFlow of one DCR document. */
export interface ParsedDcr {
  flows: DcrFlow[];
  totalEventNames: number;
  totalColumns: number;
}

/** Per-table routing + schema summary produced by {@link extractTableRouting}. */
export interface TableRoutingInfo {
  tableName: string;
  outputStream: string;
  routeCondition: string;
  eventSimpleNames: string[];
  columns: FieldRef[];
  typeConversions: Array<{ field: string; toType: string }>;
}

/** A single field's disposition in the gap analysis (kept for provenance). */
export interface GapAnalysisField {
  fieldName: string;
  sourceType: string;
  destType: string;
  action:
    | "passthrough"
    | "cribl_rename"
    | "cribl_coerce"
    | "cribl_overflow"
    | "cribl_drop"
    | "cribl_enrich";
  reason: string;
}

/**
 * The DCR-SIDE partitioning of a source field set against a destination schema
 * and a DCR dataFlow. `dcrHandles` is what the DCR already does (leave it
 * alone); `criblMustHandle` is the residual gap the pipeline covers.
 *
 * Unit 18 addition vs legacy: `warnings`. Following the Unit 13 AdditionalData_d
 * precedent (surface, do not silently drop), a source field literally named
 * "source"/"host"/"port"/etc. that collides with the Cribl-internal drop-set is
 * still dropped, but a warning is surfaced so the data loss is VISIBLE.
 */
export interface DcrGapAnalysis {
  tableName: string;
  /** What the DCR handles - Cribl must NOT touch these. */
  dcrHandles: {
    renames: Array<{ source: string; dest: string }>;
    coercions: Array<{ field: string; toType: string }>;
    routing: string;
    timeGenerated: boolean;
  };
  /** What Cribl must handle - the gaps the DCR does not cover. */
  criblMustHandle: {
    renames: Array<{ source: string; dest: string; reason: string }>;
    coercions: Array<{
      field: string;
      fromType: string;
      toType: string;
      reason: string;
    }>;
    /** Source fields not present in the destination schema. */
    overflow: Array<{ field: string; type: string }>;
    /** Cribl-internal fields removed before ingestion. */
    drops: Array<{ field: string; reason: string }>;
    /** Fields the pipeline adds (Type, and the vendor _time enrichment). */
    enrichments: Array<{ field: string; value: string }>;
  };
  totalSourceFields: number;
  totalDestFields: number;
  passthroughCount: number;
  dcrHandledCount: number;
  criblHandledCount: number;
  overflowCount: number;
  /**
   * Non-fatal problems surfaced to the user. Empty on a clean analysis. The
   * load-bearing case: a REAL vendor field whose name collides with the
   * Cribl-internal drop-set (e.g. a firewall log's literal "source"/"host"/
   * "port" field) is dropped as internal metadata - the warning makes that
   * data loss visible instead of silent. See analyze-dcr-gap.
   */
  warnings: string[];
}
