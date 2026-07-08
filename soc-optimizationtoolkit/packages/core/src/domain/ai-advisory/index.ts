/**
 * ai-advisory domain module barrel (docs/ai-assisted-analysis-plan.md P1/P2).
 *
 * The PURE half of the AI advisories: prompt construction, fence-tolerant
 * response parsing, and never-trusted sanitization for the mapping proposal
 * (A1) and the rule/workbook coverage explanations (A2/A3). The model call
 * itself lives behind the LlmAssist port, orchestrated by usecases/ai-advisory.
 * All pure.
 */

export type {
  AdvisoryField,
  AdvisoryCurrentMapping,
  MappingAdvisoryInput,
  SuggestedMapping,
  MappingSuggestion,
  MappingParseResult,
} from "./mapping-advisory";
export {
  EXAMPLE_MAX_CHARS,
  REASON_MAX_CHARS,
  MAPPING_ADVISORY_MAX_TOKENS,
  truncateExample,
  buildMappingPrompt,
  extractJsonBlock,
  parseMappingSuggestion,
  sanitizeMappingSuggestion,
} from "./mapping-advisory";

export type {
  CoverageAdvisoryInput,
  CoverageFix,
  CoverageAdvice,
  CoverageParseResult,
} from "./coverage-advisory";
export {
  KQL_MAX_CHARS,
  ADVICE_MAX_CHARS,
  COVERAGE_ADVISORY_MAX_TOKENS,
  buildCoveragePrompt,
  parseCoverageAdvice,
} from "./coverage-advisory";
