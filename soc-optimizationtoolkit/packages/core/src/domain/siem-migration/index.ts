/**
 * siem-migration domain barrel (porting-plan Unit 26, ENG-40): the legacy
 * Electron SIEM Migration analyzer rebuilt as pure domain modules - the
 * verbatim mapping knowledge bases, the Splunk/QRadar parsers, plan assembly
 * (with the pinned normalization fix), and the HTML report generator. The
 * IO half (fuzzy map + analytics-rule enrichment over the SentinelContent
 * port) is usecases/siem-migration. All pure.
 */

export type {
  IdentifiedDataSource,
  MigrationConfidence,
  MigrationPlan,
  MitreTacticCoverage,
  ParsedRule,
  SentinelAnalyticRuleMatch,
  SiemPlatform,
} from "./models";
export {
  MIGRATION_RAW_SEARCH_CAP,
  parseMigrationPlan,
  serializeMigrationPlan,
} from "./models";

export type { SolutionTableTarget } from "./knowledge-bases";
export {
  QRADAR_EXTENSION_MAP,
  SPLUNK_DATAMODEL_MAP,
  SPLUNK_INTERNAL_MACROS,
  SPLUNK_MACRO_MAP,
  SPLUNK_PREFIX_MAP,
  SPLUNK_SKIP_MACROS,
  isSplunkFilterMacro,
  resolveSplunkMacro,
} from "./knowledge-bases";

export {
  detectSiemPlatform,
  parseQRadarExport,
  parseRfc4180Csv,
  parseSiemExport,
  parseSplunkExport,
} from "./parsers";

export type { AssembleMigrationPlanInput } from "./plan";
export {
  applyFuzzySolutionMap,
  assembleMigrationPlan,
  buildMitreCoverage,
  enrichPlanWithAnalyticRules,
  identifyDataSources,
  normalizeSourceKey,
} from "./plan";

export { generateMigrationReport, migrationReportFileName } from "./report";
