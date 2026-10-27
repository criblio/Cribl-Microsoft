/**
 * onboarding-flow domain barrel (AZR-33): which metrics query each live-flow
 * poll run sends, and the measured state of each onboarding lane's
 * Azure -> Cribl source hop (ADR 0007, D15).
 */

export {
  FLOW_BYTES_AGGREGATION,
  FLOW_EVENTS_KEY,
  FLOW_LOOKBACK,
  FLOW_WINDOW_SECONDS,
  LOOKBACK_RETRY_EVERY,
  describeFlowRequest,
  flowQuery,
  flowQueryBody,
  nextFlowQuery,
} from "./flow-query";
export type { FlowQueryKind, LookbackStatus, NextFlowQueryInput } from "./flow-query";

export {
  FLOW_STATE_LABEL,
  NOT_MEASURED_REASON_LABEL,
  classifyLaneFlow,
  describeLaneFlow,
  matchInputLabel,
  shouldAnimate,
  unmatchedInputLabels,
  windowSawInput,
} from "./flow-state";
export type {
  ClassifyLaneFlowInput,
  FlowAnswer,
  FlowInput,
  LaneFlowState,
  NotMeasuredReason,
} from "./flow-state";
