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

/** How the picker as a whole should read. */
export type PickerStatus = "idle" | "loading" | "empty" | "degraded" | "ready";

export interface PickerView {
  status: PickerStatus;
  /** The lead sentence. */
  headline: string;
  options: SelectOption[];
  /** Per-surface lines for anything that is not plain `ok` with entries. */
  sectionNotes: Array<{ kind: SampleSourceKind; text: string }>;
}

/** One line per surface that has something to explain; `ok` with entries is silent. */
export function sectionNotes(
  sections: readonly SampleSourceSection[],
): Array<{ kind: SampleSourceKind; text: string }> {
  const out: Array<{ kind: SampleSourceKind; text: string }> = [];
  for (const section of sections) {
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

/**
 * Project the inventory into what the picker renders.
 *
 * `enabled` false is `idle`, NOT `empty` - no Cribl connection means we have not
 * looked, and reporting that as "nothing found" would blame the workspace for
 * our own missing address.
 */
export function derivePickerView(
  inventory: SampleSourceInventory | null,
  loading: boolean,
  enabled: boolean,
): PickerView {
  if (!enabled) {
    return {
      status: "idle",
      headline:
        "Connect Cribl to list the datasets and sources you could take samples from. Uploading a file works either way.",
      options: [],
      sectionNotes: [],
    };
  }
  if (loading && inventory === null) {
    return {
      status: "loading",
      headline: "Looking for datasets and sources you can take samples from...",
      options: [],
      sectionNotes: [],
    };
  }
  if (inventory === null) {
    return {
      status: "empty",
      headline:
        "Nothing could be listed from Cribl. Upload a sample file instead - it needs no Cribl access.",
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
        : "This workspace has no Search datasets, Lake datasets or sources to take samples from. Upload a sample file instead.",
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
