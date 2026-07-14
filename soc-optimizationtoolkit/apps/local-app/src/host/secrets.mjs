// File-backed secrets store: the local twin of the cloud shell's
// PlatformSecretsStore (platform KV). SECURITY POSTURE PARITY is the design
// driver: values written with { encrypted: true } are WRITE-ONLY through the
// browser-facing API - GET resolves { value: null } exactly like the cloud
// KV's 403-mapped-to-null - so the shared UI behaves identically on both
// targets and never expects to read a secret back.
//
// Deliberately deferred (documented in CONTEXT.md): encryption AT REST. The
// marker makes the value unreadable over HTTP, but data/secrets.json itself
// is plaintext on disk, written 0600 best-effort (mode bits are advisory on
// Windows). data/ is gitignored.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE_MODE = 0o600;

/**
 * @typedef {{ value: string, encrypted: boolean }} SecretEntry
 */

/**
 * Build the secrets store over {dataDir}/secrets.json.
 *
 * All operations are serialized through an in-process queue so concurrent
 * requests cannot interleave read-modify-write cycles (single-operator tool;
 * no cross-process locking is attempted).
 *
 * @param {string} dataDir
 */
export function createSecretsStore(dataDir) {
  const filePath = path.join(dataDir, 'secrets.json');
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

  /** @returns {Promise<Record<string, SecretEntry>>} */
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
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${filePath} is not valid JSON - fix or delete the file (stored secrets will be lost)`);
    }
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  }

  /** @param {Record<string, SecretEntry>} entries */
  async function writeAll(entries) {
    await mkdir(dataDir, { recursive: true });
    // Atomic-ish: write a temp file, then rename over the target.
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: FILE_MODE });
    await rename(tmpPath, filePath);
    try {
      await chmod(filePath, FILE_MODE);
    } catch {
      // Best effort; mode bits are advisory on Windows.
    }
  }

  return {
    /**
     * Store `value` under `key`, overwriting any existing entry including
     * its encrypted flag.
     *
     * @param {string} key
     * @param {string} value
     * @param {boolean} encrypted
     */
    set(key, value, encrypted) {
      return enqueue(async () => {
        const entries = await readAll();
        entries[key] = { value, encrypted };
        await writeAll(entries);
      });
    },

    /**
     * Read the value under `key`. Resolves null for a missing key AND for an
     * encrypted entry (write-only parity with the cloud KV) - callers must
     * re-set rather than read-modify-write secrets.
     *
     * @param {string} key
     * @returns {Promise<string | null>}
     */
    get(key) {
      return enqueue(async () => {
        const entries = await readAll();
        const entry = entries[key];
        if (entry === undefined || entry.encrypted === true) {
          return null;
        }
        return typeof entry.value === 'string' ? entry.value : null;
      });
    },

    /**
     * Remove the entry under `key`. Idempotent: succeeds when absent.
     * @param {string} key
     */
    delete(key) {
      return enqueue(async () => {
        const entries = await readAll();
        if (!(key in entries)) {
          return;
        }
        delete entries[key];
        await writeAll(entries);
      });
    },

    /**
     * List stored keys starting with `prefix` ('' for all). Keys only,
     * never values or encrypted flags.
     *
     * @param {string} prefix
     * @returns {Promise<string[]>}
     */
    list(prefix) {
      return enqueue(async () => {
        const entries = await readAll();
        return Object.keys(entries).filter((key) => key.startsWith(prefix));
      });
    },
  };
}
