// File-backed pack build-record store: the local twin of the cloud shell's
// PlatformPackStore (KV-backed StoredPack entries + index). Same contract per
// the @soc/ui PackRecordStore port: list/get/put(upsert by record id)/delete.
//
// A stored entry is a StoredPack { record, definition, cachedCrblBase64? } - the
// record is the small list-renderable descriptor and the definition is enough
// to regenerate the identical .crbl on demand (assemblePack is deterministic).
// Unlike the cloud store (which never persists bytes - KV size), the local host
// MAY keep cachedCrblBase64 when the client sends it; it simply stores what it
// is given.
//
// Persistence is one JSON array in {dataDir}/packs.json (insert order, newest
// appended), written atomically-ish via temp file + rename. data/ is gitignored.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {object} StoredPack Mirrors the @soc/ui StoredPack shape.
 * @property {{ id: string, [k: string]: unknown }} record
 * @property {unknown} definition
 * @property {string} [cachedCrblBase64]
 */

/**
 * Build the pack store over {dataDir}/packs.json. Mutations are serialized
 * through an in-process queue (single-operator tool).
 *
 * @param {string} dataDir
 */
export function createPackStore(dataDir) {
  const filePath = path.join(dataDir, 'packs.json');
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

  /** @returns {Promise<StoredPack[]>} */
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
      throw new Error(`${filePath} is not valid JSON - fix or delete the file (pack build history will be lost)`);
    }
    return Array.isArray(parsed) ? parsed : [];
  }

  /** @param {StoredPack[]} records */
  async function writeAll(records) {
    await mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(records, null, 2), 'utf8');
    await rename(tmpPath, filePath);
  }

  /** Read the stable record id from a StoredPack, or null when malformed. */
  function idOf(pack) {
    const record = pack && typeof pack === 'object' ? pack.record : undefined;
    const id = record && typeof record === 'object' ? record.id : undefined;
    return typeof id === 'string' && id !== '' ? id : null;
  }

  return {
    /** @returns {Promise<StoredPack[]>} */
    list() {
      return enqueue(() => readAll());
    },

    /**
     * @param {string} id
     * @returns {Promise<StoredPack | null>}
     */
    get(id) {
      return enqueue(async () => {
        const records = await readAll();
        return records.find((p) => idOf(p) === id) ?? null;
      });
    },

    /**
     * Upsert by record id: replace an existing entry with the same id in place,
     * otherwise append. Resolves the stored pack.
     *
     * @param {StoredPack} pack
     * @returns {Promise<StoredPack>}
     */
    put(pack) {
      return enqueue(async () => {
        const id = idOf(pack);
        if (id === null) {
          throw new Error('pack store put: pack.record.id must be a non-empty string');
        }
        const records = await readAll();
        const index = records.findIndex((p) => idOf(p) === id);
        if (index === -1) {
          records.push(pack);
        } else {
          records[index] = pack;
        }
        await writeAll(records);
        return pack;
      });
    },

    /**
     * Remove the entry with the given id (idempotent). Resolves true when an
     * entry was removed, false when none matched.
     *
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    delete(id) {
      return enqueue(async () => {
        const records = await readAll();
        const next = records.filter((p) => idOf(p) !== id);
        if (next.length === records.length) {
          return false;
        }
        await writeAll(next);
        return true;
      });
    },
  };
}
