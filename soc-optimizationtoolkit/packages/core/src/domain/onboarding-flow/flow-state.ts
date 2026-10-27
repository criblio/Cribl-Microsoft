/**
 * The live-flow state of one onboarding lane's Event Hub / Blob -> Cribl
 * source hop, from Cribl's own intake metrics (AZR-33, ADR 0007 D15).
 *
 * PURE. The states are distinct on purpose (claude-kit standards/cribl-metrics.md,
 * inventory-honesty.md): a refused or unreadable answer is NEVER zero, a missing
 * row is NEVER idle unless the lookback measured the input, and only a measured
 * non-zero window row is "flowing" - the one state that animates.
 *
 * Label matching follows kit/metrics/counting.ts parseEndpointLabel: an input
 * label is `<type>:<id>`, `<type>:<id>:<extra>...`, or inside a pack
 * `<type>:<packId>.<id>` (Measured 2026-08-25 / 2026-09-24 in the kit). The
 * form for a new eventhub / azure_blob input is NOT measured live yet (ADR 0007
 * live-verification list).
 */

import type { MetricsAnswer } from "../../kit/metrics/metricsQuery";
import { parseEndpointLabel } from "../../kit/metrics/counting";
import { FLOW_EVENTS_KEY, FLOW_LOOKBACK, type LookbackStatus } from "./flow-query";

/** The Cribl input a lane reads into, as the onboarding source created it. */
export interface FlowInput {
  /** 'eventhub' or 'azure_blob'. */
  type: string;
  id: string;
  /** Set only when the input lives inside a pack. */
  packId?: string;
}

/**
 * What a metrics read produced. The kit's MetricsAnswer, plus the two shapes a
 * caller wrapping it may report: a 401/403 as `refused`, a transport rejection
 * as `failed` (read-source-flow never throws).
 */
export type FlowAnswer =
  | MetricsAnswer
  | { kind: "refused"; status: number; detail: string }
  | { kind: "failed"; detail: string };

export type NotMeasuredReason =
  | "waiting"
  | "no-permission"
  | "http-error"
  | "unexpected-shape"
  | "no-source"
  | "lookback-failed";

export type LaneFlowState =
  | { kind: "flowing"; events: number }
  /**
   * `seenInSession` is present (true) only when an earlier window answer in this
   * session measured the input above zero, so a later missing row can never
   * read as "never seen".
   */
  | { kind: "idle"; seenInLookback: boolean; seenInSession?: true }
  /** `asOf` is the caller's label for when the lookback was taken, when known. */
  | { kind: "never-seen"; lookback: string; asOf?: string }
  | { kind: "not-measured"; reason: NotMeasuredReason; detail: string }
  /** Reserved: backpressure is not read in this slice, so nothing produces it. */
  | { kind: "blocked" };

/** Does a metrics `input` label name this input? Type and id must both match. */
export function matchInputLabel(
  label: string,
  input: FlowInput,
  installedPackIds: ReadonlySet<string> = new Set(),
): boolean {
  const packs = input.packId
    ? new Set([...installedPackIds, input.packId])
    : installedPackIds;
  const parsed = parseEndpointLabel(label, packs);
  if (!parsed) return false;
  return (
    parsed.type === input.type &&
    parsed.id === input.id &&
    (parsed.packId ?? undefined) === (input.packId ?? undefined)
  );
}

/**
 * The input's measured event count in an answer: the sum over every matching
 * row, or null when no row names the input (or the answer is not rows/empty).
 */
function rowValue(answer: FlowAnswer, input: FlowInput): number | null {
  if (answer.kind !== "rows") return null;
  let found = false;
  let total = 0;
  for (const row of answer.rows) {
    const label = row.input;
    const value = row[FLOW_EVENTS_KEY];
    if (typeof label !== "string" || !matchInputLabel(label, input)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    found = true;
    total += value;
  }
  return found ? total : null;
}

/**
 * Did this window answer measure the input above zero? The caller folds this
 * into `seenInSession` (once true, it stays true for the session).
 */
export function windowSawInput(answer: FlowAnswer | null, input: FlowInput | null): boolean {
  if (!answer || !input) return false;
  const v = rowValue(answer, input);
  return v !== null && v > 0;
}

function isError(answer: FlowAnswer): boolean {
  return answer.kind === "error" || answer.kind === "refused" || answer.kind === "failed";
}

/** A not-measured state for an answer that is an error of some kind. */
function notMeasuredFor(answer: FlowAnswer): LaneFlowState {
  if (answer.kind === "refused") {
    return { kind: "not-measured", reason: "no-permission", detail: `HTTP ${answer.status}: ${answer.detail}` };
  }
  if (answer.kind === "failed") {
    return { kind: "not-measured", reason: "http-error", detail: answer.detail };
  }
  if (answer.kind === "error") {
    if (answer.reason === "unexpected-shape") {
      return { kind: "not-measured", reason: "unexpected-shape", detail: answer.detail };
    }
    if (answer.status === 401 || answer.status === 403) {
      return { kind: "not-measured", reason: "no-permission", detail: `HTTP ${answer.status}: ${answer.detail}` };
    }
    return { kind: "not-measured", reason: "http-error", detail: `HTTP ${answer.status}: ${answer.detail}` };
  }
  return { kind: "not-measured", reason: "waiting", detail: "" };
}

export interface ClassifyLaneFlowInput {
  /** Null when the lane has no Cribl source yet. */
  input: FlowInput | null;
  /** The latest window answer; null until a window query has answered. */
  windowAnswer: FlowAnswer | null;
  /** The latest lookback answer; null until a lookback has been attempted. */
  lookbackAnswer: FlowAnswer | null;
  lookbackStatus: LookbackStatus;
  /**
   * True once any earlier window answer in this session measured the input
   * above zero (fold windowSawInput over every window answer). The lookback is
   * not re-run after it answers, so without this a lane that flowed and then
   * went quiet would fall back to "never seen".
   */
  seenInSession?: boolean;
  /** When the answered lookback was taken, as the caller formats it (core has no clock). */
  lookbackAsOf?: string;
}

/**
 * Decide in this fixed order:
 *  1. no input -> not measured (no-source);
 *  2. a window answer that is an error -> the matching not-measured;
 *  3. a window row > 0 -> flowing;
 *  4. a window row = 0 -> idle;
 *  5. no window row, lookback row > 0 or seen earlier in this session -> idle;
 *  6. no window row, lookback answered without a positive row -> never seen;
 *  7. no window row, lookback FAILED -> not measured (lookback-failed), except
 *     that a 401/403 lookback says no-permission when NO window has answered
 *     yet (a window answer proves the metrics grant, so 403 there is not
 *     "no permission");
 *  8. otherwise (nothing has answered yet) -> waiting.
 */
export function classifyLaneFlow(args: ClassifyLaneFlowInput): LaneFlowState {
  const { input, windowAnswer, lookbackAnswer, lookbackStatus, seenInSession, lookbackAsOf } = args;
  if (!input) {
    return { kind: "not-measured", reason: "no-source", detail: "no Cribl source has been created for this lane" };
  }
  if (windowAnswer && isError(windowAnswer)) return notMeasuredFor(windowAnswer);

  const windowRow = windowAnswer ? rowValue(windowAnswer, input) : null;
  const lookbackRow =
    lookbackStatus === "answered" && lookbackAnswer ? rowValue(lookbackAnswer, input) : null;

  const lookbackSaw = lookbackRow !== null && lookbackRow > 0;
  const idle = (seenInLookback: boolean): LaneFlowState =>
    seenInSession ? { kind: "idle", seenInLookback, seenInSession: true } : { kind: "idle", seenInLookback };

  if (windowRow !== null && windowRow > 0) return { kind: "flowing", events: windowRow };
  if (windowRow !== null) return idle(lookbackSaw);

  if (lookbackSaw || seenInSession) return idle(lookbackSaw);
  if (lookbackStatus === "answered") {
    return lookbackAsOf
      ? { kind: "never-seen", lookback: FLOW_LOOKBACK, asOf: lookbackAsOf }
      : { kind: "never-seen", lookback: FLOW_LOOKBACK };
  }
  if (lookbackStatus === "failed") {
    const failed = lookbackAnswer && isError(lookbackAnswer) ? notMeasuredFor(lookbackAnswer) : null;
    if (windowAnswer === null && failed && failed.kind === "not-measured" && failed.reason === "no-permission") {
      return failed;
    }
    return {
      kind: "not-measured",
      reason: "lookback-failed",
      detail: failed && failed.kind === "not-measured" ? failed.detail : "the lookback query did not answer",
    };
  }
  return { kind: "not-measured", reason: "waiting", detail: "no metrics answer yet" };
}

/**
 * Input labels in an answer that name none of the given inputs. Shown in the
 * (i) so an operator can see the real label form when a lane never matches.
 */
export function unmatchedInputLabels(answer: FlowAnswer, inputs: readonly FlowInput[]): string[] {
  if (answer.kind !== "rows") return [];
  const out = new Set<string>();
  for (const row of answer.rows) {
    const label = row.input;
    if (typeof label !== "string") continue;
    if (!inputs.some((i) => matchInputLabel(label, i))) out.add(label);
  }
  return [...out].sort();
}

/** Only a measured, non-zero window animates. */
export function shouldAnimate(state: LaneFlowState): boolean {
  return state.kind === "flowing";
}

/** The state word shown on the edge and in the legend. */
export const FLOW_STATE_LABEL: Readonly<Record<LaneFlowState["kind"], string>> = {
  flowing: "flowing",
  idle: "idle",
  "never-seen": "never seen",
  "not-measured": "not measured",
  blocked: "blocked",
};

export const NOT_MEASURED_REASON_LABEL: Readonly<Record<NotMeasuredReason, string>> = {
  waiting: "waiting for the first answer",
  "no-permission": "no permission",
  "http-error": "the metrics request failed",
  "unexpected-shape": "unexpected answer shape",
  "no-source": "no Cribl source yet",
  "lookback-failed": "lookback failed",
};

function lookbackPhrase(lookback: string): string {
  const m = /^-(\d+)h$/.exec(lookback);
  if (m) return m[1] === "1" ? "the last hour" : `the last ${m[1]} hours`;
  return lookback;
}

/** The full sentence for a state, e.g. "not measured: lookback failed". */
export function describeLaneFlow(state: LaneFlowState): string {
  switch (state.kind) {
    case "flowing":
      return `flowing: ${state.events} events in the window`;
    case "idle":
      return state.seenInLookback || state.seenInSession
        ? "idle: no events in the window, seen earlier"
        : "idle: no events in the window";
    case "never-seen":
      return state.asOf
        ? `never seen in ${lookbackPhrase(state.lookback)} (lookback taken ${state.asOf})`
        : `never seen in ${lookbackPhrase(state.lookback)}`;
    case "not-measured":
      return `not measured: ${NOT_MEASURED_REASON_LABEL[state.reason]}`;
    case "blocked":
      return "blocked";
  }
}
