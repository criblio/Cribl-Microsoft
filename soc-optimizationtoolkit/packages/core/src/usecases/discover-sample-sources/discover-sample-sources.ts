/**
 * discover-sample-sources - the IO half of Phase 3 (ADR 0003): find what the
 * operator can reach to get their OWN samples from.
 *
 * TWO MODES, and the operator picks (user direction 2026-08-19):
 *   LAKE QUERY   - an existing Cribl Lake dataset, queried through Cribl Search.
 *   LIVE CAPTURE - a configured Cribl source, captured with a filter.
 *
 * LAZY, AND THE MODE DECIDES THE COST. Stage one lists worker groups and nothing
 * else - one request - so the page renders immediately. Stage two reads only the
 * surface the chosen mode needs:
 *
 *   stage 1        listGroups()                                1 request
 *   lake-query     GET /products/lake/lakes/{lakeId}/datasets  1, LEADER route
 *   live-capture   GET /m/{groupId}/system/inputs              1, per chosen group
 *
 * Lake mode needs NO worker group at all, which is why the group dropdown only
 * appears for capture. The first cut fanned out across every Stream worker group
 * on load - up to nine requests before the operator had done anything.
 *
 * ADDRESSING, verified live 2026-08-19 against a Cribl.Cloud workspace by
 * reading Cribl's own UI traffic - the OpenAPI spec declares these paths bare
 * and cannot settle it:
 *   - Lake datasets LIST from a LEADER route with a `lakeId` segment, NOT the
 *     `/system/lake/datasets` route Unit 20 POSTs to when creating one. Two
 *     route families for one resource; this is the listing one.
 *   - `/search/*` is GROUP-scoped under the SEARCH group. Nothing here calls it
 *     yet - Phase 4's query does - but the group is resolved in stage one so the
 *     UI can say up front whether a Lake dataset is queryable at all.
 *
 * Neither stage rejects for a per-surface failure.
 */

import type { CriblClient, CriblGroupSummary } from "../../ports/cribl-client";
import {
  filterListing,
  listingCount,
  listingRows,
  toListing,
} from "../../domain/inventory-listing";
import { isSearchGroup, isStreamWorkerGroup } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import { buildSampleSourceInventory } from "../../domain/sample-sources/inventory";
import type {
  InventoryInput,
  RawSection,
} from "../../domain/sample-sources/inventory";
import type {
  AcquisitionMode,
  SampleSourceInventory,
} from "../../domain/sample-sources/models";

/** API paths, pinned here so a change is one edit and one test. */
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

/** What stage one establishes, before any surface is read. */
export interface SampleSourceGroups {
  /**
   * Every Stream worker group, in leader order - NOT capped. The whole point of
   * asking which group is that we no longer have to guess at a subset.
   */
  streamGroupIds: string[];
  /**
   * The Search group, when this workspace has one.
   *
   * Load-bearing for the LAKE-QUERY mode even though nothing here calls Search:
   * a Lake dataset is queried THROUGH Search, so a workspace with no Search
   * group can list its datasets and not query them. The UI says that up front
   * rather than letting the operator pick a dataset and hit a wall in Phase 4.
   */
  searchGroupId?: string;
  /** Why the listing is unusable, when it is. Empty on success. */
  notes: string[];
  /** False when listGroups itself failed - nothing below can be addressed. */
  ok: boolean;
}

/**
 * Stage one: list the worker groups. ONE request, and the only thing that runs
 * on load. A failure is reported, never thrown - the page still renders, and
 * manual upload needs none of this.
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

  // DBT-62: the Cribl group listing carries the same ambiguity as an ARM one -
  // a token scoped to one worker group lists what it can reach, not what
  // exists - so the two ways of ending up with no Stream group get different
  // sentences. `filterListing` demands the source read to tell them apart.
  const listed = toListing(groups);
  const streamGroups = filterListing(
    listed,
    groups.filter(isStreamWorkerGroup),
  );
  const streamGroupIds = listingRows(streamGroups).map((g) => g.id);
  const searchGroupId = groups.find(isSearchGroup)?.id;
  const notes: string[] = [];
  if (streamGroups.kind === "none") {
    // EARNED: groups came back and none of them is a Stream group. The
    // original wording already said "visible" rather than "exists", which was
    // careful - it is kept, because it is still the honest word.
    notes.push(
      "No Stream worker group is visible, so there is no live source to capture from.",
    );
  } else if (streamGroups.kind === "empty") {
    // NOT EARNED: the worker-group listing itself returned nothing, which
    // looks identical whether the deployment has no groups or this token
    // cannot see them. Saying "no Stream worker group" here would be a claim
    // about the deployment made from a fact about the token.
    notes.push(
      "The worker-group listing returned nothing, so no Stream source could be " +
        "identified. That looks the same whether this deployment has no worker " +
        "groups or this token cannot see them. Uploading samples still works.",
    );
  }
  logger?.info("discover-sample-sources: groups listed", {
    streamGroups: listingCount(streamGroups, 0),
    streamListing: streamGroups.kind,
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
// Stage 2: the chosen mode's surface
// ---------------------------------------------------------------------------

/** Options for {@link loadSampleSources}. */
export interface LoadSampleSourcesOptions {
  /** Which surface to read. */
  mode: AcquisitionMode;
  /**
   * The worker group whose sources to list. Required for `live-capture`;
   * IGNORED for `lake-query`, which is a leader route.
   */
  groupId?: string;
  /** Lake id to list datasets from; defaults to {@link DEFAULT_LAKE_ID}. */
  lakeId?: string;
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
 * Stage two: read the chosen mode's surface, and ONLY that one. The other stays
 * `pending` in the returned inventory rather than rendering as empty - the
 * operator has not asked about it, so nothing may be claimed.
 */
export async function loadSampleSources(
  cribl: CriblClient,
  options: LoadSampleSourcesOptions,
  logger?: Logger,
): Promise<SampleSourceInventory> {
  const input: InventoryInput = {};

  if (options.mode === "lake-query") {
    const lakeId = options.lakeId ?? DEFAULT_LAKE_ID;
    input.lakeDatasets = await get(cribl, lakeDatasetsPath(lakeId), undefined, logger);
  } else if (options.groupId !== undefined && options.groupId !== "") {
    const section = await get(cribl, SYSTEM_INPUTS_PATH, options.groupId, logger);
    input.criblSources = [{ groupId: options.groupId, section }];
  }

  const inventory = buildSampleSourceInventory(input);
  logger?.info("discover-sample-sources: inventory built", {
    mode: options.mode,
    group: options.groupId ?? "(none)",
    entries: inventory.sections.reduce((n, s) => n + s.entries.length, 0),
  });
  return inventory;
}
