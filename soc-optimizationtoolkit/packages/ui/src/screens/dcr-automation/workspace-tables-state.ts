/**
 * Pure decisions for the Tables tab (TBL-3): no IO, no React, no clock.
 *
 * The panel lists the workspace's tables and says, per row, whether a DCR
 * already targets that table - because the thing this surface exists to
 * prevent is an operator building a DCR for a table that already has one.
 *
 * THE THIRD VERDICT IS THE POINT. `listDcrInventory` is scoped to ONE resource
 * group, so a DCR in a different group targeting the same table is invisible
 * here. Two verdicts would force that invisible case into "no", which is a
 * confident wrong answer of exactly the kind the inventory standard exists to
 * refuse. So a row says `has` (a DCR was found), `none-in-scope` (the group
 * was read and nothing in it targets this table), or `unchecked` (the DCR
 * listing was not read at all) - and the panel words each differently.
 *
 * This is NOT `emptyTableListMessage`'s question. That decides what an EMPTY
 * LIST means; this decides what an UNMATCHED ROW means. Folding them would
 * make one sentence answer two questions.
 *
 * TBL-8 ADDED A THIRD KIND OF NOTHING to keep apart from those two, because a
 * real workspace returned 843 tables and the panel grew a name filter. "No row
 * matched what you typed" is a fact about the FILTER; it borrows neither the
 * empty-list wording (a claim about the workspace) nor the unmatched-row
 * wording (a claim about a DCR). All three states live in this file precisely
 * so the differences are visible in one place.
 */

import { filterListing, listingRows } from "@soc/core";
import type { DcrInventoryEntry, Listing, WorkspaceTable } from "@soc/core";

/** Whether a DCR already targets a table, and how confidently we know. */
export type DcrPresence = "has" | "none-in-scope" | "unchecked";

/** One rendered row of the tables listing. */
export interface WorkspaceTableRow {
  name: string;
  kind: "custom" | "native";
  /** Retention as rendered; null in the source means the workspace default. */
  retentionLabel: string;
  /** Table plan as rendered; "" in the source becomes a dash. */
  planLabel: string;
  dcr: DcrPresence;
  /** Names of the DCRs targeting this table, in listing order. */
  dcrNames: string[];
}

/**
 * Join the table listing to the DCR listing.
 *
 * `dcrEntries` is null when the DCR listing was not read - every row is then
 * `unchecked`, never `none-in-scope`. That distinction is the whole reason
 * this function takes a nullable argument rather than an empty array: an empty
 * array is a MEASURED zero and null is an absence of measurement, and
 * collapsing them is how "we did not look" becomes "there is none".
 *
 * Matching is case-insensitive because Log Analytics table names are, and
 * because `DcrInventoryEntry.tables` is derived by stripping a stream prefix
 * rather than read from the table resource.
 */
export function buildWorkspaceTableRows(
  tables: readonly WorkspaceTable[],
  dcrEntries: readonly DcrInventoryEntry[] | null,
): WorkspaceTableRow[] {
  const byTable = new Map<string, string[]>();
  if (dcrEntries !== null) {
    for (const entry of dcrEntries) {
      for (const table of entry.tables) {
        const key = table.toLowerCase();
        const names = byTable.get(key);
        if (names === undefined) {
          byTable.set(key, [entry.name]);
        } else if (!names.includes(entry.name)) {
          names.push(entry.name);
        }
      }
    }
  }

  return tables.map((table) => {
    const dcrNames = byTable.get(table.name.toLowerCase()) ?? [];
    const dcr: DcrPresence =
      dcrEntries === null
        ? "unchecked"
        : dcrNames.length > 0
          ? "has"
          : "none-in-scope";
    return {
      name: table.name,
      kind: table.kind,
      // null is "not reported", which for a Log Analytics table means it
      // inherits the workspace default - rendering the raw null would print
      // "null" and rendering 0 would be a lie.
      retentionLabel:
        table.retentionInDays === null
          ? "workspace default"
          : String(table.retentionInDays),
      planLabel: table.plan === "" ? "-" : table.plan,
      dcr,
      dcrNames,
    };
  });
}

/**
 * The same join, over the LISTING rather than its rows (TBL-8).
 *
 * The filter below renders a count, and a count is only honest when it came
 * from the `rows` branch - so the row build must not be the place the listing
 * gets flattened into an array. `filterListing` is the right carrier even
 * though nothing is being filtered out here: this derivation is 1:1, so it
 * PRESERVES the source's kind, and an unverified `empty` stays unverified all
 * the way to the thing that would otherwise count it.
 */
export function buildWorkspaceTableListing(
  tables: Listing<WorkspaceTable>,
  dcrEntries: readonly DcrInventoryEntry[] | null,
): Listing<WorkspaceTableRow> {
  // The sanctioned use of the escape hatch: rows to map over, saying nothing
  // about emptiness - the emptiness is being CARRIED, by the line it wraps.
  return filterListing(
    tables,
    buildWorkspaceTableRows(listingRows(tables), dcrEntries),
  );
}

/**
 * The wording BOTH substring filters use - this panel and the Logs screen
 * (TBL-8).
 *
 * Not a coincidence to be tidied later: two substring filters that describe
 * themselves differently teach an operator that they behave differently.
 *
 * SHARED RATHER THAN COPIED, and the difference is load-bearing. The first
 * version of this pinned the literal in a test and called it "the Logs screen's
 * wording, verbatim" - which was a claim about a file the pin never read, so
 * editing logs-screen.tsx left the pin green and the two screens diverged
 * silently. logs-screen.tsx now imports this constant, so parity is enforced by
 * the compiler instead of asserted by a comment.
 */
export const TABLE_FILTER_PLACEHOLDER = "substring, case-insensitive";

/** What the filter leaves for the panel to render. */
export interface WorkspaceTableFilterView {
  /** The rows that matched - all of them when no filter is set. */
  rows: readonly WorkspaceTableRow[];
  /** The count line, or null when there is no measured total to count. */
  countLabel: string | null;
  /**
   * Set ONLY when a filter is active and matched nothing. Null otherwise -
   * including for an unverified listing, whose emptiness is a different
   * question with a different owner ({@link WorkspaceTableFilterView} says
   * nothing about the workspace).
   */
  noMatchMessage: string | null;
}

/**
 * Narrow the listing to the rows whose NAME contains `filter`.
 *
 * Case-insensitive substring, matching the Logs screen's Text filter rather
 * than inventing a second dialect. Client-side over rows already loaded: it
 * issues nothing, and it does not touch the DCR join - a filtered row carries
 * the same `dcr` verdict and the same `dcrNames` it had unfiltered, because
 * the join happened before this ran.
 *
 * TWO HONESTY RULES, and they are why this is a function rather than a
 * `.filter()` in the JSX:
 *
 *   1. THE TOTAL COMES OFF THE `rows` BRANCH. `843` in "showing 12 of 843" is a
 *      count derived from an ARM listing, and an RBAC-filtered list returns 200
 *      with nothing (docs/inventory-standard.md) - so a total taken after an
 *      unwrap could be a zero nobody measured. Narrowing first makes it
 *      non-empty BY TYPE.
 *   2. NO MATCHES IS A FACT ABOUT THE FILTER, never about the workspace. The
 *      panel's `emptyTableListMessage` answers "is this workspace empty, or
 *      can we not see it?" - a question this function has no business
 *      answering, and reusing its wording here would tell an operator their
 *      workspace is empty because they typed four letters. `filterListing`
 *      keeps the two apart structurally: over a source that HAS rows it mints
 *      a verified `none` (zero matches, measured), and over an unverified
 *      `empty` it propagates `empty` and there is nothing to say at all.
 */
export function filterWorkspaceTables(
  listing: Listing<WorkspaceTableRow>,
  filter: string,
): WorkspaceTableFilterView {
  const needle = filter.trim().toLowerCase();

  // No rows: nothing to filter, no total to count, and nothing about the
  // filter worth saying. The empty-listing message already owns this space,
  // and a second sentence here would be a second answer to one question.
  if (listing.kind !== "rows") {
    return { rows: [], countLabel: null, noMatchMessage: null };
  }
  const total = listing.rows.length;

  if (needle === "") {
    return {
      rows: listing.rows,
      countLabel: tableCount(total),
      noMatchMessage: null,
    };
  }

  const matched = listing.rows.filter((row) =>
    row.name.toLowerCase().includes(needle),
  );
  const result = filterListing(listing, matched);
  if (result.kind === "rows") {
    return {
      rows: result.rows,
      countLabel: `showing ${result.rows.length} of ${tableCount(total)}`,
      noMatchMessage: null,
    };
  }
  return {
    rows: [],
    countLabel: null,
    noMatchMessage: noFilterMatchMessage(filter.trim(), total),
  };
}

/** Both counts here are measured, so only the grammar is left to get right. */
function tableCount(total: number): string {
  return `${total} ${total === 1 ? "table" : "tables"}`;
}

/**
 * What to say when the filter matched nothing.
 *
 * Every clause is about the FILTER. It names what was typed, says the listing
 * is unchanged, quotes the measured total that is still there, and gives the
 * way out - so there is no reading of it under which the workspace is the thing
 * that came back empty.
 */
function noFilterMatchMessage(filter: string, total: number): string {
  return (
    `No table matches "${filter}". The listing is unchanged - ` +
    `${tableCount(total)} loaded, hidden by this filter. ` +
    "Clear it to see them all."
  );
}

/**
 * The per-row DCR cell text.
 *
 * `none-in-scope` NAMES THE SCOPE rather than saying "no", because the listing
 * only ever saw one resource group. Callers pass the group they read.
 */
export function dcrCellLabel(
  row: WorkspaceTableRow,
  resourceGroup: string,
): string {
  if (row.dcr === "unchecked") return "not checked";
  if (row.dcr === "has") return row.dcrNames.join(", ");
  return `none in ${resourceGroup}`;
}

/**
 * Whether a proposed table name is already taken (TBL-2).
 *
 * WHY THIS IS NOT COSMETIC: the tables PUT is an UPSERT, exactly like the DCR
 * PUT that `avoidNameCollision` exists to guard. Authoring a schema over a
 * name that already exists does not fail - it REDEFINES a live table's
 * schema, and the first symptom is somebody else's data not arriving.
 *
 * THREE VERDICTS, NOT TWO, for the same reason the DCR column has three: a
 * listing that was never read cannot say a name is free. `tables` is null
 * before the listing runs, and `unchecked` must not block the operator - it
 * only stops the app promising. (`createCustomTable` still GETs before it
 * writes, so an unchecked name is safe to attempt; this check exists to tell
 * the operator BEFORE they fill in a schema, not to be the only guard.)
 */
export type TableNameVerdict = "taken" | "free" | "unchecked";

export interface TableNameCheck {
  verdict: TableNameVerdict;
  /** Operator-facing sentence, or null when there is nothing to say. */
  message: string | null;
  /** Whether the name should stop a create attempt. */
  blocking: boolean;
}

export function checkTableName(
  name: string,
  tables: readonly WorkspaceTable[] | null,
): TableNameCheck {
  const trimmed = name.trim();
  if (trimmed === "") {
    return { verdict: "unchecked", message: null, blocking: false };
  }
  if (tables === null) {
    // `null` now means two different things - never loaded, and loaded but the
    // listing came back unverifiably empty - and this function cannot tell
    // them apart. So the wording must be true of BOTH. The first version named
    // an action ("Load the table list"), which is wrong in the second case
    // because by then the button reads "Refresh"; review caught it pointing at
    // a control that no longer exists under that name.
    return {
      verdict: "unchecked",
      message:
        "The table list has not been read, so this name cannot be checked " +
        "against it. Creating over an existing table replaces its schema.",
      blocking: false,
    };
  }
  const hit = tables.find(
    (t) => t.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (hit !== undefined) {
    return {
      verdict: "taken",
      message:
        `${hit.name} already exists in this workspace. Creating it again ` +
        "would replace its schema - choose another name, or use the " +
        "existing table.",
      blocking: true,
    };
  }
  return { verdict: "free", message: null, blocking: false };
}

/**
 * The header note explaining what the DCR column can and cannot see.
 *
 * Rendered once, above the listing, rather than repeated per row - the caveat
 * is about the whole column.
 */
export function dcrColumnNote(resourceGroup: string): string {
  return (
    `The DCR column covers resource group ${resourceGroup} only. ` +
    "A rule in another group that targets the same table is not visible here."
  );
}
