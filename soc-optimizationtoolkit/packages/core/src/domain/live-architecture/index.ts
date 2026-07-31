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
  LivePipelineFunction,
  LiveBreaker,
  LivePack,
  RouteFilterInputs,
} from "./live-architecture";
export {
  buildLiveDiagram,
  criblUiBaseFromLeaderUrl,
  installedPackIds,
  listLiveOutputs,
  parseRouteFilterInputs,
  isAzureCriblType,
  isAzureInput,
  outputCostTier,
} from "./live-architecture";
export {
  buildFleetInventory,
  parseWorkerInventory,
  resolveOffloads,
  type FleetInventory,
  type FleetOffload,
  type WorkerRecord,
} from "./edge-fleets";
