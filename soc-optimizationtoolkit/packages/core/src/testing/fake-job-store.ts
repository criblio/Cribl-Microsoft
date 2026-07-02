import type { JobRecord, JobStore } from '../ports/job-store';

/**
 * In-memory {@link JobStore} for tests.
 *
 * Ids are deterministic ("job-1", "job-2", ...). Timestamps come from the
 * injectable clock (defaults to the real time) so tests can assert on
 * createdAt/updatedAt without sleeping. All records returned by `get`/`list`
 * are defensive copies: mutating them does not affect the store.
 */
export class FakeJobStore implements JobStore {
  private readonly records = new Map<string, JobRecord>();
  private nextId = 1;
  private readonly clock: () => string;

  /**
   * @param clock Optional ISO-timestamp source, e.g. a counter-backed fake
   *   clock for deterministic updatedAt assertions.
   */
  constructor(clock?: () => string) {
    this.clock = clock ?? (() => new Date().toISOString());
  }

  async create(kind: string, input: unknown): Promise<JobRecord> {
    const now = this.clock();
    const record: JobRecord = {
      id: `job-${this.nextId++}`,
      kind,
      status: 'pending',
      input,
      steps: [],
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return copyRecord(record);
  }

  async update(id: string, patch: Partial<Omit<JobRecord, 'id'>>): Promise<void> {
    const existing = this.records.get(id);
    if (existing === undefined) {
      throw new Error(`FakeJobStore.update: no job with id "${id}"`);
    }
    const merged: JobRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.clock(),
    };
    this.records.set(id, copyRecord(merged));
  }

  async get(id: string): Promise<JobRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : copyRecord(record);
  }

  async list(kind?: string): Promise<JobRecord[]> {
    const all = [...this.records.values()]
      .filter((record) => kind === undefined || record.kind === kind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return all.map(copyRecord);
  }
}

/** Copy a record deeply enough that callers cannot mutate stored steps. */
function copyRecord(record: JobRecord): JobRecord {
  return { ...record, steps: record.steps.map((step) => ({ ...step })) };
}
