/**
 * sentinel-content domain module barrel - porting-plan Unit 14 (ENG-21
 * redesigned, ENG-23, ENG-30, ENG-22 content-filter-only, ENG-52 superseded,
 * GUI-04 redesigned, GUI-05).
 *
 * The PURE KNOWLEDGE behind the lazy Sentinel content workflow: the ONE 4-format
 * connector decoder with three projections, the reconciled normalizeDcrType
 * superset, the deprecation heuristics, the file-selection and EDR content
 * filters, cache-key derivation, and the PAT policy. The FETCHING lives in the
 * shell adapters over the SentinelContent port (ports/sentinel-content). All
 * pure - zero IO, zero fetch, zero React, no Date/crypto.
 */

// normalizeDcrType superset (ENG-23; contract section 3 item 8)
export type { DcrVocabularyType } from "./dcr-type";
export { DCR_TYPE_MAP, normalizeDcrType, isKnownDcrType } from "./dcr-type";

// Canonical decoded connector + projection shapes
export type {
  DecodedColumn,
  DecodedTable,
  DecodedConnector,
  SchemaColumn,
  DataConnectorSchema,
  VendorLogTypeField,
  VendorLogType,
  SchemaFingerprint,
} from "./models";

// The ONE decoder + three projections (ENG-23 / ENG-24 seam / ENG-26 seam)
export {
  decodeConnector,
  toFullSchemas,
  toVendorLogTypes,
  toFingerprints,
  canonicalFieldString,
  sanitizeLogTypeId,
} from "./connector-decoder";

// Logs Ingestion API fit classification (Recommended / Supported / Legacy)
export type { IngestionTier, IngestionClass } from "./ingestion-class";
export {
  CCF_PUSH_KINDS,
  CCF_PULL_KINDS,
  detectConnectorKinds,
  classifyConnectorIngestion,
  classifySolutionIngestion,
  ingestionTierLabel,
} from "./ingestion-class";
export type {
  SolutionIngestion,
  SolutionIngestionEntry,
} from "./ingestion-classification";
export {
  SOLUTION_INGESTION_ENTRIES,
  lookupSolutionIngestion,
  ingestionTierReason,
} from "./ingestion-classification";

// The badge a solution ROW renders, absent classification included (DBT-15):
// a solution missing from the shipped map is "not measured", never blank and
// never silently demoted to a tier.
export type {
  DeliveryFitState,
  DeliveryFitBadge,
  TieredIngestion,
} from "./delivery-fit-badge";
export {
  DELIVERY_FIT_UNMEASURED_LABEL,
  DELIVERY_FIT_UNMEASURED_REASON,
  deliveryFitBadge,
} from "./delivery-fit-badge";

// File-selection persistence filter (verbatim extension/dir sets), plus the
// analytic-rule location rules shared by rule-coverage and siem-migration
// (audit finding 1, 2026-08-17: they were duplicated, and only one was pinned).
export {
  BLOCKED_EXTENSIONS,
  SKIP_EXTENSIONS,
  SKIP_DIRS,
  INCLUDED_EXTENSIONS,
  extname,
  isContentPathIncluded,
  ANALYTIC_RULE_DIR_VARIANTS,
  isRuleYamlFileName,
  RULE_FILE_CAP,
} from "./file-selection";

// Solution deprecation heuristics
export type { DeprecationResult, DeprecationInput } from "./deprecation";
export {
  DEPRECATION_NAME_MARKERS,
  SOLUTION_DATA_DEPRECATION_MARKERS,
  CONNECTOR_DEPRECATED_TAG,
  CONNECTOR_TITLE_MARKER,
  isDeprecatedByName,
  isDeprecatedBySolutionData,
  areAllConnectorsDeprecated,
  classifySolutionDeprecation,
} from "./deprecation";

// Directory-name variants + recursive connector-file selection
export {
  DATA_CONNECTOR_DIR_NAMES,
  ANALYTIC_RULE_DIR_NAMES,
  SAMPLE_DATA_DIR_NAMES,
  SOLUTION_DATA_DIR,
  isNestedConnectorDir,
  findConnectorDirName,
  selectConnectorFiles,
} from "./discovery";

// EDR content filter (ENG-22 data only; crash detection dropped)
export type { BlockedSolution, BlockedSolutionSource } from "./edr-filter";
export {
  BUILTIN_EDR_BLOCKLIST,
  mergeBlocklist,
  blockedSolutionNames,
  isSolutionAllowed,
  solutionNameFromPath,
  isPathAllowedByEdr,
} from "./edr-filter";

// Cache-key derivation (ENG-52 superseded; solution + commit SHA)
export type { ContentCacheKind, ContentCacheKeyParams } from "./cache-key";
export {
  CONTENT_CACHE_NAMESPACE,
  shortCommitSha,
  contentCacheKey,
  connectorsCacheKey,
  solutionIndexCacheKey,
} from "./cache-key";

// PAT policy (ENG-30; validate-then-store, hasPat-only, cloud-required)
export type {
  ContentPlatform,
  PatStatus,
  PatValidationResult,
  PatPolicy,
  PatGate,
} from "./pat-policy";
export {
  PAT_VALIDATION_ENDPOINT,
  PAT_MIN_LENGTH,
  PAT_SCOPE_GUIDANCE,
  patFormatIssue,
  patStatusFrom,
  decidePatStore,
  patPolicyFor,
  evaluatePatGate,
} from "./pat-policy";

// Fuzzy solution-NAME matching (rehomed 2026-08-18 with the sample-browser
// removal; analyze-samples reconciles a typed name against the repo's list).
export type { SolutionKeywordedPack } from "./solution-matching";
export {
  matchSolutionName,
  normalizeSolutionKey,
  packAppliesToSolution,
} from "./solution-matching";
