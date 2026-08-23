/**
 * Merge the log-type EVIDENCE TIERS into one ranked recommendation
 * (ADR 0003; user direction 2026-08-19).
 *
 * Three tiers, and they make DIFFERENT CLAIMS. Collapsing them would be the
 * whole mistake:
 *
 *   detection  - a shipped analytic rule filters on this value. The strongest
 *                evidence there is: the solution demonstrably breaks without it.
 *   workbook   - a shipped workbook queries it. Real, weaker - a dashboard
 *                panel is not a detection.
 *   vendor     - the VENDOR documents it as a feed. Says nothing about what
 *                this solution needs; says everything about what exists to be
 *                collected, which is exactly what an operator facing a solution
 *                with no detections has to decide.
 *
 * A value found by several tiers is reported ONCE at its strongest, so the list
 * is "what to provide" rather than "how many places said so". Ranking is tier
 * first, then MEASURED VOLUME where a Lake query supplied one (plan Phase 5),
 * then how many content items referenced it - the log types the most detections
 * depend on are what the operator is asked about first.
 *
 * Volume is attached, never judged: no threshold, no flag, no finding. See
 * {@link rankUnreferencedByVolume} for why that is a decision rather than an
 * omission.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { ExpectedLogType } from "../coverage-analysis/expected-log-types";
import {
  logTypeNameMatches,
  normalizeLogTypeName,
} from "../coverage-analysis/expected-log-types";
import type { DocumentedLogTypeEntry } from "./vendor-log-types";

/** Which kind of evidence named a log type. Strongest first. */
export type LogTypeEvidence = "detection" | "workbook" | "vendor";

/** Rank for sorting; lower is stronger. */
const EVIDENCE_RANK: Record<LogTypeEvidence, number> = {
  detection: 0,
  workbook: 1,
  vendor: 2,
};

/** One recommended log type, with the strongest evidence that named it. */
export interface MergedLogType {
  /** The value as its strongest source writes it. */
  value: string;
  evidence: LogTypeEvidence;
  /** Content tiers: the discriminator field the content compares against. */
  field?: string;
  /** Content tiers: display names of the referencing items. */
  referencedBy?: readonly string[];
  /** Vendor tier: who documents it, and where. */
  vendor?: string;
  docUrl?: string;
  /** Vendor tier: the vendor's one-line description of the feed. */
  doc?: string;
  /** True when a tagged sample covers it. */
  provided: boolean;
  /**
   * Events MEASURED for this log type over the queried window, when a volume
   * source ran. UNDEFINED means unmeasured, never zero - see
   * {@link LogTypeVolume}.
   */
  eventCount?: number;
}

/**
 * One measured log-type volume (plan Phase 5).
 *
 * Declared HERE, in domain, rather than imported from the Lake query usecase:
 * domain may not import usecases, and this shape is the whole contract. The
 * Lake result's `LakeLogTypeVolume` satisfies it structurally, so the usecase
 * needs no adapter and no second type.
 *
 * WHAT MAY BE PASSED HERE: counts from a `summarize count() by <field>` over
 * the operator's own data. WHAT MAY NOT: a capture's event count. A capture is
 * bounded by its own limit - a hundred events says nothing about daily volume,
 * and presenting it beside a Search count would put a measurement and an
 * artifact of our own cap in the same column.
 */
export interface LogTypeVolume {
  /** The discriminator value as the volume source grouped it. */
  logType: string;
  /** Events over that source's window; undefined when it came back unreadable. */
  eventCount?: number;
}

// Both IMPORTED, not re-derived (2026-08-20 audit). This module used to carry
// its own copies with a comment saying they were "kept identical on purpose" -
// but intent is not a mechanism, and they answer the same question as
// compareLogTypeCoverage on the same screen.
const normalize = normalizeLogTypeName;
const isCovered = logTypeNameMatches;

/** The evidence tier for a content item's type. */
function evidenceFor(types: readonly string[]): LogTypeEvidence {
  // A value referenced by BOTH a rule and a workbook is a detection value -
  // the strongest claim wins, which is the same first-wins rule the mapping
  // packs use for hand-vs-generated.
  return types.some((t) => t !== "workbook") ? "detection" : "workbook";
}

/** Inputs to {@link mergeLogTypeSources}. */
export interface MergeLogTypeInput {
  /** Content-derived, from deriveExpectedLogTypes over rules AND workbooks. */
  expected: readonly ExpectedLogType[];
  /** Vendor-documented, from documentedLogTypesForSolution. */
  vendorLogTypes: readonly DocumentedLogTypeEntry[];
  /** Log types the operator has already tagged. */
  provided: readonly string[];
  /**
   * Measured volumes, when a Lake query has run. Absent until one does, and
   * absence must read as UNMEASURED - every entry simply carries no count.
   */
  volumes?: readonly LogTypeVolume[];
}

/**
 * Total the measured events across every volume row matching one log type.
 *
 * SUMMING IS SAFE, and that rests on where these rows come from: one
 * `summarize count() by <field>` partitions the window's events, so distinct
 * rows are DISJOINT sets. A recommendation entry for "TRAFFIC" that matches
 * both "pan-traffic" and "gp-traffic" is therefore looking at two non-
 * overlapping groups, and adding them double-counts nothing. Were the rows
 * ever to come from separate queries, or from overlapping predicates, this
 * would stop being true and the sum would have to go.
 *
 * Returns UNDEFINED when nothing matched, and when every match came back with
 * an unreadable count - the same refusal `LakeLogTypeVolume.eventCount` makes.
 * A zero here would be a claim about the data that no one measured.
 */
function sumVolumeFor(
  keys: readonly string[],
  volumes: readonly LogTypeVolume[],
): number | undefined {
  let total: number | undefined;
  for (const row of volumes) {
    if (row.eventCount === undefined) continue;
    if (!isCovered(row.logType, keys)) continue;
    total = (total ?? 0) + row.eventCount;
  }
  return total;
}

/**
 * Merge the tiers into one list, strongest evidence first.
 *
 * A vendor entry is dropped when content already names the same log type - not
 * because the vendor is wrong, but because showing "TRAFFIC (a rule needs it)"
 * beside "TRAFFIC (Palo Alto documents it)" asks the operator to reconcile two
 * rows that mean one thing. Aliases participate, so the vendor's "ZIA Web" is
 * recognised as the same feed a rule calls "NSSWeblog".
 */
export function mergeLogTypeSources(
  input: MergeLogTypeInput,
): MergedLogType[] {
  const providedNorm = input.provided.map(normalize).filter((p) => p !== "");
  const volumes = input.volumes ?? [];
  const out: MergedLogType[] = [];
  const seen = new Set<string>();

  for (const entry of input.expected) {
    const key = normalize(entry.value);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    const merged: MergedLogType = {
      value: entry.value,
      evidence: evidenceFor(entry.referencedTypes),
      field: entry.field,
      referencedBy: entry.referencedBy,
      provided: isCovered(entry.value, providedNorm),
    };
    const eventCount = sumVolumeFor([key], volumes);
    if (eventCount !== undefined) merged.eventCount = eventCount;
    out.push(merged);
  }

  for (const entry of input.vendorLogTypes) {
    const keys = [entry.value, ...(entry.aliases ?? [])]
      .map(normalize)
      .filter((k) => k !== "");
    if (keys.length === 0 || keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    const merged: MergedLogType = {
      value: entry.value,
      evidence: "vendor",
      vendor: entry.vendor,
      provided: keys.some((k) => isCovered(k, providedNorm)),
    };
    if (entry.doc !== undefined) merged.doc = entry.doc;
    if (entry.docUrl !== undefined) merged.docUrl = entry.docUrl;
    // Aliases participate here for the same reason they do in `provided`: the
    // vendor's "ZIA Web" and the dataset's "NSSWeblog" are one feed, and a
    // volume found under either belongs to this row.
    const eventCount = sumVolumeFor(keys, volumes);
    if (eventCount !== undefined) merged.eventCount = eventCount;
    out.push(merged);
  }

  // VOLUME RANKS WITHIN A TIER, NEVER ACROSS ONE (plan Phase 5, 2026-08-20).
  // Evidence stays the primary key because the two answer different questions:
  // the tier says whether the operator NEEDS this log type, the volume says how
  // much of it there is. Letting volume cross tiers would float a busy feed the
  // vendor merely documents above a quiet one a shipped detection depends on -
  // dressing a catalog entry in a requirement's authority, which is exactly
  // what the tier split exists to prevent.
  //
  // Unmeasured sorts last within its tier (-1), below even a measured zero, and
  // deliberately matches the `?? -1` the Lake query already uses to rank its
  // own rows.
  return out.sort(
    (a, b) =>
      EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence] ||
      (b.eventCount ?? -1) - (a.eventCount ?? -1) ||
      (b.referencedBy?.length ?? 0) - (a.referencedBy?.length ?? 0) ||
      a.value.localeCompare(b.value),
  );
}

/** A provided log type that no content references, with what it costs. */
export interface UnreferencedLogType {
  /** The log-type name exactly as the operator tagged it. */
  value: string;
  /** Events measured over the volume source's window; undefined if unmeasured. */
  eventCount?: number;
}

/**
 * Rank the provided-but-unreferenced log types by measured volume (Phase 5).
 *
 * This is the cross-product the plan named: what the dataset holds against what
 * any shipped detection reads, yielding "GLOBALPROTECT - 890K events, nothing
 * consumes it". `compareLogTypeCoverage` produces the set; this orders it.
 *
 * NO THRESHOLD, NO VERDICT - decided 2026-08-20. The number is attached and the
 * list is ordered; nothing is flagged and nothing is called a finding. A cutoff
 * would be a claim we cannot support (the line that is obviously right in one
 * tenant is obviously wrong in the next) and would contradict this module's own
 * standing position that an unreferenced log type is NOT a problem - a vendor
 * emits more than any one solution detects on. Ranking asserts only what was
 * measured; the 890K entry rises on its own and the operator concludes.
 *
 * TIES KEEP INPUT ORDER. The sort compares volume alone, so when nothing has
 * been measured - the state before any Lake query runs - the caller's order
 * survives untouched. Re-alphabetizing an unmeasured list would be reordering
 * on no evidence.
 */
export function rankUnreferencedByVolume(
  unreferenced: readonly string[],
  volumes: readonly LogTypeVolume[] = [],
): UnreferencedLogType[] {
  return unreferenced
    .map((value) => {
      const key = normalize(value);
      const entry: UnreferencedLogType = { value };
      const eventCount =
        key === "" ? undefined : sumVolumeFor([key], volumes);
      if (eventCount !== undefined) entry.eventCount = eventCount;
      return entry;
    })
    .sort((a, b) => (b.eventCount ?? -1) - (a.eventCount ?? -1));
}

/** How many of the merged log types come from each tier. */
export function evidenceCounts(
  merged: readonly MergedLogType[],
): Record<LogTypeEvidence, number> {
  const counts: Record<LogTypeEvidence, number> = {
    detection: 0,
    workbook: 0,
    vendor: 0,
  };
  for (const entry of merged) counts[entry.evidence] += 1;
  return counts;
}
