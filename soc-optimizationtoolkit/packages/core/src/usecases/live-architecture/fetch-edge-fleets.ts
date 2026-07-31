/**
 * fetch-edge-fleets - the IO half of the Edge Fleet inventory (2026-07-30):
 * list the leader's groups, snapshot every Edge FLEET's configuration
 * (reusing fetchLiveArchitecture - fleet config lives under the same
 * /m/{id} sections), and read the leader's worker inventory once so the
 * pure builder can resolve which Stream worker group each cribl_tcp/
 * cribl_http destination offloads to. Per-fleet failures degrade to
 * whatever sections arrived; a failed worker read degrades to unresolved
 * offload hosts.
 */

import type { CriblClient } from "../../ports/cribl-client";
import { isEdgeFleet } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import type {
  LiveArchitectureSnapshot,
  LiveSnapshotSection,
} from "../../domain/live-architecture";
import { fetchLiveArchitecture } from "./fetch-live-architecture";

/** How many fleets get their configuration snapshotted per load. */
export const MAX_FLEET_FETCHES = 8;

export interface EdgeFleetData {
  fleets: Array<{ id: string; snapshot: LiveArchitectureSnapshot }>;
  /** Raw /master/workers response for offload resolution; undefined = the
   * read failed (offload hosts then stay unresolved, honestly). */
  workers?: LiveSnapshotSection;
  /** Fleet ids beyond the fetch cap, surfaced instead of silently dropped. */
  skippedFleets: string[];
}

export async function fetchEdgeFleetData(
  cribl: CriblClient,
  logger?: Logger,
): Promise<EdgeFleetData> {
  const groups = await cribl.listGroups();
  const fleetIds = groups.filter(isEdgeFleet).map((g) => g.id);
  const fetched = fleetIds.slice(0, MAX_FLEET_FETCHES);
  const fleets = await Promise.all(
    fetched.map(async (id) => ({
      id,
      snapshot: await fetchLiveArchitecture(cribl, id, logger),
    })),
  );
  let workers: LiveSnapshotSection | undefined;
  try {
    const response = await cribl.request({
      method: "GET",
      path: "/master/workers",
    });
    workers = { status: response.status, body: response.body };
  } catch (err) {
    logger?.warn("edge-fleets: worker inventory fetch failed", {
      error: String(err),
    });
  }
  logger?.info("edge-fleets: inventory fetched", {
    fleets: fleets.length,
    skipped: fleetIds.length - fetched.length,
    workersAvailable: workers !== undefined,
  });
  return { fleets, workers, skippedFleets: fleetIds.slice(MAX_FLEET_FETCHES) };
}
