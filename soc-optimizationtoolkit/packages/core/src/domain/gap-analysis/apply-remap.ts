/**
 * applyRemap - the ONE rule for pointing a mapping row at a different
 * destination column (GEN-19).
 *
 * WHY THIS EXISTS. The mapping review's Dest Field edit used to change exactly
 * one field of the row, `dest`, and leave everything else as the matcher had
 * left it. An overflow row re-pointed at a real column kept `action: overflow`,
 * and the pipeline emitter writes a Rename only for `action: rename` - so the
 * UAT's PanSrcMac -> SourceMACAddress edit (2026-10-29, PaloAlto-PAN-OS) showed
 * as mapped in the header while the pack still serialized PanSrcMac into
 * AdditionalExtensions. A row's action, destType, coercion flag and confidence
 * all FOLLOW from its destination; this function derives them together, so no
 * caller can set one without the others.
 *
 * THE RULES, per destination:
 *   - The row's BASELINE destination (what the analysis gave it): the baseline
 *     row comes back verbatim. Setting a field back is a revert, not a new
 *     decision, and must read as unmodified (DBT-194).
 *   - The table's CATCH-ALL column: `overflow`, as the matcher writes it.
 *   - Any other schema column: `rename` when the source spelling differs from
 *     the column, otherwise `keep` - or `coerce` when the types differ, which is
 *     what the matcher emits for a same-named column and what makes the
 *     emitter write the conversion. A `decode` row stays `decode`: its source
 *     is encoded, and a rename would land base64 text in the new column.
 *     A column the reviewer chose carries confidence `reviewer`, never the
 *     matcher's `exact` (which the review table defines as identical names).
 *   - A column not in the schema, or a source no row carries: nothing changes,
 *     and the outcome says which.
 *
 * TWO SIDE EFFECTS ARE REPORTED, NOT PERFORMED. `displaced` is the column the
 * source vacates when nothing else lands there any more (it becomes an
 * unmapped destination column). `claimedBy` names another row already landing
 * in the chosen column; that row is left alone, because which of two fields
 * should own a column is the reviewer's call and the caller is the one that
 * can ask.
 *
 * ONCE THE REVIEWER HAS ANSWERED (DBT-208), `moveClaimed` performs the move:
 * the claiming row falls back to the catch-all as overflow - the same row the
 * catch-all rule above writes - and `moved` names it. Two rows left in one
 * column are two Renames onto one name, and the second overwrites the first,
 * so that value reached neither the column nor overflow. With no catch-all in
 * the schema there is nowhere to move it: the claim is left and still
 * reported, and the caller must not store that result.
 *
 * THE ACTION PATH FOLLOWS THE SAME RULE (DBT-209). An action that writes the
 * row into a column (keep, rename, coerce, decode) is only as good as that
 * column, and only this function chooses one. actionEditRefusal says when the
 * Action select would set one on a row with no real column - the catch-all, or
 * none - and the reducer refuses it, so a row in the catch-all comes to land in
 * a column only by the Dest path. It does not guard the other way back: a row
 * the Action select set to overflow or drop keeps its column, and setting it
 * back is not checked against a row that has filled that column since.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { MatchAction } from "../field-matcher/models";
import type { GapFieldMapping } from "./gap-report";
import type { FieldRef } from "./models";

/** What the reviewer asked for. */
export interface RemapRequest {
  /** The source field whose row is re-pointed (exact spelling). */
  sourceField: string;
  /** The destination column chosen (matched case-insensitively to the schema). */
  destColumn: string;
  /** The destination table's resolved schema - supplies the column's type. */
  destSchema: readonly FieldRef[];
  /**
   * The table's catch-all column (AdditionalExtensions for CommonSecurityLog).
   * Choosing it makes the row `overflow`. Omitted, no column is treated as one.
   */
  catchAllColumn?: string;
  /**
   * The analysis's own rows for the table. When the chosen column is the
   * baseline row's destination, the baseline row is restored verbatim.
   */
  baseline?: readonly GapFieldMapping[];
  /**
   * The reviewer chose to MOVE the column from the row already filling it
   * (DBT-208): that row is re-pointed at the catch-all as overflow. Omitted,
   * the claiming row is left alone and reported as `claimedBy`.
   */
  moveClaimed?: boolean;
}

/** How the request was resolved. */
export type RemapOutcome =
  /** The row now lands in the chosen column. */
  | "applied"
  /** The chosen column was the analysis's own; the baseline row is restored. */
  | "reverted"
  /** The row already lands in the chosen column. */
  | "unchanged"
  /** No row carries `sourceField`. */
  | "unknown-source"
  /** `destColumn` is not a column of `destSchema`. */
  | "unknown-column";

export interface RemapResult {
  /** The table's rows after the remap (a new array; the input is not mutated). */
  rows: GapFieldMapping[];
  outcome: RemapOutcome;
  /**
   * The real column the source vacated and no other row still lands in - it
   * is now an unmapped destination column. Null when nothing was vacated.
   */
  displaced: FieldRef | null;
  /**
   * The source of another row that ALSO lands in the chosen column after the
   * remap. Null when the column was free (or is the catch-all, which takes any
   * number of fields).
   */
  claimedBy: string | null;
  /**
   * The source of the row `moveClaimed` sent from the chosen column to the
   * catch-all. Null when nothing was moved.
   */
  moved: string | null;
}

/** Whether a row's value reaches a dedicated destination column. */
export function landsInColumn(row: GapFieldMapping): boolean {
  return row.action !== "overflow" && row.action !== "drop" && row.dest !== "";
}

/** The actions that write a row into its Dest Field column (DBT-209). */
const COLUMN_ACTIONS: readonly MatchAction[] = [
  "keep",
  "rename",
  "coerce",
  "decode",
];

/**
 * Why the Action select may not set `action` on `row`, or null when it may
 * (DBT-209). keep, rename, coerce and decode each write the row into its Dest
 * Field column, so they need a real one: on a row whose dest is the catch-all
 * (or empty) a rename is a Rename onto the catch-all, which overwrites the
 * serialized overflow, and a keep sends the field to the DCR under its raw
 * name, where it is discarded. Only the Dest path (applyRemap above) chooses a
 * column, and it derives the action with it - so the Action path REFUSES
 * rather than guessing a column, and the reason names the Dest path. overflow
 * and drop need no column and are always allowed.
 */
export function actionEditRefusal(
  row: GapFieldMapping,
  action: MatchAction,
  catchAllColumn?: string,
): string | null {
  if (!COLUMN_ACTIONS.includes(action)) return null;
  return columnlessRefusal(`${action} needs`, row, catchAllColumn);
}

/**
 * actionEditRefusal for every column action at once - the one sentence the
 * Action select shows on a row that has no real column. Null when it has one.
 */
export function columnActionsRefusal(
  row: GapFieldMapping,
  catchAllColumn?: string,
): string | null {
  const names = COLUMN_ACTIONS.join(", ").replace(/, (\w+)$/, " and $1");
  return columnlessRefusal(`${names} need`, row, catchAllColumn);
}

function columnlessRefusal(
  subject: string,
  row: GapFieldMapping,
  catchAllColumn: string | undefined,
): string | null {
  const way = "choose a column in Dest Field first, which sets the action for you.";
  if (row.dest === "") {
    return `${subject} a destination column, and ${row.source} has none: ${way}`;
  }
  if (
    catchAllColumn !== undefined &&
    row.dest.toLowerCase() === catchAllColumn.toLowerCase()
  ) {
    return `${subject} a destination column, and ${row.dest} is the catch-all: ${way}`;
  }
  return null;
}

/** Describe the reviewer's choice in the row's description column. */
function reviewerDescription(source: string, column: string): string {
  return `Reviewer choice: ${source} -> ${column}`;
}

/** The row re-pointed at `column`, with every dependent field derived. */
function remappedRow(
  row: GapFieldMapping,
  column: FieldRef,
  isCatchAll: boolean,
): GapFieldMapping {
  if (isCatchAll) {
    return {
      ...row,
      dest: column.name,
      destType: column.type,
      confidence: "unmatched",
      action: "overflow",
      needsCoercion: false,
      description: `Reviewer choice: collected into ${column.name}`,
    };
  }
  if (row.action === "decode") {
    return {
      ...row,
      dest: column.name,
      destType: column.type,
      confidence: "reviewer",
      needsCoercion: false,
      description: reviewerDescription(row.source, column.name),
    };
  }
  // The matcher's own coercion test (match-fields.ts): an unknown type on
  // either side is not evidence of a mismatch.
  const needsCoercion =
    row.sourceType !== column.type &&
    row.sourceType !== "" &&
    column.type !== "";
  const action =
    row.source !== column.name ? "rename" : needsCoercion ? "coerce" : "keep";
  return {
    ...row,
    dest: column.name,
    destType: column.type,
    confidence: "reviewer",
    action,
    needsCoercion,
    description: reviewerDescription(row.source, column.name),
  };
}

/** Re-point one row at a destination column (see the module header). */
export function applyRemap(
  rows: readonly GapFieldMapping[],
  request: RemapRequest,
): RemapResult {
  const index = rows.findIndex((r) => r.source === request.sourceField);
  const unchangedResult = (outcome: RemapOutcome): RemapResult => ({
    rows: [...rows],
    outcome,
    displaced: null,
    claimedBy: null,
    moved: null,
  });
  if (index === -1) {
    return unchangedResult("unknown-source");
  }
  const row = rows[index];
  if (row.dest === request.destColumn) {
    return unchangedResult("unchanged");
  }

  const wanted = request.destColumn.toLowerCase();
  const baselineRow = request.baseline?.find((r) => r.source === row.source);
  let next: GapFieldMapping;
  let outcome: RemapOutcome;
  if (baselineRow !== undefined && baselineRow.dest.toLowerCase() === wanted) {
    next = { ...baselineRow };
    outcome = "reverted";
  } else {
    const column =
      request.destSchema.find((c) => c.name === request.destColumn) ??
      request.destSchema.find((c) => c.name.toLowerCase() === wanted);
    if (column === undefined) {
      return unchangedResult("unknown-column");
    }
    const isCatchAll =
      request.catchAllColumn !== undefined &&
      request.catchAllColumn.toLowerCase() === column.name.toLowerCase();
    next = remappedRow(row, column, isCatchAll);
    outcome = "applied";
  }

  const nextRows = rows.map((r, i) => (i === index ? next : r));

  const landingIn = (column: string): GapFieldMapping | undefined =>
    nextRows.find(
      (r, i) =>
        i !== index &&
        landsInColumn(r) &&
        r.dest.toLowerCase() === column.toLowerCase(),
    );

  // DBT-208: the reviewer chose to move the column from the row filling it.
  // Every claimant moves (an analysis can already leave two in one column),
  // and `moved` names the first.
  let moved: string | null = null;
  const catchAllName = request.catchAllColumn?.toLowerCase();
  const catchAll = request.destSchema.find(
    (c) => c.name.toLowerCase() === catchAllName,
  );
  if (request.moveClaimed === true && catchAll !== undefined && landsInColumn(next)) {
    for (let claimant = landingIn(next.dest); claimant !== undefined; claimant = landingIn(next.dest)) {
      nextRows[nextRows.indexOf(claimant)] = remappedRow(claimant, catchAll, true);
      moved ??= claimant.source;
    }
  }

  const vacated =
    landsInColumn(row) && row.dest.toLowerCase() !== next.dest.toLowerCase();
  const displaced =
    vacated && landingIn(row.dest) === undefined
      ? { name: row.dest, type: row.destType }
      : null;
  const claimedBy = landsInColumn(next)
    ? (landingIn(next.dest)?.source ?? null)
    : null;

  return { rows: nextRows, outcome, displaced, claimedBy, moved };
}
