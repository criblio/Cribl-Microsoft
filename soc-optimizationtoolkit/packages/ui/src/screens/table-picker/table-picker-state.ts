/**
 * The PURE decisions behind pointing gap analysis at a real workspace table.
 *
 * THE THREE CAPABILITY RULES, and where each one lives after 2026-08-18:
 *
 *   1. A denied `table.read` never removes the attempt. Once this was an
 *      annotation beside a Load button; there is no button now - the listing is
 *      unconditional - so the rule holds STRUCTURALLY, and is pinned as such in
 *      use-workspace-tables.dom.test.tsx.
 *   2. Reads have NO fallback artifact. There is no "download the thing someone
 *      else runs" for a listing, so the honest note IS the whole answer. The
 *      note offers a retry and nothing besides.
 *   3. An empty result is only a zero once the read was verified
 *      (docs/inventory-standard.md, BINDING). {@link emptyTableListMessage}
 *      decides that, and it is the last of the three still expressed here.
 *
 * `deriveTablePickerAccess` and `TablePickerAccess` were DELETED with the panel.
 * They said what to EXPECT before loading, which mattered while the operator had
 * to press Load and wanted to know whether it was worth it. The listing now runs
 * on mount, so the real answer arrives in the same second and a prediction of it
 * was noise - and worse, a prediction that disagreed with the outcome would have
 * been two answers to one question.
 *
 * Pure: no IO, no React, no clock.
 */

import type { CapabilityContext, CapabilitySet } from "@soc/core";
import { AUDITED_SCOPE, emptyInventoryMessage } from "../../capabilities/empty-inventory";
import type { EmptyInventoryMessage } from "../../capabilities/empty-inventory";

/**
 * What to say when the listing COMPLETED and returned nothing.
 *
 * docs/inventory-standard.md names this lister explicitly: `listWorkspaceTables`
 * throws on a non-2xx, which covers an explicit denial, but an RBAC-filtered
 * `200 []` is byte-identical to a genuinely empty workspace and would read as
 * one. Only a measured `table.read` may call it a zero.
 *
 * SCOPE IS {@link AUDITED_SCOPE} BY CONSTRUCTION, and the caller must keep it
 * that way: the audit's `tables-list` probe runs against the COMMITTED
 * workspace, so this answer is only sound while the picker lists that same
 * workspace. A picker that grows a workspace selector must pass a real scope
 * comparison instead - siblings that browse (Azure targeting, DCR inventory)
 * already do.
 */
export function emptyTableListMessage(
  capabilities: CapabilitySet,
  context: CapabilityContext,
): EmptyInventoryMessage {
  return emptyInventoryMessage({
    noun: "tables",
    capability: "table.read",
    capabilities,
    context,
    scope: AUDITED_SCOPE,
  });
}

// `filterTables` and `tableCountLabel` were DELETED 2026-08-18 with the panel
// they served. Both existed only for the ~842-row browse list above the mapping
// review, which nobody selected from once the destination choice moved onto the
// cards - the listing is now a hook with no surface of its own. The count
// line's "No tables loaded yet." distinction survives as behaviour rather than
// text: a listing in flight renders nothing at all, which is the same claim
// (nothing has been verified yet) made by saying less.
//
// NEITHER CAME BACK. TBL-8 gave the DCR Automation Tables tab a filter and a
// count of its own - `filterWorkspaceTables` in workspace-tables-state.ts -
// after a real workspace returned 843 rows. That listing is ACTIONABLE (a
// Create DCR button per row), which is the condition the deletion set, and the
// new one takes the LISTING rather than an array so its total comes off the
// verified branch. Anyone arriving here by grepping the old names wants that
// file, not a revival of these.

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
