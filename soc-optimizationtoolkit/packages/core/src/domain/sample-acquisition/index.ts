/**
 * sample-acquisition domain module barrel - porting-plan Unit 16
 * (ENG-19, ENG-20 redesigned lazy, ENG-41, ENG-42; completes GUI-06 browse).
 *
 * Tiered sample acquisition (user > cribl > elastic > synthesis), the curated
 * solution map + ONE fuzzy matcher, the Elastic 6-format split/unwrap cascade,
 * the ENG-42 sentinel-repo scorer (markers, abbreviations, three messages), and
 * ENG-41 deterministic synthesis. All pure - the lazy fetch lives in the
 * acquire-samples usecase + shell adapters.
 */

// Models + tier vocabulary + caps
export type {
  SampleTier,
  ResolvedSample,
  AvailableSample,
  SplitSample,
  SampleSourceEntry,
} from "./models";
export {
  TIER_PRECEDENCE,
  ELASTIC_EVENT_CAP,
  CRIBL_EVENT_CAP,
  USER_EVENT_CAP,
  SYNTHESIS_EVENT_COUNT,
  PREVIEW_EVENT_COUNT,
} from "./models";

// Solution map + ONE fuzzy matcher
export {
  SOLUTION_SAMPLE_MAP,
  STRIP_SUFFIXES,
  normalizeSolutionKey,
  matchSolutionName,
  lookupSolution,
  fuzzyMatchElasticPackage,
} from "./solution-map";

// Elastic parsing (6-format cascade + unwrap)
export {
  parseElasticFileContent,
  extractInnerEvent,
  unwrapElasticEvents,
  logTypeFromFilename,
} from "./elastic-parsing";

// Splitting, self-describing detection, stable ids, PAN-OS load conversion
export {
  parseKvLine,
  splitSamplesByLogType,
  browseSampleId,
  hasNamedFields,
  convertPanosSplitAtLoad,
} from "./splitting";

// ENG-42 sentinel-repo scorer
export type {
  RepoSampleCandidate,
  RepoSample,
  RepoSampleResult,
  ResolveRepoOptions,
  RepoMessageInput,
} from "./repo-samples";
export {
  SENTINEL_SCHEMA_MARKERS,
  PREINGESTED_MARKER_THRESHOLD,
  ABBREVIATIONS,
  EXCLUDE_PATTERNS,
  SHORT_KEYWORD_MIN,
  REPO_MATCH_MIN_SCORE,
  REPO_SAMPLE_DATA_DIRS,
  MAX_REPO_ROOT_SAMPLE_READS,
  MAX_REPO_SAMPLE_FILE_BYTES,
  detectPreIngested,
  buildSampleKeywords,
  scoreFileName,
  isEligibleRepoFile,
  buildRepoSampleMessage,
  consolidateByTableRouting,
  resolveRepoSamples,
} from "./repo-samples";

// ENG-41 synthesis
export type {
  KqlExtraction,
  SynthesisField,
  SynthesizeInput,
} from "./synthesis";
export {
  DEFAULT_SYNTH_COUNT,
  extractKqlFieldsAndLiterals,
  serializeEvent,
  synthesizeEvents,
} from "./synthesis";

// Tier precedence + pure browse/load transforms
export type { ElasticFile, CriblPackFile, UserSampleInput } from "./precedence";
export {
  selectByPrecedence,
  elasticSourceId,
  elasticStreamOf,
  buildElasticLogTypeDisambiguator,
  browseElasticFile,
  loadElasticFile,
  readCriblPackSamples,
  repoBrowseId,
  browseRepoResult,
  loadRepoResult,
  resolveUserSamples,
} from "./precedence";
