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
export {
  COUNT_COLUMN,
  DEFAULT_EARLIEST,
  DEFAULT_LATEST,
  DEFAULT_MAX_LOG_TYPES,
  DEFAULT_SAMPLE_LIMIT,
  JOB_POLL_ATTEMPTS,
  JOB_POLL_INTERVAL_MS,
  MAX_LOG_TYPES_LIMIT,
  MAX_SAMPLE_LIMIT,
  SEARCH_JOBS_PATH,
  SEARCH_QUERY_PATH,
  buildDiscriminatorSampleQuery,
  buildLogTypeCountQuery,
  buildLogTypeEventQuery,
  fetchLakeLogTypeEvents,
  queryLakeSamples,
  searchJobResultsPath,
  searchJobStatusPath,
  searchResultRows,
} from "./query-lake-samples";
