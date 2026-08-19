/**
 * discover-sample-sources - the IO half of Phase 3 (ADR 0003): find every
 * surface the operator can actually reach to get their OWN samples from, and
 * hand the raw responses to the pure domain builder.
 *
 * Three reads, all GET, all independently degradable:
 *
 *   GET /m/{searchGroupId}/search/datasets      Search datasets (incl. federated)
 *   GET /products/lake/lakes/{lakeId}/datasets  Cribl Lake datasets  (LEADER route)
 *   GET /m/{groupId}/system/inputs              live sources, per Stream group
 *
 * ADDRESSING, verified live 2026-08-19 against a Cribl.Cloud workspace by
 * reading Cribl's own UI traffic - the OpenAPI spec declares these paths bare
 * and cannot settle it:
 *   - `/search/*` is GROUP-scoped, under the SEARCH group (`isSearchGroup`).
 *     The group id is not a constant; it is resolved from listGroups().
 *   - Lake datasets are a LEADER route with a `lakeId` path segment, NOT the
 *     `/system/lake/datasets` route Unit 20 POSTs to when creating one. Two
 *     route families for one resource; this is the listing one.
 *
 * Never rejects for a per-surface failure: a refused Search read must not cost
 * the operator their source list. Only listGroups() failing is fatal, because
 * without it there is nothing to address at all - and even that is reported as
 * an inventory with every section marked, not thrown.
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

/**
 * How many Stream worker groups get their sources read. A workspace can carry
 * dozens (this one has 15+); reading every one turns a page load into a request
 * storm against a shared 100/min proxy budget. The domain reports the shortfall.
 */
export const MAX_SOURCE_GROUPS = 6;

/** Options for {@link discoverSampleSources}. */
export interface DiscoverSampleSourcesOptions {
  /**
   * Restrict the source read to these Stream groups. Absent = the first
   * {@link MAX_SOURCE_GROUPS} Stream groups the leader reports.
   */
  groupIds?: readonly string[];
  /** Lake id to list datasets from; defaults to {@link DEFAULT_LAKE_ID}. */
  lakeId?: string;
}

/** The result: the inventory plus what discovery itself could not do. */
export interface DiscoverSampleSourcesResult {
  inventory: SampleSourceInventory;
  /**
   * Notes about the DISCOVERY, distinct from the per-section notes about each
   * surface - e.g. "only the first 6 of 15 worker groups were read".
   */
  notes: string[];
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
 * Discover every reachable sample source. See the module header for the three
 * reads and why each degrades independently.
 */
export async function discoverSampleSources(
  cribl: CriblClient,
  options: DiscoverSampleSourcesOptions = {},
  logger?: Logger,
): Promise<DiscoverSampleSourcesResult> {
  const notes: string[] = [];

  let groups: CriblGroupSummary[] = [];
  try {
    groups = await cribl.listGroups();
  } catch (err) {
    // Nothing can be addressed without the group list. Report it as an empty
    // inventory with the reason rather than throwing - the page still renders,
    // and manual upload is still a valid path.
    logger?.warn("discover-sample-sources: listGroups failed", {
      error: String(err),
    });
    notes.push(
      `The worker-group listing failed (${String(err)}), so no Cribl surface could be reached. Uploading samples still works.`,
    );
    return { inventory: buildSampleSourceInventory({}), notes };
  }

  const searchGroupId = groups.find(isSearchGroup)?.id;
  const streamGroupIds =
    options.groupIds !== undefined
      ? [...options.groupIds]
      : groups.filter(isStreamWorkerGroup).map((g) => g.id);
  const readGroupIds = streamGroupIds.slice(0, MAX_SOURCE_GROUPS);
  if (streamGroupIds.length > readGroupIds.length) {
    notes.push(
      `Sources were read from the first ${readGroupIds.length} of ${streamGroupIds.length} worker groups. Pick a group explicitly to see the rest.`,
    );
  }

  const lakeId = options.lakeId ?? DEFAULT_LAKE_ID;

  // All reads concurrently: they are independent, and the slowest one should
  // set the wall clock rather than their sum.
  const [searchDatasets, lakeDatasets, sourceSections] = await Promise.all([
    searchGroupId === undefined
      ? Promise.resolve(undefined)
      : get(cribl, SEARCH_DATASETS_PATH, searchGroupId, logger),
    get(cribl, lakeDatasetsPath(lakeId), undefined, logger),
    Promise.all(
      readGroupIds.map(async (groupId) => ({
        groupId,
        section: await get(cribl, SYSTEM_INPUTS_PATH, groupId, logger),
      })),
    ),
  ]);

  const input: InventoryInput = { criblSources: sourceSections };
  if (searchGroupId !== undefined) {
    input.searchGroupId = searchGroupId;
    if (searchDatasets !== undefined) input.searchDatasets = searchDatasets;
  }
  if (lakeDatasets !== undefined) input.lakeDatasets = lakeDatasets;

  const inventory = buildSampleSourceInventory(input);
  logger?.info("discover-sample-sources: inventory built", {
    searchGroup: searchGroupId ?? "(none)",
    groupsRead: readGroupIds.length,
    entries: inventory.sections.reduce((n, s) => n + s.entries.length, 0),
  });
  return { inventory, notes };
}
