/**
 * Pure decisions behind the capture panel (plan Phase 4, ADR 0003).
 *
 * The panel runs ONE bounded capture off the source the operator picked, shows
 * what came back, and tags it only when they say so. Nothing here does IO; the
 * capture itself is the core captureSamples usecase.
 *
 * TWO THINGS THIS MODULE EXISTS TO GET RIGHT:
 *
 * 1. WHICH LOG TYPES TO SUGGEST. The recommendation already ranks them across
 *    three evidence tiers, so the checkboxes reuse it rather than inventing a
 *    second opinion: content-derived types are pre-ticked, vendor-documented
 *    ones are offered unticked. A type the operator has ALREADY provided is
 *    offered unticked too - re-capturing it would overwrite a sample they
 *    already curated.
 *
 * 2. WHAT A COMMIT WILL OVERWRITE. The tagged-sample store is
 *    replace-by-logType, so adding a captured "TRAFFIC" silently replaces an
 *    existing "TRAFFIC" sample. Silent replacement of the operator's own work
 *    is exactly what a confirm step is for, so the collision is named in the
 *    preview rather than discovered afterwards.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type {
  CaptureSamplesResult,
  LogTypeEvidence,
  SplitSample,
  TaggedSample,
} from "@soc/core";
import { buildCaptureFilter, captureFilterWarning } from "@soc/core";
import type { RecommendedLogType } from "./sample-coverage-state";
import { tagSampleFromContent } from "./sample-intake-state";

/** One log-type checkbox on the capture panel. */
export interface CaptureLogTypeChoice {
  value: string;
  /** Which tier suggested it - shown so the operator can weigh it. */
  evidence: LogTypeEvidence;
  /** Whether it starts ticked. */
  selected: boolean;
  /** Why it is or is not pre-ticked, when that needs saying. */
  note?: string;
}

/**
 * Build the checkbox list from the recommendation.
 *
 * PRE-TICKED = the solution's own content names it AND no sample covers it yet.
 * Those are the log types whose absence actually costs the operator something.
 * Vendor-documented types and already-provided ones are visible but unticked -
 * offered, never assumed, the same rule the vendor-identity chips follow.
 */
export function captureLogTypeChoices(
  entries: readonly RecommendedLogType[],
): CaptureLogTypeChoice[] {
  return entries.map((entry) => {
    const fromContent = entry.evidence !== "vendor";
    const choice: CaptureLogTypeChoice = {
      value: entry.value,
      evidence: entry.evidence,
      selected: fromContent && !entry.provided,
    };
    if (entry.provided) {
      choice.note = "already provided - capturing again replaces that sample";
    } else if (!fromContent) {
      choice.note = "documented by the vendor, not required by this solution";
    }
    return choice;
  });
}

/** The values currently ticked, in the order they are offered. */
export function selectedValues(
  choices: readonly CaptureLogTypeChoice[],
): string[] {
  return choices.filter((c) => c.selected).map((c) => c.value);
}

/** Flip one checkbox, returning a new list. */
export function toggleChoice(
  choices: readonly CaptureLogTypeChoice[],
  value: string,
): CaptureLogTypeChoice[] {
  return choices.map((c) =>
    c.value === value ? { ...c, selected: !c.selected } : c,
  );
}

/** The filter a given source and checkbox set compose to. */
export function composeFilter(
  inputId: string,
  choices: readonly CaptureLogTypeChoice[],
): string {
  return buildCaptureFilter({ inputId, logTypes: selectedValues(choices) });
}

/** A warning about an operator-edited filter, or null. Re-exported for the UI. */
export function filterWarning(filter: string, inputId: string): string | null {
  return captureFilterWarning(filter, inputId);
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

/** One captured log type, as the preview renders it. */
export interface CapturedLogTypeView {
  logType: string;
  eventCount: number;
  /** First few raw lines, for the operator to eyeball. */
  preview: string[];
  /** True when committing this would replace an existing tagged sample. */
  replacesExisting: boolean;
}

/** How the capture panel's result area should read. */
export type CaptureStatus = "idle" | "running" | "empty" | "failed" | "ready";

export interface CaptureView {
  status: CaptureStatus;
  headline: string;
  logTypes: CapturedLogTypeView[];
  notes: readonly string[];
  /** True when nothing distinguished the events - the operator must name them. */
  noDiscriminator: boolean;
  /** Log types that would replace an existing sample, for the commit warning. */
  collisions: string[];
}

/** How many raw lines the preview shows per log type. */
export const PREVIEW_LINES = 3;

/**
 * Project a capture result into what the panel renders.
 *
 * `existingLogTypes` is the tagged-sample store's current keys, used only to
 * warn about replacement - never to filter anything out. The operator may well
 * WANT to replace a sample; they just should not do it by accident.
 */
export function deriveCaptureView(
  result: CaptureSamplesResult | null,
  running: boolean,
  existingLogTypes: readonly string[],
): CaptureView {
  const base = {
    logTypes: [] as CapturedLogTypeView[],
    notes: [] as readonly string[],
    noDiscriminator: false,
    collisions: [] as string[],
  };

  if (running) {
    return { ...base, status: "running", headline: "Capturing..." };
  }
  if (result === null) {
    return {
      ...base,
      status: "idle",
      headline:
        "Capture a short, filtered sample from this source. Nothing is added until you confirm.",
    };
  }
  if (!result.ok) {
    return {
      ...base,
      status: "failed",
      headline: "The capture did not run.",
      notes: result.notes,
    };
  }
  if (result.splits.length === 0) {
    return {
      ...base,
      status: "empty",
      headline: "The capture ran and returned no events.",
      notes: result.notes,
    };
  }

  const existing = new Set(existingLogTypes.map((t) => t.trim().toLowerCase()));
  const logTypes = result.splits.map((split) => ({
    logType: split.logType,
    eventCount: split.eventCount,
    preview: split.rawEvents.slice(0, PREVIEW_LINES),
    replacesExisting: existing.has(split.logType.trim().toLowerCase()),
  }));
  const collisions = logTypes.filter((l) => l.replacesExisting).map((l) => l.logType);

  const total = result.rawEvents.length;
  const kinds = logTypes.length;
  return {
    status: "ready",
    headline: `Captured ${total} event${total === 1 ? "" : "s"} in ${kinds} log type${kinds === 1 ? "" : "s"} (${result.format}).`,
    logTypes,
    notes: result.notes,
    noDiscriminator: result.noDiscriminator,
    collisions,
  };
}

/**
 * Convert captured splits into storage tagged samples - one per log type.
 *
 * Re-tags through {@link tagSampleFromContent}, the SAME content-first parse an
 * upload goes through, rather than trusting the capture's own idea of the
 * format. That is what makes a captured sample and an uploaded one identical
 * downstream, and it is why the format is detected again here from the raw
 * lines rather than carried over.
 */
export function plannedCaptureSamples(
  splits: readonly SplitSample[],
  sourceLabel: string,
): TaggedSample[] {
  const order: string[] = [];
  const byType = new Map<string, TaggedSample>();
  for (const split of splits) {
    if (split.rawEvents.length === 0) continue;
    const tagged = tagSampleFromContent(
      split.logType,
      split.rawEvents.join("\n"),
      sourceLabel,
    );
    // A split can hold LINES that parse to no RECORDS - whitespace, a partial
    // event caught at the edge of the capture window. Storing that produces a
    // husk: a sample with a name and zero fields, which satisfies the
    // "samples provided" check while giving the mapping nothing to work with.
    // Having lines is not the same as having events.
    if (tagged.parsed.records.length === 0) continue;
    if (!byType.has(tagged.logType)) order.push(tagged.logType);
    byType.set(tagged.logType, tagged);
  }
  return order.map((t) => byType.get(t) as TaggedSample);
}
