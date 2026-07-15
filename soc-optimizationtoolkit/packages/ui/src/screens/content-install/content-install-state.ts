/**
 * Content-install section state (user feature 2026-07-14) - the PURE
 * projections behind the "Enable Sentinel Content" section, kept out of the
 * component so the selection accounting, the installed/installable split, and
 * the outcome summaries are unit-testable without a DOM.
 *
 * Pure: no IO, no fetch, no React.
 */

import { partitionByInstalled } from "@soc/core";
import type {
  AvailableWorkbook,
  InstalledContentState,
  ContentInstallOutcome,
  ParsedAnalyticRule,
} from "@soc/core";

/** A selectable content item with its checked state. */
export interface SelectableRule {
  rule: ParsedAnalyticRule;
  /** Already in the workspace (rendered disabled + "installed"). */
  installed: boolean;
  /** The install-support reason when the rule is not installable at all. */
  unsupportedReason?: string;
}

export interface SelectableWorkbook {
  workbook: AvailableWorkbook;
  installed: boolean;
}

/** Split available rules into installed vs installable by display name. */
export function splitRules(
  rules: readonly ParsedAnalyticRule[],
  state: InstalledContentState,
): { installed: ParsedAnalyticRule[]; installable: ParsedAnalyticRule[] } {
  return partitionByInstalled(rules, state.installedRuleNames, (r) => r.name);
}

/** Split available workbooks into installed vs installable by display name. */
export function splitWorkbooks(
  workbooks: readonly AvailableWorkbook[],
  state: InstalledContentState,
): { installed: AvailableWorkbook[]; installable: AvailableWorkbook[] } {
  return partitionByInstalled(
    workbooks,
    state.installedWorkbookNames,
    (w) => w.displayName,
  );
}

/** How many of `names` are selected (checked and present in the set). */
export function selectedCount(selection: ReadonlySet<string>): number {
  return selection.size;
}

/** A short "N of M selected" label for a group's install button. */
export function selectionLabel(
  selectedNames: ReadonlySet<string>,
  installableCount: number,
): string {
  return `${selectedNames.size} of ${installableCount} selected`;
}

/** Group an outcome list by success for compact rendering. */
export function partitionOutcomes(outcomes: readonly ContentInstallOutcome[]): {
  ok: ContentInstallOutcome[];
  failed: ContentInstallOutcome[];
} {
  return {
    ok: outcomes.filter((o) => o.ok),
    failed: outcomes.filter((o) => !o.ok),
  };
}

/** A stable set with `name` toggled (case-preserving; membership by exact string). */
export function toggleName(
  set: ReadonlySet<string>,
  name: string,
): Set<string> {
  const next = new Set(set);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/** Select every installable name (the "select all" affordance). */
export function selectAll(names: readonly string[]): Set<string> {
  return new Set(names);
}
