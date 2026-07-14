/**
 * Source wiring - porting-plan Unit 20 task item 8. THE TOP CHARACTERIZATION
 * CANDIDATE: a regression in ROUTE ORDER or the final-flags silently DROPS data.
 *
 * After a pack is deployed, the legacy handleWireSource (SentinelIntegration.tsx
 * 1381-1451) connected a Cribl source to it by creating routes, committing, and
 * deploying to the worker groups. The routes were inserted with `unshift` (each
 * new route to index 0 of the existing routes array - auth.ts 1817-1829), so the
 * ORDER OF CREATION determines the final evaluation order:
 *
 *   1. The Sentinel route is created FIRST (unshift -> index 0), final: true.
 *   2. When Cribl Lake federation is on (CLOUD deployments only), the Lake route
 *      is created SECOND (unshift -> index 0), pushing Sentinel to index 1.
 *      final: false (NON-final, so events continue past it to Sentinel).
 *
 * Net EVALUATION order therefore:
 *   - no Lake:  [ Sentinel(final:true) ]                       Sentinel at pos 0
 *   - Lake:     [ Lake(final:false), Sentinel(final:true) ]    Lake 0, Sentinel 1
 *
 * WHY THE ORDER IS LOAD-BEARING: routes evaluate top-down; a `final` route stops
 * evaluation for the events it matches. The Lake route (same filter) MUST sit
 * ABOVE the final Sentinel route and be NON-final - otherwise either Lake never
 * receives data (if Sentinel-final ran first) or the Sentinel route is bypassed.
 * The invariants a regression must never break, all pinned by test:
 *   - the Sentinel route is ALWAYS final:true;
 *   - when present, the Lake route is ALWAYS final:false and evaluates BEFORE
 *     (lower position than) the Sentinel route;
 *   - the Lake route exists ONLY for cloud deployments with federation enabled
 *     and a dataset.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random. The plan is data;
 * the guided-deploy usecase applies it through the CriblClient port.
 */

/** Cribl deployment flavor - Lake is a CLOUD-only capability. */
export type CriblDeploymentType = "cloud" | "onprem";

/** One route entry (the shape auth.ts 1777-1786 builds). */
export interface RouteEntry {
  id: string;
  name: string;
  /** Route filter expression; both app routes share the source filter. */
  filter: string;
  /** "pack:{packName}" for the Sentinel route, "passthru" for the Lake route. */
  pipeline: string;
  /** "default" (pack's embedded output) or "cribl_lake:{dataset}". */
  output: string;
  /** final:true stops evaluation for matched events; false lets them continue. */
  final: boolean;
  disabled: false;
  description: string;
}

/** Optional Cribl Lake federation for the wiring. */
export interface LakeFederation {
  /** Whether the operator enabled the full-fidelity Lake copy. */
  enabled: boolean;
  /** Target Lake dataset id (existing or newly created). */
  dataset: string;
  /** Lake exists only on cloud; onprem never gets a Lake route. */
  deploymentType: CriblDeploymentType;
}

/** Input for {@link planSourceWiring}. */
export interface SourceWiringInput {
  /** The Cribl input id the routes filter on (`__inputId=='...'`). */
  sourceId: string;
  /** The deployed pack name (drives route ids, names, and the pipeline). */
  packName: string;
  /** Worker groups the committed config is deployed to (order preserved). */
  workerGroups: readonly string[];
  /** Lake federation, when the operator turned it on. */
  lake?: LakeFederation;
}

/** The pure wiring plan the usecase applies. */
export interface SourceWiringPlan {
  /** The shared route filter (`__inputId=='{sourceId}'`). */
  filter: string;
  /**
   * Routes in FINAL EVALUATION ORDER: index 0 evaluates first. The usecase
   * prepends these (in this order) ahead of the group's existing routes, which
   * reproduces the legacy successive-unshift result. `position` on each entry is
   * its index here, surfaced explicitly so the order contract is assertable.
   */
  routes: Array<RouteEntry & { position: number }>;
  /** The commit message (mentions Lake only when a Lake route was planned). */
  commitMessage: string;
  /** Worker groups to deploy the committed config to (input order). */
  deployGroups: string[];
  /** Whether a create-dataset step is needed first (dataset id, when new). */
  createDataset: string | null;
}

/** Whether Lake federation should produce a Lake route for this input. */
function lakeApplies(lake: LakeFederation | undefined): lake is LakeFederation {
  return (
    lake !== undefined &&
    lake.enabled &&
    lake.deploymentType === "cloud" &&
    lake.dataset.trim() !== ""
  );
}

/**
 * Build the Sentinel route (always final:true). Pipeline is the pack; output is
 * the pack's embedded default output.
 */
function sentinelRoute(sourceId: string, packName: string, filter: string): RouteEntry {
  return {
    id: `${packName}-sentinel`,
    name: `${packName} to Sentinel`,
    filter,
    pipeline: `pack:${packName}`,
    output: "default",
    final: true,
    disabled: false,
    description: `Routes ${sourceId} through ${packName} pack to Sentinel`,
  };
}

/**
 * Build the Lake route (always final:false). Pipeline is passthru; output is the
 * Lake dataset. NON-final so events continue to the Sentinel route below it.
 */
function lakeRoute(
  sourceId: string,
  packName: string,
  filter: string,
  dataset: string,
): RouteEntry {
  return {
    id: `${packName}-lake`,
    name: `${packName} full fidelity to Lake`,
    filter,
    pipeline: "passthru",
    output: `cribl_lake:${dataset}`,
    final: false,
    disabled: false,
    description: `Full fidelity copy of ${sourceId} to Cribl Lake dataset ${dataset}`,
  };
}

/**
 * Compose the source-wiring plan. The route array is returned in EVALUATION
 * order (Lake before Sentinel when Lake applies), each carrying its explicit
 * position; the Sentinel route is always final and the Lake route is always
 * non-final.
 *
 * @throws Error when sourceId or packName is blank (a wiring with no source or
 *   pack cannot produce a valid route id/filter).
 */
export function planSourceWiring(input: SourceWiringInput): SourceWiringPlan {
  if (input.sourceId.trim() === "") {
    throw new Error("planSourceWiring: sourceId must be a non-empty string");
  }
  if (input.packName.trim() === "") {
    throw new Error("planSourceWiring: packName must be a non-empty string");
  }

  const filter = `__inputId=='${input.sourceId}'`;
  const sentinel = sentinelRoute(input.sourceId, input.packName, filter);

  const ordered: RouteEntry[] = [];
  let createDataset: string | null = null;
  let commitMessage = `Wired source ${input.sourceId} to pack ${input.packName}`;

  if (lakeApplies(input.lake)) {
    // Lake evaluates FIRST (non-final), then Sentinel (final) - the legacy
    // Sentinel-then-Lake creation order under unshift.
    ordered.push(
      lakeRoute(input.sourceId, input.packName, filter, input.lake.dataset),
    );
    createDataset = input.lake.dataset;
    commitMessage += " + Cribl Lake";
  }
  ordered.push(sentinel);

  const routes = ordered.map((route, position) => ({ ...route, position }));

  return {
    filter,
    routes,
    commitMessage,
    deployGroups: [...input.workerGroups],
    createDataset,
  };
}

/**
 * Prepend the plan's routes (in evaluation order) ahead of a worker group's
 * EXISTING routes, skipping any whose id already exists (the legacy
 * already-exists guard, auth.ts 1772). Returns the new routes array in final
 * order. Pure - the usecase feeds this the live config's routes and PUTs the
 * result.
 */
export function prependRoutes(
  existing: readonly { id?: string }[],
  planRoutes: ReadonlyArray<RouteEntry & { position: number }>,
): RouteEntry[] {
  const existingIds = new Set(
    existing.map((route) => route.id).filter((id): id is string => id !== undefined),
  );
  const toAdd: RouteEntry[] = [];
  for (const route of planRoutes) {
    if (!existingIds.has(route.id)) {
      const { position: _position, ...entry } = route;
      void _position;
      toAdd.push(entry);
    }
  }
  return [...toAdd, ...(existing as RouteEntry[])];
}
