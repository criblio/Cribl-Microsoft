/**
 * query-lake-samples usecase barrel (plan Phase 4, ADR 0003).
 *
 * The SEARCH half of Phase 4: which log types a Lake dataset holds, and how
 * much of each. capture-samples is the other half.
 */

export type {
  FetchLakeEventsOptions,
  FetchLakeEventsResult,
  LakeLogTypeEvents,
  LakeLogTypeVolume,
  QueryLakeSamplesOptions,
  QueryLakeSamplesResult,
  SearchPath,
} from "./query-lake-samples";
// THE SEARCH PLUMBING IS DELIBERATELY NOT EXPORTED: the two route paths and
// their job-id builders, the poll bounds, the step-one and step-two query
// builders, searchResultRows, the count-column alias, and the window and
// row-cap defaults. The 2026-08-20 audit found every one of them reachable only
// from this usecase's own tests, and those import "./query-lake-samples"
// directly, so withholding them costs a test nothing. It is worth doing because
// usecases/index.ts re-exports this file with `export *`: a name left here is a
// name @soc/core promises to every app, and each one is another thing an
// internal change has to keep working.
//
// The two SAMPLE bounds stay - the Lake panel seeds its input from
// DEFAULT_SAMPLE_LIMIT and states MAX_SAMPLE_LIMIT as that input's max, which
// is exactly the consumer the withheld names do not have.
//
// buildLogTypeEventQuery was kept here for one round on the belief that
// live-verify.test.ts consumed it. It does not - it mentions the name in a
// comment and reaches the query through fetchLakeLogTypeEvents - so it fails
// the same test as the other thirteen and is withheld with them. The
// `tostring()` rule it encodes is pinned in this usecase's own tests, which is
// where a rule about this usecase's query text belongs.
export {
  DEFAULT_SAMPLE_LIMIT,
  MAX_SAMPLE_LIMIT,
  fetchLakeLogTypeEvents,
  queryLakeSamples,
} from "./query-lake-samples";
