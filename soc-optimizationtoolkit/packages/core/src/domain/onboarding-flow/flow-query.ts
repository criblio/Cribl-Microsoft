/**
 * Which Cribl metrics query the onboarding live flow sends on each poll run,
 * and the literal body of that query (AZR-33, ADR 0007 D15).
 *
 * PURE: no clock, no IO. The caller (the UI's use-live-flow hook) owns the
 * poll timer and tracks whether the lookback has answered.
 *
 * Exactly ONE query per run, so the proxy budget is one request per minute:
 *  - the lookback (cumulative over FLOW_LOOKBACK) runs first, so a lane can say
 *    "never seen in the last 24 hours" instead of "waiting";
 *  - after it answers, every run is the window query (cumulative over
 *    FLOW_WINDOW_SECONDS), which decides flowing versus idle;
 *  - if the lookback FAILED, runs use the window query and the lookback is
 *    retried on every LOOKBACK_RETRY_EVERY-th run until it answers.
 *
 * The counter is intake: `total.in_events` split by `input`
 * (claude-kit standards/cribl-metrics.md; kit/metrics/counting.ts
 * INTAKE_AGGREGATION). Never `pipe.in_events`, which counts once per pipeline
 * path. No `where`: one query covers every onboarding input, and the labels are
 * matched client-side (flow-state.ts matchInputLabel).
 *
 * Provenance: the request shape is Documented (kit metricsQuery.ts header), NOT
 * measured live; the label form for a new eventhub / azure_blob input is on the
 * ADR 0007 live-verification list.
 */

import {
  buildMetricsQueryBody,
  describeMetricsRequest,
  type MetricsQuery,
} from "../../kit/metrics/metricsQuery";
import { INTAKE_AGGREGATION } from "../../kit/metrics/counting";

/** The window that decides flowing versus idle, in seconds. */
export const FLOW_WINDOW_SECONDS = 300;
/** The lookback that decides idle versus never seen. Shown to the operator as-is. */
export const FLOW_LOOKBACK = "-24h";
/** After a failed lookback, retry it on every Nth run (the others are window runs). */
export const LOOKBACK_RETRY_EVERY = 5;

/** The bytes aggregation sent alongside intake events. */
export const FLOW_BYTES_AGGREGATION = 'sum("total.in_bytes").as(in_bytes)';
/** The alias the events aggregation is given; flow-state reads this key. */
export const FLOW_EVENTS_KEY = "in_events";

export type FlowQueryKind = "lookback" | "window";
export type LookbackStatus = "pending" | "answered" | "failed";

export interface NextFlowQueryInput {
  lookback: LookbackStatus;
  /**
   * Runs since the last lookback attempt, COUNTING the run being planned
   * (1 for the first run after the attempt). Only read when `lookback` is
   * 'failed'.
   */
  runsSinceLookbackAttempt: number;
}

/** The one query this run sends. */
export function nextFlowQuery(input: NextFlowQueryInput): FlowQueryKind {
  if (input.lookback === "pending") return "lookback";
  if (input.lookback === "answered") return "window";
  return input.runsSinceLookbackAttempt >= LOOKBACK_RETRY_EVERY
    ? "lookback"
    : "window";
}

/** The typed query for a kind, for the kit's queryMetrics. */
export function flowQuery(kind: FlowQueryKind): MetricsQuery {
  return {
    aggregations: [INTAKE_AGGREGATION, FLOW_BYTES_AGGREGATION],
    splitBys: ["input"],
    window: { cumulative: true },
    earliest: kind === "window" ? `-${FLOW_WINDOW_SECONDS}s` : FLOW_LOOKBACK,
    latest: "now",
  };
}

/** The literal body sent for a kind. */
export function flowQueryBody(kind: FlowQueryKind): Record<string, unknown> {
  return buildMetricsQueryBody(flowQuery(kind));
}

/**
 * Method, path and body for the diagram's (i) popover. Null when there is no
 * worker group yet: nothing is sent then, so there is no request to describe
 * (the kit's metricsQueryPath throws on an empty group).
 */
export function describeFlowRequest(
  groupId: string,
  kind: FlowQueryKind,
): { method: "POST"; path: string; body: string } | null {
  if (!groupId) return null;
  return describeMetricsRequest(groupId, flowQuery(kind));
}
