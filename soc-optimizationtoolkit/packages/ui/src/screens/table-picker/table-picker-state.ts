/**
 * Table picker state - the PURE decisions behind choosing a workspace table to
 * run DCR gap analysis against.
 *
 * TWO RULES FROM THE CAPABILITY MODEL apply here, and this is the first feature
 * to exercise them rather than the nav:
 *
 *   1. A DENIED `table.read` ANNOTATES the picker; it never hides or disables
 *      it. The audit informs and offers, and Azure's own 403 is the real gate -
 *      so the operator can still press Load and find out.
 *   2. Reads have NO fallback artifact. There is no "download the thing someone
 *      else runs" for a listing, so the annotation IS the whole answer. A
 *      surface that implied otherwise would be inventing a workaround.
 *
 * Pure: no IO, no React, no clock.
 */

import { unavailableReason, verdictFor } from "@soc/core";
import type {
  CapabilityContext,
  CapabilitySet,
  WorkspaceTable,
} from "@soc/core";

/** What the picker should say about its own availability. */
export interface TablePickerAccess {
  /** Whether loading is worth presenting as expected to work. */
  expectedToWork: boolean;
  /**
   * The honest note, or null when nothing needs saying. Never null merely
   * because the verdict is bad - a denial has the most to say.
   */
  note: string | null;
  /**
   * ALWAYS true. Kept explicit rather than implied so the rule is visible at
   * the call site: the operator may always attempt the load, whatever the audit
   * says, because a stale or wrong audit must not cost them the attempt.
   */
  loadable: true;
}

/**
 * What to tell the operator about their access before they load.
 *
 * `table.read` is the capability, and it is already measured by the audit - no
 * new probing. `unavailableReason` supplies the wording so the picker and the
 * nav cannot describe the same verdict differently.
 */
export function deriveTablePickerAccess(
  capabilities: CapabilitySet,
  context: CapabilityContext,
): TablePickerAccess {
  const verdict = verdictFor("table.read", capabilities, context);
  return {
    expectedToWork: verdict === "granted",
    note: unavailableReason("table.read", capabilities, context),
    loadable: true,
  };
}

/** Case-insensitive substring filter over table names, order preserved. */
export function filterTables(
  tables: readonly WorkspaceTable[],
  query: string,
): WorkspaceTable[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [...tables];
  }
  return tables.filter((table) => table.name.toLowerCase().includes(needle));
}

/** The count line under the list; states the filter rather than hiding it. */
export function tableCountLabel(total: number, shown: number): string {
  if (total === 0) {
    return "No tables loaded yet.";
  }
  return shown === total
    ? `${total} table${total === 1 ? "" : "s"}`
    : `${shown} of ${total} tables`;
}

/**
 * The warning shown once a table is selected while an analysis already exists.
 *
 * The selection INVALIDATES that analysis: every mapping, coverage and overflow
 * verdict in it was computed against a different destination schema. The
 * decision (user, 2026-08-10) is that the old results go STALE while the new run
 * loads rather than being cleared - so this text has to say the results on
 * screen are about the previous table, not merely that something is loading.
 */
export const ANALYSIS_STALE_NOTICE =
  "These results are for the previously selected table. Re-running the gap analysis against the new table's schema.";
