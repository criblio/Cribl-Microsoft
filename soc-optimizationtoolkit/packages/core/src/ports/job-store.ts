/**
 * JobStore port: persistence for long-running operations (DCR deployments,
 * pack builds, discovery scans) so the UI can render progress and history.
 *
 * Implementations:
 * - Cloud shell: adapter over platform storage (e.g. /kvstore-backed records).
 * - Local shell: the Node host persists jobs on disk.
 */

/**
 * Lifecycle state shared by jobs and their individual steps.
 *
 * 'skipped' is FIRST-CLASS (user decision, porting-plan "DECISIONS RESOLVED
 * 2026-07-03" item 1, binding Units 6/20 and step-line rendering): a step or
 * job that was deliberately not run - a skip-existing hit, or a downstream
 * step of a failed prerequisite (the legacy engine cascaded confusing errors
 * instead; downstream steps of a failed table SKIP here). It is terminal and
 * distinct from 'succeeded' - a skipped step did no work.
 */
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

/** One unit of progress within a job (e.g. "create table", "deploy DCR"). */
export interface JobStep {
  /** Human-readable step name, unique within the job. */
  name: string;
  /** Current lifecycle state of this step. */
  status: JobStatus;
  /** Optional human-readable progress, skip-reason, or failure detail. */
  detail?: string;
}

/** A persisted long-running operation. */
export interface JobRecord {
  /** Store-assigned unique identifier. */
  id: string;
  /** Job category (e.g. "deploy-dcr", "build-pack"); used for filtering. */
  kind: string;
  /** Current lifecycle state of the job as a whole. */
  status: JobStatus;
  /** The input the job was created with (JSON-serializable). */
  input: unknown;
  /** Output produced on success (JSON-serializable). */
  result?: unknown;
  /** Failure summary when status is 'failed'. */
  error?: string;
  /** Ordered progress steps; usecases replace this array wholesale on update. */
  steps: JobStep[];
  /** ISO 8601 timestamp of creation. Set by the store. */
  createdAt: string;
  /** ISO 8601 timestamp of the last update. Maintained by the store. */
  updatedAt: string;
}

/**
 * CRUD store for {@link JobRecord}s.
 *
 * Error semantics: `create` and `update` reject on backend failure; `update`
 * also rejects when `id` does not exist. `get` resolves null for a missing
 * id; `list` resolves [] when nothing matches.
 */
export interface JobStore {
  /**
   * Create a new job of `kind` with the given input. The store assigns `id`,
   * sets status 'pending', an empty `steps` array, and both timestamps, then
   * resolves the full record.
   */
  create(kind: string, input: unknown): Promise<JobRecord>;

  /**
   * Shallow-merge `patch` into the stored record and refresh `updatedAt`
   * (patch fields win; a `steps` value in the patch replaces the whole
   * array). `id`, and `createdAt`/`updatedAt` supplied in the patch, are
   * ignored in favor of store-managed values. Rejects if `id` is unknown.
   */
  update(id: string, patch: Partial<Omit<JobRecord, 'id'>>): Promise<void>;

  /** Resolve the record for `id`, or null when it does not exist. */
  get(id: string): Promise<JobRecord | null>;

  /**
   * List jobs, newest first by `createdAt`. When `kind` is given, only jobs
   * of that kind are returned.
   */
  list(kind?: string): Promise<JobRecord[]>;
}
