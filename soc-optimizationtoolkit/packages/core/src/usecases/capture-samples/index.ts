/**
 * capture-samples usecase barrel (plan Phase 4, ADR 0003).
 */

export type {
  CaptureSamplesOptions,
  CaptureSamplesResult,
} from "./capture-samples";
// MAX_EVENTS_LIMIT, SYSTEM_CAPTURE_PATH and extractCapturedEvents stay
// module-local (2026-08-20 audit): internal and test-only. The two DEFAULT_*
// bounds ARE exported - the capture panel seeds its inputs from them.
export { DEFAULT_DURATION_SECONDS, DEFAULT_MAX_EVENTS, captureSamples } from "./capture-samples";
