/**
 * analyze-samples usecase barrel - porting-plan Unit 18 (ENG-12). The chunked,
 * per-table DCR gap-analysis engine behind the crown-jewel mapping review.
 */

export type {
  AnalyzeSamplesPorts,
  AnalyzeSampleSpec,
  AnalyzeSamplesInput,
} from "./analyze-samples";
export {
  analyzeSamples,
  collectGapReports,
  resolveSolutionDcrFlows,
} from "./analyze-samples";
export type {
  SampleRoutingInput,
  SampleRoutingResult,
} from "./resolve-sample-routing";
export {
  CONNECTOR_TABLE_DECODE_CAP,
  resolveSampleRouting,
} from "./resolve-sample-routing";
