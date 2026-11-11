/**
 * onboarding-lake-route domain barrel (AZR-35): the fixed ids, bodies and
 * route for sending the Defender for Cloud export and the Activity Log to a
 * Cribl Lake dataset through an app-created unroll pipeline, and the pure
 * classification of what is already there.
 */

export type {
  DatasetPresence,
  FieldDifference,
  LakeRouteSource,
  LakeRouteSourceId,
  PipelineLookup,
  PipelineVerdict,
} from "./lake-route";
export {
  LAKE_DATASET_ID_PATTERN,
  LAKE_ID,
  LAKE_ROUTE_SOURCES,
  UNROLL_PATH,
  UNROLL_PIPELINE_DESCRIPTION,
  UNROLL_PIPELINE_ID,
  buildLakeDatasetBody,
  buildLakeRoute,
  buildUnrollPipelineBody,
  classifyUnrollPipeline,
  datasetPresence,
  describeDifference,
  findPipeline,
  isLakeRouteSource,
  lakeOutputFor,
  pipelineCommitMarker,
  subsetDifferences,
} from "./lake-route";
