// File-backed tagged-sample store: the local twin of the cloud shell's
// PlatformTaggedSampleStore (KV entries + index). Identical contract per the
// @soc/core TaggedSampleStore port: keyed by log type with replace-by-logType
// semantics (upsert replaces an existing entry IN PLACE, keeping its position,
// or appends a new one), get resolves null for an unknown log type, list
// returns first-upsert order, remove of an unknown log type is a no-op.
//
// Persistence is one JSON array in {dataDir}/tagged-samples.json, written
// atomically-ish via temp file + rename. The core caps rawEvents at 200 events
// per sample (and the UI caps stored records too), so each entry stays small.
// data/ is gitignored.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {object} TaggedSample Mirrors the @soc/core TaggedSample shape.
 * @property {string} logType The replace key.
 * @property {string} format
 * @property {string[]} rawEvents
 * @property {object} parsed
 */

/**
 * Build the tagged-sample store over {dataDir}/tagged-samples.json. Mutations
 * are serialized through an in-process queue (single-operator tool).
 *
 * @param {string} dataDir
 */
export function createTaggedSampleStore(dataDir) {
  const filePath = path.join(dataDir, 'tagged-samples.json');
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

  /** @returns {Promise<TaggedSample[]>} */
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
      throw new Error(`${filePath} is not valid JSON - fix or delete the file (tagged samples will be lost)`);
    }
    return Array.isArray(parsed) ? parsed : [];
  }

  /** @param {TaggedSample[]} samples */
  async function writeAll(samples) {
    await mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(samples, null, 2), 'utf8');
    await rename(tmpPath, filePath);
  }

  return {
    /**
     * Insert `sample`, replacing any existing entry with the same logType in
     * place (position preserved) or appending when the log type is new.
     *
     * @param {TaggedSample} sample
     * @returns {Promise<void>}
     */
    upsert(sample) {
      return enqueue(async () => {
        const samples = await readAll();
        const index = samples.findIndex((s) => s.logType === sample.logType);
        if (index === -1) {
          samples.push(sample);
        } else {
          samples[index] = sample;
        }
        await writeAll(samples);
      });
    },

    /**
     * Resolve the tagged sample for `logType`, or null when none exists.
     * @param {string} logType
     * @returns {Promise<TaggedSample | null>}
     */
    get(logType) {
      return enqueue(async () => {
        const samples = await readAll();
        return samples.find((s) => s.logType === logType) ?? null;
      });
    },

    /**
     * List all tagged samples in first-upsert order.
     * @returns {Promise<TaggedSample[]>}
     */
    list() {
      return enqueue(async () => readAll());
    },

    /**
     * Remove the entry for `logType`. Idempotent: a missing log type is a no-op.
     * @param {string} logType
     * @returns {Promise<void>}
     */
    remove(logType) {
      return enqueue(async () => {
        const samples = await readAll();
        const next = samples.filter((s) => s.logType !== logType);
        if (next.length !== samples.length) {
          await writeAll(next);
        }
      });
    },
  };
}
