/**
 * Pure editing and validation for a HAND-AUTHORED custom table schema
 * (TBL-1). Kept out of the screen so the row operations and the per-row
 * verdicts are testable without a DOM, exactly as `custom-schema-state`
 * already is for the vendor/file/existing sources.
 *
 * WHY THIS EXISTS AT ALL. The three shipped schema sources all CONSUME a
 * schema somebody else authored - a bundled vendor entry, a pasted JSON
 * file, or a table that already exists in the workspace. An operator with a
 * new log source and no schema file has no path through the screen. This
 * module is the fourth source's state, and it deliberately produces the SAME
 * `CustomSchemaFileColumn[]` shape the file path produces, so everything
 * downstream - validateCustomTableSchema, the reserved-name strip, the
 * TimeGenerated injection, the creation payload - is reached unchanged.
 *
 * WHAT IT DOES NOT VALIDATE, and why that is deliberate: there is no column
 * NAME rule here beyond blank and duplicate. The domain has no charset or
 * leading-character rule for column names - `validateCustomTableSchema`
 * checks only that a name and type are present - so inventing one would mean
 * this editor rejecting names Azure would have accepted, on a rule nobody
 * measured. Blank and duplicate are different: both are provably wrong
 * before the request is sent, and a duplicate in particular would otherwise
 * reach the tables PUT as two columns with one name.
 */

import { CUSTOM_COLUMN_TYPES } from "@soc/core";
import type { CustomSchemaFileColumn } from "@soc/core";

/**
 * One row of the field editor.
 *
 * The `id` is the row's identity for editing and for React keys, and is NOT
 * the column name - a rename must not look like a delete plus an insert, or
 * the focused input loses focus mid-word.
 */
export interface ManualColumnDraft {
  id: string;
  name: string;
  type: string;
}

/** The default type for a newly added row - the tables API's own default. */
export const DEFAULT_MANUAL_COLUMN_TYPE = "string";

/** What is wrong with one row, if anything. */
export type ManualColumnIssue = "blank-name" | "duplicate-name" | "unknown-type";

/** Per-row verdict for the editor to render beside the inputs. */
export interface ManualRowStatus {
  id: string;
  issues: ManualColumnIssue[];
  /** Blocking - the run cannot proceed while true. */
  blocking: boolean;
  /** Operator-facing sentence, or null when the row is fine. */
  message: string | null;
}

/**
 * The next row id: one past the highest numeric id in use.
 *
 * DERIVED FROM THE ROWS rather than a counter held beside them, so the
 * function stays pure and a test can assert ids without threading a seed
 * through every call. Ids are never reused within a session because removal
 * cannot lower the maximum of the rows that remain... except when the LAST
 * row is removed, which is fine: nothing holds a reference to a row that is
 * gone.
 */
function nextManualId(rows: readonly ManualColumnDraft[]): string {
  let highest = 0;
  for (const row of rows) {
    const parsed = Number.parseInt(row.id, 10);
    if (Number.isFinite(parsed) && parsed > highest) highest = parsed;
  }
  return String(highest + 1);
}

/** A fresh editor: ONE empty row, so the operator has somewhere to type. */
export function emptyManualColumns(): ManualColumnDraft[] {
  return [{ id: "1", name: "", type: DEFAULT_MANUAL_COLUMN_TYPE }];
}

/** Append a blank row. */
export function addManualColumn(
  rows: readonly ManualColumnDraft[],
): ManualColumnDraft[] {
  return [
    ...rows,
    { id: nextManualId(rows), name: "", type: DEFAULT_MANUAL_COLUMN_TYPE },
  ];
}

/**
 * Remove one row. Removing the LAST row leaves one blank row rather than an
 * empty editor - an editor with no rows offers the operator nothing to do
 * and reads as broken.
 */
export function removeManualColumn(
  rows: readonly ManualColumnDraft[],
  id: string,
): ManualColumnDraft[] {
  const kept = rows.filter((row) => row.id !== id);
  return kept.length === 0 ? emptyManualColumns() : kept;
}

/** Edit one row's name and/or type, leaving every other row identical. */
export function updateManualColumn(
  rows: readonly ManualColumnDraft[],
  id: string,
  patch: Partial<Pick<ManualColumnDraft, "name" | "type">>,
): ManualColumnDraft[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

/**
 * The rows that carry a name, as the schema shape the rest of the pipeline
 * consumes.
 *
 * A ROW WITH A BLANK NAME IS SKIPPED, not sent as an unnamed column: the
 * editor always holds at least one row, so a trailing blank is the normal
 * resting state of a finished schema rather than a mistake. Names are
 * trimmed, because a trailing space in a column name is never intended and
 * Azure would keep it.
 */
export function manualColumnsToSchema(
  rows: readonly ManualColumnDraft[],
): CustomSchemaFileColumn[] {
  return rows
    .map((row) => ({ name: row.name.trim(), type: row.type }))
    .filter((column) => column.name !== "");
}

/**
 * Per-row verdicts, in row order.
 *
 * DUPLICATES MARK EVERY COPY, not just the second one. The operator has to
 * decide which of the two is wrong, and marking only the later one implies
 * the earlier is the keeper - which it may not be.
 */
export function manualRowStatuses(
  rows: readonly ManualColumnDraft[],
): ManualRowStatus[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    if (key === "") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return rows.map((row) => {
    const name = row.name.trim();
    const issues: ManualColumnIssue[] = [];

    // A blank row is only a PROBLEM when it is not the resting trailing row -
    // and since the editor cannot tell intent, a blank name is reported as a
    // non-blocking note. manualColumnsToSchema skips it either way.
    if (name === "") {
      issues.push("blank-name");
    } else if ((counts.get(name.toLowerCase()) ?? 0) > 1) {
      issues.push("duplicate-name");
    }

    if (!(CUSTOM_COLUMN_TYPES as readonly string[]).includes(row.type)) {
      issues.push("unknown-type");
    }

    const blocking =
      issues.includes("duplicate-name") || issues.includes("unknown-type");

    let message: string | null = null;
    if (issues.includes("duplicate-name")) {
      message = `Another column is also named '${name}'. Names must be unique.`;
    } else if (issues.includes("unknown-type")) {
      message =
        `'${row.type}' is not a type the tables API accepts. Choose one of: ` +
        `${CUSTOM_COLUMN_TYPES.join(", ")}.`;
    } else if (issues.includes("blank-name")) {
      message = "Name this column, or remove the row.";
    }

    return { id: row.id, issues, blocking, message };
  });
}

/**
 * The blocking problems across all rows, as whole-schema error sentences.
 *
 * Feeds the same `errors` list the file and vendor sources populate, so the
 * screen's existing "cannot proceed" rendering covers this source too rather
 * than growing a parallel one. Deduplicated: one duplicate name marks two
 * rows but is ONE problem to fix.
 */
export function manualSchemaErrors(
  rows: readonly ManualColumnDraft[],
): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const status of manualRowStatuses(rows)) {
    if (!status.blocking || status.message === null) continue;
    if (seen.has(status.message)) continue;
    seen.add(status.message);
    errors.push(status.message);
  }
  return errors;
}
