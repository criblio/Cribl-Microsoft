/**
 * Pure presentation helpers for the DCR inventory's update preview (user
 * feedback 2026-07-13: the before/after column dumps were unreadable walls
 * of text - the preview renders color-coded chips instead, changes first).
 * Color semantics (user direction): GREEN = matches between DCR and table
 * ("unchanged"), RED = in the DCR but not the table ("removed"; type
 * mismatches too), AMBER = in the table but not the DCR ("added").
 *
 * Pure: no IO, no React, no Date.
 */

import type { DcrUpdatePreview } from "@soc/core";

/** One column chip in the merged preview view. */
export interface PreviewColumnChip {
  name: string;
  /** The type the update would install (or the current type for removals). */
  type: string;
  status: "added" | "removed" | "retyped" | "unchanged";
  /** For retyped chips: the type the DCR carries today. */
  fromType?: string;
}

/** Case-insensitive alphabetical order (user direction 2026-07-13). */
function byName(a: PreviewColumnChip, b: PreviewColumnChip): number {
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Merge a preview into one chip list: additions, retypes, and removals
 * FIRST (the decisions), then the matching columns - each group in
 * ALPHABETICAL order so a field is findable among 150 chips.
 */
export function mergePreviewColumns(
  preview: Pick<DcrUpdatePreview, "currentDcrColumns" | "rebuiltDcrColumns" | "diff">,
): PreviewColumnChip[] {
  const added = new Set(preview.diff.added.map((c) => c.name.toLowerCase()));
  const removed = new Set(preview.diff.removed.map((c) => c.name.toLowerCase()));
  const retypedByName = new Map(
    preview.diff.retyped.map((r) => [r.name.toLowerCase(), r]),
  );

  const addedChips: PreviewColumnChip[] = [];
  const retypedChips: PreviewColumnChip[] = [];
  const removedChips: PreviewColumnChip[] = [];
  const unchangedChips: PreviewColumnChip[] = [];
  for (const column of preview.rebuiltDcrColumns) {
    const key = column.name.toLowerCase();
    if (added.has(key)) {
      addedChips.push({ name: column.name, type: column.type, status: "added" });
      continue;
    }
    const retype = retypedByName.get(key);
    if (retype !== undefined) {
      retypedChips.push({
        name: column.name,
        type: retype.to,
        fromType: retype.from,
        status: "retyped",
      });
      continue;
    }
    unchangedChips.push({ name: column.name, type: column.type, status: "unchanged" });
  }
  for (const column of preview.currentDcrColumns) {
    if (removed.has(column.name.toLowerCase())) {
      removedChips.push({ name: column.name, type: column.type, status: "removed" });
    }
  }
  return [
    ...addedChips.sort(byName),
    ...retypedChips.sort(byName),
    ...removedChips.sort(byName),
    ...unchangedChips.sort(byName),
  ];
}

/** One-line human summary of what the update would change. */
export function summarizePreview(
  preview: Pick<DcrUpdatePreview, "currentDcrColumns" | "rebuiltDcrColumns" | "diff">,
): string {
  const { diff } = preview;
  const changes: string[] = [];
  if (diff.added.length > 0) changes.push(`${diff.added.length} added`);
  if (diff.removed.length > 0) changes.push(`${diff.removed.length} removed`);
  if (diff.retyped.length > 0) changes.push(`${diff.retyped.length} retyped`);
  if (changes.length === 0) {
    return `In sync - the DCR already matches the table schema (${diff.unchanged} columns).`;
  }
  return (
    `${preview.currentDcrColumns.length} columns before, ` +
    `${preview.rebuiltDcrColumns.length} after: ${changes.join(", ")}, ` +
    `${diff.unchanged} unchanged.`
  );
}
