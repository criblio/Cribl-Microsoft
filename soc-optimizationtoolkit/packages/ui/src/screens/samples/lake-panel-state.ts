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
 *   2. fetchLakeLogTypeEvents -> the actual events for the log types they ticked,
 *                            SHOWN before they are taken
 *                            ({@link lakeSamplePreviews}).
 *   3. the commit           -> those same events, tagged into the store. No
 *                            search, no re-fetch: step two's bytes.
 *
 * Keeping one and two apart is the point: fetching bodies for every log type up
 * front would pull them for the ones the operator discards, on the biggest
 * datasets, which is exactly where it hurts most (see the usecase's own note).
 * Keeping two and three apart costs NO extra search - the fetch is the same one
 * the commit used to run inside itself - and it is what lets an operator see the
 * bytes before they are stored, the way the capture panel always has.
 *
 * SIX THINGS THIS MODULE EXISTS TO GET RIGHT:
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
 * 5. AN UNSPLITTABLE DATASET IS NOT AN EMPTY ONE, and since 2026-08-25 it is
 *    not a dead end either. When nothing distinguishes a populated dataset's
 *    events it holds ONE log type, which core offers under the DATASET'S name
 *    with a measured volume. Two things follow that this module owes the
 *    operator: the row is committable (so the controls and the window sentence
 *    appear for it, {@link lakeOffersSamples}), and the name is stated as the
 *    dataset's rather than as something found in the data. Getting the second
 *    wrong would have the app invent a vendor log type it never observed.
 *
 * 6. A ROW CAN BE OFFERED WITHOUT HAVING A NAME (user report 2026-08-25). The
 *    `summarize by msgid` group for the events that carry NO msgid is a real
 *    group with a real count, and core now offers it under a label it MINTED
 *    from the field - "(no msgid)". That is item 5's bargain per row rather
 *    than per dataset, and it lands in the hardest place for it: beside twelve
 *    log types whose names ARE the data's. {@link LakeLogTypeChoice.unnamed}
 *    carries core's own word for which row that is, so the caveat sits on the
 *    row and never has to be inferred from how the label is spelled.
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
import { estimatedLogTypeBytes } from "@soc/core";
import {
  existingLabelsByCase,
  plannedSamplesFrom,
  previewLines,
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
  /**
   * ESTIMATED bytes over that window - {@link eventCount} times the mean size of
   * this log type's sampled events, computed by core's `estimatedLogTypeBytes`.
   * Undefined whenever either half is missing, and rendered as an estimate.
   *
   * Worth showing HERE, on the row the operator ticks: what a log type costs to
   * ingest into Sentinel is charged by volume, so it is part of deciding whether
   * to take it - and "890,123 events" alone does not answer that.
   */
  estimatedBytes?: number;
  /** Whether it starts ticked. */
  selected: boolean;
  /** True when taking this would replace an existing tagged sample. */
  replacesExisting: boolean;
  /**
   * True when this row is the group whose discriminator value was ABSENT, so
   * its {@link value} is a label core MINTED from the field ("(no msgid)")
   * rather than a name anything in the data carries.
   *
   * Carried on the row for the same reason {@link LakeQueryView.datasetAsLogType}
   * is carried on the view: a row that reads as a vendor log type when it is
   * not is the app claiming something it never observed, and the panel must be
   * able to say so beside THIS row rather than in a note far below a list of
   * twelve real ones.
   */
  unnamed: boolean;
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
      // Read from the volume, never inferred from the NAME here. Core mints the
      // label and core says which row it minted; a second rule in the UI that
      // decided by looking for parentheses would eventually disagree with it,
      // and the disagreement would be a real vendor log type presented with a
      // caveat about a field it does carry.
      unnamed: entry.unnamed === true,
    };
    if (entry.eventCount !== undefined) {
      choice.eventCount = entry.eventCount;
    }
    // The multiplication is CORE's, not this module's. A second events-to-bytes
    // rule in the UI would be a second place to decide what an unmeasured log
    // type weighs, and the answer to that has to be "nothing at all", once.
    const estimatedBytes = estimatedLogTypeBytes(entry);
    if (estimatedBytes !== undefined) {
      choice.estimatedBytes = estimatedBytes;
    }
    if (replacesExisting) {
      choice.note =
        "you already have a sample with this name - taking it replaces yours";
    }
    return choice;
  });
}

/**
 * What the hint above the list may truthfully say about the ticks.
 *
 * "The highest-volume ones are pre-selected" was printed unconditionally, and it
 * is false in exactly the case the rule above creates: when EVERY row would
 * replace a sample the operator already has, nothing is pre-selected at all
 * (2026-08-26 audit). The behaviour is right - re-taking a curated sample is a
 * deliberate act - but an operator reading that sentence over a list of empty
 * boxes is being told the panel did something it declined to do, and the natural
 * next move is to hunt for the tick that went missing.
 *
 * Read off `replacesExisting` rather than off the live ticks, deliberately. This
 * describes what the list ARRIVED as; deriving it from what is ticked NOW would
 * rewrite the sentence under the operator as they work, and a hint that changes
 * when you tick a box is not a hint about pre-selection.
 */
export function lakePreselectionHint(
  choices: readonly LakeLogTypeChoice[],
): string {
  if (choices.length === 0) return "";
  if (choices.every((c) => c.replacesExisting)) {
    return "None are pre-selected: you already have a sample for every log type here, so taking one replaces yours.";
  }
  return "The highest-volume ones you do not already have are pre-selected.";
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
 *
 * `dataset-as-log-type` IS THE ANSWER TO THAT (2026-08-25), and the two must not
 * be confused either. A populated dataset that nothing splits holds ONE log
 * type, and core now offers it under the dataset's own name with a real count -
 * so this status has rows, a window and a commit, where `no-discriminator` has
 * none of the three. `no-discriminator` remains for a result that reports the
 * missing field WITHOUT offering anything, which core no longer produces but the
 * port's type still permits; a status that silently renders a row-less panel as
 * ready would be worse than one branch that is currently unreachable.
 *
 * `no-groups` IS THE SECOND SPLIT OF `empty` (2026-08-26 audit), closing the same
 * collapse one step further in. Core reaches a row-less `ok: true` result down
 * TWO paths and only one of them is an empty window. The other runs only AFTER
 * step one returned rows - so the dataset PROVABLY holds events - and it is the
 * GROUPING that came back with nothing (query-lake-samples.ts, the
 * `readout.logTypes.length === 0` branch, which carries the discriminator field
 * the empty-window branch cannot). Both wore the sentence "holds no log types
 * between -24h and now", which for the second is the app stating the opposite of
 * what core had just observed - with core's own note beside it saying so, so the
 * headline and the note contradicted each other on one screen. That branch also
 * covers a count whose every group was UNREADABLE, which is this app failing,
 * printed as a fact about the operator's data.
 */
export type LakeQueryStatus =
  | "idle"
  | "querying"
  | "failed"
  | "empty"
  | "no-groups"
  | "no-discriminator"
  | "dataset-as-log-type"
  | "ready";

export interface LakeQueryView {
  status: LakeQueryStatus;
  headline: string;
  /** The window the volumes cover; null until a result establishes one. */
  window: LakeWindow | null;
  /** The field Search grouped by - step two cannot be addressed without it. */
  discriminatorField?: string;
  /**
   * True when the one row on offer is named after the DATASET rather than after
   * anything observed in the events.
   *
   * Carried rather than inferred from the status so the two things it decides
   * stay in one place: whether the panel prints the naming caveat, and whether
   * a fetch can be addressed with NO discriminator field. Inferring the second
   * from "the field is missing" is what would let a genuinely field-less result
   * enable a button that fetches the whole dataset under a name nobody saw.
   */
  datasetAsLogType: boolean;
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
    datasetAsLogType: false,
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
    // OFFERED, not refused. The dataset is populated and nothing splits it, so
    // it holds one log type and core names it after the dataset. The panel
    // renders that row, its measured volume and a commit - what it must NOT do
    // is present the name as a log type anyone found in the data, which is what
    // `datasetAsLogType` on the view goes on to say.
    if (result.datasetAsLogType && result.logTypes.length > 0) {
      return {
        ...base,
        window,
        status: "dataset-as-log-type",
        datasetAsLogType: true,
        headline: `Nothing on these events tells one log type from another, so "${result.datasetId}" is offered as a single log type.`,
        notes: result.notes,
      };
    }
    // Nothing was offered with it, so this stays the dead end it always was.
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
    // TWO ANSWERS WEAR THIS SHAPE and only one of them is about an idle dataset.
    // The FIELD is what tells them apart, and it is evidence rather than a
    // convention: core can only name a discriminator after step one returned
    // events to read it off, so a row-less result that carries one is a result
    // about a dataset that demonstrably holds events.
    if (result.discriminatorField !== undefined) {
      return {
        ...base,
        window,
        status: "no-groups",
        discriminatorField: result.discriminatorField,
        // NOT "holds no log types". The events are there and were read; what
        // came back with nothing is the grouping, and core's note says which of
        // its causes applies. Claiming the dataset is empty here would send the
        // operator to widen a window over data they already have - or, when the
        // groups were simply unreadable, hand them this app's own failure as a
        // fact about their data.
        headline: `The dataset "${result.datasetId}" holds events, but grouping them by ${result.discriminatorField} produced no log types.`,
        notes: result.notes,
      };
    }
    return {
      ...base,
      window,
      status: "empty",
      headline: `The dataset "${result.datasetId}" answered, and holds no events over ${windowLabel(window)}.`,
      notes: result.notes,
    };
  }

  const kinds = result.logTypes.length;
  const view: LakeQueryView = {
    status: "ready",
    headline: `${kinds} log type${kinds === 1 ? "" : "s"} in "${result.datasetId}", highest volume first.`,
    window,
    // A field grouped these, so every name on offer came out of the data.
    datasetAsLogType: false,
    truncated: result.truncated,
    notes: result.notes,
  };
  if (result.discriminatorField !== undefined) {
    view.discriminatorField = result.discriminatorField;
  }
  return view;
}

/**
 * Whether this view has rows the operator can actually take.
 *
 * TWO statuses do, and the second one is easy to forget: a dataset offered as a
 * single log type is as committable as a grouped list. The panel asks this
 * rather than comparing statuses inline, so a new offering status cannot reach
 * the screen with its window sentence and its controls silently missing.
 */
export function lakeOffersSamples(view: LakeQueryView): boolean {
  return view.status === "ready" || view.status === "dataset-as-log-type";
}

/**
 * Whether a fetch can be ADDRESSED from this view and this selection.
 *
 * THE BUTTON AND THE HANDLER ASK THE SAME QUESTION, which is the whole reason
 * this is a function rather than a condition written twice. A control that does
 * nothing whatever when pressed reads to an operator as a broken app rather
 * than as a missing field, and the two conditions drifting apart is exactly how
 * that happens.
 *
 * The field may be absent ONLY when the dataset itself is the log type: with no
 * field the fetch runs unfiltered and returns the whole dataset, so allowing it
 * for a result that merely lacked a discriminator would take those events under
 * a name nobody observed.
 */
export function canFetchLakeSamples(
  view: LakeQueryView,
  selectedCount: number,
): boolean {
  if (selectedCount === 0) return false;
  if (!lakeOffersSamples(view)) return false;
  return view.discriminatorField !== undefined || view.datasetAsLogType;
}

/**
 * The units a relative Kusto bound can carry, spelled the way an operator reads
 * them. Anything outside this map is a token this module declines to translate.
 */
const BOUND_UNITS: Readonly<Record<string, string | undefined>> = {
  s: "second",
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
};

function isNowBound(bound: string): boolean {
  return bound === "" || bound.toLowerCase() === "now";
}

/** "-24h" -> {24, "hour"}. Null for anything that is not one of these. */
function relativeBound(bound: string): { amount: number; unit: string } | null {
  const match = /^-(\d+)([smhdw])$/.exec(bound.toLowerCase());
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = BOUND_UNITS[match[2]];
  // A zero-length window is not a period, so it is not described as one - it is
  // handed back untranslated with everything else this cannot read.
  if (unit === undefined || !Number.isFinite(amount) || amount === 0) return null;
  return { amount, unit };
}

/** "24 hours", "1 day" - the quantity alone, for either phrasing below. */
function boundQuantity(parts: { amount: number; unit: string }): string {
  return `${parts.amount} ${parts.unit}${parts.amount === 1 ? "" : "s"}`;
}

/**
 * Render a window as the operator sees it.
 *
 * THE BOUNDS ARE KUSTO TOKENS, NOT TIMES, and until 2026-08-26 they were printed
 * raw: "between -24h and now", "Volumes cover -24h to now." That is the app
 * quoting its own query language at someone who never wrote it, and the leading
 * "-" reads as a minus sign rather than as "ago" - so the one sentence that turns
 * a volume into a fact was the least legible on the screen.
 *
 * AN UNRECOGNISED TOKEN IS PRINTED AS IT IS, never guessed at. A bound this
 * module cannot parse is one whose meaning it does not know, and inventing a
 * phrase for it would state a window that was never queried - the same rule the
 * counts follow when a volume comes back unreadable.
 */
export function windowLabel(window: LakeWindow): string {
  const earliest = window.earliest.trim();
  const latest = window.latest.trim();
  const from = relativeBound(earliest);
  // The overwhelmingly common shape, and the only one with a natural phrase:
  // a relative start against the present.
  if (from !== null && isNowBound(latest)) {
    return `the last ${from.amount === 1 ? from.unit : boundQuantity(from)}`;
  }
  return `${boundPhrase(earliest)} to ${boundPhrase(latest)}`;
}

function boundPhrase(bound: string): string {
  if (isNowBound(bound)) return "now";
  const parts = relativeBound(bound);
  return parts === null ? bound : `${boundQuantity(parts)} ago`;
}

// ---------------------------------------------------------------------------
// Step two: the events, previewed before they are taken
// ---------------------------------------------------------------------------

/**
 * One fetched log type as the preview renders it - the capture panel's
 * {@link CapturedLogTypeView} for a Lake haul, deliberately.
 *
 * WHY THIS EXISTS (user report 2026-08-25). Lake samples were reaching the store
 * carrying a syslog transport envelope wrapped around the vendor's own bytes,
 * and there was no point in the flow where anyone could SEE that: the events
 * were fetched and committed inside one click. The capture panel had shown its
 * events before tagging them since the day it was written; this is the same
 * confirmation, on the path that lacked it.
 *
 * THE TEXT IS THE FETCH'S OWN, not a re-query and not a reformat. Anything else
 * would be a preview of something other than what lands in the store, which is
 * worse than no preview at all - it would show a clean vendor line while an
 * enveloped one was committed.
 */
export interface LakeSamplePreview {
  /** The log type as the FETCH returned it - the row the operator ticked. */
  logType: string;
  /**
   * The label these events would actually be STORED under: the operator's own
   * casing when one of their samples collides ({@link storeLabelFor}), the
   * dataset's otherwise. Read from the SAME store fold the commit uses, so the
   * preview cannot name a sample the commit will not write.
   */
  storeLabel: string;
  /** Events fetched for it. The whole haul; {@link preview} shows its head. */
  eventCount: number;
  /** The first few lines, exactly as they arrived. */
  preview: string[];
  /** True when committing this would replace an existing tagged sample. */
  replacesExisting: boolean;
  /**
   * False when the commit will DROP these events because they parse to no
   * record ({@link plannedSamplesFrom} refuses to store a husk).
   *
   * Said on the row rather than left to the summary afterwards: an operator
   * looking at three previews and pressing the button has been told they are
   * taking three samples, and finding out from a shortfall sentence that one of
   * them was never addable is finding out too late to pick something else.
   */
  willBeAdded: boolean;
  /**
   * Events the STORED sample will report - `parsed.eventCount`, which is the
   * number this sample's chip goes on to show - when it can be attributed to
   * this row alone.
   *
   * THE TWO NUMBERS NEVER RECONCILED (user report 2026-08-26). The confirm
   * screen said "Fetched 200 events in 4 log types" and listed each row at "50
   * events"; the chips that appeared read 26, 19 and 17. The mechanism was
   * investigated and the obvious causes ruled out - Search returns exactly the
   * rows asked for, the parser keeps them, RAW_EVENTS_CAP is not reached, and
   * nothing dedupes on the commit path - so this does NOT fix a drop. It states
   * BOTH numbers when they differ, so a recurrence explains itself on the screen
   * that made the claim instead of reading as corruption two clicks later.
   *
   * ABSENT WHERE IT WOULD BE AMBIGUOUS: two rows that fold onto ONE store label
   * produce ONE sample between them, and printing its count beside each row
   * would attribute the same events twice.
   */
  storedEventCount?: number;
}

/**
 * Project a fetched haul into what the panel shows BEFORE the commit.
 *
 * Takes the planned SAMPLES rather than re-parsing the events, for the reason
 * {@link mergedLakeLogTypeCount} takes them: the parse has already been run
 * once to decide what would be committed, and a second one here could disagree
 * with it. `willBeAdded` is therefore the commit's own answer, not a prediction
 * of it.
 */
export function lakeSamplePreviews(
  events: readonly LakeLogTypeEvents[],
  samples: readonly TaggedSample[],
  existingLogTypes: readonly string[] = [],
): LakeSamplePreview[] {
  const byKey = existingLabelsByCase(existingLogTypes);
  const added = new Set(samples.map((s) => s.logType));
  // What each stored sample will REPORT, keyed the way the store keys it. Read
  // off the planned samples for the same reason `willBeAdded` is: this is the
  // commit's own number, not a second count of the same lines.
  const storedByLabel = new Map(
    samples.map((s) => [s.logType, s.parsed.eventCount] as const),
  );
  // How many ROWS resolve to each label, which is what decides whether the
  // number above can be attributed to one of them.
  const rowsPerLabel = new Map<string, number>();
  for (const entry of events) {
    const label = storeLabelFor(entry.logType, byKey);
    rowsPerLabel.set(label, (rowsPerLabel.get(label) ?? 0) + 1);
  }

  return events.map((entry) => {
    const storeLabel = storeLabelFor(entry.logType, byKey);
    const stored = storedByLabel.get(storeLabel);
    const preview: LakeSamplePreview = {
      logType: entry.logType,
      storeLabel,
      eventCount: entry.rawEvents.length,
      preview: previewLines(entry.rawEvents),
      replacesExisting: byKey.has(sampleStoreKey(entry.logType)),
      willBeAdded: added.has(storeLabel),
    };
    if (stored !== undefined && rowsPerLabel.get(storeLabel) === 1) {
      preview.storedEventCount = stored;
    }
    return preview;
  });
}

/**
 * What the preview says it is holding, and that nothing has been stored yet.
 *
 * EMPTY FOR AN EMPTY HAUL, because the panel renders no preview block at all
 * then: a fetch that produced nothing to take is reported by
 * {@link deriveLakeCommitView}, which owns the difference between "no events
 * came back" and "events came back and parsed to nothing". A second sentence
 * about it here is a second place for those two to be confused.
 */
export function lakePreviewHeadline(
  previews: readonly LakeSamplePreview[],
  samples?: readonly TaggedSample[],
): string {
  if (previews.length === 0) return "";
  const events = previews.reduce((sum, entry) => sum + entry.eventCount, 0);
  const kinds = previews.length;
  // THE STORED TOTAL, when the caller can supply it. Summed over the SAMPLES
  // rather than over the rows, so two picks folded into one sample are counted
  // once - the row-level figure deliberately goes absent in that case, and a
  // total built from it would inherit the gap.
  const stored =
    samples === undefined
      ? undefined
      : samples.reduce((sum, s) => sum + s.parsed.eventCount, 0);
  // Said ONLY when the two disagree. Restating one number twice on every haul is
  // noise, and noise is what stops a caveat being read on the haul that needs it.
  const reconciled =
    stored !== undefined && stored !== events
      ? `, which parse into ${stored} stored event${stored === 1 ? "" : "s"}`
      : "";
  return (
    `Fetched ${events} event${events === 1 ? "" : "s"}` +
    ` in ${kinds} log type${kinds === 1 ? "" : "s"}${reconciled}.` +
    " Nothing is added until you confirm."
  );
}

// ---------------------------------------------------------------------------
// Step three: what the commit reports afterwards
// ---------------------------------------------------------------------------

/**
 * How the commit half reads.
 *
 * `unusable` is separate from `failed` for the same reason empty is separate
 * from failed: Search answered, the events arrived, and they parsed to nothing
 * this app can map. That is a data problem, not an access problem.
 *
 * `no-events` is the third of those (2026-08-25). A fetch that succeeds and
 * returns NO events at all was reported as `unusable` - under a headline reading
 * "Events came back, but none of them parsed into a usable sample", about a
 * fetch where no event came back at all. It is the empty-versus-failed collapse
 * this file keeps closing, one step further in: the operator was sent to look at
 * their data's shape when what they needed was a wider window or another log
 * type. The two are told apart by the haul itself, not by a count of what
 * survived the parse.
 *
 * `partial` is the fourth (2026-08-26 audit), and it was the loudest of the lot.
 * Core's `ok` is `failed === 0` - false when ANY log type failed, not when all
 * did - so a haul that lost one pick and kept four arrived here with `ok: false`
 * AND four samples already written by the commit. This projection tested `ok`
 * before it looked at what had been stored, so the panel printed "No events could
 * be fetched for the log types you picked, so nothing was added" with the four
 * new chips sitting directly below it. WHAT WAS STORED IS THEREFORE READ FIRST:
 * a haul that produced samples reports what it produced, and names its shortfall,
 * and only a haul that produced NOTHING can be one of the three answers above.
 *
 * `store-failed` is the fifth, and it is the same collapse in a third direction.
 * The store write was awaited with no catch at all, so a rejected write rendered
 * as NOTHING: the button un-disabled, the preview stayed, and the operator could
 * not tell a refused write from a slow one.
 */
export type LakeCommitStatus =
  | "idle"
  | "fetching"
  | "failed"
  | "no-events"
  | "unusable"
  | "partial"
  | "store-failed"
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
  storeError: string | null = null,
): LakeCommitView {
  if (fetching) {
    return { status: "fetching", headline: "Fetching events...", notes: [] };
  }
  if (storeError !== null) {
    // THE WRITE ITSELF REFUSED, which is neither an empty haul nor a failed
    // search - the events are in hand and on screen. It says nothing about how
    // much of the haul landed, because a rejected upsert loop does not report
    // where it stopped, and "nothing was added" would be a guess. What it does
    // say is that the preview is still there to retry from, since it is.
    return {
      status: "store-failed",
      headline: `The samples could not be saved: ${storeError}. The fetched events are still here - press "Add as samples" to try again.`,
      notes: [],
    };
  }
  if (result === null) {
    return { status: "idle", headline: "", notes: [] };
  }
  // WHAT WAS STORED IS READ BEFORE `ok`, and that order is the whole fix. Core's
  // `ok` is false when ANY log type failed, so a partial haul - four fetched, one
  // lost - arrives here as `ok: false` with four samples already in the store.
  // Testing `ok` first answered "nothing was added" over four new chips.
  if (plannedCount > 0) {
    if (!result.ok) {
      return {
        status: "partial",
        headline:
          `Added ${plannedCount} sample${plannedCount === 1 ? "" : "s"} from the` +
          ` ${requestedCount} log type${requestedCount === 1 ? "" : "s"} you picked. ` +
          partialFetchShortfall(plannedCount, requestedCount, mergedCount),
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
  if (!result.ok && result.events.length === 0) {
    return {
      status: "failed",
      headline:
        "No events could be fetched for the log types you picked, so nothing was added.",
      notes: result.notes,
    };
  }
  // NOTHING WAS ADDED, and the two reasons for that send the operator to
  // opposite places. Read off the HAUL rather than off the parse: with no
  // events there was never anything to parse, and saying otherwise describes
  // events that do not exist.
  if (result.events.length === 0) {
    return {
      status: "no-events",
      headline:
        "The search ran and returned no events for the log types you picked, so nothing was added.",
      notes: result.notes,
    };
  }
  // Events came back and none of them parsed into a record. Storing that would
  // produce husks - samples with a name and no fields, which satisfy the
  // "samples provided" check while giving the mapping nothing. Reached whether
  // or not a SIBLING log type also failed to fetch: nothing was added either
  // way, and `notes` names each failure by log type.
  return {
    status: "unusable",
    headline:
      "Events came back, but none of them parsed into a usable sample, so nothing was added.",
    notes: result.notes,
  };
}

/**
 * What a PARTIAL haul lost, for a fetch that stored something and still failed.
 *
 * Deliberately vaguer than {@link shortfallReason}, because less is known here.
 * `ok: false` says at least one log type failed but not HOW MANY - core reports
 * that per log type in `notes` and nowhere else - so a shortfall split between
 * "failed" and "returned nothing usable" cannot be attributed. Naming a number
 * for either half would be a sum nobody measured, so the causes are named
 * together and the operator is pointed at the notes that separate them.
 *
 * The merged clause stays exact, because merges ARE counted
 * ({@link mergedLakeLogTypeCount}), and it is the one part of a shortfall that
 * must never be reported as missing data.
 */
function partialFetchShortfall(
  plannedCount: number,
  requestedCount: number,
  mergedCount: number,
): string {
  const merged = Math.max(Math.min(mergedCount, requestedCount - plannedCount), 0);
  const lost = requestedCount - plannedCount - merged;
  const clauses: string[] = [];
  if (merged > 0) {
    clauses.push(
      `${merged} ${merged === 1 ? "shares" : "share"} a sample name with another and ${merged === 1 ? "was" : "were"} added as part of it.`,
    );
  }
  clauses.push(
    lost > 0
      ? `${lost} of them could not be fetched, or returned nothing usable - the notes below name which.`
      : "Some could not be fetched - the notes below name which.",
  );
  return clauses.join(" ");
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
 *
 * A PICK THAT BROUGHT BACK NOTHING WAS NOT MERGED INTO ANYTHING (2026-08-26
 * audit). `fetchedLogTypes` is the list that actually returned events, and
 * without it a pick whose fetch FAILED, against a case-variant sibling that
 * succeeded, was counted as "added as part of" the sibling's sample - a claim
 * that its events are sitting in a sample they never reached. Optional so a
 * caller with no haul in hand reads exactly as before; the panel always has one.
 */
export function mergedLakeLogTypeCount(
  selected: readonly string[],
  samples: readonly TaggedSample[],
  existingLogTypes: readonly string[] = [],
  fetchedLogTypes?: readonly string[],
): number {
  const byKey = existingLabelsByCase(existingLogTypes);
  const added = new Set(samples.map((s) => s.logType));
  const returned =
    fetchedLogTypes === undefined ? null : new Set(fetchedLogTypes);

  const picksPerLabel = new Map<string, number>();
  for (const pick of selected) {
    if (returned !== null && !returned.has(pick)) continue;
    const label = storeLabelFor(pick, byKey);
    picksPerLabel.set(label, (picksPerLabel.get(label) ?? 0) + 1);
  }

  let merged = 0;
  for (const [label, picks] of picksPerLabel) {
    if (picks > 1 && added.has(label)) merged += picks - 1;
  }
  return merged;
}
