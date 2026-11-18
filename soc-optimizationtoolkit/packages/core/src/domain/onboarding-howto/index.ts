/**
 * onboarding-howto domain barrel (AZR-30, AZR-31, AZR-32): the sources a
 * customer can onboard and how their logs travel, the plan values How-to steps
 * are written against, the Validate verdict vocabulary, and the progress KV
 * document (ADR 0007, D1).
 */

export {
  ONBOARDING_SOURCES,
  isAutomatable,
  isOnboardingSourceId,
  onboardingSource,
} from "./sources";
export type {
  CriblInputType,
  EmitterKind,
  HubNaming,
  OnboardingSource,
  OnboardingSourceId,
  OnboardingTransport,
} from "./sources";

export {
  DEFAULT_CONSUMER_GROUP,
  DEFAULT_FLOW_LOG_CONTAINER,
  EVENT_HUB_PLAN_KEYS,
  eventHubLocation,
  withEventHubLocation,
  PLAN_VALUE_KEYS,
  PLAN_VALUE_LABELS,
  changedValueKeys,
  defaultPlanValues,
  isPlanValueKey,
  missingValues,
  planFingerprint,
  sanitizePlanValue,
} from "./plan-values";
export type { PlanValueKey, PlanValueLabel, PlanValues } from "./plan-values";

export { CHECK_KINDS, CHECK_SUBJECT, aggregateVerdict, otherNameAlsoFound } from "./check-kinds";
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
  eventHubFollowsSection1,
  progressFrom,
  readProgressDocument,
  strandedCriblSources,
  tickState,
  withCriblSource,
  withEventHubSource,
  withLakeRoute,
  withPlanValues,
  withSourceChosen,
  withSourceMode,
  withTick,
  withWorkerGroup,
  withoutTick,
  activityLogSettingRecord,
  withActivityLogSetting,
  entraSettingRecord,
  withEntraSetting,
  withoutEntraSetting,
  withLakeRouteAfterTeardown,
  withoutActivityLogSetting,
  withoutCriblSource,
  withEventHubAccess,
  withoutEventHubAccess,
} from "./progress-document";
export type {
  ActivityLogSettingRecord,
  EntraSettingRecord,
  CriblSourceRecord,
  LakeRouteRecord,
  DecodedProgress,
  EventHubSource,
  OnboardingProgress,
  ProgressDocument,
  SourceMode,
  SourceProgress,
  StepTick,
  StrandedCriblSource,
  TickState,
} from "./progress-document";
