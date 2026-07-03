// File-backed job store: the local twin of the cloud shell's
// PlatformJobStore (KV-backed records + index). Identical contract per the
// @soc/core JobStore port: the store owns identity and time (crypto.randomUUID
// ids, ISO timestamps), update() is a shallow merge where the patch wins but
// id/createdAt stay store-managed and updatedAt is always refreshed, and
// list() returns newest-first by createdAt.
//
// Persistence is one JSON array in {dataDir}/jobs.json (creation order,
// newest appended), written atomically-ish via temp file + rename. data/ is
// gitignored.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {object} JobRecord Mirrors the @soc/core JobRecord shape.
 * @property {string} id
 * @property {string} kind
 * @property {string} status
 * @property {unknown} input
 * @property {unknown} [result]
 * @property {string} [error]
 * @property {Array<{ name: string, status: string, detail?: string }>} steps
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Build the job store over {dataDir}/jobs.json. Mutations are serialized
 * through an in-process queue (single-operator tool).
 *
 * @param {string} dataDir
 */
export function createJobStore(dataDir) {
  const filePath = path.join(dataDir, 'jobs.json');
  let queue = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** @returns {Promise<JobRecord[]>} */
  async function readAll() {
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${filePath} is not valid JSON - fix or delete the file (job history will be lost)`);
    }
    return Array.isArray(parsed) ? parsed : [];
  }

  /** @param {JobRecord[]} records */
  async function writeAll(records) {
    await mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(records, null, 2), 'utf8');
    await rename(tmpPath, filePath);
  }

  return {
    /**
     * Create a job: store-assigned id, status 'pending', empty steps, both
     * timestamps set to now. Resolves the full record.
     *
     * @param {string} kind
     * @param {unknown} input
     * @returns {Promise<JobRecord>}
     */
    create(kind, input) {
      return enqueue(async () => {
        const now = new Date().toISOString();
        /** @type {JobRecord} */
        const record = {
          id: randomUUID(),
          kind,
          status: 'pending',
          input,
          steps: [],
          createdAt: now,
          updatedAt: now,
        };
        const records = await readAll();
        records.push(record);
        await writeAll(records);
        return record;
      });
    },

    /**
     * Shallow-merge `patch` into the stored record: patch fields win, id and
     * createdAt are store-managed, updatedAt is refreshed (same contract as
     * PlatformJobStore and the in-memory fake). Resolves the merged record,
     * or null when `id` is unknown.
     *
     * @param {string} id
     * @param {Record<string, unknown>} patch
     * @returns {Promise<JobRecord | null>}
     */
    update(id, patch) {
      return enqueue(async () => {
        const records = await readAll();
        const index = records.findIndex((record) => record.id === id);
        if (index === -1) {
          return null;
        }
        const existing = records[index];
        /** @type {JobRecord} */
        const merged = {
          ...existing,
          ...patch,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString(),
        };
        records[index] = merged;
        await writeAll(records);
        return merged;
      });
    },

    /**
     * Resolve the record for `id`, or null when it does not exist.
     * @param {string} id
     * @returns {Promise<JobRecord | null>}
     */
    get(id) {
      return enqueue(async () => {
        const records = await readAll();
        return records.find((record) => record.id === id) ?? null;
      });
    },

    /**
     * List jobs newest-first by createdAt, optionally filtered by kind.
     * Walks the stored array newest-appended-first so the stable sort keeps
     * creation order for records sharing a createdAt timestamp (mirrors the
     * cloud adapter's index walk).
     *
     * @param {string} [kind]
     * @returns {Promise<JobRecord[]>}
     */
    list(kind) {
      return enqueue(async () => {
        const records = await readAll();
        const filtered = [...records]
          .reverse()
          .filter((record) => kind === undefined || record.kind === kind);
        filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return filtered;
      });
    },
  };
}
