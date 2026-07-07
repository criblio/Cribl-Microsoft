/**
 * Browse-samples state - the PURE decisions behind the Integrate page's
 * Browse Samples modal (porting-plan Unit 16 UI, ENG-19/20/41/42; completes
 * GUI-06). Kept out of the component so every decision is unit-testable without
 * a DOM, a store, or a fetch.
 *
 * @soc/core owns ALL acquisition (browseSamplesDetailed / loadSamples lazily
 * fetch a solution's Sample-Data + Elastic test files through the ports and run
 * the ENG-42 scorer / ENG-19 split cascade). This module only shapes those
 * results for the modal:
 *
 *   - tier PROJECTION: group the flat browse-list into per-tier groups in a
 *     stable display order (sentinel-repo > elastic > cribl > synthesized), each
 *     with its previews and event total.
 *   - SELECT-ALL indeterminate state per tier (none / some / all selected).
 *   - per-tier + overall LOAD SUMMARY derivation (selected count + event total).
 *   - preIngested MESSAGE selection: classify the ENG-42 RepoSampleResult into
 *     one of its three honest user-facing messages (found / all-pre-ingested /
 *     matched-but-none-parsed) plus the no-candidate case, with a display tone.
 *   - resolved -> TaggedSample conversion for the load step (browse never
 *     commits: nothing touches the store until the user loads a selection).
 *
 * Selection is keyed by the STABLE core browse/load id (`${source}:${logType}`)
 * so a selection survives re-render (the ID-stability footgun) - callers use the
 * same id as the React key AND the selection-set member.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto. (browseSamplesDetailed /
 * loadSamples are the impure seam and live in the component + the usecase.)
 */

import type {
  AvailableSample,
  RepoSampleResult,
  ResolvedSample,
  TaggedSample,
} from "@soc/core";
import { tagSampleFromContent } from "./sample-intake-state";

/** The browsable tiers (the "user" tier is never browsed - it is what you tag). */
export type BrowseTier = AvailableSample["tier"];

/**
 * The tier DISPLAY order for the modal, highest-precedence first (mirrors the
 * core TIER_PRECEDENCE, with the browse-only sentinel-repo tier surfaced first).
 * A tier only renders when it has at least one entry.
 */
export const BROWSE_TIER_ORDER: readonly BrowseTier[] = [
  "sentinel-repo",
  "elastic",
  "cribl",
  "synthesized",
];

const TIER_LABELS: Record<BrowseTier, string> = {
  "sentinel-repo": "Sentinel Repo",
  elastic: "Elastic Integrations",
  cribl: "Cribl Packs",
  synthesized: "Synthesized",
};

const TIER_DESCRIPTIONS: Record<BrowseTier, string> = {
  "sentinel-repo":
    "Raw vendor samples curated in the Microsoft Sentinel solution's Sample Data.",
  elastic:
    "Test events from the matching Elastic integration package, split by log type.",
  cribl: "Sample events shipped inside the matching Cribl pack.",
  synthesized:
    "Schema-driven synthetic events generated when no real samples are found.",
};

/** The human label for a browse tier. */
export function tierLabel(tier: BrowseTier): string {
  return TIER_LABELS[tier];
}

/** The one-line description for a browse tier. */
export function tierDescription(tier: BrowseTier): string {
  return TIER_DESCRIPTIONS[tier];
}

/** One tier's group in the modal: its label, its entries, and their event total. */
export interface BrowseTierGroup {
  tier: BrowseTier;
  label: string;
  description: string;
  /** The browse-list entries in this tier, in the order the core returned them. */
  entries: AvailableSample[];
  /** Sum of eventCount across the tier's entries. */
  eventTotal: number;
}

/**
 * Group the flat browse-list into per-tier groups in {@link BROWSE_TIER_ORDER}.
 * Only tiers with at least one entry are returned; within a tier the input order
 * is preserved (the core already ordered them). Unknown tiers (forward-compat)
 * are appended after the known ones in first-seen order.
 */
export function projectTiers(
  available: readonly AvailableSample[],
): BrowseTierGroup[] {
  const byTier = new Map<BrowseTier, AvailableSample[]>();
  for (const entry of available) {
    const list = byTier.get(entry.tier);
    if (list === undefined) {
      byTier.set(entry.tier, [entry]);
    } else {
      list.push(entry);
    }
  }

  const groups: BrowseTierGroup[] = [];
  const seen = new Set<BrowseTier>();
  const emit = (tier: BrowseTier) => {
    const entries = byTier.get(tier);
    if (entries === undefined || entries.length === 0) {
      return;
    }
    seen.add(tier);
    groups.push({
      tier,
      label: TIER_LABELS[tier] ?? tier,
      description: TIER_DESCRIPTIONS[tier] ?? "",
      entries,
      eventTotal: entries.reduce((sum, e) => sum + e.eventCount, 0),
    });
  };
  for (const tier of BROWSE_TIER_ORDER) {
    emit(tier);
  }
  for (const tier of byTier.keys()) {
    if (!seen.has(tier)) {
      emit(tier);
    }
  }
  return groups;
}

/** How many of `entries` are currently selected. */
export function countSelected(
  entries: readonly AvailableSample[],
  selectedIds: ReadonlySet<string>,
): number {
  let n = 0;
  for (const entry of entries) {
    if (selectedIds.has(entry.id)) {
      n += 1;
    }
  }
  return n;
}

/**
 * The tri-state of a tier's select-all control: `checked` when every entry is
 * selected, `indeterminate` when some (but not all) are, neither when none are.
 * An empty tier is neither checked nor indeterminate.
 */
export function tierSelectionState(
  entries: readonly AvailableSample[],
  selectedIds: ReadonlySet<string>,
): { checked: boolean; indeterminate: boolean } {
  if (entries.length === 0) {
    return { checked: false, indeterminate: false };
  }
  const selected = countSelected(entries, selectedIds);
  return {
    checked: selected === entries.length,
    indeterminate: selected > 0 && selected < entries.length,
  };
}

/**
 * Return the new selection set after toggling every entry in a tier: when
 * `select` is true, ADD all of the tier's ids; otherwise REMOVE them. Other
 * selections are preserved. Pure - a fresh Set is returned.
 */
export function toggleTier(
  entries: readonly AvailableSample[],
  selectedIds: ReadonlySet<string>,
  select: boolean,
): Set<string> {
  const next = new Set(selectedIds);
  for (const entry of entries) {
    if (select) {
      next.add(entry.id);
    } else {
      next.delete(entry.id);
    }
  }
  return next;
}

/** Return the new selection set after toggling a single entry id. */
export function toggleOne(
  selectedIds: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(selectedIds);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/** One tier's load-summary line: how much of it the current selection loads. */
export interface TierLoadSummary {
  tier: BrowseTier;
  label: string;
  /** Entries available in this tier. */
  total: number;
  /** Entries selected in this tier. */
  selectedCount: number;
  /** Sum of eventCount across the selected entries. */
  selectedEventTotal: number;
}

/** The whole modal's load summary: per-tier lines plus the grand totals. */
export interface LoadSummary {
  tiers: TierLoadSummary[];
  /** Total entries selected across every tier. */
  totalSelected: number;
  /** Total events across every selected entry. */
  totalEvents: number;
}

/**
 * Derive the load summary for the current selection over the projected groups:
 * a per-tier line (total / selected / selected-event-total) for every group,
 * plus the grand totals used by the Load button caption.
 */
export function loadSummary(
  groups: readonly BrowseTierGroup[],
  selectedIds: ReadonlySet<string>,
): LoadSummary {
  const tiers: TierLoadSummary[] = [];
  let totalSelected = 0;
  let totalEvents = 0;
  for (const group of groups) {
    let selectedCount = 0;
    let selectedEventTotal = 0;
    for (const entry of group.entries) {
      if (selectedIds.has(entry.id)) {
        selectedCount += 1;
        selectedEventTotal += entry.eventCount;
      }
    }
    tiers.push({
      tier: group.tier,
      label: group.label,
      total: group.entries.length,
      selectedCount,
      selectedEventTotal,
    });
    totalSelected += selectedCount;
    totalEvents += selectedEventTotal;
  }
  return { tiers, totalSelected, totalEvents };
}

/** Which of the honest ENG-42 outcomes the sentinel-repo resolution reported. */
export type RepoNoticeKind =
  | "found"
  | "all-preingested"
  | "none-parsed"
  | "no-match";

/** A classified repo notice: the honest message plus a display tone. */
export interface RepoNotice {
  kind: RepoNoticeKind;
  /** The verbatim core message (one of the three ENG-42 messages / no-match). */
  message: string;
  /** ok = usable samples, warn = pre-ingested/nothing usable, info = neutral. */
  tone: "ok" | "warn" | "info";
}

/**
 * Classify the sentinel-repo resolution into one of the honest ENG-42 outcomes
 * for the modal, reusing the core's already-composed `message` verbatim:
 *   - found            : at least one raw sample survived (ok).
 *   - all-preingested  : every match was Sentinel-schema data, all skipped
 *                        (warn - "upload raw vendor samples or capture live").
 *   - none-parsed      : files matched but none parsed (info).
 *   - no-match         : nothing scored high enough (info).
 * Returns null when there were no candidates to resolve at all (`repo` is null).
 */
export function repoNotice(repo: RepoSampleResult | null): RepoNotice | null {
  if (repo === null) {
    return null;
  }
  if (repo.samples.length > 0) {
    return { kind: "found", message: repo.message, tone: "ok" };
  }
  if (repo.skippedPreIngested > 0) {
    return { kind: "all-preingested", message: repo.message, tone: "warn" };
  }
  if (repo.filesSearched > 0) {
    return { kind: "none-parsed", message: repo.message, tone: "info" };
  }
  return { kind: "no-match", message: repo.message, tone: "info" };
}

/**
 * The log type a resolved sample tags to: its own `logType` when present, else
 * its destination `tableName`. (The store is keyed by log type.)
 */
export function resolvedLogType(resolved: ResolvedSample): string {
  const logType = resolved.logType?.trim() ?? "";
  return logType !== "" ? logType : resolved.tableName;
}

/**
 * Convert a loaded {@link ResolvedSample} into a storage {@link TaggedSample}:
 * join its raw events back to text and re-tag through the SAME content-first
 * parse the intake path uses (format detected from content, capture unwrapped).
 * The tier/source provenance becomes the parse sourceName.
 */
export function taggedFromResolved(resolved: ResolvedSample): TaggedSample {
  return tagSampleFromContent(
    resolvedLogType(resolved),
    resolved.rawEvents.join("\n"),
    resolved.source,
  );
}

/**
 * Convert a batch of loaded resolved samples into tagged samples, one per log
 * type (LAST wins on a collision - the store's replace-by-logType contract),
 * preserving first-seen order. This is what the modal upserts on Load.
 */
export function plannedTagged(
  resolved: readonly ResolvedSample[],
): TaggedSample[] {
  const order: string[] = [];
  const byType = new Map<string, TaggedSample>();
  for (const sample of resolved) {
    const tagged = taggedFromResolved(sample);
    if (!byType.has(tagged.logType)) {
      order.push(tagged.logType);
    }
    byType.set(tagged.logType, tagged);
  }
  return order.map((logType) => byType.get(logType) as TaggedSample);
}
