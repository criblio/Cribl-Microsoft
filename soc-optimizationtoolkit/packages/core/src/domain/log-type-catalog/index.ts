/**
 * log-type-catalog domain barrel (ADR 0003): WHICH log types a solution needs,
 * from three tiers of evidence - shipped detections, shipped workbooks, and the
 * vendor's own documentation.
 *
 * The vendor tier is the fallback that answers a solution with no detections at
 * all, which the content-derived tiers structurally cannot.
 */

export type {
  DocumentedLogType,
  DocumentedLogTypePack,
  DocumentedLogTypeEntry,
} from "./vendor-log-types";
export {
  DOCUMENTED_LOG_TYPE_PACKS,
  documentedLogTypePacksForSolution,
  documentedLogTypesForSolution,
} from "./vendor-log-types";
export type {
  LogTypeEvidence,
  MergedLogType,
  MergeLogTypeInput,
  LogTypeVolume,
  UnreferencedLogType,
} from "./merge";
// evidenceCounts is module-local: test-only at the 2026-08-20 audit, and the
// UI counts tiers off the entries it already has.
// estimatedLogTypeBytes IS exported, unlike evidenceCounts: the Lake panel does
// the same events-to-bytes conversion for its own per-row volumes, and a second
// multiplication in the UI would be a second place for the app to decide what
// an unmeasured log type weighs.
export {
  estimatedLogTypeBytes,
  mergeLogTypeSources,
  rankUnreferencedByVolume,
} from "./merge";
