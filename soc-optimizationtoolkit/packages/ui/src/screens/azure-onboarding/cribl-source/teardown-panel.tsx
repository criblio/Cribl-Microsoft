/**
 * TeardownPanel - "Remove or pause what this app created" (AZR-105).
 *
 * The App Platform gives an app no uninstall hook, so what the onboarding
 * screen created in Cribl stays until someone removes it - and a leftover
 * object blocks a fresh create with "already exists". This panel lists every
 * source the app has a RECORD for (chosen or not: unchoosing a source never
 * removes anything), and offers, per source:
 *
 *   Pause / Resume  sets the Cribl source's `disabled`; nothing else changes
 *   Remove          the Lake route, the shared pipeline when nothing else uses
 *                   it, the Cribl source and its secret - and, only with the
 *                   box ticked, the Lake dataset and the data it holds
 *
 * Each is TWO CLICKS (teardown-state.ts): the first checks read-only and arms
 * a confirm quoting exactly what goes, in order, what is kept and why, the
 * commit files and the worker restart; the second applies. The screen owns
 * the IO (core planSourceTeardown / applySourceTeardown, planInputPause /
 * applyInputPause) and updates the records.
 *
 * The Activity Log's Azure diagnostic setting is removed from its own
 * section; the Defender export's removal is not built here. The Entra ID
 * tenant setting (AZR-99) is removed HERE, by whatever the screen passes as
 * `azure` (entra-remove-panel.tsx), so its Remove stays offered after Entra
 * ID is unchosen - its own record, its own two-step confirm.
 */

import { useEffect, useReducer, useState } from "react";
import type { ReactNode } from "react";
import { onboardingSource } from "@soc/core";
import type {
  ApplyPauseOutcome,
  ApplyTeardownOutcome,
  CriblSourceRecord,
  LakeRouteRecord,
  OnboardingSourceId,
  PlanPauseResult,
  PlanTeardownResult,
  ReadyPause,
  ReadyTeardown,
} from "@soc/core";
import { InfoTip } from "../../../components/info-tip";
import type { OutcomeView } from "./cribl-source-state";
import {
  pauseArmKey,
  pauseConfirmText,
  pauseOutcomeView,
  pausePlanView,
  removeArmKey,
  teardownConfirmText,
  teardownOutcomeView,
  teardownPlanView,
  teardownRows,
  twoClick,
  twoClickReducer,
  type TeardownRow,
  type TwoClickAction,
  type TwoClickState,
} from "./teardown-state";

export interface TeardownHooks {
  readonly criblSources: Readonly<Partial<Record<OnboardingSourceId, CriblSourceRecord>>>;
  readonly lakeRoutes: Readonly<Partial<Record<OnboardingSourceId, LakeRouteRecord>>>;
  /** Bumped on every read a plan depends on. */
  readonly readSeq: number;
  readonly onPlanRemove: (sourceId: OnboardingSourceId, removeDataset: boolean) => Promise<PlanTeardownResult>;
  readonly onApplyRemove: (ready: ReadyTeardown) => Promise<ApplyTeardownOutcome>;
  readonly onPlanPause: (sourceId: OnboardingSourceId, pause: boolean) => Promise<PlanPauseResult>;
  readonly onApplyPause: (ready: ReadyPause) => Promise<ApplyPauseOutcome>;
}

const PANEL_TIP =
  "Cribl apps have no uninstall step, so what this app created in Cribl stays until it is removed. Remove takes out " +
  "only objects the app can prove it created: the id is one it makes, the description carries its mark, and its own " +
  "saved record says it wrote it. Anything else is left alone and named. Pause stops the Cribl source reading without " +
  "deleting anything.";

const DATASET_TIP =
  "The Lake dataset holds the events already stored. It is deleted only when this box is ticked, and only if this app " +
  "created it; one that already existed is never deleted from here.";

type RemoveState = TwoClickState<ReadyTeardown, Exclude<PlanTeardownResult, { kind: "ready" }>, ApplyTeardownOutcome>;
type RemoveAction = TwoClickAction<ReadyTeardown, Exclude<PlanTeardownResult, { kind: "ready" }>, ApplyTeardownOutcome>;
type PauseState = TwoClickState<ReadyPause, Exclude<PlanPauseResult, { kind: "ready" }>, ApplyPauseOutcome>;
type PauseAction = TwoClickAction<ReadyPause, Exclude<PlanPauseResult, { kind: "ready" }>, ApplyPauseOutcome>;

const removeReducer = (s: RemoveState, a: RemoveAction): RemoveState => twoClickReducer(s, a);
const pauseReducer = (s: PauseState, a: PauseAction): PauseState => twoClickReducer(s, a);

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function TeardownPanel({ hooks, azure }: { readonly hooks: TeardownHooks; readonly azure?: ReactNode }) {
  const rows = teardownRows(hooks.criblSources, hooks.lakeRoutes);
  return (
    <section className="azo-teardown" aria-label="Remove or pause what this app created">
      <h4>
        Remove or pause what this app created <InfoTip text={PANEL_TIP} />
      </h4>
      {rows.length === 0 ? (
        <p className="field-hint">This app has no record of creating anything in Cribl for these sources.</p>
      ) : (
        rows.map((row) => <TeardownRowView key={row.sourceId} row={row} hooks={hooks} />)
      )}
      {azure}
    </section>
  );
}

function ResultView({ view }: { readonly view: OutcomeView | null }) {
  if (view === null) return null;
  return (
    <div role="status" data-tone={view.tone}>
      <p>
        <strong>{view.headline}</strong>
      </p>
      {view.detail !== "" && <p>{view.detail}</p>}
      {view.inCribl !== null && <p>{view.inCribl}</p>}
    </div>
  );
}

function TeardownRowView({ row, hooks }: { readonly row: TeardownRow; readonly hooks: TeardownHooks }) {
  const title = onboardingSource(row.sourceId)?.title ?? row.sourceId;
  const [removeDataset, setRemoveDataset] = useState(false);
  const [pauseTarget, setPauseTarget] = useState(true);
  const [error, setError] = useState("");
  const [remove, dispatchRemove] = useReducer(removeReducer, { phase: "idle" });
  const [pause, dispatchPause] = useReducer(pauseReducer, { phase: "idle" });

  const removeKey = removeArmKey(row, removeDataset, hooks.readSeq);
  const pauseKey = pauseArmKey(row, pauseTarget, hooks.readSeq);
  useEffect(() => dispatchRemove({ type: "inputs", key: removeKey }), [removeKey]);
  useEffect(() => dispatchPause({ type: "inputs", key: pauseKey }), [pauseKey]);

  const removeArmed = remove.phase === "armed" && remove.key === removeKey;
  const pauseArmed = pause.phase === "armed" && pause.key === pauseKey;
  const busy = remove.phase === "planning" || remove.phase === "applying" || pause.phase === "planning" || pause.phase === "applying";

  async function onRemove(): Promise<void> {
    const action = twoClick(remove, removeKey);
    if (action === "none") return;
    setError("");
    if (action === "apply" && remove.phase === "armed") {
      const ready = remove.ready;
      dispatchRemove({ type: "apply-start", key: removeKey });
      try {
        dispatchRemove({ type: "apply-result", outcome: await hooks.onApplyRemove(ready) });
      } catch (e) {
        setError(`The removal stopped before it reported an outcome: ${errorText(e)}. Check the worker group in Cribl before retrying.`);
        dispatchRemove({ type: "reset" });
      }
      return;
    }
    dispatchPause({ type: "reset" });
    dispatchRemove({ type: "plan-start", key: removeKey });
    try {
      const result = await hooks.onPlanRemove(row.sourceId, removeDataset);
      dispatchRemove({ type: "plan-result", key: removeKey, ready: result.kind === "ready" ? result.ready : null, result: result.kind === "ready" ? null : result });
    } catch (e) {
      setError(`The check before the removal did not finish: ${errorText(e)}`);
      dispatchRemove({ type: "reset" });
    }
  }

  async function onPause(target: boolean): Promise<void> {
    // Pause and Resume are two actions with two keys: the other one's arm
    // never applies this one.
    const key = pauseArmKey(row, target, hooks.readSeq);
    setPauseTarget(target);
    const action = twoClick(pause, key);
    if (action === "none") return;
    setError("");
    if (action === "apply" && pause.phase === "armed") {
      const ready = pause.ready;
      dispatchPause({ type: "apply-start", key });
      try {
        dispatchPause({ type: "apply-result", outcome: await hooks.onApplyPause(ready) });
      } catch (e) {
        setError(`The change stopped before it reported an outcome: ${errorText(e)}. Check the source in Cribl before retrying.`);
        dispatchPause({ type: "reset" });
      }
      return;
    }
    dispatchRemove({ type: "reset" });
    dispatchPause({ type: "plan-start", key });
    try {
      const result = await hooks.onPlanPause(row.sourceId, target);
      dispatchPause({ type: "plan-result", key, ready: result.kind === "ready" ? result.ready : null, result: result.kind === "ready" ? null : result });
    } catch (e) {
      setError(`The check before the change did not finish: ${errorText(e)}`);
      dispatchPause({ type: "reset" });
    }
  }

  const removeView: OutcomeView | null =
    remove.phase === "done" ? teardownOutcomeView(remove.outcome) : remove.phase === "planned" ? teardownPlanView(remove.result) : null;
  const pauseView: OutcomeView | null =
    pause.phase === "done" ? pauseOutcomeView(pause.outcome) : pause.phase === "planned" ? pausePlanView(pause.result) : null;

  const names = [
    row.criblSource !== null ? `Cribl source ${row.criblSource.inputId} and secret ${row.criblSource.secretId}` : null,
    row.lakeRoute?.routeId != null ? `route ${row.lakeRoute.routeId}` : null,
    row.lakeRoute?.pipelineId != null ? `pipeline ${row.lakeRoute.pipelineId}` : null,
    row.lakeRoute !== null ? `Lake dataset ${row.lakeRoute.datasetId}${row.lakeRoute.datasetCreated === true ? " (created by this app)" : " (not created by this app)"}` : null,
  ].filter((n): n is string => n !== null);
  const groupId = row.criblSource?.groupId ?? row.lakeRoute?.groupId ?? "";

  return (
    <div className="azo-teardown-row" aria-label={`Remove or pause ${title}`}>
      <p className="field-label">{title}</p>
      <p className="field-hint">{`Recorded in worker group ${groupId}: ${names.join("; ")}.`}</p>

      {row.criblSource !== null && (
        <div className="panel-controls">
          <button
            type="button"
            className={pauseArmed && pauseTarget ? "next-action-button" : "run-button"}
            disabled={busy}
            onClick={() => void onPause(true)}
          >
            {pause.phase === "planning" && pauseTarget ? "Checking..." : pauseArmed && pauseTarget ? "Confirm: pause the source" : "Pause the Cribl source"}
          </button>
          <button
            type="button"
            className={pauseArmed && !pauseTarget ? "next-action-button" : "run-button"}
            disabled={busy}
            onClick={() => void onPause(false)}
          >
            {pause.phase === "planning" && !pauseTarget ? "Checking..." : pauseArmed && !pauseTarget ? "Confirm: resume the source" : "Resume the Cribl source"}
          </button>
          {pauseArmed && (
            <button type="button" className="run-button" onClick={() => dispatchPause({ type: "reset" })}>
              Cancel
            </button>
          )}
        </div>
      )}
      {pauseArmed && pause.phase === "armed" && (
        <div className="azo-confirm" role="alert">
          {pauseConfirmText(pause.ready).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      <ResultView view={pauseView} />

      {row.lakeRoute !== null && (
        <label className="integrate-check">
          <input type="checkbox" checked={removeDataset} disabled={busy} onChange={(e) => setRemoveDataset(e.target.checked)} />
          <span className="integrate-check-text">
            {`Also delete Cribl Lake dataset ${row.lakeRoute.datasetId} and the data it holds`} <InfoTip text={DATASET_TIP} />
          </span>
        </label>
      )}
      {removeArmed && remove.phase === "armed" && (
        <div className="azo-confirm" role="alert">
          {teardownConfirmText(remove.ready).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      <div className="panel-controls">
        <button type="button" className="next-action-button" disabled={busy} onClick={() => void onRemove()}>
          {remove.phase === "planning"
            ? "Checking..."
            : remove.phase === "applying"
              ? "Removing..."
              : removeArmed
                ? "Confirm: remove these objects"
                : "Remove what this app created"}
        </button>
        {removeArmed && (
          <button type="button" className="run-button" onClick={() => dispatchRemove({ type: "reset" })}>
            Cancel
          </button>
        )}
      </div>
      <ResultView view={removeView} />
      {error !== "" && (
        <p className="field-hint" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
