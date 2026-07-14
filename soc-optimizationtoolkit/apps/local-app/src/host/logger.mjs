// File logger for the local host (porting-plan Unit 3): appends single-line
// records to {dataDir}/logs/app.log with size-based rotation, and serves the
// recent tail back to the browser (GET /api/logs?tail=N). One logger serves
// BOTH producers: entries the browser shell ships via POST /api/logs, and
// the host's own server-side events (API requests, token refreshes,
// upstream failures).
//
// LINE FORMAT - the runtime twin of @soc/core log-model's formatLogLine
// (pinned there by tests; @soc/ui parseLogLine round-trips it):
//
//   {iso} [{LEVEL padded to 5}] [job:{jobId}]? {message} {key=value ...}
//
// The host cannot import @soc/core at runtime (the package ships TypeScript
// source consumed by Vite; this process is plain Node ESM), so the format is
// deliberately reimplemented here. Keep the two in lockstep: any change to
// the core format is a pinned-contract change and must land in both files.
//
// ROTATION - prior art is the legacy Electron logger (10MB cap, rotated
// files), reimplemented per the Unit 3 verdict, simplified to a cap plus a
// SINGLE .1 rollover: when app.log reaches LOG_MAX_BYTES it becomes
// app.log.1 (replacing any previous rollover) and a fresh app.log starts.
// Bounded worst case: 2 x LOG_MAX_BYTES on disk.
//
// HARD RULE - no secret or token value is ever loggable: context values are
// restricted to string | number | boolean | null and every browser-shipped
// entry passes sanitizeLogEntries (non-primitive context values are DROPPED,
// sizes are capped). Host-side call sites log names, ids, counts, statuses,
// and curated error messages - never credentials, bodies, or headers.

import { Buffer } from 'node:buffer';
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

/** Rotate app.log to app.log.1 when it reaches this size. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Default and maximum line counts for the tail endpoint. */
export const LOG_TAIL_DEFAULT = 500;
export const LOG_TAIL_MAX = 2000;

/** Caps applied to browser-shipped entries (defense in depth). */
export const LOG_BATCH_ENTRY_CAP = 100;
const MESSAGE_LENGTH_CAP = 4000;
const CONTEXT_VALUE_LENGTH_CAP = 1000;
const CONTEXT_KEY_CAP = 32;

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const LEVEL_PAD = 5;

/**
 * @typedef {object} HostLogEntry Mirrors the @soc/core LogEntry shape.
 * @property {string} timestamp ISO 8601, injected by the producing adapter.
 * @property {'debug' | 'info' | 'warn' | 'error'} level
 * @property {string} message
 * @property {Record<string, string | number | boolean | null>} [context]
 * @property {string} [jobId]
 */

/**
 * Render one entry as a single line - the twin of core formatLogLine (see
 * module doc). Exported for tests-by-inspection and reuse; keep in lockstep
 * with @soc/core log-model.
 *
 * @param {HostLogEntry} entry
 * @returns {string}
 */
export function formatLogLine(entry) {
  const level = `[${entry.level.toUpperCase().padEnd(LEVEL_PAD)}]`;
  const jobTag = entry.jobId !== undefined ? ` [job:${entry.jobId}]` : '';
  let line = `${entry.timestamp} ${level}${jobTag} ${singleLine(entry.message)}`;
  if (entry.context !== undefined) {
    for (const [key, value] of Object.entries(entry.context)) {
      line += ` ${key}=${formatContextValue(value)}`;
    }
  }
  return line;
}

/** @param {string} text */
function singleLine(text) {
  return text.replace(/\r\n|\r|\n/g, '\\n');
}

/** @param {string | number | boolean | null} value */
function formatContextValue(value) {
  if (typeof value === 'string') {
    return value === '' || needsQuoting(value) ? JSON.stringify(value) : value;
  }
  return String(value);
}

/** @param {string} value */
function needsQuoting(value) {
  if (/[\s"=]/.test(value)) {
    return true;
  }
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) {
      return true;
    }
  }
  return false;
}

/**
 * Sanitize a browser-shipped POST /api/logs payload into HostLogEntry[].
 * Returns null when the payload is not { entries: [...] } (route answers
 * 400). Individual entries are salvaged tolerantly: a bad level falls back
 * to 'info', a missing/blank message drops the entry, non-primitive context
 * values are DROPPED (the hard rule, enforced server-side), long strings are
 * truncated, and a non-ISO-looking timestamp is replaced host-side.
 *
 * @param {unknown} payload
 * @param {() => string} now ISO timestamp source for entries without one.
 * @returns {HostLogEntry[] | null}
 */
export function sanitizeLogEntries(payload, now) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const entries = /** @type {{ entries?: unknown }} */ (payload).entries;
  if (!Array.isArray(entries)) {
    return null;
  }
  /** @type {HostLogEntry[]} */
  const clean = [];
  for (const raw of entries.slice(0, LOG_BATCH_ENTRY_CAP)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      continue;
    }
    const candidate = /** @type {Record<string, unknown>} */ (raw);
    if (typeof candidate.message !== 'string' || candidate.message === '') {
      continue;
    }
    /** @type {HostLogEntry} */
    const entry = {
      timestamp:
        typeof candidate.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(candidate.timestamp)
          ? candidate.timestamp
          : now(),
      level:
        typeof candidate.level === 'string' && LEVELS.has(candidate.level)
          ? /** @type {HostLogEntry['level']} */ (candidate.level)
          : 'info',
      message: candidate.message.slice(0, MESSAGE_LENGTH_CAP),
    };
    if (typeof candidate.jobId === 'string' && candidate.jobId !== '') {
      entry.jobId = candidate.jobId.slice(0, 200);
    }
    if (
      typeof candidate.context === 'object' &&
      candidate.context !== null &&
      !Array.isArray(candidate.context)
    ) {
      /** @type {Record<string, string | number | boolean | null>} */
      const context = {};
      let keys = 0;
      for (const [key, value] of Object.entries(candidate.context)) {
        if (keys >= CONTEXT_KEY_CAP) {
          break;
        }
        if (typeof value === 'string') {
          context[key] = value.slice(0, CONTEXT_VALUE_LENGTH_CAP);
          keys++;
        } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
          context[key] = value;
          keys++;
        }
        // Anything else (object, array, undefined, function) is DROPPED:
        // no unknown passthrough onto disk, by construction.
      }
      if (keys > 0) {
        entry.context = context;
      }
    }
    clean.push(entry);
  }
  return clean;
}

/**
 * Build the file logger over {dataDir}/logs/app.log. Writes are serialized
 * through an in-process chain (order-preserving, one rotation check per
 * write) and NEVER throw: a failing disk must not take logging's callers
 * down with it. warn/error lines also mirror to the console for operator
 * visibility; info/debug stay file-only (API request lines would drown the
 * terminal).
 *
 * @param {string} dataDir
 */
export function createFileLogger(dataDir) {
  const logDir = path.join(dataDir, 'logs');
  const logPath = path.join(logDir, 'app.log');
  const rolloverPath = path.join(logDir, 'app.log.1');
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  /** @type {number | null} Current app.log size; stat'ed lazily once. */
  let size = null;

  /** @param {HostLogEntry} entry */
  function append(entry) {
    const line = `${formatLogLine(entry)}\n`;
    if (entry.level === 'warn' || entry.level === 'error') {
      (entry.level === 'error' ? console.error : console.warn)(line.trimEnd());
    }
    chain = chain
      .then(async () => {
        await mkdir(logDir, { recursive: true });
        if (size === null) {
          try {
            size = (await stat(logPath)).size;
          } catch {
            size = 0;
          }
        }
        if (size >= LOG_MAX_BYTES) {
          // Single .1 rollover (replaces any previous one - Node's rename
          // overwrites on Windows too); a rename failure falls through to
          // keep appending rather than lose the record.
          try {
            await rename(logPath, rolloverPath);
            size = 0;
          } catch {
            // Keep writing to the oversized file; retry rotation next write.
          }
        }
        await appendFile(logPath, line, 'utf8');
        size += Buffer.byteLength(line, 'utf8');
      })
      .catch(() => undefined);
  }

  /**
   * @param {'debug' | 'info' | 'warn' | 'error'} level
   * @param {string} message
   * @param {Record<string, string | number | boolean | null>} [context]
   * @param {string} [jobId]
   */
  function log(level, message, context, jobId) {
    /** @type {HostLogEntry} */
    const entry = { timestamp: new Date().toISOString(), level, message };
    if (context !== undefined) {
      entry.context = context;
    }
    if (jobId !== undefined) {
      entry.jobId = jobId;
    }
    append(entry);
  }

  /** @param {string} file @returns {Promise<string[]>} */
  async function readLines(file) {
    try {
      const text = await readFile(file, 'utf8');
      return text.split('\n').filter((line) => line !== '');
    } catch {
      return [];
    }
  }

  return {
    /** Ship a pre-built entry (the sanitized browser batches). */
    append,

    /** Host-side convenience methods (host stamps the timestamp). */
    debug: (message, context, jobId) => log('debug', message, context, jobId),
    info: (message, context, jobId) => log('info', message, context, jobId),
    warn: (message, context, jobId) => log('warn', message, context, jobId),
    error: (message, context, jobId) => log('error', message, context, jobId),

    /**
     * The most recent `maxLines` lines, oldest first, spanning the rollover
     * file when app.log alone is shorter than requested. Awaits pending
     * writes first so a Refresh right after a flush sees its own entries.
     *
     * @param {number} maxLines
     * @returns {Promise<string[]>}
     */
    async tail(maxLines) {
      await chain;
      let lines = await readLines(logPath);
      if (lines.length < maxLines) {
        const previous = await readLines(rolloverPath);
        lines = [...previous.slice(-(maxLines - lines.length)), ...lines];
      }
      return lines.slice(-maxLines);
    },
  };
}
