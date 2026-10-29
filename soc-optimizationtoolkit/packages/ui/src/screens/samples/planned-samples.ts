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
 * What to SAY when the store write itself rejects - the one copy, shared by both
 * commits for the reason everything else here is shared.
 *
 * WHY THIS EXISTS AT ALL (2026-08-26 audit). Both panels awaited `onCommit`
 * inside a `try { ... } finally { setCommitting(false) }` with NO catch. A
 * rejected write un-disabled the button and changed nothing else: no outcome, no
 * error, the preview still sitting there. The operator pressed "Add as samples",
 * saw nothing happen, and could not tell a refused write from a slow one - the
 * empty-versus-failed collapse this codebase keeps closing, in the direction
 * where a failure is rendered as NOTHING AT ALL.
 *
 * THE REASON IS QUOTED, NEVER INVENTED. When the rejection carries no message
 * this says so rather than substituting a plausible cause; "the store gave no
 * reason" sends the operator to the console, while a guessed cause sends them
 * somewhere that may have nothing to do with it.
 */
export function commitErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  return "the store gave no reason";
}

/**
 * One committed log type the store kept FEWER events of than it was handed.
 */
export interface StoredEventShortfall {
  /** The label the sample was stored under. */
  logType: string;
  /** Events handed to the store - the parsed records of the committed sample. */
  handed: number;
  /** Events the store holds for it afterwards, read back from the store. */
  kept: number;
}

/**
 * Which committed samples the store TRIMMED, measured by reading the store
 * back rather than by asking the adapter what it meant to do (DBT-197).
 *
 * WHY THIS EXISTS. A 100-event PAN-OS CEF capture became a sample whose chip
 * read "captured 9 events", and nothing on screen said why. The cause is the
 * cloud KV adapter's byte cap (core cap-bytes.ts): one tagged sample is one KV
 * entry, the leader refuses a large body with 413, and the adapter halves its
 * budget and retries until the write fits - keeping the FIRST n events. That
 * cap is deliberate and stays; what was wrong is that its only report was a
 * console.warn, while the commit headline said "Added 1 sample" as if all 100
 * had landed. Verbose CEF is exactly the shape that hits it: every event is
 * stored three times (rawEvents, parsed.rawEvents, parsed.records).
 *
 * MEASURED FROM WHAT `list()` RETURNED, so it holds for any store that trims,
 * not only the one adapter known to today, and the port stays unchanged. A
 * handed sample ABSENT from the listing is skipped rather than reported as
 * "kept 0": a listing that missed an entry is not evidence the entry is empty
 * (inventory-honesty), and the commit view already owns what a missing write
 * means. The field list is not part of this: the cap keeps `parsed.fields`
 * whole, and those were discovered from every handed event.
 */
export function storedEventShortfalls(
  handed: readonly TaggedSample[],
  stored: readonly TaggedSample[],
): StoredEventShortfall[] {
  const byType = new Map(stored.map((s) => [s.logType, s] as const));
  const out: StoredEventShortfall[] = [];
  for (const sample of handed) {
    const landed = byType.get(sample.logType);
    if (landed === undefined) continue;
    const given = sample.parsed.records.length;
    const kept = landed.parsed.records.length;
    if (kept < given) out.push({ logType: sample.logType, handed: given, kept });
  }
  return out;
}

/**
 * The sentence that says what the store kept and why, one per trimmed log type,
 * each with a leading space so it appends to a headline as-is ("" for none).
 *
 * ONE PLACE FOR BOTH PANELS. The capture and Lake panels share the commit
 * callback that measures the trim, so they share the words for it too: a Lake
 * fetch of verbose events hits the same byte cap, and before this lived here
 * the Lake panel received the trims and said nothing about them - DBT-197 on
 * the sibling panel.
 */
export function storedEventShortfallText(
  trimmed: readonly StoredEventShortfall[],
): string {
  return trimmed
    .map(
      (t) =>
        ` "${t.logType}" kept ${t.kept} of its ${t.handed} events: the sample store limits how large one log type's sample can be, and these events are large. Its field list was still read from all ${t.handed}.`,
    )
    .join("");
}

/**
 * How many raw lines a preview shows per log type, and the ONE place either
 * acquisition panel decides it.
 *
 * Three, because a preview is for RECOGNISING an event's shape - is this CEF, is
 * there a transport envelope in front of the vendor's own bytes - and not for
 * reading the haul. Shared for the same reason the conversion below is: two
 * panels each previewing "the first few lines" by their own number is two
 * answers to one question, and an operator comparing a captured sample with a
 * Lake one would be comparing different amounts of evidence.
 */
export const PREVIEW_LINES = 3;

/**
 * The first few raw lines of an acquired log type, EXACTLY as they arrived.
 *
 * Not reformatted, not pretty-printed, not trimmed, and that is the whole value
 * of it: the preview has to be the bytes {@link plannedSamplesFrom} would tag,
 * or it stops being evidence about what is going into the store. Tidying a line
 * here would hide precisely the defect a preview exists to catch - the syslog
 * envelope that reached a Lake sample unseen (2026-08-25) is what one line of
 * unedited text would have shown on screen.
 */
export function previewLines(rawEvents: readonly string[]): string[] {
  return rawEvents.slice(0, PREVIEW_LINES);
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
