/**
 * The PURE half of sample-source discovery: raw Cribl API bodies in, a normalized
 * {@link SampleSourceInventory} out (plan Phase 3, ADR 0003).
 *
 * The usecase beside this does the fetching and hands the raw `{status, body}`
 * pairs straight here, the same split live-architecture uses. Everything below
 * is total: no body shape throws, and every failure becomes a section the UI can
 * render rather than an exception that blanks the panel.
 *
 * THE RULE THAT SHAPES ALL OF IT: an empty list and a failed read must never
 * look the same. "You have no Lake datasets" and "the Lake read returned 403"
 * lead an operator to opposite next actions, and the second silently rendered as
 * the first is how someone concludes their environment has nothing to offer and
 * goes back to hand-crafting a sample. Hence `status` per section, and hence
 * `criblEnvelopeItems` returning null for an unrecognized body rather than [].
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import {
  criblEnvelopeItems,
  readNumber,
  readProp,
  readString,
} from "../cribl-api/envelope";
import type {
  SampleSourceInventory,
  SampleSourceKind,
  SampleSourceRef,
  SampleSourceSection,
} from "./models";

/** One fetched response, exactly as the port surfaces it. */
export interface RawSection {
  status: number;
  body: unknown;
}

/**
 * The inputs to {@link buildSampleSourceInventory}.
 *
 * An ABSENT field means "not requested", which becomes a `pending` section - not
 * an empty one. Discovery is lazy and mode-driven: the load path reads only the
 * worker group listing, and each surface arrives when the operator picks the
 * mode that needs it. A surface nobody has looked at yet must never render as a
 * fact about the workspace.
 */
export interface InventoryInput {
  /** GET /products/lake/lakes/{lakeId}/datasets. */
  lakeDatasets?: RawSection;
  /** GET /m/{groupId}/system/inputs, per worker group that was read. */
  criblSources?: ReadonlyArray<{ groupId: string; section: RawSection }>;
}

/** True for a 2xx status. */
function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Turn one raw response into items, or a note explaining why not. Returns null
 * items ONLY when the read genuinely failed.
 */
function itemsOrNote(
  section: RawSection,
  what: string,
): { items: unknown[] } | { note: string } {
  if (!ok(section.status)) {
    const hint =
      section.status === 403 || section.status === 401
        ? " - the app's credentials may not carry access to it"
        : section.status === 404
          ? " - it is not enabled in this workspace"
          : "";
    return {
      note: `${what} returned HTTP ${section.status}${hint}. That surface is not offered below; the other is unaffected.`,
    };
  }
  const items = criblEnvelopeItems(section.body);
  if (items === null) {
    return {
      note: `${what} answered with an unrecognized response shape, so it is not offered below. This is a version-skew or a bug - it is NOT "you have none".`,
    };
  }
  return { items };
}

/**
 * Parse Cribl Lake datasets. `CriblLakeDataset` requires only `id`; the size
 * comes from `metrics.currentSizeBytes` when a snapshot exists.
 *
 * NO groupId: listing Lake datasets is a LEADER route
 * (`/products/lake/lakes/{lakeId}/datasets`, verified live 2026-08-19). Querying
 * one later goes through the SEARCH group, but that is the query's business,
 * not the listing's.
 */
export function parseLakeDatasets(items: readonly unknown[]): SampleSourceRef[] {
  const out: SampleSourceRef[] = [];
  for (const item of items) {
    const id = readString(item, "id");
    if (id === undefined) continue;
    const ref: SampleSourceRef = { kind: "lake-dataset", id, label: id };
    const description = readString(item, "description");
    if (description !== undefined) ref.detail = description;
    const sizeBytes = readNumber(readProp(item, "metrics"), "currentSizeBytes");
    if (sizeBytes !== undefined) ref.sizeBytes = sizeBytes;
    const retentionDays = readNumber(item, "retentionPeriodInDays");
    if (retentionDays !== undefined) ref.retentionDays = retentionDays;
    out.push(ref);
  }
  return out;
}

/**
 * Parse `/system/inputs` into capturable sources.
 *
 * DISABLED SOURCES ARE KEPT, flagged rather than filtered. A disabled source is
 * the likeliest explanation for a capture that returns nothing, so hiding it
 * turns a one-glance answer into a support question. The UI decides whether to
 * offer it; this only reports it.
 */
export function parseCriblSources(
  items: readonly unknown[],
  groupId: string,
): SampleSourceRef[] {
  const out: SampleSourceRef[] = [];
  for (const item of items) {
    const id = readString(item, "id");
    if (id === undefined) continue;
    const type = readString(item, "type");
    const ref: SampleSourceRef = {
      kind: "cribl-source",
      id,
      label: id,
      groupId,
    };
    if (type !== undefined) ref.detail = type;
    if (readProp(item, "disabled") === true) ref.disabled = true;
    out.push(ref);
  }
  return out;
}

/** Sort entries by label, case-insensitively, so a dropdown is scannable. */
function byLabel(a: SampleSourceRef, b: SampleSourceRef): number {
  return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
}

/**
 * Build the inventory. ALWAYS returns both sections, in a fixed order (lake,
 * sources) so the UI never reflows between refreshes and an absent surface is
 * visibly absent rather than missing.
 */
export function buildSampleSourceInventory(
  input: InventoryInput,
): SampleSourceInventory {
  const lakeSection: SampleSourceSection =
    input.lakeDatasets === undefined
      ? {
          kind: "lake-dataset",
          status: "pending",
          entries: [],
          note: "Cribl Lake datasets have not been listed yet.",
        }
      : (() => {
          const outcome = itemsOrNote(
            input.lakeDatasets,
            "The Cribl Lake dataset listing",
          );
          if ("note" in outcome) {
            return {
              kind: "lake-dataset" as const,
              status: "failed" as const,
              entries: [],
              note: outcome.note,
            };
          }
          return {
            kind: "lake-dataset" as const,
            status: "ok" as const,
            entries: parseLakeDatasets(outcome.items).sort(byLabel),
          };
        })();

  // Sources are read per worker group and merged, so one failing group degrades
  // to a note while the rest still populate the dropdown. Normally exactly one
  // group is read - the one the operator selected.
  const sourceEntries: SampleSourceRef[] = [];
  const sourceNotes: string[] = [];
  const groups = input.criblSources ?? [];
  for (const { groupId, section: raw } of groups) {
    const outcome = itemsOrNote(raw, `Sources for worker group "${groupId}"`);
    if ("note" in outcome) {
      sourceNotes.push(outcome.note);
      continue;
    }
    sourceEntries.push(...parseCriblSources(outcome.items, groupId));
  }
  const everyGroupFailed = groups.length > 0 && sourceNotes.length === groups.length;
  const sourcesSection: SampleSourceSection = {
    kind: "cribl-source",
    status: groups.length === 0 ? "pending" : everyGroupFailed ? "failed" : "ok",
    entries: sourceEntries.sort(byLabel),
  };
  if (groups.length === 0) {
    sourcesSection.note =
      "Pick a worker group to list the sources you could capture from.";
  } else if (sourceNotes.length > 0) {
    sourcesSection.note = sourceNotes.join(" ");
  }

  return { sections: [lakeSection, sourcesSection] };
}

/** The section for one surface, or undefined when the kind is unknown. */
export function sectionFor(
  inventory: SampleSourceInventory,
  kind: SampleSourceKind,
): SampleSourceSection | undefined {
  return inventory.sections.find((s) => s.kind === kind);
}

/** Every entry across every section. */
export function allEntries(
  inventory: SampleSourceInventory,
): SampleSourceRef[] {
  return inventory.sections.flatMap((s) => s.entries);
}

/**
 * Whether discovery found ANY reachable entry. False means the operator's only
 * route is manual upload - a legitimate outcome that must be said out loud, not
 * left as an empty dropdown.
 */
export function hasAnySource(inventory: SampleSourceInventory): boolean {
  return inventory.sections.some((s) => s.entries.length > 0);
}
