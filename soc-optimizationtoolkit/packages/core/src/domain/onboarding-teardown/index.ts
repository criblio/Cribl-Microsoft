/**
 * onboarding-teardown domain barrel (AZR-105): the pure planning of Remove
 * and Pause for what the Azure Native Source Onboarding screen created - which
 * objects are provably the app's, what still uses them, the order they go in,
 * and which records survive. usecases/onboarding-teardown does the IO.
 */

export {
  IN_USE_CHECKED,
  classifyActivityLogRemoval,
  classifyEntraSettingRemoval,
  classifyInputForPause,
  describeTeardownObject,
  isDenied,
  planCriblTeardown,
  recordsAfterTeardown,
  sameDeletions,
  teardownDeletions,
  teardownGroup,
  teardownReadsNeeded,
} from "./teardown-plan";
export type {
  ActivityLogRemovalVerdict,
  ActivityLogSettingLookup,
  CriblTeardownInput,
  CriblTeardownPlan,
  CriblTeardownReads,
  CriblTeardownRefusalReason,
  OtherGroupRead,
  OtherGroupsRead,
  OtherLakeRoute,
  PauseVerdict,
  TeardownKeepReason,
  TeardownObjectKind,
  TeardownRead,
  TeardownStep,
  TeardownStepResult,
  TeardownVerdict,
} from "./teardown-plan";
