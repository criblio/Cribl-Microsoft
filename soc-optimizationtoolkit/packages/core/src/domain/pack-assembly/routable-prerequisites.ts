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
 * ONE ID PER TABLE. This check used to accept either of two ids, because the
 * pack generator and Deploy sanitized table names differently. [[GEN-18]] made
 * the sanitizing rule the only one, and that is the only id matched here.
 *
 * WHICH id, exactly. Deploy names the destination
 * destinationIdFromOptions(table, operator's CriblOptions). GEN-18 alone left
 * this check on the fixed "MS-Sentinel-"/"-dest" default, so an operator with
 * prefix "Sentinel-" deployed Sentinel-SecurityEvent-dest and was told
 * MS-Sentinel-SecurityEvent-dest was missing. The GEN-18 follow-through takes
 * the naming as an argument: passed (the integrate screen passes its
 * criblDefaults, the same object its Deploy and pack plan use), the id matched
 * is the one Deploy creates; omitted, it is the default naming, which equals
 * Deploy's id only when the operator kept the default prefix/suffix. Deploy's
 * collision rename (a -N suffix when the id is taken by an output pointing
 * elsewhere) is not modelled - an output found under the expected id counts as
 * present, matching what Deploy's reuse scan would find.
 *
 * A CHOSEN DESTINATION COUNTS ([[GEN-21]]). An offline operator cannot let
 * Deploy create the destination, so they pick one that already exists in the
 * group - the UAT's PAN-CSL, whose id no naming convention produces. Without
 * `chosenByTable` this check would report that table MISSING under the
 * convention id and tell the operator to run the Deploy they cannot run. A
 * table with a chosen id is matched against THAT id instead, and the entry
 * says so (`chosen`), so guidance for a chosen id that has since vanished can
 * name the picker rather than Deploy. The chosen id still has to be in the
 * listing to count as found: a choice is not evidence the output exists.
 *
 * Pure: no IO, no clock. The caller does the listing.
 */

import type { DestinationNaming } from "../option-forms";
import { destinationId } from "../pipeline-generation";

/** Whether one table's Sentinel destination is already in the worker group. */
export interface RoutablePrerequisite {
  /** The Sentinel table this pack routes to. */
  sentinelTable: string;
  /**
   * The id DEPLOY would create for this table under the naming passed in (the
   * default naming when none was) - the one to name in guidance. The pack
   * plan composes the same id from the same naming (GEN-18 follow-through).
   */
  expectedId: string;
  /** The output found in the group, or null when expectedId did not match. */
  foundId: string | null;
  /**
   * True when expectedId is the operator's chosen existing destination
   * (`chosenByTable`), not the id Deploy would create.
   */
  chosen: boolean;
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
 *
 * `naming` is the operator's destination prefix/suffix - pass the same
 * CriblOptions Deploy is given, or the expected id is the default one.
 *
 * `chosenByTable` maps a Sentinel table to the existing destination id the
 * operator picked for it; a blank id is no choice.
 */
export function checkRoutablePrerequisites(
  sentinelTables: readonly string[],
  existingOutputIds: readonly string[],
  naming?: DestinationNaming,
  chosenByTable?: Readonly<Record<string, string>>,
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

    // A chosen existing destination wins; otherwise the pack plan's own naming
    // function, so the check and the pack cannot compose the id two ways again.
    const choice = chosenByTable?.[sentinelTable]?.trim() ?? "";
    const chosen = choice !== "";
    const expectedId = chosen ? choice : destinationId(sentinelTable, naming);
    const foundId = have.get(expectedId.toLowerCase()) ?? null;
    entries.push({ sentinelTable, expectedId, foundId, chosen });
  }

  return {
    entries,
    missing: entries.filter((e) => e.foundId === null),
    listingWasEmpty: existingOutputIds.length === 0,
  };
}
