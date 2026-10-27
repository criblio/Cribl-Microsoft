/**
 * onboarding-howto domain barrel (AZR-30, AZR-31, AZR-32): the sources a
 * customer can onboard and how their logs travel, the plan values How-to steps
 * are written against, the Validate verdict vocabulary, and the progress KV
 * document (ADR 0007, D1).
 */

export {
  NOT_ONBOARDABLE,
  ONBOARDING_SOURCES,
  isAutomatable,
  isOnboardingSourceId,
  onboardingSource,
} from "./sources";
export type {
  CriblInputType,
  EmitterKind,
  HubNaming,
  NotOnboardable,
  OnboardingSource,
  OnboardingSourceId,
  OnboardingTransport,
} from "./sources";

export {
  DEFAULT_CONSUMER_GROUP,
  DEFAULT_FLOW_LOG_CONTAINER,
  PLAN_VALUE_KEYS,
  PLAN_VALUE_LABELS,
  defaultPlanValues,
  isPlanValueKey,
  missingValues,
  planFingerprint,
  sanitizePlanValue,
} from "./plan-values";
export type { PlanValueKey, PlanValueLabel, PlanValues } from "./plan-values";

export { CHECK_KINDS, aggregateVerdict } from "./check-kinds";
export type {
  AggregateVerdict,
  ArrivalReading,
  CheckKind,
  StepVerdict,
  UnknownReason,
  VerdictDiff,
} from "./check-kinds";

export {
  ONBOARDING_PROGRESS_KEY,
  ONBOARDING_PROGRESS_KIND,
  ONBOARDING_PROGRESS_VERSION,
  canWriteProgressDocument,
  decodeProgress,
  emptyProgress,
  encodeProgress,
  progressFrom,
  readProgressDocument,
  tickState,
  withCriblSource,
  withPlanValues,
  withSourceChosen,
  withSourceMode,
  withTick,
  withWorkerGroup,
  withoutTick,
} from "./progress-document";
export type {
  CriblSourceRecord,
  DecodedProgress,
  OnboardingProgress,
  ProgressDocument,
  SourceMode,
  SourceProgress,
  StepTick,
  TickState,
} from "./progress-document";
