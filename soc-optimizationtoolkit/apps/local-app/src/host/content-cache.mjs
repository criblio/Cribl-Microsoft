// File-backed parsed-content cache for the local host: the server-side twin of
// the cloud shell's KvContentCache (platform KV), porting-plan Unit 14.
//
// Stores only PARSED results (decoder projections, solution index, parsed rule
// lists) keyed by the @soc/core contentCacheKey - NEVER raw file bytes. The
// cache key embeds the upstream commit SHA, so a new commit yields new keys and
// stale entries simply miss (no explicit invalidation pass). Values round-trip
// through JSON.
//
// EDR NOTE: the browser-side LocalSentinelContent adapter applies the core EDR
// content filter (isPathAllowedByEdr) on every file read, so blocklisted
// IOC-laden rule content never reaches the browser and therefore never reaches
// THIS on-disk cache. This store is deliberately generic - it only ever
// receives already-filtered content.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Build the content cache over {dataDir}/content-cache.json.
 *
 * All operations are serialized through an in-process queue so concurrent
 * requests cannot interleave read-modify-write cycles (single-operator tool).
 *
 * @param {string} dataDir
 */
export function createContentCache(dataDir) {
  const filePath = path.join(dataDir, 'content-cache.json');
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

  /** @returns {Promise<Record<string, unknown>>} */
  async function readAll() {
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return {};
      }
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch {
      // A corrupt cache is not fatal - treat it as empty and let it be rewritten.
      return {};
    }
  }

  /** @param {Record<string, unknown>} entries */
  async function writeAll(entries) {
    await mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(entries), 'utf8');
    await rename(tmpPath, filePath);
  }

  return {
    /**
     * Resolve the cached value for `key`, or null on a miss.
     * @param {string} key
     * @returns {Promise<unknown>}
     */
    get(key) {
      return enqueue(async () => {
        const entries = await readAll();
        return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null;
      });
    },

    /**
     * Store `value` under `key`, replacing any previous entry.
     * @param {string} key
     * @param {unknown} value
     */
    set(key, value) {
      return enqueue(async () => {
        const entries = await readAll();
        entries[key] = value;
        await writeAll(entries);
      });
    },
  };
}
