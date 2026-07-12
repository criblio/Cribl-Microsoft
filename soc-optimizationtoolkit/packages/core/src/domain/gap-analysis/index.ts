/**
 * gap-analysis domain module barrel - porting-plan Unit 18 (ENG-12, GUI-08,
 * GUI-32).
 *
 * The DCR-side engine behind the crown-jewel mapping review: the KQL/transformKql
 * parser, the DCR gap partitioner (with the verbatim Cribl-internal drop-set and
 * the data-loss footgun warning), the vendor-parameterized profile, the
 * destination-table resolution helpers, and the typed six-tile gap REPORT that
 * replaces the legacy .txt side files. All pure.
 *
 * NOTE ON NAMING: analyze-workflow's `matchSampleToTable` (sample LOG TYPE ->
 * destination TABLE, returns a table name) is a DIFFERENT function from the
 * field matcher's `matchSampleToTable` (sample FIELDS -> table SCHEMA, returns a
 * MatchResult). To keep both reachable from the package root without a clash, the
 * gap-analysis one is re-exported here as `matchSampleLogTypeToTable`. The
 * verbatim-ported test imports the original name from ./analyze-workflow directly.
 */

// kql-parser (parseTransformKql, parseDcrJson tolerating all 3 shapes,
// generateRouteCondition escaped+anchored, extractTableRouting)
export {
  parseTransformKql,
  parseDcrJson,
  generateRouteCondition,
  escapeRegExp,
  extractTableRouting,
} from "./kql-parser";

// DCR gap partitioner + the verbatim drop-set + type compatibility
export {
  CRIBL_INTERNAL_FIELDS,
  COLLISION_PRONE_INTERNAL_FIELDS,
  typesCompatible,
  analyzeDcrGap,
  internalCollisionWarning,
} from "./analyze-dcr-gap";

// Vendor-parameterized profile (default + verbatim CrowdStrike/FDR)
export type { VendorGapProfile } from "./vendor-profile";
export { DEFAULT_GAP_PROFILE, CROWDSTRIKE_FDR_PROFILE } from "./vendor-profile";

// Models
export type {
  FieldRef,
  DcrFlow,
  ParsedDcr,
  TableRoutingInfo,
  GapAnalysisField,
  DcrGapAnalysis,
} from "./models";

// Destination-table resolution helpers (verbatim). The log-type matcher is
// aliased to avoid clashing with the field matcher's matchSampleToTable.
export type {
  DestinationTableResolution,
  VendorLogTypeHint,
  SolutionConnector,
} from "./analyze-workflow";
export {
  hintsFromConnectorTables,
  normalizeConnectorTableName,
  resolveDestinationTables,
  matchSampleToTable as matchSampleLogTypeToTable,
  matchLogTypeToDcrFlow,
  eventTableRoutingFromMapping,
} from "./analyze-workflow";
export type { DcrFlowRouting } from "./analyze-workflow";

// Typed six-tile gap report (replaces the legacy DCR_GAP_ANALYSIS_*.txt files)
export type {
  GapStatKey,
  GapStatTone,
  GapReportStat,
  GapFieldMapping,
  GapReport,
  BuildGapReportInput,
} from "./gap-report";
export { buildGapReport } from "./gap-report";
