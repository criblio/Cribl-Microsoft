/**
 * Turning ACQUIRED events into storage tagged samples - the one copy, shared by
 * the capture panel and the Lake panel (plan Phase 4, ADR 0003).
 *
 * WHY THIS IS SHARED RATHER THAN COPIED (2026-08-20 audit). Both panels carried
 * this function: the same case-folded label adoption, the same re-tag through
 * tagSampleFromContent, the same skip for a log type whose lines parse to no
 * records, the same dedupe keeping first-seen order. The Lake copy's own comment
 * named the capture copy as where its fix had come from - which is exactly the
 * arrangement domain/log-type-catalog/merge.ts was rewritten to reject: copies
 * "kept identical on purpose", where intent is not a mechanism. The next fix to
 * land in one of them would have been the first to diverge.
 *
 * The two inputs differed only in the NAME of their type - SplitSample and
 * LakeLogTypeEvents are both {logType, rawEvents} - so this module takes that
 * shape and each panel keeps its own type at its own boundary.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { TaggedSample } from "@soc/core";
import { tagSampleFromContent } from "./sample-intake-state";

/**
 * What either acquisition path hands over: a log-type name, and the raw lines
 * that fell under it.
 *
 * Structural on purpose rather than a union of the two core types. The extra
 * fields those carry - a format, an event count - are precisely what this
 * conversion refuses to take on trust, so naming them here would advertise an
 * input it deliberately ignores.
 */
export interface AcquiredLogTypeEvents {
  logType: string;
  rawEvents: readonly string[];
}

/**
 * The key two labels must share to count as the SAME sample.
 *
 * Case and surrounding whitespace ONLY, and deliberately NOT core's
 * `normalizeLogTypeName`, which additionally strips separators so that "pan-os
 * traffic" and "panos_traffic" fold together. That is the right question when
 * asking whether a solution's CONTENT names a log type the operator provided.
 * It is the wrong one here, because this answer decides what the tagged-sample
 * store is KEYED by, and the store keys the exact string: folding separators
 * would adopt the operator's "pan-os traffic" label for a genuinely different
 * feed and store the two as one sample, silently losing a log type - and the
 * pack builds a route pair per unique log type, so the loss shows up as a
 * missing route rather than as an error.
 *
 * Case is the one difference that is never a different log type: the operator
 * typed "traffic", splitSamplesByLogType shouts "TRAFFIC", and Search reports
 * whatever casing the data carries. The panels' collision checks
 * (deriveCaptureView, lakeLogTypeChoices) fold through here too, so the warning
 * an operator reads and the label a commit writes cannot disagree about what
 * collides.
 */
export function sampleStoreKey(label: string): string {
  return label.trim().toLowerCase();
}

/** Index the operator's existing labels by their {@link sampleStoreKey}. */
export function existingLabelsByCase(
  existingLogTypes: readonly string[],
): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const existing of existingLogTypes) {
    byKey.set(sampleStoreKey(existing), existing);
  }
  return byKey;
}

/**
 * The label an acquired log type will actually be STORED under.
 *
 * ADOPT THE OPERATOR'S EXISTING LABEL when one matches case-insensitively
 * (2026-08-20 audit). splitSamplesByLogType force-uppercases every captured log
 * type and Search reports whatever the data carries, while an upload keeps
 * whatever the operator typed - and the store keys case-SENSITIVELY. So
 * capturing TRAFFIC after uploading "traffic" APPENDED a second sample while the
 * panel had just promised "replaces your existing TRAFFIC sample".
 *
 * Two samples for one log type is not a cosmetic duplicate: the pack builds a
 * route pair per unique log type, so it silently gains an overlapping pair where
 * only the first receives events. Reusing the operator's own casing makes the
 * replacement real and the warning honest, and it respects the label they chose
 * rather than shouting it back at them.
 *
 * ONE PLACE decides this, because three callers depend on the answer: the two
 * commits ({@link plannedSamplesFrom}) and the report of what a Lake commit
 * folded together (mergedLakeLogTypeCount). A second copy of the rule would
 * drift, and the drift would read as an accounting sentence contradicting the
 * samples sitting beside it. Trimmed because tagSampleFromContent normalizes the
 * label that way, and the key has to be the STORED one.
 */
export function storeLabelFor(
  logType: string,
  byKey: Map<string, string>,
): string {
  return (byKey.get(sampleStoreKey(logType)) ?? logType).trim();
}

/**
 * Convert acquired events into storage tagged samples - one per log type.
 *
 * Re-tags through {@link tagSampleFromContent}, the SAME content-first parse an
 * upload goes through, rather than trusting whatever produced the events about
 * their format. That is what makes an acquired sample and an uploaded one
 * indistinguishable downstream, and it is why the format is detected again here
 * from the raw lines rather than carried over.
 */
export function plannedSamplesFrom(
  entries: readonly AcquiredLogTypeEvents[],
  sourceLabel: string,
  existingLogTypes: readonly string[] = [],
): TaggedSample[] {
  const byKey = existingLabelsByCase(existingLogTypes);

  const order: string[] = [];
  const byType = new Map<string, TaggedSample>();
  for (const entry of entries) {
    if (entry.rawEvents.length === 0) continue;
    const tagged = tagSampleFromContent(
      storeLabelFor(entry.logType, byKey),
      entry.rawEvents.join("\n"),
      sourceLabel,
    );
    // Having LINES is not the same as having RECORDS. A capture can catch
    // whitespace or a partial event at the edge of its window; a Lake log type
    // can return rows the parser cannot read. Storing either produces a husk - a
    // sample with a name and zero fields, which satisfies the "samples provided"
    // check while giving the mapping nothing to work with.
    if (tagged.parsed.records.length === 0) continue;
    if (!byType.has(tagged.logType)) order.push(tagged.logType);
    byType.set(tagged.logType, tagged);
  }
  return order.map((t) => byType.get(t) as TaggedSample);
}
