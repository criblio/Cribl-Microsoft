/**
 * fetch-live-architecture - the IO half of the Architecture page's Live
 * view: seven config GETs against one worker group, handed RAW to the pure
 * domain builder (domain/live-architecture). A rejected request becomes an
 * undefined section (the builder notes the omission); HTTP errors pass
 * through with their status/body. Never rejects for per-section failures.
 */

import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import type {
  LiveArchitectureSnapshot,
  LiveSnapshotSection,
} from "../../domain/live-architecture";

/** The seven config reads, in snapshot-field order. Collectors are JOBS
 * (scheduled `/jobs` entries nesting their input config under `input.`) -
 * without this section the Live view misses collector breakers/pipelines. */
const SECTION_PATHS = {
  inputs: "/system/inputs",
  outputs: "/system/outputs",
  routes: "/routes",
  pipelines: "/pipelines",
  breakers: "/lib/breakers",
  packs: "/packs",
  jobs: "/jobs",
} as const;

/** Fetch one group's live configuration snapshot. */
export async function fetchLiveArchitecture(
  cribl: CriblClient,
  groupId: string,
  logger?: Logger,
): Promise<LiveArchitectureSnapshot> {
  const entries = Object.entries(SECTION_PATHS) as Array<
    [keyof typeof SECTION_PATHS, string]
  >;
  const settled = await Promise.allSettled(
    entries.map(([, path]) => cribl.request({ method: "GET", path, groupId })),
  );

  const snapshot: LiveArchitectureSnapshot = { groupId };
  entries.forEach(([key], index) => {
    const outcome = settled[index];
    if (outcome.status === "fulfilled") {
      const section: LiveSnapshotSection = {
        status: outcome.value.status,
        body: outcome.value.body,
      };
      snapshot[key] = section;
    } else {
      logger?.warn(
        "live-architecture: section fetch failed",
        { groupId, section: key, error: String(outcome.reason) },
      );
    }
  });

  logger?.info("live-architecture: snapshot fetched", {
    groupId,
    sections: entries.filter(([key]) => snapshot[key] !== undefined).length,
  });
  return snapshot;
}
