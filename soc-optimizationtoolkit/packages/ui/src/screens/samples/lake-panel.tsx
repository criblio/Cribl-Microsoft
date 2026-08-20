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
  deriveLakeCommitView,
  deriveLakeQueryView,
  lakeCollisions,
  lakeLogTypeChoices,
  plannedLakeSamples,
  selectedLakeLogTypes,
  toggleLakeChoice,
  windowLabel,
} from "./lake-panel-state";
import type { LakeLogTypeChoice } from "./lake-panel-state";

/** What a commit established, kept beside the fetch so partials stay visible. */
interface CommitOutcome {
  result: FetchLakeEventsResult;
  /** Samples that survived the content-first parse. */
  planned: number;
  /** Log types the operator ticked, which is what `planned` is measured against. */
  requested: number;
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
  /** Fetch events for the ticked log types. Resolves; never throws. */
  onFetchEvents: (
    discriminatorField: string,
    logTypes: readonly string[],
    eventsPerLogType: number,
  ) => Promise<FetchLakeEventsResult>;
  /** Commit the fetched samples to the store. */
  onCommit: (samples: TaggedSample[]) => Promise<void>;
  busy?: boolean;
}

export function LakePanel({
  datasetId,
  searchGroupId,
  existingLogTypes,
  onQuery,
  onFetchEvents,
  onCommit,
  busy = false,
}: LakePanelProps) {
  const [result, setResult] = useState<QueryLakeSamplesResult | null>(null);
  const [choices, setChoices] = useState<LakeLogTypeChoice[]>([]);
  const [eventsPerLogType, setEventsPerLogType] = useState(DEFAULT_SAMPLE_LIMIT);
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
  );
  const selected = selectedLakeLogTypes(choices);
  const collisions = lakeCollisions(choices);
  const locked = busy || querying || fetching;
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
    const field = view.discriminatorField;
    if (field === undefined || selected.length === 0) return;
    setFetching(true);
    setOutcome(null);
    try {
      const fetched = await onFetchEvents(field, selected, eventsPerLogType);
      const samples = plannedLakeSamples(
        fetched.events,
        `lake:${datasetId}`,
        existingLogTypes,
      );
      setOutcome({
        result: fetched,
        planned: samples.length,
        requested: selected.length,
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

      {/* A VOLUME MEANS NOTHING WITHOUT ITS WINDOW. The bounds are relative and
          belong to the query, so they are reported rather than assumed. */}
      {view.status === "ready" && view.window !== null && (
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
                  <span className="field-hint lake-volume">
                    {choice.eventCount === undefined
                      ? "volume unknown"
                      : `${choice.eventCount.toLocaleString()} events`}
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

      {view.status === "ready" && (
        <div className="panel-controls">
          <label className="field lake-bound">
            <span className="field-label">Events per log type</span>
            <input
              type="number"
              value={eventsPerLogType}
              min={1}
              max={MAX_SAMPLE_LIMIT}
              onChange={(e) => setEventsPerLogType(Number(e.target.value))}
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
            disabled={locked || selected.length === 0}
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
