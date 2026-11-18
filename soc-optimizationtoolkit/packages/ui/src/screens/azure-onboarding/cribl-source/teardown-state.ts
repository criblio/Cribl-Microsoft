/**
 * Remove and Pause for what the onboarding screen created, PURE (AZR-105).
 * The panel (teardown-panel.tsx) owns the React; this module owns the arm
 * keys, the two-click machine and every sentence the confirm and the
 * outcome show.
 *
 * TWO CLICKS, as the create and the Lake route: the first click PLANS
 * (read-only) and arms a confirm that names every object that goes, in the
 * order it goes, every object that is kept and why, the commit files and the
 * worker restart. Only a second click while armed for the SAME key applies.
 * Changing what the confirm names (the dataset opt-in, the records, a newer
 * read) is a new key and disarms. A void goes back to idle with its reason:
 * the operator checks again, nothing retries.
 *
 * Visible copy carries no card ids, dates or phases.
 */

import { describeTeardownObject } from "@soc/core";
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
  TeardownStep,
} from "@soc/core";
import type { OutcomeView } from "./cribl-source-state";

// ---------------------------------------------------------------------------
// The two-click machine, shared by Remove and Pause
// ---------------------------------------------------------------------------

export type TwoClickState<R, N, O> =
  | { readonly phase: "idle" }
  | { readonly phase: "planning"; readonly key: string }
  | { readonly phase: "armed"; readonly key: string; readonly ready: R }
  | { readonly phase: "planned"; readonly key: string; readonly result: N }
  | { readonly phase: "applying"; readonly key: string }
  | { readonly phase: "done"; readonly outcome: O };

export type TwoClickAction<R, N, O> =
  | { readonly type: "inputs"; readonly key: string }
  | { readonly type: "plan-start"; readonly key: string }
  | { readonly type: "plan-result"; readonly key: string; readonly ready: R | null; readonly result: N | null }
  | { readonly type: "apply-start"; readonly key: string }
  | { readonly type: "apply-result"; readonly outcome: O }
  | { readonly type: "reset" };

export function twoClickReducer<R, N, O>(state: TwoClickState<R, N, O>, action: TwoClickAction<R, N, O>): TwoClickState<R, N, O> {
  switch (action.type) {
    case "reset":
      return state.phase === "applying" ? state : { phase: "idle" };
    case "inputs":
      // An apply in flight runs to its outcome; anything keyed to an older key
      // goes back to idle (a revert never re-arms it).
      if (state.phase === "idle" || state.phase === "done" || state.phase === "applying") return state;
      return state.key === action.key ? state : { phase: "idle" };
    case "plan-start":
      return state.phase === "applying" ? state : { phase: "planning", key: action.key };
    case "plan-result":
      if (state.phase !== "planning" || state.key !== action.key) return state;
      if (action.ready !== null) return { phase: "armed", key: action.key, ready: action.ready };
      if (action.result !== null) return { phase: "planned", key: action.key, result: action.result };
      return { phase: "idle" };
    case "apply-start":
      if (state.phase !== "armed" || state.key !== action.key) return state;
      return { phase: "applying", key: action.key };
    case "apply-result":
      if (state.phase !== "applying") return state;
      return { phase: "done", outcome: action.outcome };
  }
}

export function twoClick<R, N, O>(state: TwoClickState<R, N, O>, key: string): "plan" | "apply" | "none" {
  if (state.phase === "planning" || state.phase === "applying") return "none";
  if (state.phase === "armed" && state.key === key) return "apply";
  return "plan";
}

// ---------------------------------------------------------------------------
// Rows and keys
// ---------------------------------------------------------------------------

export interface TeardownRow {
  readonly sourceId: OnboardingSourceId;
  readonly criblSource: CriblSourceRecord | null;
  readonly lakeRoute: LakeRouteRecord | null;
}

/** One row per source the app has a record for, sorted by source id. */
export function teardownRows(
  criblSources: Readonly<Partial<Record<OnboardingSourceId, CriblSourceRecord>>>,
  lakeRoutes: Readonly<Partial<Record<OnboardingSourceId, LakeRouteRecord>>>,
): TeardownRow[] {
  const ids = new Set<OnboardingSourceId>();
  for (const [k, v] of Object.entries(criblSources)) if (v !== undefined) ids.add(k as OnboardingSourceId);
  for (const [k, v] of Object.entries(lakeRoutes)) if (v !== undefined) ids.add(k as OnboardingSourceId);
  return [...ids].sort().map((sourceId) => ({ sourceId, criblSource: criblSources[sourceId] ?? null, lakeRoute: lakeRoutes[sourceId] ?? null }));
}

export function removeArmKey(row: TeardownRow, removeDataset: boolean, readSeq: number): string {
  return JSON.stringify(["remove", row.sourceId, row.criblSource, row.lakeRoute, removeDataset, readSeq]);
}

export function pauseArmKey(row: TeardownRow, pause: boolean, readSeq: number): string {
  return JSON.stringify(["pause", row.sourceId, row.criblSource, pause, readSeq]);
}

// ---------------------------------------------------------------------------
// The Remove confirm, in words
// ---------------------------------------------------------------------------

function deleteLine(step: TeardownStep, groupId: string, ready: ReadyTeardown): string {
  switch (step.kind) {
    case "route":
      return `Remove route ${step.id} from routing table ${ready.routeWrite?.tableId ?? "(unknown)"} in worker group ${groupId}. No other route is changed.`;
    case "pipeline":
      return `Delete pipeline ${step.id} in worker group ${groupId}. No route, source or other recorded route of this app uses it.`;
    case "input":
      return `Delete Cribl source ${step.id} in worker group ${groupId}. It stops reading from Azure.`;
    case "secret":
      return `Delete secret ${step.id} in worker group ${groupId}, which holds that source's credential.`;
    case "dataset":
      return `After the deploy, delete Cribl Lake dataset ${step.id} and every event it holds. This cannot be undone.`;
  }
}

/** The confirm's lines. Every claim is one the apply keeps. */
export function teardownConfirmText(ready: ReadyTeardown): string[] {
  const { groupId } = ready;
  const lines: string[] = [];
  const goes = ready.steps.filter((s) => s.verdict.kind === "delete");
  lines.push(`Remove, in this order, only what this app can prove it created:`);
  goes.forEach((s, i) => lines.push(`${i + 1}. ${deleteLine(s, groupId, ready)}`));
  for (const s of ready.steps) {
    if (s.verdict.kind === "keep") lines.push(`Kept: ${describeTeardownObject(s, groupId)}. ${s.verdict.detail}`);
    if (s.verdict.kind === "already-gone") lines.push(`Already gone: ${describeTeardownObject(s, groupId)}.`);
  }
  if (ready.commitFiles.length > 0) {
    lines.push(`The commit can include at most these files, and only those still uncommitted after the removals: ${ready.commitFiles.join(", ")}.`);
    if (ready.scope.alreadyDirty.length > 0) {
      lines.push(`These files already have someone else's uncommitted changes, which the commit will carry too: ${ready.scope.alreadyDirty.join(", ")}.`);
    }
    if (ready.scope.elsewhere.length > 0) lines.push(`Other uncommitted changes in Cribl are left alone: ${ready.scope.elsewhere.join(", ")}.`);
    lines.push(`Then deploy worker group ${groupId}, which restarts its workers.`);
  }
  return lines;
}

export function teardownPlanView(result: Exclude<PlanTeardownResult, { kind: "ready" }>): OutcomeView {
  if (result.kind === "nothing-to-remove") {
    const kept = result.steps.filter((s) => s.verdict.kind === "keep");
    return {
      tone: kept.length > 0 ? "warning" : "ok",
      headline: kept.length > 0 ? "Nothing this app can remove: what is left is kept." : "Nothing left to remove: every object is already gone.",
      detail: result.steps
        .map((s) => `${describeTeardownObject(s, result.groupId)}: ${s.verdict.kind === "keep" ? s.verdict.detail : "already gone."}`)
        .join(" "),
      inCribl: null,
    };
  }
  return {
    tone: "error",
    headline: result.denied === true ? "Cannot check: Cribl refused a read this needs (permission)." : "Cannot remove from here.",
    detail: result.detail,
    inCribl: null,
  };
}

export function teardownOutcomeView(outcome: ApplyTeardownOutcome): OutcomeView {
  if (outcome.kind === "removed") {
    return { tone: "ok", headline: "Removed: every object named was removed or already gone, and the change is deployed.", detail: outcome.detail, inCribl: null };
  }
  if (outcome.kind === "void") {
    return {
      tone: "warning",
      headline: "Not removed: Cribl changed since the confirm, so it no longer describes what would go. Check again.",
      detail: outcome.detail,
      inCribl: null,
    };
  }
  const denied = outcome.steps.some((s) => s.denied === true);
  return {
    tone: "error",
    headline: denied ? "Stopped: Cribl refused a removal (permission)." : "Stopped before every object was removed.",
    detail: outcome.detail,
    inCribl: "In Cribl, check the objects named above; what this app removed is listed, and what it did not is still there.",
  };
}

// ---------------------------------------------------------------------------
// Pause, in words
// ---------------------------------------------------------------------------

export function pauseConfirmText(ready: ReadyPause): string[] {
  const { record, pause } = ready;
  const lines = [
    pause
      ? `Pause Cribl source ${record.inputId} in worker group ${record.groupId}: set it disabled, so it stops reading from Azure. Nothing else changes.`
      : `Resume Cribl source ${record.inputId} in worker group ${record.groupId}: set it enabled again, so it reads from Azure. Nothing else changes.`,
  ];
  if (pause) {
    lines.push("Events wait in the Event Hub only for the hub's retention period; a pause longer than that loses the events in between.");
  }
  lines.push(`The commit can include at most these files: ${ready.commitFiles.join(", ")}.`);
  if (ready.scope.alreadyDirty.length > 0) {
    lines.push(`These files already have someone else's uncommitted changes, which the commit will carry too: ${ready.scope.alreadyDirty.join(", ")}.`);
  }
  lines.push(`Then deploy worker group ${record.groupId}, which restarts its workers.`);
  return lines;
}

export function pausePlanView(result: Exclude<PlanPauseResult, { kind: "ready" }>): OutcomeView {
  if (result.kind === "already") return { tone: "ok", headline: "Nothing to change.", detail: result.detail, inCribl: null };
  return {
    tone: "error",
    headline: result.denied === true ? "Cannot check: Cribl refused a read this needs (permission)." : "Cannot change this source from here.",
    detail: result.detail,
    inCribl: null,
  };
}

export function pauseOutcomeView(outcome: ApplyPauseOutcome): OutcomeView {
  switch (outcome.kind) {
    case "deployed":
      return { tone: "ok", headline: "Done: committed and deployed.", detail: outcome.detail, inCribl: null };
    case "void":
      return { tone: "warning", headline: "Not changed: the source changed since the confirm. Check again.", detail: outcome.detail, inCribl: null };
    case "refused":
      return { tone: "error", headline: outcome.denied === true ? "Refused by Cribl (permission)." : "Not changed.", detail: outcome.detail, inCribl: null };
    case "written-not-deployed":
      return {
        tone: "error",
        headline: "Changed in Cribl, but not deployed.",
        detail: outcome.detail,
        inCribl: "In Cribl, check the worker group's pending changes before trying again.",
      };
  }
}
