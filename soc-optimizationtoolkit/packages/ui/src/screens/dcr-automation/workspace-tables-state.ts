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
 */

import type { DcrInventoryEntry, WorkspaceTable } from "@soc/core";

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
    return {
      verdict: "unchecked",
      message:
        "Load the table list to check whether this name is already taken. " +
        "Creating over an existing table replaces its schema.",
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
