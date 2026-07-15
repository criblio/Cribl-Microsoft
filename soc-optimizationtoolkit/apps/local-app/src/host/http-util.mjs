// Shared HTTP plumbing for the local host: consistent JSON responses, a
// size-capped JSON body reader, and an AbortController upstream timeout.
//
// Timeout note (dual-target parity): the cloud shell must Promise.race its
// timeouts because the Cribl platform's locked fetch bridge ignores
// AbortSignal. Node's fetch honors AbortSignal, so a plain abort timer is
// correct here - but the ~30s bound itself is kept for behavioral parity
// with the cloud proxy's 30s server-side timeout.

import { Buffer } from 'node:buffer';

/** Default upper bound for any upstream (Azure / Cribl leader) request. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30000;

/** Size cap for incoming JSON request bodies. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Error carrying an HTTP status for the API dispatcher to surface as-is. */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status to respond with.
   * @param {string} message Actionable, user-facing error text.
   */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** True when `value` is a plain (non-null, non-array) object. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Write a JSON response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload JSON-serializable payload.
 */
export function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Write an empty response (e.g. 204 for PUT/DELETE).
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 */
export function sendEmpty(res, status) {
  res.writeHead(status);
  res.end();
}

/**
 * Read and JSON-parse a request body with a size cap. Resolves `undefined`
 * for an empty body (route handlers validate the shape they need and emit
 * their own actionable 400s). Rejects with HttpError 413 when the cap is
 * exceeded and 400 when the body is not valid JSON.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<unknown>}
 */
export function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop buffering and reject; do NOT destroy the socket here - that
        // would reset the connection before the 413 response is written.
        // Node tears the connection down itself after the response ends
        // because the request body was never fully consumed.
        req.removeAllListeners('data');
        req.pause();
        reject(new HttpError(413, `request body exceeds the ${maxBytes}-byte cap`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'request body is not valid JSON'));
      }
    });
    req.on('error', (err) => {
      reject(new HttpError(400, `failed to read request body: ${err.message}`));
    });
  });
}

/**
 * fetch with a hard abort timeout covering the WHOLE exchange - request,
 * headers, and body. The body is read inside the abort window on purpose:
 * clearing the timer when fetch resolves (headers received) would let an
 * upstream that stalls mid-body hang past the ~30s bound. Every upstream
 * request the host makes on behalf of the browser goes through this (or
 * through the equivalent signal handling in cribl.mjs for TLS-agent
 * requests) so nothing can hang past ~30s.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ status: number, ok: boolean, text: string, retryAfter: number|null, rateLimitReset: number|null }>}
 */
export async function fetchTextWithTimeout(url, init = {}, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    // Surface the rate-limit headers so callers can honor Retry-After /
    // x-ratelimit-reset on GitHub 429s (live report 2026-07-15).
    const retryAfterRaw = Number(res.headers.get('retry-after'));
    const resetRaw = Number(res.headers.get('x-ratelimit-reset'));
    // res.text() shares the abort signal: aborting mid-body rejects it too.
    return {
      status: res.status,
      ok: res.ok,
      text: await res.text(),
      retryAfter: Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? retryAfterRaw : null,
      rateLimitReset: Number.isFinite(resetRaw) && resetRaw > 0 ? resetRaw : null,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`request to ${new URL(url).host} timed out after ${timeoutMs / 1000}s`);
    }
    // undici buries the real failure (DNS, refused connection, TLS) in the
    // cause chain behind a bare "fetch failed"; surface it.
    throw new Error(`request to ${new URL(url).host} failed: ${describeNetworkError(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Flatten a network error into an actionable one-line description. Node hides
 * the useful detail in two places this walks: `cause` (undici's fetch throws
 * TypeError "fetch failed" with the real error as cause) and `errors`
 * (dual-stack connects reject with an AggregateError whose own message is
 * EMPTY and whose per-address failures sit in .errors).
 *
 * @param {unknown} err
 * @returns {string} Non-empty description, e.g. "connect ECONNREFUSED 127.0.0.1:9999".
 */
export function describeNetworkError(err) {
  /** @type {string[]} */
  const parts = [];
  const seen = new Set();
  /** @param {unknown} e */
  function walk(e) {
    if (e === null || e === undefined || seen.has(e)) {
      return;
    }
    seen.add(e);
    if (e instanceof Error) {
      if (e.message !== '' && e.message !== 'fetch failed') {
        parts.push(e.message);
      }
      if (Array.isArray(e.errors)) {
        for (const sub of e.errors) {
          walk(sub);
        }
      }
      walk(e.cause);
    } else {
      parts.push(String(e));
    }
  }
  walk(err);
  if (parts.length === 0) {
    parts.push(err instanceof Error && err.message !== '' ? err.message : String(err));
  }
  // De-duplicate while keeping order (dual-stack failures often repeat the
  // same code for v4 and v6).
  return [...new Set(parts)].join('; ');
}

/**
 * Interpret an upstream body the way the cloud shell's readPortBody does:
 * parsed JSON when parseable, the raw text otherwise, null when empty.
 * Ports and proxy endpoints surface raw {status, body} pairs and never
 * throw on HTTP-level errors.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseUpstreamBody(text) {
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Allowed verbs for the Azure/Cribl proxy endpoints. */
export const ALLOWED_PROXY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

/**
 * Validate the common {method, path, body?, query?} proxy-request fields,
 * throwing actionable HttpError 400s. Returns the validated fields.
 *
 * @param {unknown} payload Parsed request body.
 * @param {string} endpoint Endpoint name for error messages.
 * @returns {{ method: string, path: string, body: unknown, query: Record<string, string> | undefined }}
 */
export function validateProxyRequest(payload, endpoint) {
  if (!isPlainObject(payload)) {
    throw new HttpError(400, `${endpoint}: request body must be a JSON object with { method, path, ... }`);
  }
  const method = payload.method;
  if (typeof method !== 'string' || !ALLOWED_PROXY_METHODS.includes(method.toUpperCase())) {
    throw new HttpError(400, `${endpoint}: "method" must be one of ${ALLOWED_PROXY_METHODS.join(', ')}`);
  }
  const path = payload.path;
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new HttpError(400, `${endpoint}: "path" must be a string starting with "/"`);
  }
  let query;
  if (payload.query !== undefined) {
    if (!isPlainObject(payload.query)) {
      throw new HttpError(400, `${endpoint}: "query" must be an object of string values`);
    }
    for (const [key, value] of Object.entries(payload.query)) {
      if (typeof value !== 'string') {
        throw new HttpError(400, `${endpoint}: query parameter "${key}" must be a string`);
      }
    }
    query = /** @type {Record<string, string>} */ (payload.query);
  }
  return { method: method.toUpperCase(), path, body: payload.body, query };
}
