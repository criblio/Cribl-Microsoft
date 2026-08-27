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
 * TWO IN-FLIGHT STATES, not one (2026-08-20 audit). The capture is awaited and
 * so is the COMMIT, and until the store write resolves the panel is showing a
 * preview of samples already on their way in. Both lock the panel. The commit
 * lock replaced a `busy` prop that the only caller never passed, so the commit
 * and discard buttons had been permanently enabled - including mid-write.
 *
 * THE COMMIT NOW REPORTS WHAT IT ACHIEVED (2026-08-26 audit), which this panel
 * had no way to do at all. It committed through plannedCaptureSamples - which
 * drops any log type whose lines parse to no record - and then cleared the
 * result, so the headline reverted to "Capture a short, filtered sample from
 * this source. Nothing is added until you confirm": false the moment after a
 * commit, and identical whether 3 of 3 or 1 of 3 log types reached the store.
 * The Lake panel's header states the rule in as many words - "clearing the panel
 * on success would round a partial haul up to a clean one" - and the two commit
 * through the SAME conversion, so it is the same drop that has to be reported.
 *
 * AND A REFUSED WRITE IS SAID OUT LOUD. `onCommit` was awaited with no catch, so
 * a store that rejected left the button enabled and changed nothing else - a
 * failure rendered as absence, which an operator cannot tell from a slow write.
 *
 * All decisions are the pure capture-panel-state; this renders and wires.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CaptureSamplesResult, SampleSourceRef, TaggedSample } from "@soc/core";
import {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_MAX_EVENTS,
  MAX_DURATION_SECONDS,
  MAX_EVENTS_LIMIT,
} from "@soc/core";
import type { RecommendedLogType } from "./sample-coverage-state";
import {
  captureLogTypeChoices,
  composeFilter,
  deriveCaptureCommitView,
  deriveCaptureView,
  filterWarning,
  plannedCaptureSamples,
  toggleChoice,
} from "./capture-panel-state";
import { commitErrorText } from "./planned-samples";
import { useNumericField } from "./use-numeric-field";
import type {
  CaptureCommitOutcome,
  CaptureLogTypeChoice,
} from "./capture-panel-state";

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
}

export function CapturePanel({
  source,
  recommended,
  existingLogTypes,
  onCapture,
  onCommit,
}: CapturePanelProps) {
  const seeded = useMemo(() => captureLogTypeChoices(recommended), [recommended]);
  const [choices, setChoices] = useState<CaptureLogTypeChoice[]>(seeded);
  const [filter, setFilter] = useState(() => composeFilter(source.id, seeded));
  // True once the operator has edited the filter by hand: after that NEITHER the
  // checkboxes NOR the re-seed rewrites it, because silently discarding
  // someone's edit is worse than letting the two disagree.
  //
  // A REF, NOT STATE, since 2026-08-26. The re-seed effect below has to read this
  // without listing it as a dependency: adding it would make the effect re-run
  // the instant the operator typed, and that run would re-seed the CHECKBOXES
  // out from under them. Nothing renders the flag, so there is nothing to
  // re-render for. Same touched-ref discipline as the pack-name and table
  // prefills in integrate-screen.tsx:398-410.
  const filterEditedRef = useRef(false);
  // Which source the picks were last seeded for, so the effect can tell a SOURCE
  // change from a RECOMMENDATION change - they want opposite things from the
  // latch. Same guard-ref shape as azure-resources-section.tsx:259-262.
  const seededForSourceRef = useRef(source.id);
  const maxEvents = useNumericField(DEFAULT_MAX_EVENTS);
  // The one that bites hardest cleared: 0 clamps to a ONE-SECOND capture, which
  // on a quiet source returns nothing and is then reported as an idle source.
  const duration = useNumericField(DEFAULT_DURATION_SECONDS);
  const [result, setResult] = useState<CaptureSamplesResult | null>(null);
  const [running, setRunning] = useState(false);
  // The store write is awaited too, and until it resolves this panel is showing
  // a preview of something already on its way in. The store is
  // replace-by-logType, so a second commit is idempotent and nothing is
  // corrupted by a double click - what this prevents is the operator ACTING on
  // a panel mid-write: discarding the preview, or re-running the capture,
  // against a commit whose result they cannot yet see. Named apart from
  // `running` because a capture and a commit fail differently and lock the same
  // controls for different reasons.
  const [committing, setCommitting] = useState(false);
  // WHAT THE LAST COMMIT ESTABLISHED, kept after the preview goes. Without it
  // the panel reverted to its idle sentence - "Nothing is added until you
  // confirm" - immediately after adding something, and said the same thing
  // whether every log type landed or one of three did.
  const [outcome, setOutcome] = useState<CaptureCommitOutcome | null>(null);
  // Why the store write refused, when it did. Apart from `outcome` because a
  // rejected write establishes nothing about what landed.
  const [storeError, setStoreError] = useState<string | null>(null);

  /**
   * RE-SEED THE PICKS when the recommendation changes, and when the source does
   * - a different source means different suggestions and a different filter.
   * Only the picks: see the second effect for why the capture and its summary
   * are NOT reset here.
   *
   * A HAND-EDITED FILTER SURVIVES A RE-SEED, since 2026-08-26. This effect used
   * to clear the latch and recompose the filter unconditionally, which made the
   * edit unkeepable: `seeded` is memoised on `recommended`, `recommended` is
   * rebuilt from coverage, and committing samples always changes coverage. So
   * the same identity change that 51d272d stopped from erasing the SUMMARY was
   * still erasing the FILTER one line up - the fix landed on half the defect.
   *
   * Worse than a no-op recompose: the just-committed log types come back
   * `provided`, so they un-tick and the filter recomposes NARROWER than the one
   * the operator wrote. And a commit is not the only trigger - the same memo
   * moves when the rule-coverage read resolves or Lake volumes land, so the edit
   * could vanish with no operator action at all.
   *
   * The source case still clears the latch, because a filter written for one
   * source is not an answer about another. Today the parent mounts this panel
   * with `key={captureTarget.id}` so a source change remounts and the refs reset
   * anyway - but a component that is only correct because of how its parent keys
   * it is one refactor away from being wrong, and the branch costs a ref.
   */
  useEffect(() => {
    setChoices(seeded);
    if (seededForSourceRef.current !== source.id) {
      seededForSourceRef.current = source.id;
      filterEditedRef.current = false;
    }
    if (!filterEditedRef.current) {
      setFilter(composeFilter(source.id, seeded));
    }
  }, [seeded, source.id]);

  /**
   * THE CAPTURE AND ITS SUMMARY BELONG TO THE SOURCE, so they reset when the
   * SOURCE changes and at no other time. Left up across a source change, the
   * summary reads as a report about the source now named above it.
   *
   * SPLIT OUT OF THE EFFECT ABOVE 2026-08-26, because keying this on `seeded`
   * made a successful commit erase its own result. `seeded` is memoised on
   * `recommended`, and committing samples ALWAYS changes the recommendation -
   * coverage is what the recommendation is computed from. So the order was:
   * commit writes the samples, `setOutcome` records what it stored, the parent
   * re-renders with new coverage, `recommended` gets a new identity, this effect
   * fires, and `setOutcome(null)` wiped the summary before it ever painted.
   *
   * The panel therefore fell back to its idle sentence - "Nothing is added until
   * you confirm" - immediately after adding something, which is the exact defect
   * the outcome state was added to fix. It reproduced on every commit and was
   * invisible to the component's own tests, because those re-render with a
   * STABLE `recommended`; only the live app supplies a fresh array. The pin
   * added alongside this re-renders with a new one.
   */
  useEffect(() => {
    setResult(null);
    setOutcome(null);
    setStoreError(null);
  }, [source.id]);

  const view = deriveCaptureView(result, running, existingLogTypes);
  const commitView = deriveCaptureCommitView(outcome, committing, storeError);
  const warning = filterWarning(filter, source.id);
  // One lock for the whole panel, as the Lake panel does with querying/fetching:
  // every control here describes a request that is already in flight.
  const locked = running || committing;

  const toggle = (value: string) => {
    const next = toggleChoice(choices, value);
    setChoices(next);
    if (!filterEditedRef.current) {
      setFilter(composeFilter(source.id, next));
    }
  };

  const run = async () => {
    setRunning(true);
    setResult(null);
    // The previous commit's summary is about the previous capture; a new run
    // makes it stale before it makes it wrong.
    setOutcome(null);
    setStoreError(null);
    try {
      setResult(await onCapture(filter, maxEvents.value, duration.value));
    } finally {
      setRunning(false);
    }
  };

  /**
   * The store write, and what it actually achieved.
   *
   * THE SAMPLES ARE COMPUTED ONCE, HERE, and both the write and the summary read
   * that one list - so the count reported is the count handed over rather than a
   * second guess at it. plannedCaptureSamples DROPS a log type whose lines parse
   * to no record, which is exactly the shortfall this panel used to hide.
   */
  const commit = async () => {
    if (result === null) return;
    const samples = plannedCaptureSamples(
      result.splits,
      `capture:${source.id}`,
      existingLogTypes,
    );
    setCommitting(true);
    setStoreError(null);
    try {
      await onCommit(samples);
      setOutcome({ stored: samples.length, returned: result.splits.length });
      // Cleared only once the store has it, AND only when it took something: a
      // commit that stored nothing leaves the preview up, because the only way
      // back to it is another capture.
      if (samples.length > 0) setResult(null);
    } catch (error) {
      // A rejected write used to change NOTHING on screen - the button simply
      // un-disabled, which an operator cannot tell from a slow store.
      setStoreError(commitErrorText(error));
    } finally {
      setCommitting(false);
    }
  };

  /** Throw the preview away. The last commit's summary is not about it. */
  const discard = () => {
    setResult(null);
    setStoreError(null);
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
                    disabled={locked}
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
            filterEditedRef.current = true;
          }}
          spellCheck={false}
          rows={3}
          disabled={locked}
        />
      </label>
      {warning !== null && (
        <p className="field-hint capture-filter-warning">{warning}</p>
      )}

      {/* BOTH ceilings come from core, which owns them: the capture API's own
          maxEvents maximum, and the longest window the platform bridge
          survives. Neither is restated here - a literal 10000 is what this
          panel carried until 2026-08-20, and a literal goes on advertising the
          old number after core changes the real one.

          The seconds box gets a max as well, though core clamps it and says so
          in a note. The note arrives AFTER the capture has already run to the
          clamped window, so an operator who asks for 30s finds out it was 12
          only once they have waited for it; `max` states the same ceiling
          before they press Run. It withholds nothing either - a number input
          still accepts a larger typed value, useNumericField deliberately
          leaves upper bounds to the usecase, and the clamp note still fires. */}
      <div className="panel-controls">
        <label className="field capture-bound">
          <span className="field-label">Max events</span>
          <input
            type="number"
            value={maxEvents.text}
            min={1}
            max={MAX_EVENTS_LIMIT}
            onChange={(e) => maxEvents.setText(e.target.value)}
            disabled={locked}
          />
        </label>
        <label className="field capture-bound">
          <span className="field-label">Seconds</span>
          <input
            type="number"
            value={duration.text}
            min={1}
            max={MAX_DURATION_SECONDS}
            onChange={(e) => duration.setText(e.target.value)}
            disabled={locked}
          />
        </label>
        <button
          className="run-button"
          onClick={() => void run()}
          disabled={locked}
        >
          {running ? "Capturing..." : "Run capture"}
        </button>
      </div>

      {/* THE IDLE SENTENCE IS NOT PRINTED OVER AN OUTCOME (2026-08-26 audit).
          A commit clears the preview, which returns this headline to "Capture a
          short, filtered sample from this source. Nothing is added until you
          confirm" - which is false the moment something has been added. It is an
          instruction about the NEXT capture, so it waits for one. */}
      {(view.status !== "idle" || commitView.status === "idle") && (
        <p className="panel-desc">{view.headline}</p>
      )}

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
            disabled={locked}
          >
            {committing ? "Adding samples..." : "Add these as samples"}
          </button>
          <button className="run-button" onClick={discard} disabled={locked}>
            Discard
          </button>
        </div>
      )}

      {/* WHAT THE COMMIT ACHIEVED, which outlives the preview for the reason the
          Lake panel's summary outlives its log-type list: clearing the panel on
          success rounds a partial haul up to a clean one. */}
      {commitView.status !== "idle" && (
        <div className="capture-outcome" data-status={commitView.status}>
          <p className="panel-desc">{commitView.headline}</p>
        </div>
      )}
    </div>
  );
}
