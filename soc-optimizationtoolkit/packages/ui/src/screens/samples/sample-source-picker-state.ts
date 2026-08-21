/**
 * Pure decisions behind the sample-source picker (plan Phase 3, ADR 0003).
 *
 * TWO MODES the operator chooses between (user direction 2026-08-19):
 *   lake-query    an existing Cribl Lake dataset, queried through Cribl Search
 *   live-capture  a configured Cribl source, captured with a filter
 *
 * The panel's job is to answer "where do my samples come from?" honestly, which
 * mostly means being careful about states that look identical if you only count
 * entries:
 *
 *   no connection     -> we have not looked; blame nothing
 *   no mode chosen    -> the operator has not asked a question yet
 *   mode chosen, empty-> a real fact about the workspace
 *   mode chosen, failed-> a fact about our SIGHT, not the workspace
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type {
  AcquisitionMode,
  SampleSourceInventory,
  SampleSourceKind,
  SampleSourceRef,
} from "@soc/core";
import { MODE_KIND, sectionFor } from "@soc/core";
import type { SelectOption } from "../../components/searchable-select";

/** The two modes, with the copy the chooser renders. */
export interface ModeChoice {
  mode: AcquisitionMode;
  label: string;
  /** What this mode gives you, and what it costs - one line each. */
  detail: string;
}

export const MODE_CHOICES: readonly ModeChoice[] = Object.freeze([
  {
    mode: "lake-query",
    label: "Query a Cribl Lake dataset",
    detail:
      "Data you already retain, so it can show every log type present rather than whatever arrives during a short window. Needs a Cribl Search group to run the query.",
  },
  {
    mode: "live-capture",
    label: "Capture from a live source",
    detail:
      "A bounded capture off a configured source, filtered to the log types you want. Immediate, but it only sees what flows while it runs.",
  },
]);

/** The stable option id for a discovered entry: kind, group, and id. */
export function sourceOptionValue(ref: SampleSourceRef): string {
  return `${ref.kind}:${ref.groupId ?? ""}:${ref.id}`;
}

/** Human name for a surface, used in option hints and section headings. */
export function kindLabel(kind: SampleSourceKind): string {
  return kind === "lake-dataset" ? "Lake dataset" : "Cribl source";
}

/**
 * Byte size in the shortest honest unit. Deliberately coarse - a hint about
 * which dataset is worth querying, never an accounting figure.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * Options for the CHOSEN mode's surface only - never both at once.
 *
 * Module-local: derivePickerView is this module's public surface, and an
 * exported helper nothing imports is the shape the audit looks for.
 */
function sourceOptions(
  inventory: SampleSourceInventory | null,
  mode: AcquisitionMode | null,
): SelectOption[] {
  if (inventory === null || mode === null) return [];
  const section = sectionFor(inventory, MODE_KIND[mode]);
  if (section === undefined) return [];
  return section.entries.map((entry) => {
    const bits: string[] = [];
    if (entry.detail !== undefined) bits.push(entry.detail);
    if (entry.groupId !== undefined) bits.push(`group ${entry.groupId}`);
    if (entry.sizeBytes !== undefined) bits.push(formatBytes(entry.sizeBytes));
    if (entry.retentionDays !== undefined) bits.push(`${entry.retentionDays}d retention`);
    if (entry.disabled === true) bits.push("DISABLED");
    return {
      value: sourceOptionValue(entry),
      label: entry.label,
      ...(bits.length > 0 ? { hint: bits.join(" - ") } : {}),
    };
  });
}

/** Find the entry an option value refers to, or null. */
export function findEntry(
  inventory: SampleSourceInventory | null,
  value: string,
): SampleSourceRef | null {
  if (inventory === null || value === "") return null;
  for (const section of inventory.sections) {
    for (const entry of section.entries) {
      if (sourceOptionValue(entry) === value) return entry;
    }
  }
  return null;
}

/** Worker-group options for the capture mode's group dropdown. */
export function groupOptions(
  groups: { streamGroupIds: readonly string[] } | null,
): SelectOption[] {
  if (groups === null) return [];
  return groups.streamGroupIds.map((id) => ({ value: id, label: id }));
}

/** How the picker as a whole should read. */
export type PickerStatus =
  | "idle"
  | "loading"
  | "awaiting-mode"
  | "awaiting-group"
  | "empty"
  | "degraded"
  | "ready";

export interface PickerView {
  status: PickerStatus;
  /** The lead sentence. */
  headline: string;
  options: SelectOption[];
  /** Whether the worker-group dropdown belongs on screen. Capture mode only. */
  showGroupPicker: boolean;
  /**
   * A blocking-shaped fact stated up front rather than discovered later: Lake
   * mode needs a Search group to run the query. Null when there is nothing to
   * warn about. NOT a gate - the datasets still list, and the operator may want
   * to see what exists even if they cannot query it from here.
   */
  modeWarning: string | null;
}

/**
 * One line per surface that has something to explain. Only ever describes the
 * CHOSEN mode's surface - the other is none of the operator's business right
 * now, and `pending` says nothing either way.
 */
export function sectionNote(
  inventory: SampleSourceInventory | null,
  mode: AcquisitionMode | null,
): string | null {
  if (inventory === null || mode === null) return null;
  const section = sectionFor(inventory, MODE_KIND[mode]);
  if (section === undefined || section.status === "pending") return null;
  if (section.status === "ok") {
    return section.entries.length > 0
      ? null
      : `${kindLabel(section.kind)}s: none in this workspace.`;
  }
  return `${kindLabel(section.kind)}s: ${section.note ?? "unavailable."}`;
}

/** Everything {@link derivePickerView} needs. */
export interface PickerViewInput {
  groups: {
    streamGroupIds: readonly string[];
    searchGroupId?: string;
    ok: boolean;
  } | null;
  inventory: SampleSourceInventory | null;
  mode: AcquisitionMode | null;
  selectedGroupId: string;
  loadingGroups: boolean;
  loadingSources: boolean;
  enabled: boolean;
}

/** Project the two stages and the chosen mode into what the picker renders. */
export function derivePickerView(input: PickerViewInput): PickerView {
  const {
    groups,
    inventory,
    mode,
    selectedGroupId,
    loadingGroups,
    loadingSources,
    enabled,
  } = input;

  const base = { options: [] as SelectOption[], showGroupPicker: false, modeWarning: null };

  if (!enabled) {
    return {
      ...base,
      status: "idle",
      headline:
        "Connect Cribl to pull samples from a Lake dataset or a live source. Uploading a file works either way.",
    };
  }
  if (loadingGroups && groups === null) {
    return { ...base, status: "loading", headline: "Checking what this workspace offers..." };
  }
  if (groups === null || !groups.ok) {
    return {
      ...base,
      status: "empty",
      headline:
        "Nothing could be listed from Cribl. Upload a sample file instead - it needs no Cribl access.",
    };
  }
  if (mode === null) {
    return {
      ...base,
      status: "awaiting-mode",
      headline:
        "Choose where your samples come from. Nothing is loaded until you pick one.",
    };
  }

  // Lake mode is queried THROUGH Search, so no Search group means the datasets
  // can be listed and not read. Said here, not discovered in Phase 4.
  const modeWarning =
    mode === "lake-query" && groups.searchGroupId === undefined
      ? "This workspace has no Cribl Search group, so a Lake dataset cannot be queried from here. The datasets below are listed for reference; capture from a live source, or upload a file."
      : null;

  const showGroupPicker = mode === "live-capture";

  if (mode === "live-capture" && selectedGroupId === "") {
    const count = groups.streamGroupIds.length;
    return {
      ...base,
      status: "awaiting-group",
      showGroupPicker: count > 0,
      headline:
        count === 0
          ? "No Stream worker group is visible, so there is no live source to capture from. Query a Lake dataset instead, or upload a file."
          : `Pick one of this workspace's ${count} worker groups to see what you could capture from.`,
    };
  }
  if (loadingSources) {
    return {
      ...base,
      status: "loading",
      showGroupPicker,
      modeWarning,
      headline:
        mode === "lake-query"
          ? "Listing this workspace's Lake datasets..."
          : `Listing the sources in "${selectedGroupId}"...`,
    };
  }
  if (inventory === null) {
    return {
      ...base,
      status: "awaiting-mode",
      showGroupPicker,
      headline: "Choose where your samples come from.",
    };
  }

  const options = sourceOptions(inventory, mode);
  const section = sectionFor(inventory, MODE_KIND[mode]);
  const failed = section?.status === "failed";

  if (options.length === 0) {
    return {
      options,
      showGroupPicker,
      modeWarning,
      status: "empty",
      headline: failed
        ? "That listing failed, so this may be a permission problem rather than an empty workspace. Uploading a file always works."
        : mode === "lake-query"
          ? "This workspace has no Cribl Lake datasets. Capture from a live source instead, or upload a file."
          : `Worker group "${selectedGroupId}" has no sources configured. Try another group, or upload a sample file.`,
    };
  }

  const count = options.length;
  const noun = mode === "lake-query" ? "Lake dataset" : "source";
  return {
    options,
    showGroupPicker,
    modeWarning,
    status: failed ? "degraded" : "ready",
    headline: `${count} ${noun}${count === 1 ? "" : "s"} to choose from.`,
  };
}
