/**
 * What a ROUTABLE pack needs the worker group to already have (GEN-16).
 *
 * THE GAP THIS CLOSES. [[GEN-13]] gave the operator two pack shapes. A routable
 * pack ships no `outputs.yml` and every route carries `output: default`, so the
 * events it processes are handed back to the group and the Sentinel destination
 * has to exist THERE. The operator asked the obvious next question - does
 * choosing routable make the app create that destination in the group? - and
 * the honest answer needed two corrections to get right:
 *
 *   1. The app DOES create a group-level Sentinel destination. onboard-table
 *      (the Deploy action) step 6 POSTs /system/outputs in groupId context -
 *      group scope, no /p/ pack prefix - with a collision-and-reuse scan.
 *   2. But the PACK BUILDER cannot, and this is not an oversight to fix later.
 *      Creating the destination needs the DCR's immutableId, its ingestion
 *      endpoint, and the ingestion client SECRET. The secret is transient by
 *      design: the platform's encrypted KV is write-only and it can never be
 *      read back. A create path at build time would mean asking the operator
 *      for a secret they already gave Deploy.
 *
 * So this module SURFACES the prerequisite instead of triggering it. That is
 * the whole design: report what is missing and name Deploy as the step that
 * creates it, and never block the build - building a pack before deploying, or
 * for a group that will be populated later, is a legitimate thing to do.
 *
 * WHY TWO IDS ARE ACCEPTED PER TABLE. The id Deploy creates and the id the pack
 * generator would use come from two different functions that sanitize
 * differently ([[GEN-18]]): only Deploy's maps non-alphanumerics to "_". They
 * agree for every letters-digits-underscore table name, which is what Sentinel
 * tables are in practice, and diverge for a name carrying a hyphen, dot or
 * space. Matching EITHER means this check cannot report a false "missing" while
 * that divergence stands, and it costs nothing once the two are unified.
 *
 * Pure: no IO, no clock. The caller does the listing.
 */

import { defaultSentinelDestinationId } from "../sentinel-destination";
import { destinationId as packDestinationId } from "../pipeline-generation/naming";

/** Whether one table's Sentinel destination is already in the worker group. */
export interface RoutablePrerequisite {
  /** The Sentinel table this pack routes to. */
  sentinelTable: string;
  /**
   * The id DEPLOY would create for this table - the one to name in guidance,
   * because it is the one the operator will actually end up with.
   */
  expectedId: string;
  /** The id the PACK generator would use. Equal to expectedId unless GEN-18 bites. */
  packId: string;
  /** The output found in the group, or null when neither id matched. */
  foundId: string | null;
}

/** The whole report for one routable pack against one worker group. */
export interface RoutablePrerequisiteReport {
  entries: RoutablePrerequisite[];
  /** Entries with no matching output. Empty means every table is covered. */
  missing: RoutablePrerequisite[];
  /**
   * True when the group listing was EMPTY - no outputs were legible at all.
   *
   * Held separately because it is a different claim from "your destinations are
   * missing", and conflating them is exactly the inventory-standard failure: an
   * empty list is an unknown, not a zero. A group with no outputs and a listing
   * that could not be parsed produce the same empty array here, and neither is
   * evidence that the operator has nothing.
   */
  listingWasEmpty: boolean;
}

/**
 * Match the pack's tables against the outputs a worker group already has.
 *
 * Comparison is case-insensitive, matching the reuse scan in onboard-table step
 * 6 - the two must agree about whether an id is taken, or Deploy would create a
 * second destination this check had just reported as present.
 */
export function checkRoutablePrerequisites(
  sentinelTables: readonly string[],
  existingOutputIds: readonly string[],
): RoutablePrerequisiteReport {
  const have = new Map<string, string>();
  for (const id of existingOutputIds) have.set(id.toLowerCase(), id);

  const entries: RoutablePrerequisite[] = [];
  const seen = new Set<string>();
  for (const sentinelTable of sentinelTables) {
    // One entry per TABLE, not per route: a pack emits a reduction route and a
    // transform route per log type, and several log types can share a table.
    // Reporting the same destination three times would read as three problems.
    if (seen.has(sentinelTable)) continue;
    seen.add(sentinelTable);

    const expectedId = defaultSentinelDestinationId(sentinelTable);
    const packId = packDestinationId(sentinelTable);
    const foundId =
      have.get(expectedId.toLowerCase()) ?? have.get(packId.toLowerCase()) ?? null;
    entries.push({ sentinelTable, expectedId, packId, foundId });
  }

  return {
    entries,
    missing: entries.filter((e) => e.foundId === null),
    listingWasEmpty: existingOutputIds.length === 0,
  };
}
