/**
 * capture-samples usecase barrel (plan Phase 4, ADR 0003).
 */

export type {
  CaptureSamplesOptions,
  CaptureSamplesResult,
} from "./capture-samples";
// SYSTEM_CAPTURE_PATH and extractCapturedEvents stay module-local (2026-08-20
// audit): internal and test-only, and the tests that read them import the
// module directly, so nothing is lost by withholding them here.
//
// EVERY BOUND IS EXPORTED, ceilings as well as defaults. The panel seeds its
// inputs from the DEFAULT_* pair, and states the MAX_* pair as those inputs'
// `max` - which it can only do without restating them. It restated 10000 as a
// literal until 2026-08-20, so this file's own claim that MAX_EVENTS_LIMIT was
// "internal and test-only" was false the day it was written, and the UI would
// have gone on advertising 10000 after any change to the API's real ceiling.
export {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_MAX_EVENTS,
  MAX_DURATION_SECONDS,
  MAX_EVENTS_LIMIT,
  captureSamples,
} from "./capture-samples";
