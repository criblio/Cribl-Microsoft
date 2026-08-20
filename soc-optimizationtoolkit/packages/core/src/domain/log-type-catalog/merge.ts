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
 * first, then how many content items referenced it - the log types the most
 * detections depend on are what the operator is asked about first.
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
  const out: MergedLogType[] = [];
  const seen = new Set<string>();

  for (const entry of input.expected) {
    const key = normalize(entry.value);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push({
      value: entry.value,
      evidence: evidenceFor(entry.referencedTypes),
      field: entry.field,
      referencedBy: entry.referencedBy,
      provided: isCovered(entry.value, providedNorm),
    });
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
    out.push(merged);
  }

  return out.sort(
    (a, b) =>
      EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence] ||
      (b.referencedBy?.length ?? 0) - (a.referencedBy?.length ?? 0) ||
      a.value.localeCompare(b.value),
  );
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
