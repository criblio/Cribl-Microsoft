/**
 * Pure decisions behind the sample-source picker (plan Phase 3, ADR 0003).
 *
 * The picker's whole job is to answer "where can I get my own samples from?"
 * honestly, which mostly means being careful about the difference between these
 * four states, because three of them look identical if you only count entries:
 *
 *   - not looked yet          -> say so, offer nothing
 *   - looked, found nothing   -> a real fact about the workspace
 *   - looked, the read failed -> a fact about our SIGHT, not the workspace
 *   - looked, found things    -> the dropdown
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type {
  SampleSourceInventory,
  SampleSourceKind,
  SampleSourceRef,
  SampleSourceSection,
} from "@soc/core";
import type { SelectOption } from "../../components/searchable-select";

/** The stable option id for a discovered entry: kind, group, and id. */
export function sourceOptionValue(ref: SampleSourceRef): string {
  return `${ref.kind}:${ref.groupId ?? ""}:${ref.id}`;
}

/** Human name for a surface, used in option labels and section headings. */
export function kindLabel(kind: SampleSourceKind): string {
  switch (kind) {
    case "search-dataset":
      return "Search dataset";
    case "lake-dataset":
      return "Lake dataset";
    case "cribl-source":
      return "Cribl source";
  }
}

/**
 * Byte size in the shortest honest unit. Deliberately coarse - this is a hint
 * about which dataset is worth searching, never an accounting figure.
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
 * Build the dropdown options for the whole inventory, one flat list with the
 * surface named in each label.
 *
 * Flat rather than grouped on purpose: the operator is choosing WHERE their data
 * is, and a Lake dataset and a live source are equally valid answers to that -
 * making them navigate a hierarchy first implies a decision they have not made.
 * The surface is in the hint so it is still filterable by typing "lake".
 */
export function sourceOptions(
  inventory: SampleSourceInventory | null,
): SelectOption[] {
  if (inventory === null) return [];
  const options: SelectOption[] = [];
  for (const section of inventory.sections) {
    for (const entry of section.entries) {
      const bits: string[] = [kindLabel(entry.kind)];
      if (entry.detail !== undefined) bits.push(entry.detail);
      if (entry.groupId !== undefined) bits.push(`group ${entry.groupId}`);
      if (entry.sizeBytes !== undefined) bits.push(formatBytes(entry.sizeBytes));
      if (entry.disabled === true) bits.push("DISABLED");
      options.push({
        value: sourceOptionValue(entry),
        label: entry.label,
        hint: bits.join(" - "),
      });
    }
  }
  return options;
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

/**
 * How the picker as a whole should read.
 *
 * `awaiting-group` is the state the lazy two-stage load added: the group listing
 * is in and the dropdown is up, but nothing has been chosen so there is nothing
 * to list. It is emphatically NOT `empty` - the workspace has not been asked yet.
 */
export type PickerStatus =
  | "idle"
  | "loading"
  | "awaiting-group"
  | "empty"
  | "degraded"
  | "ready";

export interface PickerView {
  status: PickerStatus;
  /** The lead sentence. */
  headline: string;
  options: SelectOption[];
  /** Per-surface lines for anything that is not plain `ok` with entries. */
  sectionNotes: Array<{ kind: SampleSourceKind; text: string }>;
}

/**
 * One line per surface that has something to explain; `ok` with entries is
 * silent, because the dropdown is the evidence it worked.
 *
 * `pending` is skipped entirely. A surface nobody has asked for yet has nothing
 * to say, and printing "not listed yet" for each one turns the empty state into
 * a wall of non-news.
 */
export function sectionNotes(
  sections: readonly SampleSourceSection[],
): Array<{ kind: SampleSourceKind; text: string }> {
  const out: Array<{ kind: SampleSourceKind; text: string }> = [];
  for (const section of sections) {
    if (section.status === "pending") {
      continue;
    }
    if (section.status === "ok" && section.entries.length > 0) {
      continue;
    }
    if (section.status === "ok") {
      out.push({
        kind: section.kind,
        text: `${kindLabel(section.kind)}s: none in this workspace.`,
      });
      continue;
    }
    out.push({
      kind: section.kind,
      text: `${kindLabel(section.kind)}s: ${section.note ?? "unavailable."}`,
    });
  }
  return out;
}

/** Worker-group options for the FIRST dropdown (stage one). */
export function groupOptions(
  groups: { streamGroupIds: readonly string[] } | null,
): SelectOption[] {
  if (groups === null) return [];
  return groups.streamGroupIds.map((id) => ({ value: id, label: id }));
}

/** Everything {@link derivePickerView} needs to decide how the picker reads. */
export interface PickerViewInput {
  /** Stage one: the worker group listing, or null before it lands. */
  groups: { streamGroupIds: readonly string[]; ok: boolean } | null;
  /** Stage two: the selected group's inventory, or null before a selection. */
  inventory: SampleSourceInventory | null;
  /** The chosen worker group, or "". */
  selectedGroupId: string;
  loadingGroups: boolean;
  loadingSources: boolean;
  /** False when there is no Cribl connection to discover against. */
  enabled: boolean;
}

/**
 * Project the two stages into what the picker renders.
 *
 * The states this exists to keep apart, in order of how easily they collapse:
 *
 *   idle           - no Cribl address. We have not looked; blame nothing.
 *   loading        - stage one in flight.
 *   awaiting-group - groups are listed, none chosen. NOTHING is known about
 *                    sources yet, and saying "none found" here would be a claim
 *                    about the workspace made before asking it a question.
 *   empty          - a group WAS chosen and it really has nothing (or the reads
 *                    failed, which reads differently).
 *   degraded/ready - there is something to pick.
 */
export function derivePickerView(input: PickerViewInput): PickerView {
  const {
    groups,
    inventory,
    selectedGroupId,
    loadingGroups,
    loadingSources,
    enabled,
  } = input;

  if (!enabled) {
    return {
      status: "idle",
      headline:
        "Connect Cribl to list the datasets and sources you could take samples from. Uploading a file works either way.",
      options: [],
      sectionNotes: [],
    };
  }
  if (loadingGroups && groups === null) {
    return {
      status: "loading",
      headline: "Listing this workspace's worker groups...",
      options: [],
      sectionNotes: [],
    };
  }
  if (groups === null || !groups.ok) {
    return {
      status: "empty",
      headline:
        "Nothing could be listed from Cribl. Upload a sample file instead - it needs no Cribl access.",
      options: [],
      sectionNotes: [],
    };
  }
  // ORDER MATTERS: a group IS selected and its first listing is in flight, so
  // `inventory` is still null - which the awaiting-group branch below would
  // otherwise read as "nothing chosen" and answer with "pick a group", right
  // after the operator picked one.
  if (selectedGroupId !== "" && loadingSources) {
    return {
      status: "loading",
      headline: `Listing what is available in "${selectedGroupId}"...`,
      options: [],
      sectionNotes: [],
    };
  }
  if (selectedGroupId === "" || inventory === null) {
    const count = groups.streamGroupIds.length;
    return {
      status: "awaiting-group",
      headline:
        count === 0
          ? "No Stream worker group is visible, so there is no live source to capture from. Upload a sample file instead."
          : `Pick one of this workspace's ${count} worker groups to see what you could take samples from. Nothing is loaded until you do.`,
      options: [],
      sectionNotes: [],
    };
  }

  const notes = sectionNotes(inventory.sections);
  const options = sourceOptions(inventory);
  const anyFailed = inventory.sections.some((s) => s.status === "failed");

  if (options.length === 0) {
    return {
      status: "empty",
      headline: anyFailed
        ? "No sample source could be listed, and at least one listing failed - so this may be a permission problem rather than an empty workspace. Uploading a file always works."
        : `Worker group "${selectedGroupId}" has no sources, and this workspace has no Search or Lake datasets to take samples from. Try another group, or upload a sample file.`,
      options,
      sectionNotes: notes,
    };
  }

  const count = options.length;
  const noun = count === 1 ? "place" : "places";
  return {
    status: anyFailed ? "degraded" : "ready",
    headline: anyFailed
      ? `${count} ${noun} to take samples from - though one listing failed, so there may be more.`
      : `${count} ${noun} to take samples from.`,
    options,
    sectionNotes: notes,
  };
}
