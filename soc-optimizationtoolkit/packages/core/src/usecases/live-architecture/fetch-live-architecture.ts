/**
 * fetch-live-architecture - the IO half of the Architecture page's Live
 * view: seven config GETs against one worker group, handed RAW to the pure
 * domain builder (domain/live-architecture). A rejected request becomes an
 * undefined section (the builder notes the omission); HTTP errors pass
 * through with their status/body. Never rejects for per-section failures.
 */

import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import { installedPackIds } from "../../domain/live-architecture";
import type {
  LiveArchitectureSnapshot,
  LivePackDetail,
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

/** Per-pack config reads (all-inclusive packs carry their own endpoints). */
const PACK_SECTION_PATHS = {
  inputs: "/system/inputs",
  outputs: "/system/outputs",
  routes: "/routes",
  pipelines: "/pipelines",
} as const;

/**
 * How many installed packs get their internals inspected (4 GETs each).
 * The builder notes the shortfall when a group has more.
 */
export const MAX_PACK_DETAIL_FETCHES = 8;

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

  // Inspect each installed pack's own config sections (capped): all-inclusive
  // packs carry sources/routes/pipelines/destinations the group-level
  // sections never see.
  const packIds = installedPackIds(snapshot.packs).slice(0, MAX_PACK_DETAIL_FETCHES);
  if (packIds.length > 0) {
    const details: Record<string, LivePackDetail> = {};
    await Promise.all(
      packIds.map(async (packId) => {
        const packEntries = Object.entries(PACK_SECTION_PATHS) as Array<
          [keyof typeof PACK_SECTION_PATHS, string]
        >;
        const packSettled = await Promise.allSettled(
          packEntries.map(([, path]) =>
            cribl.request({
              method: "GET",
              path: `/p/${encodeURIComponent(packId)}${path}`,
              groupId,
            }),
          ),
        );
        const detail: LivePackDetail = {};
        packEntries.forEach(([key], index) => {
          const outcome = packSettled[index];
          if (outcome.status === "fulfilled") {
            detail[key] = { status: outcome.value.status, body: outcome.value.body };
          } else {
            logger?.warn("live-architecture: pack section fetch failed", {
              groupId,
              packId,
              section: key,
              error: String(outcome.reason),
            });
          }
        });
        details[packId] = detail;
      }),
    );
    snapshot.packDetails = details;
  }

  logger?.info("live-architecture: snapshot fetched", {
    groupId,
    sections: entries.filter(([key]) => snapshot[key] !== undefined).length,
    packsInspected: packIds.length,
  });
  return snapshot;
}
