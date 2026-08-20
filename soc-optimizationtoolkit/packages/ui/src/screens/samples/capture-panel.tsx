/**
 * CapturePanel - run one bounded capture off the selected source, preview what
 * came back, and tag it only on confirmation (plan Phase 4, ADR 0003).
 *
 * NOTHING ENTERS THE SAMPLE STORE WITHOUT A DELIBERATE CLICK (user direction
 * 2026-08-19). The store is replace-by-logType, so an auto-tag would silently
 * overwrite a sample the operator had already curated - and a capture is the
 * one intake path where the app, not the operator, chose the content.
 *
 * The filter is SHOWN and EDITABLE, per the plan. What it is not is validated:
 * Cribl evaluates the expression and returns its own message, which beats a
 * guess from here. The one thing checked is the edit that fails silently -
 * deleting the __inputId clause, which widens the capture to every source in
 * the worker group.
 *
 * All decisions are the pure capture-panel-state; this renders and wires.
 */

import { useEffect, useMemo, useState } from "react";
import type { CaptureSamplesResult, SampleSourceRef, TaggedSample } from "@soc/core";
import { DEFAULT_DURATION_SECONDS, DEFAULT_MAX_EVENTS } from "@soc/core";
import type { RecommendedLogType } from "./sample-coverage-state";
import {
  captureLogTypeChoices,
  composeFilter,
  deriveCaptureView,
  filterWarning,
  plannedCaptureSamples,
  toggleChoice,
} from "./capture-panel-state";
import type { CaptureLogTypeChoice } from "./capture-panel-state";

export interface CapturePanelProps {
  /** The source the operator selected. Capture is only offered for one. */
  source: SampleSourceRef;
  /** The recommendation's entries, which seed the log-type checkboxes. */
  recommended: readonly RecommendedLogType[];
  /** Log types already in the tagged-sample store, for the replace warning. */
  existingLogTypes: readonly string[];
  /** Run the capture. Resolves with the result; never throws. */
  onCapture: (filter: string, maxEvents: number, durationSeconds: number) => Promise<CaptureSamplesResult>;
  /** Commit the previewed samples to the store. */
  onCommit: (samples: TaggedSample[]) => Promise<void>;
  busy?: boolean;
}

export function CapturePanel({
  source,
  recommended,
  existingLogTypes,
  onCapture,
  onCommit,
  busy = false,
}: CapturePanelProps) {
  const seeded = useMemo(() => captureLogTypeChoices(recommended), [recommended]);
  const [choices, setChoices] = useState<CaptureLogTypeChoice[]>(seeded);
  const [filter, setFilter] = useState(() => composeFilter(source.id, seeded));
  // True once the operator has edited the filter by hand: after that the
  // checkboxes stop rewriting it, because silently discarding someone's edit is
  // worse than letting the two disagree.
  const [filterEdited, setFilterEdited] = useState(false);
  const [maxEvents, setMaxEvents] = useState(DEFAULT_MAX_EVENTS);
  const [duration, setDuration] = useState(DEFAULT_DURATION_SECONDS);
  const [result, setResult] = useState<CaptureSamplesResult | null>(null);
  const [running, setRunning] = useState(false);

  // A different source means different suggestions and a different filter.
  useEffect(() => {
    setChoices(seeded);
    setFilterEdited(false);
    setFilter(composeFilter(source.id, seeded));
    setResult(null);
  }, [seeded, source.id]);

  const view = deriveCaptureView(result, running, existingLogTypes);
  const warning = filterWarning(filter, source.id);

  const toggle = (value: string) => {
    const next = toggleChoice(choices, value);
    setChoices(next);
    if (!filterEdited) {
      setFilter(composeFilter(source.id, next));
    }
  };

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      setResult(await onCapture(filter, maxEvents, duration));
    } finally {
      setRunning(false);
    }
  };

  const commit = async () => {
    if (result === null) return;
    await onCommit(plannedCaptureSamples(result.splits, `capture:${source.id}`));
    setResult(null);
  };

  return (
    <div className="capture-panel" data-status={view.status}>
      <span className="field-label">Capture from {source.id}</span>

      {choices.length > 0 && (
        <>
          <span className="field-hint">
            Log types to capture. The ones this solution&apos;s own content needs
            are ticked; the rest are offered, not assumed.
          </span>
          <ul className="capture-log-types">
            {choices.map((choice) => (
              <li key={choice.value}>
                <label className="capture-log-type">
                  <input
                    type="checkbox"
                    checked={choice.selected}
                    onChange={() => toggle(choice.value)}
                    disabled={busy || running}
                  />
                  <span className="capture-log-type-name">{choice.value}</span>
                  {choice.note !== undefined && (
                    <span className="field-hint">{choice.note}</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      <label className="field">
        <span className="field-label">Filter</span>
        <textarea
          className="capture-filter"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setFilterEdited(true);
          }}
          spellCheck={false}
          rows={3}
          disabled={busy || running}
        />
      </label>
      {warning !== null && (
        <p className="field-hint capture-filter-warning">{warning}</p>
      )}

      <div className="panel-controls">
        <label className="field capture-bound">
          <span className="field-label">Max events</span>
          <input
            type="number"
            value={maxEvents}
            min={1}
            max={10000}
            onChange={(e) => setMaxEvents(Number(e.target.value))}
            disabled={busy || running}
          />
        </label>
        <label className="field capture-bound">
          <span className="field-label">Seconds</span>
          <input
            type="number"
            value={duration}
            min={1}
            onChange={(e) => setDuration(Number(e.target.value))}
            disabled={busy || running}
          />
        </label>
        <button
          className="run-button"
          onClick={() => void run()}
          disabled={busy || running}
        >
          {running ? "Capturing..." : "Run capture"}
        </button>
      </div>

      <p className="panel-desc">{view.headline}</p>

      {view.noDiscriminator && (
        <p className="field-hint">
          Nothing in these events tells one log type from another, so they are
          offered as one sample. Rename it on its chip once added.
        </p>
      )}

      {view.logTypes.length > 0 && (
        <ul className="capture-results">
          {view.logTypes.map((entry) => (
            <li key={entry.logType}>
              <div className="capture-result-head">
                <span className="capture-log-type-name">{entry.logType}</span>
                <span className="field-hint">
                  {entry.eventCount} event{entry.eventCount === 1 ? "" : "s"}
                </span>
                {entry.replacesExisting && (
                  <span className="field-hint capture-replaces">
                    replaces your existing sample
                  </span>
                )}
              </div>
              <details>
                <summary className="field-hint">Preview</summary>
                <pre className="result capture-preview">
                  {entry.preview.join("\n")}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}

      {view.notes.map((note) => (
        <p className="field-hint" key={note}>
          {note}
        </p>
      ))}

      {view.status === "ready" && (
        <div className="panel-controls">
          {view.collisions.length > 0 && (
            <span className="field-hint capture-replaces">
              Adding these replaces your existing {view.collisions.join(", ")}{" "}
              sample{view.collisions.length === 1 ? "" : "s"}.
            </span>
          )}
          <button
            className="next-action-button"
            onClick={() => void commit()}
            disabled={busy}
          >
            Add these as samples
          </button>
          <button
            className="run-button"
            onClick={() => setResult(null)}
            disabled={busy}
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
