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
} from "./merge";
export { evidenceCounts, mergeLogTypeSources } from "./merge";
