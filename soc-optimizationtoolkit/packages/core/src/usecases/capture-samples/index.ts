/**
 * capture-samples usecase barrel (plan Phase 4, ADR 0003).
 */

export type {
  CaptureSamplesOptions,
  CaptureSamplesResult,
} from "./capture-samples";
export {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_MAX_EVENTS,
  MAX_EVENTS_LIMIT,
  SYSTEM_CAPTURE_PATH,
  captureSamples,
  extractCapturedEvents,
} from "./capture-samples";
