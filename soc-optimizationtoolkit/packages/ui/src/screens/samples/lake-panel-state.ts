/**
 * Pure decisions behind the Lake panel (plan Phase 4, ADR 0003).
 *
 * The SEARCH sibling of capture-panel-state. The capture panel pulls bytes off a
 * live source for a few seconds; this one reads data that already exists, which
 * is why its flow has TWO steps where capture has one:
 *
 *   1. queryLakeSamples   -> which log types, and HOW MANY events of each.
 *                            COUNTS, not bodies. This is what the operator picks
 *                            from.
 *   2. fetchLakeLogTypeEvents -> the actual events for the log types they ticked.
 *                            THIS is what becomes tagged samples.
 *
 * Keeping them apart is the point: fetching bodies for every log type up front
 * would pull them for the ones the operator discards, on the biggest datasets,
 * which is exactly where it hurts most (see the usecase's own note).
 *
 * FOUR THINGS THIS MODULE EXISTS TO GET RIGHT:
 *
 * 1. EMPTY AND FAILED ARE DIFFERENT ANSWERS. `ok: false` is "the read failed";
 *    `ok: true` with no log types is "this dataset genuinely holds none in this
 *    window". They send the operator to opposite places - credentials and search
 *    permission versus a wider window or a different dataset - so they get
 *    separate statuses and separate copy, never a shared "nothing found".
 *
 * 2. A VOLUME IS NOT A FACT WITHOUT ITS WINDOW. "890,114 events" over an
 *    unstated period says nothing, so `window` travels with the counts and the
 *    view carries no counts until it has one.
 *
 * 3. WHAT A COMMIT WILL OVERWRITE. The tagged-sample store is
 *    replace-by-logType, so taking a Lake "TRAFFIC" silently replaces an
 *    existing "TRAFFIC" sample. Named per row and again at the commit, and only
 *    for the rows actually TICKED - unlike a capture, where everything returned
 *    is committed, here the operator's selection decides what collides. Two
 *    ticks that resolve to ONE label are ONE sample on BOTH sides of the
 *    commit: named once in the warning beforehand ({@link lakeCollisions}), and
 *    accounted for as a merge afterwards ({@link mergedLakeLogTypeCount})
 *    rather than reported as data that never arrived.
 *
 * 4. TRUNCATION IS NOT COMPLETENESS. A list that hit the row cap reads as the
 *    whole dataset unless it says otherwise.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto. Number FORMATTING is left to
 * the component - `toLocaleString` is a rendering choice, and pinning its output
 * here would pin the test runner's locale.
 */

import type {
  FetchLakeEventsResult,
  LakeLogTypeEvents,
  LakeLogTypeVolume,
  QueryLakeSamplesResult,
  TaggedSample,
} from "@soc/core";
import {
  existingLabelsByCase,
  plannedSamplesFrom,
  sampleStoreKey,
  storeLabelFor,
} from "./planned-samples";

/**
 * How many log types start ticked.
 *
 * Bounded rather than "all", because every ticked box costs one more search
 * against the dataset when the operator commits, and a busy dataset can return
 * two hundred log types. The list arrives biggest-first, so the ones that are
 * pre-selected are the ones most worth onboarding; the rest are one tick away.
 */
export const DEFAULT_PRESELECTED = 5;

/** The time bounds a set of volumes covers. */
export interface LakeWindow {
  earliest: string;
  latest: string;
}

/** One log-type checkbox on the Lake panel. */
export interface LakeLogTypeChoice {
  /** The log type as the DATASET names it - what the row shows. */
  value: string;
  /**
   * The label this row's events would actually be STORED under: the operator's
   * own casing when one of their samples collides with it ({@link
   * storeLabelFor}), the dataset's otherwise.
   *
   * Carried on the row rather than re-derived when the warning is built, so
   * that the warning and the row's own note cannot describe two different
   * stores. The list is seeded ONCE from the store's log types and deliberately
   * not re-seeded when they change - re-deriving the label later would read
   * that newer store while `replacesExisting` still spoke for the older one.
   */
  storeLabel: string;
  /**
   * Events over the queried window, or UNDEFINED when Search reported the
   * volume in a column this app does not recognize. Never defaulted to 0 - a
   * volume of zero is a claim about the data, and we would be making it up.
   */
  eventCount?: number;
  /** Whether it starts ticked. */
  selected: boolean;
  /** True when taking this would replace an existing tagged sample. */
  replacesExisting: boolean;
  /** Why the row needs a caveat, when it does. */
  note?: string;
}

/**
 * Build the checkbox list from the log-type volumes.
 *
 * A log type the operator has ALREADY provided is offered UNTICKED, the same
 * rule the capture panel follows: taking it again would overwrite a sample they
 * curated themselves, and that is a decision worth making deliberately. It does
 * not consume the pre-selection budget either - it was never a candidate for
 * spending a search on.
 *
 * `existingLogTypes` is matched case-INSENSITIVELY because the store keys on the
 * label the operator typed: Search reports whatever casing the data carries,
 * while an upload keeps "traffic". Without folding the case the panel would not
 * know the two collide. {@link plannedLakeSamples} then adopts the operator's
 * own casing so the replacement this warning promises actually happens, and
 * each row carries that same adopted label ({@link LakeLogTypeChoice.storeLabel})
 * so the warning can name the sample the operator will actually lose.
 */
export function lakeLogTypeChoices(
  logTypes: readonly LakeLogTypeVolume[],
  existingLogTypes: readonly string[] = [],
): LakeLogTypeChoice[] {
  // The store's OWN index, answering both questions from one fold: whether a
  // row collides, and under which label. A row that warns about replacing a
  // sample is therefore a row plannedLakeSamples will really replace, named the
  // way plannedLakeSamples will really name it.
  const byKey = existingLabelsByCase(existingLogTypes);
  let preselected = 0;

  return logTypes.map((entry) => {
    const replacesExisting = byKey.has(sampleStoreKey(entry.logType));
    const selected = !replacesExisting && preselected < DEFAULT_PRESELECTED;
    if (selected) preselected += 1;

    const choice: LakeLogTypeChoice = {
      value: entry.logType,
      storeLabel: storeLabelFor(entry.logType, byKey),
      selected,
      replacesExisting,
    };
    if (entry.eventCount !== undefined) {
      choice.eventCount = entry.eventCount;
    }
    if (replacesExisting) {
      choice.note =
        "you already have a sample with this name - taking it replaces yours";
    }
    return choice;
  });
}

/** The values currently ticked, in the order they are offered. */
export function selectedLakeLogTypes(
  choices: readonly LakeLogTypeChoice[],
): string[] {
  return choices.filter((c) => c.selected).map((c) => c.value);
}

/** Flip one checkbox, returning a new list. */
export function toggleLakeChoice(
  choices: readonly LakeLogTypeChoice[],
  value: string,
): LakeLogTypeChoice[] {
  return choices.map((c) =>
    c.value === value ? { ...c, selected: !c.selected } : c,
  );
}

/**
 * The SAMPLES a commit would replace RIGHT NOW - one entry per sample, never
 * one per tick.
 *
 * Read off the ticks rather than off the query result, which is where this
 * differs from the capture panel: a capture commits everything it returned, so
 * its collisions are fixed the moment the result lands. Here the operator's
 * selection decides, and warning about a row they already unticked would train
 * them to ignore the warning.
 *
 * FOLDED THE WAY THE STORE FOLDS (2026-08-20). A dataset can hold both
 * "TRAFFIC" and "traffic" as discriminator values; against an operator sample
 * called "Traffic" BOTH rows adopt that one label, so ticking both replaces ONE
 * sample. Listing the two ticks named two samples the operator does not have
 * and overstated what they were about to lose - the pre-commit mirror of the
 * shortfall that blamed "returned nothing usable" for picks that had in fact
 * been merged ({@link mergedLakeLogTypeCount}).
 *
 * The name shown is the operator's own, because it is THEIR sample being
 * replaced and that is what it is called on their screen; the store key is only
 * the fold that decides which rows are the same sample.
 */
export function lakeCollisions(
  choices: readonly LakeLogTypeChoice[],
): string[] {
  // One entry per store key, holding the label to show for it.
  const named = new Map<string, string>();
  for (const choice of choices) {
    if (!choice.selected || !choice.replacesExisting) continue;
    // First tick wins the position; both ticks carry the same adopted label, so
    // there is no casing to choose between here.
    const key = sampleStoreKey(choice.storeLabel);
    if (!named.has(key)) named.set(key, choice.storeLabel);
  }
  return [...named.values()];
}

// ---------------------------------------------------------------------------
// Step one: the log-type query
// ---------------------------------------------------------------------------

/**
 * How the panel's result area should read.
 *
 * `no-discriminator` is its own status rather than the boolean the capture view
 * carries, and deliberately. A capture with nothing to split on still produces
 * ONE sample the operator can rename; a Lake query with nothing to group by
 * produces NO rows at all, because step two never ran. Folding it into `empty`
 * would tell an operator their dataset is idle when it is full.
 */
export type LakeQueryStatus =
  | "idle"
  | "querying"
  | "failed"
  | "empty"
  | "no-discriminator"
  | "ready";

export interface LakeQueryView {
  status: LakeQueryStatus;
  headline: string;
  /** The window the volumes cover; null until a result establishes one. */
  window: LakeWindow | null;
  /** The field Search grouped by - step two cannot be addressed without it. */
  discriminatorField?: string;
  /** True when the list hit the row cap and the dataset may hold more. */
  truncated: boolean;
  notes: readonly string[];
}

/**
 * Project a log-type query into what the panel renders.
 *
 * Takes no `existingLogTypes`: replacement is a property of the SELECTION, and
 * lives on the choices ({@link lakeLogTypeChoices}, {@link lakeCollisions}).
 */
export function deriveLakeQueryView(
  result: QueryLakeSamplesResult | null,
  running: boolean,
): LakeQueryView {
  const base = {
    window: null,
    truncated: false,
    notes: [] as readonly string[],
  };

  if (running) {
    // Wins over a result already in hand: a stale list beside a live spinner is
    // read as the answer to the query now running.
    return { ...base, status: "querying", headline: "Counting log types..." };
  }
  if (result === null) {
    return {
      ...base,
      status: "idle",
      headline:
        "Count the log types this dataset holds, and how many events of each. Nothing is added until you confirm.",
    };
  }

  const window = result.window;

  if (!result.ok) {
    return {
      ...base,
      window,
      status: "failed",
      headline: `The dataset "${result.datasetId}" could not be read, so its log types are unknown.`,
      notes: result.notes,
    };
  }
  if (result.noDiscriminator) {
    return {
      ...base,
      window,
      status: "no-discriminator",
      headline:
        "Nothing on these events tells one log type from another, so Search has nothing to count by.",
      notes: result.notes,
    };
  }
  if (result.logTypes.length === 0) {
    return {
      ...base,
      window,
      status: "empty",
      headline: `The dataset "${result.datasetId}" answered, and holds no log types between ${window.earliest} and ${window.latest}.`,
      notes: result.notes,
    };
  }

  const kinds = result.logTypes.length;
  const view: LakeQueryView = {
    status: "ready",
    headline: `${kinds} log type${kinds === 1 ? "" : "s"} in "${result.datasetId}", highest volume first.`,
    window,
    truncated: result.truncated,
    notes: result.notes,
  };
  if (result.discriminatorField !== undefined) {
    view.discriminatorField = result.discriminatorField;
  }
  return view;
}

/** Render a window as the operator sees it. Bounds are relative, not dates. */
export function windowLabel(window: LakeWindow): string {
  return `${window.earliest} to ${window.latest}`;
}

// ---------------------------------------------------------------------------
// Step two: the events, and what they commit to
// ---------------------------------------------------------------------------

/**
 * How the commit half reads.
 *
 * `unusable` is separate from `failed` for the same reason empty is separate
 * from failed: Search answered, the events arrived, and they parsed to nothing
 * this app can map. That is a data problem, not an access problem.
 */
export type LakeCommitStatus =
  | "idle"
  | "fetching"
  | "failed"
  | "unusable"
  | "done";

export interface LakeCommitView {
  status: LakeCommitStatus;
  headline: string;
  notes: readonly string[];
}

/**
 * Project an events fetch into what the panel reports afterwards.
 *
 * PARTIAL SUCCESS IS NAMED, not rounded up. fetchLakeLogTypeEvents keeps the
 * good log types when one of them fails, so "added 2" after ticking 3 is a
 * success with a hole in it - and the hole is invisible unless the count the
 * operator ASKED for is repeated back. `notes` says which ones were lost.
 *
 * A SHORTFALL HAS TWO CAUSES AND THEY ARE NOT THE SAME EVENT (2026-08-20
 * audit). Picks can be lost because the search returned nothing this app could
 * parse, OR because two of them resolve to ONE sample name and were added as
 * one ({@link mergedLakeLogTypeCount}). Reporting the second as "returned
 * nothing usable" tells the operator their data is missing when it is sitting
 * in the sample they just added, and sends them off to widen a window that was
 * never the problem. `mergedCount` is what lets the two be told apart; it
 * defaults to 0 so a caller with nothing to fold reads exactly as before.
 */
export function deriveLakeCommitView(
  result: FetchLakeEventsResult | null,
  fetching: boolean,
  plannedCount: number,
  requestedCount: number,
  mergedCount = 0,
): LakeCommitView {
  if (fetching) {
    return { status: "fetching", headline: "Fetching events...", notes: [] };
  }
  if (result === null) {
    return { status: "idle", headline: "", notes: [] };
  }
  if (!result.ok) {
    return {
      status: "failed",
      headline:
        "No events could be fetched for the log types you picked, so nothing was added.",
      notes: result.notes,
    };
  }
  if (plannedCount === 0) {
    // Events came back and none of them parsed into a record. Storing that
    // would produce husks - samples with a name and no fields, which satisfy
    // the "samples provided" check while giving the mapping nothing.
    return {
      status: "unusable",
      headline:
        "Events came back, but none of them parsed into a usable sample, so nothing was added.",
      notes: result.notes,
    };
  }
  return {
    status: "done",
    headline:
      plannedCount < requestedCount
        ? `Added ${plannedCount} of the ${requestedCount} log types you picked; ${shortfallReason(plannedCount, requestedCount, mergedCount)}.`
        : `Added ${plannedCount} sample${plannedCount === 1 ? "" : "s"} from this dataset.`,
    notes: result.notes,
  };
}

/**
 * Why fewer samples arrived than log types were picked, naming each cause that
 * actually applies rather than blaming the whole shortfall on empty data.
 *
 * The unusable clause is worded EXACTLY as it was before merges were counted
 * ("the rest returned nothing usable"), because when nothing merged that
 * sentence was already the true one - and its pin is the one that catches a
 * partial haul being rounded up to a clean one.
 */
function shortfallReason(
  plannedCount: number,
  requestedCount: number,
  mergedCount: number,
): string {
  const merged = Math.max(Math.min(mergedCount, requestedCount - plannedCount), 0);
  const unusable = requestedCount - plannedCount - merged;
  const reasons: string[] = [];
  if (merged > 0) {
    reasons.push(
      `${merged} ${merged === 1 ? "shares" : "share"} a sample name with another and ${merged === 1 ? "was" : "were"} added as part of it`,
    );
  }
  if (unusable > 0) {
    // "the rest" only while it IS the rest: with a merge already named, an
    // unqualified "the rest" would count the merged ones a second time.
    reasons.push(
      merged > 0
        ? `${unusable} returned nothing usable`
        : "the rest returned nothing usable",
    );
  }
  return reasons.join(", and ");
}

/**
 * Convert fetched Lake events into storage tagged samples - one per log type.
 *
 * The conversion is {@link plannedSamplesFrom}, shared with the capture panel:
 * the operator's existing label is adopted, the events are re-tagged through the
 * SAME content-first parse an upload goes through, and a log type whose rows
 * parse to no records is dropped rather than stored as a husk.
 *
 * What stays here is the Lake BOUNDARY: LakeLogTypeEvents is accepted at the
 * edge and reduced to {logType, rawEvents}, because the format is detected from
 * the raw lines rather than carried over from anything Search said about them.
 */
export function plannedLakeSamples(
  events: readonly LakeLogTypeEvents[],
  sourceLabel: string,
  existingLogTypes: readonly string[] = [],
): TaggedSample[] {
  return plannedSamplesFrom(events, sourceLabel, existingLogTypes);
}

/**
 * How many picked log types were ADDED AS PART OF ANOTHER rather than lost.
 *
 * The case-variant collision this exists for: a dataset holding both "TRAFFIC"
 * and "traffic" while the operator already has a sample called "traffic". Both
 * picks adopt the operator's label ({@link storeLabelFor}), so
 * {@link plannedLakeSamples} folds them into ONE sample - and without this
 * count the commit summary calls the second one "returned nothing usable",
 * which is the opposite of what happened to it.
 *
 * Counted off the NAMES the operator picked plus the samples that came back,
 * never off the events, so it never re-parses anything: a pick counts as merged
 * only when another pick resolves to the same label AND that label actually
 * produced a sample. When the whole group produced nothing, every one of them
 * genuinely returned nothing usable and is left to be reported as such.
 *
 * The extras are what is counted, not the group - two picks sharing one label
 * cost ONE sample, not two.
 */
export function mergedLakeLogTypeCount(
  selected: readonly string[],
  samples: readonly TaggedSample[],
  existingLogTypes: readonly string[] = [],
): number {
  const byKey = existingLabelsByCase(existingLogTypes);
  const added = new Set(samples.map((s) => s.logType));

  const picksPerLabel = new Map<string, number>();
  for (const pick of selected) {
    const label = storeLabelFor(pick, byKey);
    picksPerLabel.set(label, (picksPerLabel.get(label) ?? 0) + 1);
  }

  let merged = 0;
  for (const [label, picks] of picksPerLabel) {
    if (picks > 1 && added.has(label)) merged += picks - 1;
  }
  return merged;
}
