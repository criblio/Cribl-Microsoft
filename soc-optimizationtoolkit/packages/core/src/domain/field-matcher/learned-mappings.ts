/**
 * LEARNED MAPPINGS - the feedback loop best-of-class matchers build on: every
 * manual remap the reviewer APPROVES in the Gap Analysis is a labeled
 * correction, persisted per solution and replayed on every future analysis as
 * the HIGHEST-priority Phase 0 tier (ahead of the documented vendor packs -
 * the operator's own decision beats the vendor's documentation). The tool
 * never asks the same question twice.
 *
 * Storage rides the plain-KV ContentCache port (JSON in, JSON out, hashed
 * keys, no TTL) under {@link learnedMappingsCacheKey}; entries are decoded
 * DEFENSIVELY ({@link parseLearnedMappings}) so a corrupt value reads as
 * empty rather than poisoning analysis.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto. The UI owns the load/save
 * calls; this module owns every decision.
 */

import type { VendorMapping } from "./match-fields";

/** One remembered reviewer decision for a source field. */
export interface LearnedMapping {
  /** Source field name exactly as the sample carries it. */
  sourceName: string;
  /** The destination column the reviewer chose ("" for drop). */
  destName: string;
  /** How the pipeline realizes it. */
  action: "map" | "decode" | "drop";
}

/** The Phase-0 provenance line for replayed reviewer decisions. */
export const LEARNED_MAPPING_DESCRIPTION =
  "Learned from your mapping review";

/** lowercase, non-alphanumerics removed (mirrors normalizeSolutionKey; kept
 * local to avoid a field-matcher -> sample-acquisition import cycle). */
function solutionKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The ContentCache key holding a solution's learned mappings. */
export function learnedMappingsCacheKey(solutionName: string): string {
  return `learned-mappings~v1~${solutionKey(solutionName)}`;
}

/** The mapping-row subset the differ needs (a GapFieldMapping projection). */
export interface LearnedDiffRow {
  source: string;
  dest: string;
  action: string;
}

/** Fold a review action into the learned vocabulary (null = not learnable). */
function learnedActionOf(action: string): LearnedMapping["action"] | null {
  if (action === "keep" || action === "rename" || action === "coerce") {
    return "map";
  }
  if (action === "decode") return "decode";
  if (action === "drop") return "drop";
  // overflow is the matcher's default disposition, never a decision to learn.
  return null;
}

/**
 * The reviewer decisions in `effective` that DIFFER from the analyzed
 * `baseline` (same source, different destination or action). Only genuine
 * hand edits are learned - rows the matcher produced unchanged are not - and
 * an edit back to the baseline unlearns by simply not differing.
 */
export function diffLearnedMappings(
  baseline: readonly LearnedDiffRow[],
  effective: readonly LearnedDiffRow[],
): LearnedMapping[] {
  const baselineBySource = new Map(
    baseline.map((row) => [row.source.toLowerCase(), row]),
  );
  const out: LearnedMapping[] = [];
  for (const row of effective) {
    const before = baselineBySource.get(row.source.toLowerCase());
    if (before === undefined) continue;
    if (before.dest === row.dest && before.action === row.action) continue;
    const action = learnedActionOf(row.action);
    if (action === null) continue;
    out.push({
      sourceName: row.source,
      destName: action === "drop" ? "" : row.dest,
      action,
    });
  }
  return out;
}

/**
 * Merge fresh decisions over the stored set: last-write-wins per source name
 * (case-insensitive), stored order preserved for untouched entries, new
 * sources appended in incoming order.
 */
export function mergeLearnedMappings(
  existing: readonly LearnedMapping[],
  incoming: readonly LearnedMapping[],
): LearnedMapping[] {
  const merged = existing.map((entry) => ({ ...entry }));
  for (const entry of incoming) {
    const at = merged.findIndex(
      (candidate) =>
        candidate.sourceName.toLowerCase() === entry.sourceName.toLowerCase(),
    );
    if (at >= 0) merged[at] = { ...entry };
    else merged.push({ ...entry });
  }
  return merged;
}

/** Replay learned decisions as Phase-0 vendor mappings (highest priority). */
export function learnedToVendorMappings(
  entries: readonly LearnedMapping[],
): VendorMapping[] {
  return entries.map((entry) => ({
    sourceName: entry.sourceName,
    destName: entry.destName,
    sourceType: "",
    destType: "",
    action: entry.action,
    description: LEARNED_MAPPING_DESCRIPTION,
  }));
}

/** Defensively decode a stored value; anything malformed reads as empty. */
export function parseLearnedMappings(raw: unknown): LearnedMapping[] {
  if (!Array.isArray(raw)) return [];
  const out: LearnedMapping[] = [];
  for (const item of raw) {
    const entry = item as LearnedMapping;
    if (
      typeof entry?.sourceName === "string" &&
      entry.sourceName !== "" &&
      typeof entry?.destName === "string" &&
      (entry?.action === "map" ||
        entry?.action === "decode" ||
        entry?.action === "drop")
    ) {
      out.push({
        sourceName: entry.sourceName,
        destName: entry.destName,
        action: entry.action,
      });
    }
  }
  return out;
}
