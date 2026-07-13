/**
 * Pure presentation helpers for the DCR inventory's update preview (user
 * feedback 2026-07-13: the before/after column dumps were unreadable walls
 * of text - the preview renders color-coded chips instead, changes first,
 * unchanged collapsed).
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

/**
 * Merge a preview into one chip list: additions, retypes, and removals
 * FIRST (the decisions), then the unchanged columns in declaration order.
 */
export function mergePreviewColumns(
  preview: Pick<DcrUpdatePreview, "currentDcrColumns" | "rebuiltDcrColumns" | "diff">,
): PreviewColumnChip[] {
  const added = new Set(preview.diff.added.map((c) => c.name.toLowerCase()));
  const removed = new Set(preview.diff.removed.map((c) => c.name.toLowerCase()));
  const retypedByName = new Map(
    preview.diff.retyped.map((r) => [r.name.toLowerCase(), r]),
  );

  const chips: PreviewColumnChip[] = [];
  for (const column of preview.rebuiltDcrColumns) {
    if (added.has(column.name.toLowerCase())) {
      chips.push({ name: column.name, type: column.type, status: "added" });
    }
  }
  for (const column of preview.rebuiltDcrColumns) {
    const retype = retypedByName.get(column.name.toLowerCase());
    if (retype !== undefined) {
      chips.push({
        name: column.name,
        type: retype.to,
        fromType: retype.from,
        status: "retyped",
      });
    }
  }
  for (const column of preview.currentDcrColumns) {
    if (removed.has(column.name.toLowerCase())) {
      chips.push({ name: column.name, type: column.type, status: "removed" });
    }
  }
  for (const column of preview.rebuiltDcrColumns) {
    const key = column.name.toLowerCase();
    if (!added.has(key) && !retypedByName.has(key)) {
      chips.push({ name: column.name, type: column.type, status: "unchanged" });
    }
  }
  return chips;
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
