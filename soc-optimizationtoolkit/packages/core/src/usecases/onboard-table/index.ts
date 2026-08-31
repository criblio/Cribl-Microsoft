export {
  // DBT-60: the store-failure signal crosses the module boundary as a
  // PREDICATE, never as the class. onboardBatch has its own identically-named
  // class, and testing one module's class with `instanceof` against the other's
  // rejection matches nothing - which is how the child's signal was raised and
  // then silently recorded as an ordinary failed table.
  isJobStoreFailure,
  onboardTable,
  onboardTableStepsFor,
  DEFAULT_DCR_POLL_ATTEMPTS,
  LOG_ANALYTICS_API_VERSION,
  ONBOARD_TABLE_JOB_KIND,
  ONBOARD_TABLE_STEPS,
} from "./onboard-table";
export type {
  OnboardTableDceInput,
  OnboardTableInput,
  OnboardTableOutcome,
  OnboardTablePorts,
  OnboardTableStepName,
} from "./onboard-table";
