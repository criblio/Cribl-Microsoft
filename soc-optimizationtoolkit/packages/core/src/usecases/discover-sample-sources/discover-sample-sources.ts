/**
 * discover-sample-sources - the IO half of Phase 3 (ADR 0003): find the surfaces
 * the operator can reach to get their OWN samples from.
 *
 * TWO STAGES, DELIBERATELY LAZY (user direction 2026-08-19). Stage one lists
 * worker groups and nothing else - ONE request - so the page can render a group
 * dropdown immediately. Stage two runs only once the operator has picked a
 * group, and reads that ONE group's sources plus the two workspace-wide dataset
 * listings.
 *
 * The first cut fanned out across every Stream worker group on load. This
 * workspace has 15+, so that was up to nine requests before the operator had
 * done anything, against a proxy budget shared with the rest of the page - and
 * it forced a MAX_SOURCE_GROUPS cap whose only job was to bound damage that a
 * dropdown removes entirely. Lazy is both cheaper AND more complete: every group
 * is now selectable, where the cap silently hid some.
 *
 *   stage 1   listGroups()                             1 request
 *   stage 2   GET /m/{groupId}/system/inputs           1 request
 *             GET /m/{searchGroupId}/search/datasets   1, when a Search group exists
 *             GET /products/lake/lakes/{lakeId}/datasets  1
 *
 * ADDRESSING, verified live 2026-08-19 against a Cribl.Cloud workspace by
 * reading Cribl's own UI traffic - the OpenAPI spec declares these paths bare
 * and cannot settle it:
 *   - `/search/*` is GROUP-scoped, under the SEARCH group (`isSearchGroup`).
 *     The group id is not a constant; it comes from listGroups().
 *   - Lake datasets are a LEADER route with a `lakeId` path segment, NOT the
 *     `/system/lake/datasets` route Unit 20 POSTs to when creating one. Two
 *     route families for one resource; this is the listing one.
 *
 * Neither stage rejects for a per-surface failure: a refused Search read must
 * not cost the operator their source list.
 */

import type { CriblClient, CriblGroupSummary } from "../../ports/cribl-client";
import { isSearchGroup, isStreamWorkerGroup } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import { buildSampleSourceInventory } from "../../domain/sample-sources/inventory";
import type {
  InventoryInput,
  RawSection,
} from "../../domain/sample-sources/inventory";
import type { SampleSourceInventory } from "../../domain/sample-sources/models";

/** API paths, pinned here so a change is one edit and one test. */
export const SEARCH_DATASETS_PATH = "/search/datasets";
export const SYSTEM_INPUTS_PATH = "/system/inputs";
/**
 * The Cribl.Cloud managed lake's id. There is no "list lakes" route in the
 * vendored spec, and the live workspace serves its datasets under `default`, so
 * this is a constant until a multi-lake deployment proves otherwise.
 */
export const DEFAULT_LAKE_ID = "default";
export const lakeDatasetsPath = (lakeId: string): string =>
  `/products/lake/lakes/${encodeURIComponent(lakeId)}/datasets`;

// ---------------------------------------------------------------------------
// Stage 1: the group listing
// ---------------------------------------------------------------------------

/** What the operator can choose between, before anything else is fetched. */
export interface SampleSourceGroups {
  /**
   * Every Stream worker group, in leader order - NOT capped. The whole point of
   * asking the operator which group they want is that we no longer have to
   * guess at a subset.
   */
  streamGroupIds: string[];
  /** The Search group, when this workspace has one. */
  searchGroupId?: string;
  /** Why the listing is unusable, when it is. Empty on success. */
  notes: string[];
  /** False when listGroups itself failed - nothing below can be addressed. */
  ok: boolean;
}

/**
 * Stage one: list the worker groups. ONE request, and the only thing that runs
 * on load.
 *
 * A failure here is reported, never thrown: the page still renders, and manual
 * upload does not need any of this.
 */
export async function listSampleSourceGroups(
  cribl: CriblClient,
  logger?: Logger,
): Promise<SampleSourceGroups> {
  let groups: CriblGroupSummary[] = [];
  try {
    groups = await cribl.listGroups();
  } catch (err) {
    logger?.warn("discover-sample-sources: listGroups failed", {
      error: String(err),
    });
    return {
      streamGroupIds: [],
      notes: [
        `The worker-group listing failed (${String(err)}), so no Cribl surface could be reached. Uploading samples still works.`,
      ],
      ok: false,
    };
  }

  const streamGroupIds = groups.filter(isStreamWorkerGroup).map((g) => g.id);
  const searchGroupId = groups.find(isSearchGroup)?.id;
  const notes: string[] = [];
  if (streamGroupIds.length === 0) {
    notes.push(
      "No Stream worker group is visible, so there is no live source to capture from.",
    );
  }
  logger?.info("discover-sample-sources: groups listed", {
    streamGroups: streamGroupIds.length,
    searchGroup: searchGroupId ?? "(none)",
  });
  return {
    streamGroupIds,
    ...(searchGroupId !== undefined ? { searchGroupId } : {}),
    notes,
    ok: true,
  };
}

// ---------------------------------------------------------------------------
// Stage 2: the selected group's sources, plus the workspace-wide datasets
// ---------------------------------------------------------------------------

/** Options for {@link loadSampleSources}. */
export interface LoadSampleSourcesOptions {
  /** The worker group whose sources to list. Omit to list datasets only. */
  groupId?: string;
  /** The Search group from stage one; omit when the workspace has none. */
  searchGroupId?: string;
  /** Lake id to list datasets from; defaults to {@link DEFAULT_LAKE_ID}. */
  lakeId?: string;
  /**
   * Whether to list the workspace-wide Search and Lake datasets. They do not
   * depend on the selected group, so a caller that already has them can skip
   * the two requests on a subsequent group change.
   */
  includeDatasets?: boolean;
}

/** Execute one GET, folding any transport rejection into a synthetic 599. */
async function get(
  cribl: CriblClient,
  path: string,
  groupId: string | undefined,
  logger?: Logger,
): Promise<RawSection> {
  try {
    const response = await cribl.request(
      groupId === undefined
        ? { method: "GET", path }
        : { method: "GET", path, groupId },
    );
    return { status: response.status, body: response.body };
  } catch (err) {
    // The port rejects only on transport failure. 599 is not a real HTTP
    // status; it exists so the domain's one "did this read work" test covers
    // transport and HTTP failures identically.
    logger?.warn("discover-sample-sources: request failed", {
      path,
      ...(groupId !== undefined ? { groupId } : {}),
      error: String(err),
    });
    return { status: 599, body: String(err) };
  }
}

/**
 * Stage two: read the selected group's sources and, when asked, the two
 * workspace-wide dataset listings. Everything not requested stays `pending` in
 * the returned inventory rather than rendering as empty.
 */
export async function loadSampleSources(
  cribl: CriblClient,
  options: LoadSampleSourcesOptions,
  logger?: Logger,
): Promise<SampleSourceInventory> {
  const { groupId, searchGroupId, includeDatasets = true } = options;
  const lakeId = options.lakeId ?? DEFAULT_LAKE_ID;

  const [sources, searchDatasets, lakeDatasets] = await Promise.all([
    groupId === undefined
      ? Promise.resolve(undefined)
      : get(cribl, SYSTEM_INPUTS_PATH, groupId, logger),
    includeDatasets && searchGroupId !== undefined
      ? get(cribl, SEARCH_DATASETS_PATH, searchGroupId, logger)
      : Promise.resolve(undefined),
    includeDatasets
      ? get(cribl, lakeDatasetsPath(lakeId), undefined, logger)
      : Promise.resolve(undefined),
  ]);

  const input: InventoryInput = { groupsListed: true };
  if (groupId !== undefined && sources !== undefined) {
    input.criblSources = [{ groupId, section: sources }];
  }
  if (searchGroupId !== undefined) {
    input.searchGroupId = searchGroupId;
    if (searchDatasets !== undefined) input.searchDatasets = searchDatasets;
  }
  if (lakeDatasets !== undefined) input.lakeDatasets = lakeDatasets;

  const inventory = buildSampleSourceInventory(input);
  logger?.info("discover-sample-sources: inventory built", {
    group: groupId ?? "(none)",
    entries: inventory.sections.reduce((n, s) => n + s.entries.length, 0),
  });
  return inventory;
}
