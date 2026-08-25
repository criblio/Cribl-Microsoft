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
 * VOLUME IS TWO NUMBERS since the plan's last Phase 5 item shipped: the events
 * counted, and an ESTIMATE of what they weigh. Sentinel bills by volume rather
 * than by event, so a count alone leaves the operator doing arithmetic they have
 * no inputs for. The estimate is mean event size (measured over a SAMPLE of that
 * log type's own events) times the count - see {@link estimatedLogTypeBytes} -
 * and every renderer of it owes the reader the word "estimated". It is subject
 * to the same refusal as the count: absent when it cannot be computed, never
 * defaulted to zero.
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
  /**
   * ESTIMATED bytes over that same window: mean event size x
   * {@link eventCount}. UNDEFINED whenever either half is missing - see
   * {@link estimatedLogTypeBytes}, which is the only thing that computes it.
   *
   * An ESTIMATE, and it must be rendered as one. Sentinel bills by volume
   * rather than by event, so this is the number an operator can reason about
   * cost with - but the mean behind it comes from a SAMPLE of the log type's
   * events, not from every event counted.
   */
  estimatedBytes?: number;
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
  /**
   * MEAN BYTES PER EVENT for this log type, measured over a SAMPLE of its own
   * events - `meanEventBytes(estimateDropSavings(sampled, []))`. Undefined when
   * no sample of this log type was available to measure, which is a real and
   * common state: the Lake query samples a few hundred events to pick its
   * discriminator, and a skewed dataset's minority log types can be counted at
   * dataset scale without appearing in that sample at all.
   *
   * WHAT MAY BE PASSED HERE: a mean measured over actual events of THIS log
   * type. WHAT MAY NOT: a mean measured over the whole dataset and reused for
   * every row. That would be inventing this log type's size from other log
   * types' events, and a firewall's TRAFFIC and THREAT records differ by more
   * than enough to make it a lie.
   */
  meanEventBytes?: number;
}

/**
 * EVENTS TO BYTES for one measured row - mean event size x event count, rounded
 * to whole bytes. The plan's remaining Phase 5 item, and the ONLY place the
 * multiplication happens; every byte figure in the app traces back here.
 *
 * UNDEFINED IS THE DEFAULT ANSWER, not zero, and it is returned in every case
 * where the product would be a number nobody measured:
 *  - no count            -> nothing to multiply.
 *  - no mean             -> this log type's events were never sampled.
 *  - either non-finite   -> an unreadable figure must not become a byte total.
 *  - a mean of zero      -> `meanEventBytes` already refuses to produce one; the
 *    guard is repeated because a zero slipping through here would turn a
 *    million-event log type into a confident "0 B".
 *
 * A count of ZERO with a real mean DOES yield 0, and that is correct: zero
 * events genuinely is zero bytes. The distinction this module keeps everywhere -
 * a measured zero is an answer, an unmeasured value is not - holds here too.
 */
export function estimatedLogTypeBytes(
  volume: LogTypeVolume,
): number | undefined {
  const { eventCount, meanEventBytes } = volume;
  if (eventCount === undefined || meanEventBytes === undefined) return undefined;
  if (!Number.isFinite(eventCount) || !Number.isFinite(meanEventBytes)) {
    return undefined;
  }
  if (meanEventBytes <= 0 || eventCount < 0) return undefined;
  return Math.round(eventCount * meanEventBytes);
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
): VolumeTotal {
  let eventCount: number | undefined;
  let estimatedBytes: number | undefined;
  let someRowLacksAnEstimate = false;

  for (const row of volumes) {
    if (row.eventCount === undefined) continue;
    if (!isCovered(row.logType, keys)) continue;
    eventCount = (eventCount ?? 0) + row.eventCount;
    const bytes = estimatedLogTypeBytes(row);
    if (bytes === undefined) {
      someRowLacksAnEstimate = true;
      continue;
    }
    estimatedBytes = (estimatedBytes ?? 0) + bytes;
  }

  const total: VolumeTotal = {};
  if (eventCount !== undefined) total.eventCount = eventCount;
  // ALL OR NOTHING on the bytes, deliberately. A partial sum would sit beside a
  // count that covers MORE events than it does - "890,123 events, ~4 MB" where
  // the 4 MB speaks for a third of them - and an operator reading that as this
  // log type's ingest volume would be off by whatever we silently left out.
  // Under-reporting a cost figure is the expensive direction to be wrong in.
  if (estimatedBytes !== undefined && !someRowLacksAnEstimate) {
    total.estimatedBytes = estimatedBytes;
  }
  return total;
}

/** What one log type's matching volume rows add up to. */
interface VolumeTotal {
  eventCount?: number;
  estimatedBytes?: number;
}

/**
 * WHICH measured key a list ranks by - one choice for the whole list, never per
 * entry.
 *
 * Bytes is the better key when it exists: Sentinel bills by volume, and the two
 * orders genuinely disagree - 100 events at 10 KB outweighs 900 at 200 B, and
 * only the byte order says so.
 *
 * But it is a LIST-LEVEL choice because a mixed comparator would not be a total
 * order. Ranking "bytes where present, count otherwise" compares 890,123
 * (events) against 2,400,000 (bytes) as if they were the same quantity, and the
 * result depends on which pairs the sort happens to visit. Promoting the
 * estimated entries above the unestimated ones instead would rank on how well
 * we measured rather than on what we measured - a verdict, which is exactly what
 * the 2026-08-20 decision forbids.
 *
 * So: every entry that carries a count must also carry an estimate, or the list
 * ranks by count. Both orders are total and deterministic; neither invents a
 * number; and the common states behave sensibly - before any Lake query nothing
 * is measured and the count key changes nothing, while a query that measured
 * everything ranks the way cost does.
 */
function ranksByBytes(entries: readonly VolumeTotal[]): boolean {
  let anyMeasured = false;
  for (const entry of entries) {
    if (entry.eventCount === undefined) continue;
    if (entry.estimatedBytes === undefined) return false;
    anyMeasured = true;
  }
  return anyMeasured;
}

/**
 * The sort key for one entry under the chosen measure.
 *
 * UNMEASURED IS -1 under either key, which keeps the recorded rule intact: it
 * sorts below even a measured ZERO, because zero is an answer and absence is
 * not. Under the byte key an entry without an estimate also has no count (that
 * is what {@link ranksByBytes} established), so -1 still means "unmeasured".
 */
function volumeKey(entry: VolumeTotal, byBytes: boolean): number {
  return (byBytes ? entry.estimatedBytes : entry.eventCount) ?? -1;
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
    const volume = sumVolumeFor([key], volumes);
    if (volume.eventCount !== undefined) merged.eventCount = volume.eventCount;
    if (volume.estimatedBytes !== undefined) {
      merged.estimatedBytes = volume.estimatedBytes;
    }
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
    const volume = sumVolumeFor(keys, volumes);
    if (volume.eventCount !== undefined) merged.eventCount = volume.eventCount;
    if (volume.estimatedBytes !== undefined) {
      merged.estimatedBytes = volume.estimatedBytes;
    }
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
  //
  // WHICH measure is a list-level choice - estimated BYTES when every measured
  // entry has one, events otherwise. See {@link ranksByBytes}; the choice is
  // made once here so a single sort key orders the whole list.
  const byBytes = ranksByBytes(out);
  return out.sort(
    (a, b) =>
      EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence] ||
      volumeKey(b, byBytes) - volumeKey(a, byBytes) ||
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
  /**
   * ESTIMATED bytes over that window - mean event size x {@link eventCount},
   * undefined whenever either half is missing. Rendered as an estimate, never
   * as a measurement; see {@link estimatedLogTypeBytes}.
   */
  estimatedBytes?: number;
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
  const entries = unreferenced.map((value) => {
    const key = normalize(value);
    const entry: UnreferencedLogType = { value };
    const volume = key === "" ? {} : sumVolumeFor([key], volumes);
    if (volume.eventCount !== undefined) entry.eventCount = volume.eventCount;
    if (volume.estimatedBytes !== undefined) {
      entry.estimatedBytes = volume.estimatedBytes;
    }
    return entry;
  });
  // Same list-level measure the merged list uses, for the same reason - and it
  // keeps the tie rule above true: with nothing measured, every key is -1, every
  // comparison ties, and the caller's order survives.
  const byBytes = ranksByBytes(entries);
  return entries.sort((a, b) => volumeKey(b, byBytes) - volumeKey(a, byBytes));
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
