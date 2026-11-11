/**
 * The "Route to Cribl Lake" confirm, PURE (AZR-35). The panel
 * (lake-route-panel.tsx) owns the React; this module owns the arm key, the
 * confirm machine, the position picker's options and every sentence.
 *
 * TWO CLICKS, as the Cribl source panel (cribl-source-state.ts): the first
 * click PLANS (read-only) and arms a confirm naming the dataset, the pipeline,
 * the route and its position in the table, the shadowing warnings, the commit
 * files with anyone else's pending work, and the worker restart. Only a second
 * click while armed for the SAME key applies. Any change to what the confirm
 * names (group, input, position, a newer read) is a new key and disarms. A
 * void apply goes back to idle with its reason shown: the operator plans
 * again, nothing retries.
 */

import { LAKE_ROUTE_SOURCES } from "@soc/core";
import type {
  ApplyLakeRouteOutcome,
  LakeRouteSourceId,
  PlanLakeRouteRefusalReason,
  PlanLakeRouteResult,
  ReadyLakeRoute,
  RoutePosition,
  RouteRowSnapshot,
  RoutesTableSnapshot,
} from "@soc/core";
import type { SelectOption } from "../../../components/searchable-select";
import type { OutcomeView } from "./cribl-source-state";

// ---------------------------------------------------------------------------
// Position picker
// ---------------------------------------------------------------------------

/** The picker's value for a position. */
export function positionValue(p: RoutePosition): string {
  return p.kind === "before" ? `before:${p.routeId}` : p.kind;
}

/** A picker value as a position; anything unrecognised is the default, top. */
export function positionFromValue(v: string): RoutePosition {
  if (v === "end") return { kind: "end" };
  if (v.startsWith("before:") && v.length > "before:".length) return { kind: "before", routeId: v.slice("before:".length) };
  return { kind: "top" };
}

function rowLine(r: RouteRowSnapshot): string {
  const bits = [`filter ${r.filter === "" ? "(none)" : r.filter}`];
  if (r.output !== undefined) bits.push(`to ${r.output}`);
  if (r.final) bits.push("final");
  if (r.disabled) bits.push("disabled");
  return `${r.name} (${r.id}; ${bits.join(", ")})`;
}

/** Top, before each route the table names (in table order), end. */
export function positionOptions(table: RoutesTableSnapshot | null): SelectOption[] {
  const rows = table?.rows ?? [];
  return [
    { value: "top", label: "Top of the routing table (evaluated first)" },
    ...rows.map((r) => ({ value: `before:${r.id}`, label: `Before ${rowLine(r)}` })),
    { value: "end", label: "End of the routing table (after every route)" },
  ];
}

/** The position in words, for the confirm. */
export function positionText(p: RoutePosition, table: RoutesTableSnapshot | null): string {
  if (p.kind === "top") return "at the top of the routing table";
  if (p.kind === "end") return "at the end of the routing table";
  const row = table?.rows.find((r) => r.id === p.routeId);
  return `just before route ${row === undefined ? p.routeId : `${row.name} (${row.id})`}`;
}

// ---------------------------------------------------------------------------
// Arm key and the confirm machine
// ---------------------------------------------------------------------------

export interface LakeArmInputs {
  readonly groupId: string;
  readonly sourceId: LakeRouteSourceId;
  readonly inputId: string;
  readonly position: RoutePosition;
  /** Bumped on every read a plan depends on. */
  readonly readSeq: number;
}

export function lakeArmKey(a: LakeArmInputs): string {
  return JSON.stringify([a.groupId, a.sourceId, a.inputId, positionValue(a.position), a.readSeq]);
}

type NotReady = Exclude<PlanLakeRouteResult, { kind: "ready" }>;

export type LakeConfirmState =
  | { readonly phase: "idle" }
  | { readonly phase: "planning"; readonly key: string }
  | { readonly phase: "armed"; readonly key: string; readonly ready: ReadyLakeRoute }
  | { readonly phase: "planned"; readonly key: string; readonly result: NotReady }
  | { readonly phase: "applying"; readonly key: string }
  | { readonly phase: "done"; readonly outcome: ApplyLakeRouteOutcome };

export type LakeConfirmAction =
  | { readonly type: "inputs"; readonly key: string }
  | { readonly type: "plan-start"; readonly key: string }
  | { readonly type: "plan-result"; readonly key: string; readonly result: PlanLakeRouteResult }
  | { readonly type: "apply-start"; readonly key: string }
  | { readonly type: "apply-result"; readonly outcome: ApplyLakeRouteOutcome }
  | { readonly type: "reset" };

export const LAKE_CONFIRM_IDLE: LakeConfirmState = { phase: "idle" };

export function lakeConfirmReducer(state: LakeConfirmState, action: LakeConfirmAction): LakeConfirmState {
  switch (action.type) {
    case "reset":
      return state.phase === "applying" ? state : LAKE_CONFIRM_IDLE;
    case "inputs":
      // An apply in flight runs to its outcome; anything keyed to an older key
      // is stale and goes back to idle (never re-armed by a revert).
      if (state.phase === "idle" || state.phase === "done" || state.phase === "applying") return state;
      return state.key === action.key ? state : LAKE_CONFIRM_IDLE;
    case "plan-start":
      return state.phase === "applying" ? state : { phase: "planning", key: action.key };
    case "plan-result":
      if (state.phase !== "planning" || state.key !== action.key) return state;
      return action.result.kind === "ready"
        ? { phase: "armed", key: action.key, ready: action.result.ready }
        : { phase: "planned", key: action.key, result: action.result };
    case "apply-start":
      if (state.phase !== "armed" || state.key !== action.key) return state;
      return { phase: "applying", key: action.key };
    case "apply-result":
      if (state.phase !== "applying") return state;
      return { phase: "done", outcome: action.outcome };
  }
}

export function lakeClick(state: LakeConfirmState, key: string): "plan" | "apply" | "none" {
  if (state.phase === "planning" || state.phase === "applying") return "none";
  if (state.phase === "armed" && state.key === key) return "apply";
  return "plan";
}

export function isLakeArmed(
  state: LakeConfirmState,
  key: string,
): state is Extract<LakeConfirmState, { phase: "armed" }> {
  return state.phase === "armed" && state.key === key;
}

// ---------------------------------------------------------------------------
// The confirm, in words
// ---------------------------------------------------------------------------

/** The confirm's lines. Every claim is one the apply keeps (create-only, one commit, the deploy). */
export function lakeConfirmText(ready: ReadyLakeRoute): string[] {
  const { insert, route } = ready;
  const src = LAKE_ROUTE_SOURCES[ready.sourceId];
  const lines: string[] = [];
  lines.push(
    ready.dataset.action === "create"
      ? `Create Cribl Lake dataset ${ready.dataset.id} for ${src.label}.`
      : `Cribl Lake dataset ${ready.dataset.id} already exists; it will be used as it is, not changed.`,
  );
  lines.push(
    ready.pipeline.action === "create"
      ? `Create pipeline ${ready.pipeline.id} in worker group ${ready.groupId}: one JSON Unroll function that turns each entry of records[] into its own event.`
      : `Pipeline ${ready.pipeline.id}, already created by this app and unchanged, will be used as it is.`,
  );
  lines.push(
    `Insert route ${route.id} ${positionText(insert.position, insert.table)} (position ${insert.index + 1} of ${insert.table.routeCount + 1}): ` +
      `filter ${route.filter}, pipeline ${route.pipeline}, output ${route.output ?? "(none)"}, final. No other route is changed.`,
  );
  for (const r of insert.shadowedBy) {
    lines.push(
      `Warning: route ${r.name} (${r.id}) above this position is final and matches every event (filter ${r.filter === "" ? "(none)" : r.filter}), so it will take these events first and this route will receive nothing. Choose a position above it.`,
    );
  }
  if (insert.uncheckable.length > 0) {
    lines.push(
      `Could not check these routes for a clash, because their filters cannot be read: ${insert.uncheckable.map((r) => `${r.name} (${r.id})`).join(", ")}.`,
    );
  }
  lines.push(`The commit can include at most these files, and only those still uncommitted after the writes: ${insert.commitFiles.join(", ")}.`);
  if (insert.scope.alreadyDirty.length > 0) {
    lines.push(
      `These files already have someone else's uncommitted changes, which the commit will carry too: ${insert.scope.alreadyDirty.join(", ")}.`,
    );
  }
  if (insert.scope.elsewhere.length > 0) {
    lines.push(`Other uncommitted changes in Cribl are left alone: ${insert.scope.elsewhere.join(", ")}.`);
  }
  lines.push(`Then deploy worker group ${ready.groupId}, which restarts its workers.`);
  lines.push("The Lake dataset is a Cribl.Cloud object outside the worker group's commit; it exists as soon as it is created.");
  return lines;
}

// ---------------------------------------------------------------------------
// Results and outcomes, in words
// ---------------------------------------------------------------------------

export const LAKE_PLAN_REFUSAL_COPY: Readonly<Record<PlanLakeRouteRefusalReason, string>> = {
  "not-a-lake-source": "Not offered: only the Defender for Cloud export and the Activity Log are routed to Cribl Lake here.",
  "not-cloud": "Not offered: Cribl Lake is available on Cribl.Cloud only.",
  "no-cribl-source": "Create the Cribl source first.",
  "not-eventhub": "Not offered: the recorded Cribl source is not an Event Hubs source.",
  "datasets-unreadable": "Cannot check: the Cribl Lake datasets could not be read.",
  "pipelines-unreadable": "Cannot check: the worker group's pipelines could not be read.",
  "pipeline-foreign": "Refused: a pipeline with the app's id exists, and the app cannot prove it created it.",
  "pipeline-differs": "Refused: the app's pipeline was changed in Cribl, and the app does not rewrite it.",
  "routes-unreadable": "Cannot check: the routing table could not be read.",
  "unexpected-shape": "Refused: the routing table answer was not understood.",
  "no-routes": "Refused: there is no route to add.",
  "duplicate-new-id": "Refused: the new route's id is repeated.",
  "filter-not-for-input": "Refused: the route's filter does not select this source.",
  "before-missing": "Refused: the route chosen as the position is no longer in the table.",
  conflicts: "Refused: a route already sends this source somewhere, and the app never edits a route it did not create.",
  "table-unreadable": "Cannot check: the routing table itself could not be read after it was listed.",
  "table-moved": "The routing table changed while it was being read. Check again.",
  "nothing-to-change": "Nothing to change: the routing table already holds this route.",
  "status-unknown": "Cannot check: Cribl's pending-change status could not be read.",
  "scope-unplaced": "Refused: a pending change could not be placed in a worker group. Commit or discard it in Cribl first.",
};

/** A plan that did not reach the confirm. */
export function lakePlanResultView(result: NotReady): OutcomeView {
  if (result.kind === "already-applied") return { tone: "ok", headline: "Already routed to Cribl Lake.", detail: result.detail, inCribl: null };
  return { tone: result.reason === "table-moved" ? "warning" : "error", headline: LAKE_PLAN_REFUSAL_COPY[result.reason], detail: result.detail, inCribl: null };
}

/** An apply's outcome. The detail is core's, which names every object created. */
export function lakeOutcomeView(outcome: ApplyLakeRouteOutcome): OutcomeView {
  if (outcome.kind === "deployed") {
    return { tone: "ok", headline: "Routed to Cribl Lake: committed and deployed.", detail: outcome.detail, inCribl: null };
  }
  if (outcome.kind === "void") {
    return {
      tone: "warning",
      headline: "Not routed: Cribl changed since the confirm, so it no longer describes what would be written. Check again and confirm the new plan.",
      detail: outcome.detail,
      inCribl: null,
    };
  }
  const where: Record<NonNullable<ApplyLakeRouteOutcome["stage"]>, string> = {
    scope: "Stopped before writing anything.",
    dataset: "Stopped at the Lake dataset.",
    pipeline: "Stopped at the pipeline.",
    route: "Stopped at the route.",
  };
  return {
    tone: "error",
    headline: outcome.stage === null ? "Stopped." : where[outcome.stage],
    detail: outcome.detail,
    inCribl:
      outcome.dataset === "created" || outcome.pipeline === "created" || outcome.pipeline === "created-not-verified"
        ? "In Cribl, check the objects named above before retrying; the app does not remove them on its own."
        : null,
  };
}
