/**
 * coverage-analysis domain MODELS - porting-plan Unit 23 (ENG-11, GUI-09, plus
 * net-new workbook coverage).
 *
 * THE LOAD-BEARING ABSTRACTION (Unit 23 task item 1, the AMENDED plan block):
 * this module is the FIRST SLICE of the native-onboarding flagship's
 * content-reference analyzer. The whole engine runs over ONE generic shape - a
 * {@link ContentItem} carrying `{type, id, queries[]}` - so ALERT RULES and
 * WORKBOOKS are TWO SOURCES INTO ONE ENGINE. Hunting queries, parsers and
 * playbooks join later as additional {@link ContentItemType}s and additional
 * acquisition adapters; the analyzer itself never learns their names.
 *
 * Pure data: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

// ---------------------------------------------------------------------------
// The shared content item (the abstraction the whole engine is built on)
// ---------------------------------------------------------------------------

/**
 * The kind of Sentinel content a {@link ContentItem} came from. Only the two
 * sources Unit 23 wires are present; the union grows as the flagship analyzer
 * gains sources (hunting/parsers/playbooks). The analyzer treats every type
 * identically - the type is provenance for the UI, never a branch in the math.
 */
export type ContentItemType = "alert-rule" | "workbook";

/**
 * A single unit of Sentinel content to analyze for field coverage. This is the
 * generic shape both alertRules and workbooks reduce to before the shared
 * analyzer runs - the deliberate design center of Unit 23.
 */
export interface ContentItem {
  /** Provenance: which source produced this item. */
  type: ContentItemType;
  /** Stable id (rule `id`/name, or workbook ARM resource id). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /**
   * The KQL query text(s) this item references. Alert rules carry exactly one;
   * workbooks carry one per query step (a workbook is many queries in one
   * document). The analyzer extracts field references from each with
   * extractKqlFields and unions them.
   */
  queries: string[];
  /**
   * Non-KQL field references already extracted from the source (alert-rule
   * entity-mapping `columnName:` values, which are NOT inside the query text).
   * Empty/omitted for workbooks. Unioned into the item's referenced fields.
   */
  extraFields?: string[];
  /** Rule severity (alert-rule only): High/Medium/Low/Informational/Unknown. */
  severity?: string;
  /** MITRE tactics (alert-rule only). */
  tactics?: string[];
  /** True for a custom user-uploaded rule (drives the CUSTOM badge). */
  custom?: boolean;
  /**
   * Count of source query blocks that could NOT be parsed into usable KQL
   * (workbooks only - the buried-serializedData defensive-parse miss count).
   * 0/omitted when everything parsed. Surfaced, never silently swallowed.
   */
  unparseableQueryCount?: number;
}

// ---------------------------------------------------------------------------
// Coverage math inputs/outputs (the three-way classification)
// ---------------------------------------------------------------------------

/** Inputs to {@link analyzeContentCoverage}. */
export interface CoverageInput {
  /** The content items (rules and/or workbooks) to score. */
  items: ContentItem[];
  /**
   * The field names actually AVAILABLE (source sample fields + mapped
   * destination columns). Matched case-INSENSITIVELY; original casing here is
   * irrelevant (only presence matters).
   */
  availableFields: string[];
  /**
   * The UNION of every destination table's schema columns (from the
   * SchemaCatalog + the gap-analysis mapped destinations). A referenced field
   * present here but NOT in {@link availableFields} is "missing from the
   * reduced schema" - a real table column your reduced/mapped data does not
   * carry. A referenced field absent here is "unknown" (a computed KQL variable
   * or a different-table column the extractor could not resolve). Matched
   * case-INSENSITIVELY.
   */
  schemaUnion: string[];
}

/** The three-way disposition of one referenced field. */
export type FieldCoverageStatus =
  | "covered"
  | "missing-from-reduced-schema"
  | "unknown";

/** Per-item coverage result (one rule or one workbook). */
export interface ItemCoverage {
  type: ContentItemType;
  id: string;
  name: string;
  custom: boolean;
  severity: string;
  tactics: string[];
  /** All referenced fields, casing PRESERVED as the rule/query wrote them, sorted. */
  referencedFields: string[];
  /** Referenced fields present in the availability set (rule casing preserved). */
  covered: string[];
  /**
   * Referenced fields that ARE real destination columns (in the schema union)
   * but are NOT in the availability set - the actionable gap.
   */
  missingFromReducedSchema: string[];
  /**
   * Referenced fields that are NOT in the schema union at all - computed KQL
   * variables or other-table columns. SURFACED (Unit 13/18 precedent) instead
   * of the legacy silent drop.
   */
  unknown: string[];
  /**
   * covered / (covered + missing-from-reduced-schema). Unknowns are EXCLUDED
   * from the denominator, so this equals the legacy coverage ratio (whose
   * requiredFields were pre-filtered to schema columns). 1 when the denominator
   * is 0 (no schema-resolvable fields).
   */
  coverage: number;
  /** The item's query text(s) (for the "View KQL Query" expandable). */
  queries: string[];
  /** Workbook query blocks that could not be parsed (0 for rules). */
  unparseableQueryCount: number;
}

/** Aggregate coverage summary across the analyzed items. */
export interface CoverageSummary {
  totalItems: number;
  /** Items with coverage === 1. */
  fullyCovered: number;
  /** Items with 0 < coverage < 1. */
  partiallyCovered: number;
  /**
   * Missing-from-reduced-schema fields across all items, ranked by how many
   * items reference them (most-needed first; insertion order breaks ties).
   * Casing preserved.
   */
  missingFieldsAcrossRules: string[];
  /**
   * Every unique SCHEMA-RESOLVABLE field referenced by any item (covered union
   * missing-from-reduced-schema), sorted, casing preserved. This is the KEPT
   * Unit 18 CONTRACT that lights the RULE badges in the mapping table - it must
   * contain only real destination columns (never unknowns), so a badge only
   * ever appears on a mappable row.
   */
  ruleReferencedFields: string[];
  /** Total workbook query blocks that could not be parsed across all items. */
  unparseableQueryCount: number;
}

/** The full coverage report the UI renders. */
export interface CoverageReport {
  items: ItemCoverage[];
  summary: CoverageSummary;
}

// ---------------------------------------------------------------------------
// Parsed alert-rule (the regex extraction result, pinned)
// ---------------------------------------------------------------------------

/**
 * The parsed shape of one AnalyticRule YAML, from the PINNED regex extraction
 * (legacy sentinel-repo.ts listAnalyticRules). NOTE: this is deliberately the
 * regex extraction, NOT a real YAML parse - core purity forbids adopting a
 * YAML parser that is not itself pure, and the current behavior (including the
 * `\Z` query-terminator quirk) is characterized by fixtures before any such
 * upgrade. See parse-analytic-rule.ts for the documented upgrade path.
 */
export interface ParsedAnalyticRule {
  id: string;
  name: string;
  severity: string;
  tactics: string[];
  dataTypes: string[];
  /** The extracted KQL query body (subject to the `\Z` terminator quirk). */
  query: string;
  /** Entity-mapping `columnName:` fields, KQL-builtin names filtered out. */
  entityFields: string[];
  fileName: string;

  // --- INSTALL fields (content-enablement, 2026-07-14) - all OPTIONAL and
  // additive so the coverage path's pinned extraction is unchanged. ---
  /** Rule kind (Scheduled | NRT | ...). Absent = Scheduled by convention. */
  kind?: string;
  /** Description text (block or single-line form). */
  description?: string;
  /** Raw YAML duration (e.g. "1h", "PT1H") - converted at install time. */
  queryFrequency?: string;
  /** Raw YAML duration - converted at install time. */
  queryPeriod?: string;
  /** Raw YAML operator (gt/lt/eq/ne or the ARM spelling). */
  triggerOperator?: string;
  triggerThreshold?: number;
  /** relevantTechniques (e.g. T1078). */
  techniques?: string[];
  /** Rule content version (e.g. 1.0.3). */
  version?: string;
  /** Structured entity mappings (tolerant parse; absent when unparseable). */
  entityMappings?: ParsedEntityMapping[];
}

/** One structured entity mapping parsed from the rule YAML. */
export interface ParsedEntityMapping {
  entityType: string;
  fieldMappings: Array<{ identifier: string; columnName: string }>;
}

// ---------------------------------------------------------------------------
// Workbook query extraction (net-new, defensive)
// ---------------------------------------------------------------------------

/** The result of defensively mining KQL out of a workbook's serializedData. */
export interface WorkbookQueryExtraction {
  /** The KQL query strings recovered from the workbook's query steps. */
  queries: string[];
  /**
   * How many query steps (or the whole document) could NOT be parsed into a
   * usable KQL string. Surfaced so the UI can say "N of M steps unreadable"
   * rather than silently under-reporting coverage.
   */
  unparseableCount: number;
}
