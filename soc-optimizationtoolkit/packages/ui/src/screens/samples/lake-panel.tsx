/**
 * LakePanel - count what a Cribl Lake dataset holds, let the operator pick from
 * it, and fetch only what they picked (plan Phase 4, ADR 0003).
 *
 * NOTHING ENTERS THE SAMPLE STORE WITHOUT A DELIBERATE CLICK (user direction
 * 2026-08-19), the same rule the capture panel follows. The store is
 * replace-by-logType, so an auto-commit would silently overwrite a sample the
 * operator curated.
 *
 * TWO BUTTONS, TWO READS, and the split is the whole design. "Find log types"
 * runs a `summarize count()` and returns COUNTS - names and volumes, no event
 * bodies. Counts are what the operator needs to CHOOSE and are useless as a
 * sample. "Fetch events" then fetches actual events, and only for the ticked
 * rows: doing it up front would pull bodies for every log type they go on to
 * discard, on the biggest datasets, which is where it hurts most.
 *
 * A THIRD BUTTON THAT COSTS NOTHING (user report 2026-08-25). The fetch used to
 * commit what it fetched in the same click, so the first time anyone saw a Lake
 * event was after it was in the store - which is how samples carrying a syslog
 * transport envelope around the vendor's own bytes got there unnoticed. The
 * fetch now HOLDS its events, shows them, and stores them only on "Add as
 * samples". The capture panel has worked this way since it was written; this is
 * that same confirm step, on the path that lacked it.
 *
 * THE SEARCH BUDGET IS UNCHANGED, and that is the reason this shape was chosen
 * over the obvious alternatives. Fetching on expand, or behind a per-row Preview
 * button, would run a search job per log type for the preview and another for
 * the commit - double, on the step that is already one job per ticked row. The
 * events shown here are the ones the commit was ALREADY fetching; nothing was
 * added to the flow but a click, and what the operator reads is the text the
 * commit is handed - unedited, envelope and all.
 *
 * The commit summary OUTLIVES the log-type list on purpose. A fetch can lose one
 * log type and keep the rest, so clearing the panel on success would round a
 * partial haul up to a clean one.
 *
 * THE COMMIT BUTTON AGREES WITH THE COMMIT HANDLER (2026-08-20 audit). The
 * handler cannot address step two without the field step one grouped by, so it
 * returns early when there is none - and the button disables on that same
 * condition instead of being left enabled over it. Both now ask
 * `canFetchLakeSamples`, one function, because the cost of the two disagreeing
 * is a button that does nothing whatever when pressed, which an operator reads
 * as a broken app rather than as a missing field.
 *
 * A DATASET CAN BE ITS OWN LOG TYPE (2026-08-25). When nothing splits a
 * populated dataset, core offers it as ONE log type under the DATASET'S name
 * with a measured volume, and this panel commits it like any other row - the
 * fetch simply carries no field and runs unfiltered. What the panel owes that
 * row is the caveat beside it: the name is the dataset's, not a log type anyone
 * found in the data. Before this, a dataset like `winevt_dcronly` - 1,216
 * events, one Windows channel - offered NOTHING and pointed the operator at a
 * different acquisition mode for data already in their lake.
 *
 * SO CAN A GROUP WITH NO NAME (user report 2026-08-25). `summarize by msgid`
 * returns a group for the events carrying no msgid; the panel used to report it
 * ("1 group carried no msgid value and was left out") and leave those events
 * with no route to becoming a sample at all. Core now offers that group as a
 * row labelled "(no msgid)" with its real count, and what this panel owes it is
 * the same thing it owes the dataset-named row: the caveat, beside it, saying
 * the label describes what these events LACK rather than naming what they are.
 *

 * All decisions are the pure lake-panel-state; this renders and wires. The ports
 * stay with the screen (onQuery/onFetchEvents), as they do for CapturePanel.
 */

import { useEffect, useState } from "react";
import type {
  FetchLakeEventsResult,
  QueryLakeSamplesResult,
  TaggedSample,
} from "@soc/core";
import { DEFAULT_SAMPLE_LIMIT, MAX_SAMPLE_LIMIT } from "@soc/core";
import {
  canFetchLakeSamples,
  deriveLakeCommitView,
  deriveLakeQueryView,
  lakeCollisions,
  lakeLogTypeChoices,
  lakeOffersSamples,
  lakePreviewHeadline,
  lakeSamplePreviews,
  mergedLakeLogTypeCount,
  plannedLakeSamples,
  selectedLakeLogTypes,
  toggleLakeChoice,
  windowLabel,
} from "./lake-panel-state";
import type { LakeLogTypeChoice, LakeSamplePreview } from "./lake-panel-state";
// The picker's byte formatter, reused rather than reproduced - see the note at
// its definition; it is the coarse hint register an estimate belongs in.
import { formatBytes } from "./sample-source-picker-state";
import { useNumericField } from "./use-numeric-field";

/**
 * A fetched haul waiting on the operator's word - the events, and everything
 * already decided about them.
 *
 * THE SAMPLES ARE COMPUTED ONCE, HERE, and the commit sends exactly these. Not
 * re-planned at commit time, because the parse would then run against whatever
 * the store held by then rather than against what the preview described - and
 * the preview's whole claim is that it shows what is about to be written.
 */
interface PendingLakeFetch {
  result: FetchLakeEventsResult;
  /** What a commit will write, verbatim. */
  samples: TaggedSample[];
  /** The same haul as the operator sees it, rows and lines. */
  previews: LakeSamplePreview[];
  /** Log types ticked when the fetch ran - what the summary is measured against. */
  requested: number;
  /** Picks folded into another sample rather than lost; see the outcome below. */
  merged: number;
}

/** What a commit established, kept beside the fetch so partials stay visible. */
interface CommitOutcome {
  result: FetchLakeEventsResult;
  /** Samples that survived the content-first parse. */
  planned: number;
  /** Log types the operator ticked, which is what `planned` is measured against. */
  requested: number;
  /**
   * Ticked log types that were added AS PART OF another rather than lost, which
   * is the difference between a shortfall the operator should act on and one
   * they should not.
   */
  merged: number;
}

export interface LakePanelProps {
  /** The Lake dataset the operator selected, as its listing reported the id. */
  datasetId: string;
  /**
   * The SEARCH group's id - NOT a Stream worker group. Empty when the workspace
   * has none, which is a dead end worth stating before a button is pressed
   * rather than surfacing as a 404 that reads like an empty dataset.
   */
  searchGroupId: string;
  /** Log types already in the tagged-sample store, for the replace warning. */
  existingLogTypes: readonly string[];
  /** Count the dataset's log types. Resolves with the result; never throws. */
  onQuery: () => Promise<QueryLakeSamplesResult>;
  /**
   * Fetch events for the ticked log types. Resolves; never throws.
   *
   * `discriminatorField` is UNDEFINED for a dataset offered as a single log
   * type - there is no field, and core fetches it unfiltered. Passed through as
   * the query reported it rather than defaulted to a string, so the fetch is
   * addressed with what the operator can see on screen.
   */
  onFetchEvents: (
    discriminatorField: string | undefined,
    logTypes: readonly string[],
    eventsPerLogType: number,
  ) => Promise<FetchLakeEventsResult>;
  /** Commit the fetched samples to the store. */
  onCommit: (samples: TaggedSample[]) => Promise<void>;
}

export function LakePanel({
  datasetId,
  searchGroupId,
  existingLogTypes,
  onQuery,
  onFetchEvents,
  onCommit,
}: LakePanelProps) {
  const [result, setResult] = useState<QueryLakeSamplesResult | null>(null);
  const [choices, setChoices] = useState<LakeLogTypeChoice[]>([]);
  const eventsPerLogType = useNumericField(DEFAULT_SAMPLE_LIMIT);
  const [querying, setQuerying] = useState(false);
  const [fetching, setFetching] = useState(false);
  // The store write is awaited separately from the fetch, as the capture panel
  // awaits its commit: they fail differently, and while this one runs the panel
  // is showing a preview of samples already on their way in.
  const [committing, setCommitting] = useState(false);
  const [pending, setPending] = useState<PendingLakeFetch | null>(null);
  const [outcome, setOutcome] = useState<CommitOutcome | null>(null);

  // A different dataset means different log types and a different commit. Left
  // on screen, the old counts would be read as this dataset's - and a pending
  // preview would offer another dataset's events under this one's name.
  useEffect(() => {
    setResult(null);
    setChoices([]);
    setPending(null);
    setOutcome(null);
  }, [datasetId]);

  const view = deriveLakeQueryView(result, querying);
  const commitView = deriveLakeCommitView(
    outcome?.result ?? null,
    fetching,
    outcome?.planned ?? 0,
    outcome?.requested ?? 0,
    outcome?.merged ?? 0,
  );
  const selected = selectedLakeLogTypes(choices);
  const collisions = lakeCollisions(choices);
  // THE SELECTION HALF, locked while any request is in flight AND while a haul
  // is waiting to be confirmed. That last clause is the one worth stating: the
  // events below were fetched for the rows ticked at the time, so a tick changed
  // afterwards would describe a selection that is not what is about to be
  // stored. The way out is Add or Discard, not a quiet edit underneath.
  const locked = querying || fetching || committing || pending !== null;
  const unavailable = searchGroupId.trim() === "";

  const run = async () => {
    setQuerying(true);
    setResult(null);
    setChoices([]);
    setPending(null);
    setOutcome(null);
    try {
      const next = await onQuery();
      setResult(next);
      // Seeded here rather than in an effect so a later change to the store's
      // log types cannot silently re-tick boxes the operator has since changed.
      setChoices(lakeLogTypeChoices(next.logTypes, existingLogTypes));
    } finally {
      setQuerying(false);
    }
  };

  /**
   * ONE SEARCH JOB PER TICKED LOG TYPE, and this is the only place that spends
   * them. Pressing this again pays again, which is why the panel locks below
   * rather than leaving a second press a click away - and why the preview reuses
   * these events instead of fetching its own.
   */
  const fetchEvents = async () => {
    // THE SAME QUESTION THE BUTTON ASKS, from the same function - a control that
    // does nothing when pressed is worse than a disabled one, and two copies of
    // this condition is how they come to disagree. It allows a missing field
    // only when the dataset itself is the log type, where the fetch is
    // deliberately unfiltered.
    if (!canFetchLakeSamples(view, selected.length)) return;
    setFetching(true);
    setPending(null);
    setOutcome(null);
    try {
      const fetched = await onFetchEvents(
        view.discriminatorField,
        selected,
        eventsPerLogType.value,
      );
      const samples = plannedLakeSamples(
        fetched.events,
        `lake:${datasetId}`,
        existingLogTypes,
      );
      if (samples.length === 0) {
        // NOTHING TO PREVIEW AND NOTHING TO TAKE. Reported straight away rather
        // than rendered as an empty preview box, which reads as "your data looks
        // like this" about data that never arrived. The counts stay up, so
        // picking again costs no second count.
        setOutcome({
          result: fetched,
          planned: 0,
          requested: selected.length,
          merged: 0,
        });
        return;
      }
      setPending({
        result: fetched,
        samples,
        // Both folded against the store AS IT IS NOW, in one read, so the
        // preview's labels and the commit's cannot come from two different
        // stores - the rule lakeLogTypeChoices follows for the same reason.
        previews: lakeSamplePreviews(fetched.events, samples, existingLogTypes),
        requested: selected.length,
        merged: mergedLakeLogTypeCount(selected, samples, existingLogTypes),
      });
    } finally {
      setFetching(false);
    }
  };

  /** The store write, and nothing else - no search runs here. */
  const commit = async () => {
    if (pending === null) return;
    setCommitting(true);
    try {
      await onCommit(pending.samples);
      setOutcome({
        result: pending.result,
        planned: pending.samples.length,
        requested: pending.requested,
        merged: pending.merged,
      });
      // Cleared only once the store has it, as the capture panel clears its
      // preview: dropping the events first would leave a failed commit with
      // nothing on screen to retry from, and re-fetching costs searches.
      setPending(null);
      // The counts have done their job; the summary above stays.
      setResult(null);
      setChoices([]);
    } finally {
      setCommitting(false);
    }
  };

  const discard = () => {
    setResult(null);
    setChoices([]);
  };

  /**
   * Throw the fetched events away and leave the COUNTS standing.
   *
   * Deliberately not a return to idle: the operator has already paid for the
   * count, and the reason to reject a preview is usually to tick different rows.
   * Taking the list down with the events would make them buy it again.
   */
  const discardEvents = () => setPending(null);

  return (
    <div className="lake-panel" data-status={view.status}>
      <span className="field-label">Lake dataset: {datasetId}</span>

      {unavailable && (
        <p className="field-hint lake-unavailable">
          No Cribl Search group was found in this workspace, so this dataset
          cannot be queried. Capturing from a live source or uploading a file
          still works.
        </p>
      )}

      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void run()}
          disabled={locked || unavailable}
        >
          {querying ? "Finding log types..." : "Find log types"}
        </button>
      </div>

      <p className="panel-desc">{view.headline}</p>

      {/* WHOSE NAME THIS IS. The row below carries the dataset's own id, and on
          a panel full of vendor log types it would otherwise read as one more
          of them - the app claiming a log type nobody observed. Said here as
          well as in the usecase's note, for the same reason the truncation
          caveat is: this panel must not depend on another module's wording to
          keep its own screen honest. */}
      {view.datasetAsLogType && (
        <p className="field-hint lake-dataset-named">
          That name is the dataset&apos;s, not a log type found in the data -
          nothing on these events tells one type from another, so they are
          offered as one sample. Rename it on its chip once added if you know
          what these events are.
        </p>
      )}

      {/* A VOLUME MEANS NOTHING WITHOUT ITS WINDOW. The bounds are relative and
          belong to the query, so they are reported rather than assumed. */}
      {lakeOffersSamples(view) && view.window !== null && (
        <p className="field-hint lake-window">
          Volumes cover {windowLabel(view.window)}
          {view.discriminatorField !== undefined
            ? `, grouped by ${view.discriminatorField}`
            : ""}
          .
        </p>
      )}

      {/* Said here rather than left to the usecase's note: a silently truncated
          list reads as the whole dataset, and this panel must not depend on
          another module's wording to say otherwise. */}
      {view.truncated && (
        <p className="field-hint lake-truncated">
          This list hit the row cap, so the dataset may hold more log types than
          these. The highest-volume ones are shown.
        </p>
      )}

      {choices.length > 0 && (
        <>
          <span className="field-hint">
            Tick the log types worth taking as samples. The highest-volume ones
            are pre-selected; fetching them runs one more search against the
            dataset per tick. You see the events before anything is stored.
          </span>
          <ul className="lake-log-types">
            {choices.map((choice) => (
              <li key={choice.value}>
                <label className="lake-log-type">
                  <input
                    type="checkbox"
                    checked={choice.selected}
                    onChange={() => setChoices(toggleLakeChoice(choices, choice.value))}
                    disabled={locked}
                  />
                  <span className="lake-log-type-name">{choice.value}</span>
                  {/* The count, and what it is ESTIMATED to weigh. Two numbers
                      because they answer two halves of "is this worth taking":
                      Sentinel charges by volume, so the byte figure is the one
                      that maps to a bill. It carries "~" and the word
                      "estimated" wherever it renders - the mean behind it comes
                      from the events this query sampled, not from every event
                      counted - and it is simply absent when the log type was
                      never sampled, exactly as the count is when unreadable. */}
                  <span className="field-hint lake-volume">
                    {choice.eventCount === undefined
                      ? "volume unknown"
                      : `${choice.eventCount.toLocaleString()} events`}
                    {choice.estimatedBytes !== undefined &&
                      formatBytes(choice.estimatedBytes) !== "" &&
                      `, ~${formatBytes(choice.estimatedBytes)} estimated`}
                  </span>
                  {/* WHOSE NAME THIS IS, said on the row itself. This one is
                      the group of events that carry NO value in the field
                      everything else was grouped by, and its label was minted
                      from that field rather than read out of the data. Beside
                      twelve names that ARE the data's, an uncaveated
                      "(no msgid)" is the app claiming a thirteenth log type it
                      never observed - so the caveat travels with the row and
                      not in a note below the list. The field is named because
                      "no value" is only meaningful against a field. */}
                  {choice.unnamed && (
                    <span className="field-hint lake-unnamed">
                      these events carry no
                      {view.discriminatorField !== undefined
                        ? ` ${view.discriminatorField}`
                        : ""}{" "}
                      value - that name describes what they lack, not a log type
                      found in the data. Rename it on its chip once added if you
                      know what these events are.
                    </span>
                  )}
                  {choice.note !== undefined && (
                    <span className="field-hint lake-replaces">
                      {choice.note}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      {view.notes.map((note) => (
        <p className="field-hint" key={note}>
          {note}
        </p>
      ))}

      {lakeOffersSamples(view) && (
        <div className="panel-controls">
          <label className="field lake-bound">
            <span className="field-label">Events per log type</span>
            <input
              type="number"
              value={eventsPerLogType.text}
              min={1}
              max={MAX_SAMPLE_LIMIT}
              onChange={(e) => eventsPerLogType.setText(e.target.value)}
              disabled={locked}
            />
          </label>
          {collisions.length > 0 && (
            <span className="field-hint lake-replaces">
              Adding these replaces your existing {collisions.join(", ")} sample
              {collisions.length === 1 ? "" : "s"}.
            </span>
          )}
          {/* TWO PRIMARY ACTIONS LIVE ON THIS PANEL now - this one spends
              searches, the one under the preview writes to the store - and they
              are told apart by a qualifier class rather than by document order.
              Order is what a test reading `.next-action-button` would have to
              rely on, and it changes the moment a block moves. */}
          <button
            className="next-action-button lake-fetch-button"
            onClick={() => void fetchEvents()}
            disabled={locked || !canFetchLakeSamples(view, selected.length)}
          >
            {fetching ? "Fetching events..." : "Fetch events"}
          </button>
          <button className="run-button" onClick={discard} disabled={locked}>
            Discard
          </button>
        </div>
      )}

      {/* WHAT IS ABOUT TO BE STORED, in the bytes it will be stored in. The
          operator's one chance to see that a Lake event carries a transport
          envelope around the vendor's line, or that a log type came back as
          something other than what its name promised - which until 2026-08-25
          was only discoverable after the sample was in the store. Collapsed, as
          the capture panel's is: a haul of five log types must stay scannable,
          and the operator opens the ones they want to check. */}
      {pending !== null && (
        <div className="lake-fetched">
          <p className="panel-desc">{lakePreviewHeadline(pending.previews)}</p>
          <ul className="lake-previews">
            {pending.previews.map((entry) => (
              <li key={entry.logType}>
                <div className="lake-preview-head">
                  <span className="lake-log-type-name">{entry.logType}</span>
                  <span className="field-hint">
                    {entry.eventCount} event{entry.eventCount === 1 ? "" : "s"}
                  </span>
                  {entry.replacesExisting && (
                    <span className="field-hint lake-replaces">
                      replaces your existing {entry.storeLabel} sample
                    </span>
                  )}
                  {/* Said BEFORE the commit, not only in the shortfall sentence
                      afterwards: a row that cannot be stored is one the operator
                      would want to swap for another while the list is still up. */}
                  {!entry.willBeAdded && (
                    <span className="field-hint lake-preview-dropped">
                      these lines parsed to no record, so this one will not be
                      added
                    </span>
                  )}
                </div>
                <details>
                  <summary className="field-hint">Preview</summary>
                  <pre className="result lake-preview">
                    {entry.preview.join("\n")}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
          {/* The fetch's OWN notes, here rather than only after the commit. A
              haul can lose a log type and keep the rest, and the sentence naming
              which one was lost is worth reading while there is still a choice
              to make about it. */}
          {pending.result.notes.map((note) => (
            <p className="field-hint" key={note}>
              {note}
            </p>
          ))}
          <div className="panel-controls">
            <button
              className="next-action-button lake-commit-button"
              onClick={() => void commit()}
              disabled={committing}
            >
              {committing ? "Adding samples..." : "Add as samples"}
            </button>
            <button
              className="run-button"
              onClick={discardEvents}
              disabled={committing}
            >
              Discard these events
            </button>
          </div>
        </div>
      )}

      {commitView.status !== "idle" && (
        <div className="lake-outcome" data-status={commitView.status}>
          <p className="panel-desc">{commitView.headline}</p>
          {commitView.notes.map((note) => (
            <p className="field-hint" key={note}>
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
