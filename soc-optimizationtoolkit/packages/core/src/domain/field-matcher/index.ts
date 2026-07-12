/**
 * field-matcher domain module barrel - porting-plan Unit 13 (ENG-04/05/03).
 *
 * The 6-phase field matcher, its verbatim knowledge bases, the per-table
 * overflow config, and the bundled SchemaCatalog adapter over the pre-extracted
 * DCR/custom column sets. The GAP-ANALYSIS FOUNDATION. All pure.
 */

export type {
  SourceField,
  DestField,
  MatchConfidence,
  MatchAction,
  FieldMatch,
  OverflowConfig,
  MatchResult,
} from "./models";

export type { EventCategory } from "./knowledge-bases";
export {
  ALIAS_TABLE,
  REVERSE_ALIAS,
  COALESCE_PRIORITY,
  EVENT_TYPE_BOOSTS,
  VALUE_NORMALIZATIONS,
  classifyEventType,
} from "./knowledge-bases";

export {
  normalize,
  stripAffixes,
  STANDARD_COLUMNS,
  scoreMatch,
  typeValueBoost,
} from "./scoring";

export {
  TABLE_OVERFLOW_FIELDS,
  SKIP_OVERFLOW_FIELDS,
  getOverflowConfig,
} from "./overflow";

export type { VendorMapping, SampleFieldInput } from "./match-fields";
export { matchFields, matchSampleToSchema } from "./match-fields";

// Close-match suggester (missing-field buttons in the coverage sections)
export type { CloseMatchCandidate, CloseMatchRow } from "./close-matches";
export { nameTokens, suggestCloseMatches } from "./close-matches";

// Learned reviewer decisions (highest-priority Phase 0 tier)
export type { LearnedDiffRow, LearnedMapping } from "./learned-mappings";
export {
  LEARNED_MAPPING_DESCRIPTION,
  diffLearnedMappings,
  learnedMappingsCacheKey,
  learnedToVendorMappings,
  mergeLearnedMappings,
  parseLearnedMappings,
} from "./learned-mappings";

// Documented per-vendor mapping packs (Phase 0 knowledge)
export type { VendorMappingPack, VendorPackEntry } from "./vendor-mapping-packs";
export {
  CEF_CATALOG_PACK,
  VENDOR_MAPPING_PACKS,
  vendorMappingsForSolution,
  vendorPacksForSolution,
} from "./vendor-mapping-packs";

export {
  DCR_SCHEMA_SYSTEM_COLUMNS,
  normalizeTableNames,
  resolveSchemaFromCatalog,
  bundledCatalogTableNames,
  createBundledSchemaCatalog,
} from "./bundled-schema-catalog";

export {
  parsedSampleToSourceFields,
  matchParsedSampleToColumns,
  matchSampleToTable,
} from "./match-to-catalog";
