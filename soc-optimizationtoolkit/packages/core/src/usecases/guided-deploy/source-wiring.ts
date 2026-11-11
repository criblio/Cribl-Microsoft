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
 * THE FILTER (DBT-301) selects the input by the `<type>:<id>` value its events
 * carry (capture-filter/input-id.ts inputRouteFilter), never the bare id: a
 * bare `__inputId=='<id>'` was verified to match nothing live. So the plan
 * takes the input's TYPE as well as its id.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random. The plan is data;
 * wire-source.ts applies it through the shared route-insert writer.
 */

import { inputRouteFilter } from "../../domain/capture-filter/input-id";

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
  /** The Cribl input's id, as configured (no type prefix). */
  sourceId: string;
  /** The Cribl input's type (`syslog`, `http`, ...): the first `__inputId` segment. */
  sourceType: string;
  /** The deployed pack name (drives route ids, names, and the pipeline). */
  packName: string;
  /** Lake federation, when the operator turned it on. */
  lake?: LakeFederation;
}

/** The pure wiring plan the usecase applies. */
export interface SourceWiringPlan {
  /** The shared route filter (input-id.ts inputRouteFilter of `<type>:<id>`). */
  filter: string;
  /**
   * Routes in FINAL EVALUATION ORDER: index 0 evaluates first. wire-source
   * inserts these (in this order) at the TOP of the group's routing table,
   * which reproduces the legacy successive-unshift result. `position` on each
   * entry is its index here, surfaced explicitly so the order contract is
   * assertable.
   */
  routes: Array<RouteEntry & { position: number }>;
  /** The commit message (mentions Lake only when a Lake route was planned). */
  commitMessage: string;
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
  if (input.sourceType.trim() === "") {
    throw new Error("planSourceWiring: sourceType must be a non-empty string");
  }
  if (input.packName.trim() === "") {
    throw new Error("planSourceWiring: packName must be a non-empty string");
  }

  const filter = inputRouteFilter({ type: input.sourceType, id: input.sourceId });
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
    createDataset,
  };
}
