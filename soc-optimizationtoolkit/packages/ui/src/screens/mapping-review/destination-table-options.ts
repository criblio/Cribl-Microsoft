/**
 * The options in each log type's Destination table override, and what the
 * selector may say about whether a table exists (DBT-250).
 *
 * WHY THE SCHEMA REPOSITORY IS A SOURCE. The override realigns a sample to a
 * different table and re-analyses against that table's schema. The schemas
 * the analysis can resolve without Azure are the Azure-Sentinel repo's
 * KQL-validation tables (~1000) and the bundled DCR-template tables - so those
 * are what an operator can meaningfully pick even when the workspace cannot be
 * read. Before this, the only non-Azure sources were the solution's resolved
 * tables and four hardcoded natives, and on the existing-destination path
 * (GEN-28 switches the workspace listing off there) four is what showed.
 *
 * EXISTENCE IS THREE-VALUED, never inferred from an empty list:
 *   present - the workspace listing was READ and names this table;
 *   absent  - the listing was READ, it was not empty, and this table is not in it;
 *   unknown - the listing did not run, failed, or came back empty. Nothing is
 *             flagged, and every table stays selectable: not being able to see
 *             the workspace must never stop the operator overriding the
 *             analysis or building the pack with the mapping they want.
 *
 * Names are matched case-insensitively (Log Analytics table names are) and the
 * workspace's own spelling wins when both sources carry a table.
 */

import type { SelectOption } from "../../components/searchable-select-filter";

export type WorkspacePresence = "present" | "absent" | "unknown";

export interface DestinationTableSources {
  /** The solution's resolved destination tables. */
  resolved: readonly string[];
  /** Tables the current reports are already analysed against. */
  reported: readonly string[];
  /** Hardcoded common natives - kept so a cold start still offers them. */
  common: readonly string[];
  /** KQL-validation schema-repo table names (best-effort listing). */
  repo: readonly string[];
  /** Bundled DCR-template catalog table names. */
  bundled: readonly string[];
  /** Live workspace table names - only meaningful when `workspaceVerified`. */
  workspace: readonly string[];
  /** True only when the workspace listing completed without error. */
  workspaceVerified: boolean;
}

export interface DestinationTableOption extends SelectOption {
  presence: WorkspacePresence;
}

/** Hint shown on an option the workspace was read and does not contain. */
export const NOT_IN_WORKSPACE_HINT = "not in workspace";

/** Whether `table` is in the workspace, as far as the listing lets us say. */
export function workspacePresence(
  table: string,
  workspace: readonly string[],
  workspaceVerified: boolean,
): WorkspacePresence {
  // An empty listing is not evidence that every table is missing - it is the
  // case inventory-honesty forbids reading as zero.
  if (!workspaceVerified || workspace.length === 0) return "unknown";
  const key = table.toLowerCase();
  return workspace.some((t) => t.toLowerCase() === key) ? "present" : "absent";
}

export function destinationTableOptions(
  sources: DestinationTableSources,
): DestinationTableOption[] {
  const byLower = new Map<string, string>();
  // Workspace first so its spelling wins the dedupe.
  const ordered = [
    sources.workspaceVerified ? sources.workspace : [],
    sources.resolved,
    sources.reported,
    sources.common,
    sources.repo,
    sources.bundled,
    // An unverified listing can still contribute names it did return.
    sources.workspaceVerified ? [] : sources.workspace,
  ];
  for (const list of ordered) {
    for (const t of list) {
      if (t === "") continue;
      const key = t.toLowerCase();
      if (!byLower.has(key)) byLower.set(key, t);
    }
  }
  return [...byLower.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((t) => {
      const presence = workspacePresence(
        t,
        sources.workspace,
        sources.workspaceVerified,
      );
      return presence === "absent"
        ? { value: t, label: t, hint: NOT_IN_WORKSPACE_HINT, presence }
        : { value: t, label: t, presence };
    });
}

/**
 * The note under a card whose chosen table the workspace does not contain.
 * Names the consequence and that nothing is blocked - the pack still builds.
 */
export function absentTableNote(table: string): string {
  return (
    `${table} is not in this workspace. The analysis runs against the schema ` +
    `the schema repository or bundled templates define for it, and the pack ` +
    `can still be built with this mapping, but the table must exist in the ` +
    `workspace before data can land in it.`
  );
}
