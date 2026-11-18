/**
 * onboarding-teardown usecase barrel (AZR-105): Remove (plan, then apply)
 * what the Azure onboarding screen created in Cribl for one source, and Pause
 * or resume its Cribl source. The Activity Log setting's removal is in
 * usecases/activity-log-export.
 */

export {
  TEARDOWN_COMMIT_TIMEOUT_MS,
  TEARDOWN_LOG_PREFIX,
  applySourceTeardown,
  planSourceTeardown,
  teardownCommitDetail,
  teardownCommitMarkers,
  teardownSourceIds,
} from "./onboarding-teardown";
export type {
  ApplyTeardownOutcome,
  PlanTeardownInput,
  PlanTeardownRefusalReason,
  PlanTeardownResult,
  ReadyTeardown,
  TeardownCommitResult,
  TeardownPorts,
  TeardownStepOutcome,
} from "./onboarding-teardown";

export { PAUSE_COMMIT_MARKERS, applyInputPause, planInputPause } from "./input-pause";
export type { ApplyPauseOutcome, PlanPauseInput, PlanPauseResult, ReadyPause } from "./input-pause";
