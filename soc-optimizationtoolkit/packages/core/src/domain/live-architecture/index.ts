/**
 * live-architecture domain barrel: the pure snapshot-to-diagram builder for
 * the Architecture page's Live view. All parsing and assembly is here; the
 * usecase only fetches.
 */

export type {
  LiveSnapshotSection,
  LiveArchitectureSnapshot,
  LivePackDetail,
  BuildLiveDiagramOptions,
  LiveDiagramResult,
  LiveFlowSummary,
  LiveInput,
  LiveOutput,
  LiveRoute,
  LivePipeline,
  LiveBreaker,
  LivePack,
  RouteFilterInputs,
} from "./live-architecture";
export {
  buildLiveDiagram,
  criblUiBaseFromLeaderUrl,
  installedPackIds,
  parseRouteFilterInputs,
  isAzureCriblType,
  isAzureInput,
  outputCostTier,
} from "./live-architecture";
