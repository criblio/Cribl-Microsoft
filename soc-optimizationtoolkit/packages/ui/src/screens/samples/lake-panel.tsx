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
 * sample. "Add as samples" then fetches actual events, and only for the ticked
 * rows: doing it up front would pull bodies for every log type they go on to
 * discard, on the biggest datasets, which is where it hurts most.
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
  mergedLakeLogTypeCount,
  plannedLakeSamples,
  selectedLakeLogTypes,
  toggleLakeChoice,
  windowLabel,
} from "./lake-panel-state";
import type { LakeLogTypeChoice } from "./lake-panel-state";
// The picker's byte formatter, reused rather than reproduced - see the note at
// its definition; it is the coarse hint register an estimate belongs in.
import { formatBytes } from "./sample-source-picker-state";
import { useNumericField } from "./use-numeric-field";

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
  const [outcome, setOutcome] = useState<CommitOutcome | null>(null);

  // A different dataset means different log types and a different commit. Left
  // on screen, the old counts would be read as this dataset's.
  useEffect(() => {
    setResult(null);
    setChoices([]);
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
  // `fetching` spans the fetch AND the store write, so it is what keeps the
  // operator off the panel mid-commit.
  const locked = querying || fetching;
  const unavailable = searchGroupId.trim() === "";

  const run = async () => {
    setQuerying(true);
    setResult(null);
    setChoices([]);
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

  const commit = async () => {
    // THE SAME QUESTION THE BUTTON ASKS, from the same function - a control that
    // does nothing when pressed is worse than a disabled one, and two copies of
    // this condition is how they come to disagree. It allows a missing field
    // only when the dataset itself is the log type, where the fetch is
    // deliberately unfiltered.
    if (!canFetchLakeSamples(view, selected.length)) return;
    setFetching(true);
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
      setOutcome({
        result: fetched,
        planned: samples.length,
        requested: selected.length,
        merged: mergedLakeLogTypeCount(selected, samples, existingLogTypes),
      });
      if (samples.length > 0) {
        await onCommit(samples);
        // The counts have done their job; the summary above stays.
        setResult(null);
        setChoices([]);
      }
    } finally {
      setFetching(false);
    }
  };

  const discard = () => {
    setResult(null);
    setChoices([]);
  };

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
            are pre-selected; each one you take is another search against the
            dataset.
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
          <button
            className="next-action-button"
            onClick={() => void commit()}
            disabled={locked || !canFetchLakeSamples(view, selected.length)}
          >
            {fetching ? "Fetching events..." : "Add as samples"}
          </button>
          <button className="run-button" onClick={discard} disabled={locked}>
            Discard
          </button>
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
