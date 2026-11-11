/**
 * LakeRoutePanel - "Route to Cribl Lake" for one lane (AZR-35).
 *
 * Rendered directly under the Cribl source row of the two lanes it applies to
 * (the Defender for Cloud export and the Activity Log), because the route reads
 * from exactly the input that row creates: the row's state (created or not)
 * is this panel's prerequisite, and the worker group is the row's.
 *
 * What it shows, always: that Sentinel gets this data through Microsoft's own
 * connector, so Cribl is for Cribl Lake here, never Sentinel. The action is a
 * visible control in every state; when it cannot run (not Cribl.Cloud, no
 * Cribl source yet) it is disabled with the reason beside it.
 *
 * TWO CLICKS (lake-route-state.ts): the first plans read-only and arms the
 * confirm; the second, armed for the same key, applies. Changing the position
 * (or any read the plan depends on) disarms. The position picker lists the
 * routing table the last plan read; before any plan the route goes to the top.
 * The screen owns the IO (core planLakeRoute / applyLakeRoute).
 */

import { useEffect, useReducer, useState } from "react";
import { LAKE_ROUTE_SOURCES, UNROLL_PIPELINE_ID, lakeRouteGate } from "@soc/core";
import type {
  ApplyLakeRouteOutcome,
  CriblSourceRecord,
  LakeRouteRecord,
  LakeRouteSourceId,
  PlanLakeRouteResult,
  ReadyLakeRoute,
  RoutePosition,
  RoutesTableSnapshot,
} from "@soc/core";
import { InfoTip } from "../../../components/info-tip";
import { SearchableSelect } from "../../../components/searchable-select";
import type { OutcomeView } from "./cribl-source-state";
import {
  LAKE_CONFIRM_IDLE,
  isLakeArmed,
  lakeArmKey,
  lakeClick,
  lakeConfirmReducer,
  lakeConfirmText,
  lakeOutcomeView,
  lakePlanResultView,
  positionFromValue,
  positionOptions,
  positionValue,
} from "./lake-route-state";

/** What the screen hands the Cribl source panel for the Lake route. */
export interface LakeRouteHooks {
  /** The shell's declared Cribl deployment; Lake is Cribl.Cloud only. */
  readonly deploymentType: "cloud" | "onprem" | undefined;
  /** progress.criblLakeRoutes. */
  readonly records: Readonly<Partial<Record<LakeRouteSourceId, LakeRouteRecord>>>;
  /** Core planLakeRoute for one source and position. Read-only. */
  readonly onPlan: (sourceId: LakeRouteSourceId, position: RoutePosition) => Promise<PlanLakeRouteResult>;
  /** Core applyLakeRoute for a confirmed plan. */
  readonly onApply: (ready: ReadyLakeRoute) => Promise<ApplyLakeRouteOutcome>;
}

export interface LakeRoutePanelProps {
  readonly sourceId: LakeRouteSourceId;
  /** The lane's Cribl source record, or null before it is created. */
  readonly criblSource: CriblSourceRecord | null;
  readonly readSeq: number;
  readonly hooks: LakeRouteHooks;
}

const LAKE_TIP =
  "Cribl Lake is Cribl.Cloud's own storage for keeping data to search later. The app creates one Lake dataset " +
  "for this source (or uses the one already there), a pipeline that splits Azure's records array into one event " +
  "per record, and a route from this source's Cribl input to the dataset. It only creates: it never changes or " +
  "removes a route, pipeline or dataset that is already there.";

const POSITION_TIP =
  "Cribl checks routes from the top down, and a final route stops the events it matches. Pick where this route " +
  "goes: above any route that would otherwise take these events first. Changing it asks you to check again.";

const NATIVE_TIP =
  "Microsoft's own data connector already brings this data into Microsoft Sentinel, so sending it there through " +
  "Cribl would only add cost. Cribl keeps a copy in Cribl Lake instead; other destinations come later.";

export function LakeRoutePanel({ sourceId, criblSource, readSeq, hooks }: LakeRoutePanelProps) {
  const src = LAKE_ROUTE_SOURCES[sourceId];
  const [position, setPosition] = useState<RoutePosition>({ kind: "top" });
  const [table, setTable] = useState<RoutesTableSnapshot | null>(null);
  const [error, setError] = useState("");
  const [state, dispatch] = useReducer(lakeConfirmReducer, LAKE_CONFIRM_IDLE);

  const gate = lakeRouteGate({ sourceId, criblSource, deploymentType: hooks.deploymentType });
  const key = lakeArmKey({
    groupId: criblSource?.groupId ?? "",
    sourceId,
    inputId: criblSource?.inputId ?? "",
    position,
    readSeq,
  });
  useEffect(() => {
    dispatch({ type: "inputs", key });
  }, [key]);

  const armed = isLakeArmed(state, key);
  const busy = state.phase === "planning" || state.phase === "applying";
  const record = hooks.records[sourceId] ?? null;

  async function onClick(): Promise<void> {
    const action = lakeClick(state, key);
    if (action === "none") return;
    setError("");
    if (action === "apply" && state.phase === "armed") {
      const ready = state.ready;
      dispatch({ type: "apply-start", key });
      try {
        const outcome = await hooks.onApply(ready);
        dispatch({ type: "apply-result", outcome });
      } catch (e) {
        setError(
          `The route to Cribl Lake stopped before it reported an outcome: ${e instanceof Error ? e.message : String(e)}. Check the Lake dataset, pipeline ${UNROLL_PIPELINE_ID} and the routing table in Cribl before retrying.`,
        );
        dispatch({ type: "reset" });
      }
      return;
    }
    if (gate !== null) return;
    dispatch({ type: "plan-start", key });
    try {
      const result = await hooks.onPlan(sourceId, position);
      const read = result.kind === "ready" ? result.ready.insert.table : (result.table ?? null);
      if (read !== null) setTable(read);
      dispatch({ type: "plan-result", key, result });
    } catch (e) {
      setError(`The check before the route did not finish: ${e instanceof Error ? e.message : String(e)}`);
      dispatch({ type: "reset" });
    }
  }

  const view: OutcomeView | null =
    state.phase === "done"
      ? lakeOutcomeView(state.outcome)
      : state.phase === "planned"
        ? lakePlanResultView(state.result)
        : null;

  return (
    <section className="azo-lake-route" aria-label={`Route ${src.label} to Cribl Lake`}>
      <h5>
        Route to Cribl Lake <InfoTip text={LAKE_TIP} />
      </h5>
      <p className="field-hint">
        {src.nativeConnectorCopy} <InfoTip text={NATIVE_TIP} />
      </p>
      {record !== null && record.routeId !== null && (
        <p className="field-hint">{`This app created route ${record.routeId} to Cribl Lake dataset ${record.datasetId} in worker group ${record.groupId}.`}</p>
      )}

      {table !== null && (
        <label className="field">
          <span className="field-label">
            Route position <InfoTip text={POSITION_TIP} />
          </span>
          <SearchableSelect
            label={`Route position for ${src.label}`}
            placeholder="Top of the routing table"
            value={positionValue(position)}
            options={positionOptions(table)}
            disabled={busy}
            onChange={(v) => setPosition(positionFromValue(v))}
          />
        </label>
      )}

      {armed && (
        <div className="azo-confirm" role="alert">
          {lakeConfirmText(state.ready).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}

      <div className="panel-controls">
        <button
          type="button"
          className="next-action-button"
          disabled={busy || (!armed && gate !== null)}
          onClick={() => void onClick()}
        >
          {state.phase === "planning"
            ? "Checking..."
            : state.phase === "applying"
              ? "Creating..."
              : armed
                ? "Confirm: create the route to Cribl Lake"
                : "Route to Cribl Lake"}
        </button>
        {armed && (
          <button type="button" className="run-button" onClick={() => dispatch({ type: "reset" })}>
            Cancel
          </button>
        )}
      </div>
      {!armed && !busy && gate !== null && <p className="field-hint">{gate.detail}</p>}
      {error !== "" && (
        <p className="field-hint" role="alert">
          {error}
        </p>
      )}
      {view !== null && (
        <div role="status" data-tone={view.tone}>
          <p>
            <strong>{view.headline}</strong>
          </p>
          {view.detail !== "" && <p>{view.detail}</p>}
          {view.inCribl !== null && <p>{view.inCribl}</p>}
        </div>
      )}
    </section>
  );
}
