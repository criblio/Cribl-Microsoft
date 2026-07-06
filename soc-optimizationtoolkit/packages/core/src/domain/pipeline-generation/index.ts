/**
 * pipeline-generation domain module barrel - porting-plan Unit 17
 * (ENG-01/02/03-emission/13).
 *
 * The PURE pipeline generation engine: the PipelinePlan planner that unifies the
 * legacy scaffold's competing table-mutation paths, the verbatim
 * generatePipelineConf builder (with the suppress-maxEvents fix and CEF
 * indexOf(-1) guard), the reduction-rules knowledge base + findReductionRules,
 * route.yml emission, the source-types catalog + generateInputsYml, and the
 * checkCriblYaml core validator the generators must pass. All pure - delivery is
 * Units 19/20.
 */

// (c) Reduction-rules KB (8 rule sets with reasons) + lookup
export type {
  ReductionRule,
  SuppressRule,
  TableReductionRules,
  ReductionKnowledgeBase,
} from "./reduction-rules";
export { REDUCTION_RULES, findReductionRules } from "./reduction-rules";

// (e) Source-types catalog + generateInputsYml (verbatim)
export type {
  SourceTypeField,
  DiscoveryConfig,
  SourceTypeDefinition,
  VendorPreset,
  SourceConfig,
} from "./source-types";
export {
  SOURCE_TYPES,
  VENDOR_SOURCE_HINTS,
  suggestSourceType,
  generateInputsYml,
  formatYamlValue,
} from "./source-types";

// Unified naming (fixes the route/pipeline suffix-mismatch defect)
export {
  vendorPrefixFromSolution,
  pipelineSuffix,
  pipelineName,
  reductionPipelineId,
  reductionRouteId,
  passthroughRouteId,
  destinationId,
  streamName,
} from "./naming";

// (a) PipelinePlan models + the pure planner
export type {
  PipelineFieldMapping,
  FieldMappingOverride,
  PlanProvenance,
  TablePlanInput,
  TablePlan,
  PipelinePlan,
  BuildPipelinePlanInput,
} from "./models";
export { buildPipelinePlan } from "./plan";

// (b) generatePipelineConf + reduction/fallback emitters (verbatim + 2 fixes)
export type { PipelineVendorMapping } from "./pipeline-conf";
export {
  buildCoercionExpr,
  detectTimestampField,
  escapeYamlFilter,
  generatePipelineConf,
  generatePipelineConfForPlan,
  generateReductionConfForPlan,
  generateFallbackReductionConf,
} from "./pipeline-conf";

// (d) route.yml emission
export { buildRouteEntries, generateRouteYml } from "./route-yml";

// Core Cribl-YAML acceptance validator
export { checkCriblYaml } from "./cribl-yaml-validator";
