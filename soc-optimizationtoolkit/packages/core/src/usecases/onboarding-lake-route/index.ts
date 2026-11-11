/**
 * onboarding-lake-route usecase barrel (AZR-35): plan (read-only), then apply
 * (Lake dataset, unroll pipeline, route through route-insert, one commit and
 * deploy) a route from an onboarding source's Cribl input to Cribl Lake.
 */

export {
  LAKE_ROUTE_LOG_PREFIX,
  applyLakeRoute,
  lakeRouteGate,
  pipelineRecorded,
  planLakeRoute,
  routeWritten,
} from "./onboarding-lake-route";
export type {
  ApplyLakeRouteOutcome,
  ApplyLakeRouteStage,
  DatasetStep,
  LakeRouteGateInput,
  LakeRouteGateReason,
  LakeRoutePorts,
  ObjectAction,
  PipelineStep,
  PlanLakeRouteInput,
  PlanLakeRouteRefusalReason,
  PlanLakeRouteResult,
  ReadyLakeRoute,
} from "./onboarding-lake-route";
