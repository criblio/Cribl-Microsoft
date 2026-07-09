// Cribl leader proxy for the local host: the server-side twin of the cloud
// shell's PlatformCriblClient adapter (apps/cribl-app/src/platform/
// adapters.ts). Same contract: request() resolves {status, body} for every
// HTTP response and rejects only on transport failure; listGroups() maps
// /master/groups with the same tolerant shape-handling.
//
// Where the cloud shell rides the platform's authenticated fetch to the
// hosting workspace's own API, this host talks to the CONFIGURED leader
// (on-prem or Cribl.Cloud) and attaches a bearer resolved by the injected
// auth manager (cribl-auth.mjs): minted cloud/on-prem tokens or a static
// configured token. On an upstream 401 with a mintable auth type the proxy
// re-authenticates ONCE and retries ONCE (twin of azure.mjs's 401 recovery);
// with a static token it surfaces the 401 as data and logs an expiry hint.
//
// Leader calls use node:http(s).request instead of global fetch for exactly
// one reason: honoring cribl.rejectUnauthorized via an https.Agent scoped to
// THESE calls only (self-signed on-prem leaders) - Azure calls always verify
// TLS. The low-level transport (leaderRequest) is exported so the on-prem
// login in cribl-auth.mjs shares identical TLS/timeout/error semantics.

import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import { DEFAULT_UPSTREAM_TIMEOUT_MS, HttpError, describeNetworkError, parseUpstreamBody } from './http-util.mjs';
import { CONFIG_PATH } from './config.mjs';

// TLS verification failures that self-signed leader certificates produce;
// used to append the rejectUnauthorized hint to the error message.
const SELF_SIGNED_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value, key) {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return value[key];
}

/** Render a body for error messages without ever throwing. */
function bodyText(body) {
  if (typeof body === 'string') {
    return body;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/**
 * @typedef {object} CriblProxyRequest
 * @property {string} method
 * @property {string} path Path relative to /api/v1, e.g. "/system/outputs".
 * @property {string} [groupId] Worker Group / Edge Fleet; prefixes /m/{id}.
 * @property {unknown} [body]
 * @property {Record<string, string>} [query]
 */

/**
 * Build the leader proxy over the config's leader URL and the auth manager.
 *
 * @param {import('./config.mjs').CriblSection} cribl
 * @param {import('./cribl-auth.mjs').CriblAuthManager} auth
 * @returns {{
 *   request(opts: CriblProxyRequest): Promise<{ status: number, body: unknown }>,
 *   listGroups(): Promise<Array<{ id: string, product?: string }>>,
 *   uploadPack(groupId: string, fileName: string, bytes: Buffer): Promise<{ status: number, body: unknown }>,
 * }}
 */
export function createCriblProxy(cribl, auth) {
  // One agent for all leader calls; rejectUnauthorized applies ONLY here.
  const httpsAgent = new https.Agent({ rejectUnauthorized: cribl.rejectUnauthorized });

  /**
   * @param {CriblProxyRequest} opts
   * @returns {Promise<{ status: number, body: unknown }>}
   */
  async function request(opts) {
    if (cribl.leaderUrl === '') {
      throw new HttpError(500, `cribl.leaderUrl is empty in ${CONFIG_PATH} - set it and restart the host`);
    }
    const groupPrefix =
      typeof opts.groupId === 'string' && opts.groupId !== '' ? `/m/${encodeURIComponent(opts.groupId)}` : '';
    let target = `${cribl.leaderUrl}/api/v1${groupPrefix}${opts.path}`;
    if (opts.query !== undefined && Object.keys(opts.query).length > 0) {
      target += `?${new URLSearchParams(opts.query).toString()}`;
    }

    const token = await auth.getLeaderToken(false);
    const first = await send(target, opts, token);
    if (first.status !== 401) {
      return first;
    }
    if (auth.type === 'token') {
      // A static token cannot be refreshed; the 401 is the answer (data per
      // the port contract), with a host-side hint. The hint carries no token.
      console.warn(
        `[host] Cribl leader returned 401 with the static cribl.auth.token - static tokens expire. ` +
          `Mint a new one and update ${CONFIG_PATH}, or switch cribl.auth.type to "cloud"/"onprem" ` +
          `so the host can refresh tokens itself.`
      );
      return first;
    }
    // 401: the cached token was rejected (expired or revoked - on-prem
    // leaders with auth.timeout < our assumed 3600s land here). Re-auth ONCE
    // and retry ONCE; whatever comes back is the answer.
    const fresh = await auth.getLeaderToken(true);
    return send(target, opts, fresh);
  }

  /**
   * One proxied call with the given bearer, reduced to the port's
   * {status, body} shape.
   *
   * @param {string} target
   * @param {CriblProxyRequest} opts
   * @param {string} token
   * @returns {Promise<{ status: number, body: unknown }>}
   */
  async function send(target, opts, token) {
    const res = await leaderRequest(target, {
      method: opts.method,
      headers: { Authorization: `Bearer ${token}` },
      body: opts.body,
      agent: httpsAgent,
    });
    return { status: res.status, body: res.body };
  }

  /**
   * List Worker Groups / Edge Fleets - same contract and tolerance as the
   * cloud adapter: expects CountedConfigGroup {count, items} per the vendored
   * OpenAPI spec, requires only a non-empty string id per entry, and derives
   * `product` from whichever signal the leader reports - the explicit
   * `product` string (newer leaders) or the isFleet/isSearch booleans (how
   * older leaders mark Edge fleets and Search groups; mirrors the core
   * deriveGroupProduct helper the cloud adapter uses). Throws (surfaced as
   * 502 by the route) on non-2xx or an unexpected shape.
   */
  async function listGroups() {
    const response = await request({ method: 'GET', path: '/master/groups' });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GET /master/groups: HTTP ${response.status}\n${bodyText(response.body)}`);
    }
    const items = prop(response.body, 'items');
    if (!Array.isArray(items)) {
      throw new Error(`GET /master/groups: unexpected response shape\n${bodyText(response.body)}`);
    }
    const groups = [];
    for (const item of items) {
      const id = prop(item, 'id');
      if (typeof id !== 'string' || id === '') {
        continue;
      }
      const explicit = prop(item, 'product');
      const product =
        typeof explicit === 'string' && explicit !== ''
          ? explicit
          : prop(item, 'isFleet') === true
            ? 'edge'
            : prop(item, 'isSearch') === true
              ? 'search'
              : undefined;
      groups.push(product !== undefined ? { id, product } : { id });
    }
    return groups;
  }

  /**
   * Two-step pack upload, step 1: PUT the raw .crbl bytes as an octet-stream to
   * /m/{group}/packs?filename={file}. The leader answers with a JSON body
   * carrying the RANDOMIZED source filename; the browser-side install decision
   * logic (@soc/core parseUploadResponse) reads it and drives the POST install
   * through request(). Same bearer + 401-recovery contract as request(); only
   * the body transport differs (a Buffer, not JSON).
   *
   * @param {string} groupId
   * @param {string} fileName
   * @param {Buffer} bytes
   * @returns {Promise<{ status: number, body: unknown }>}
   */
  async function uploadPack(groupId, fileName, bytes) {
    if (cribl.leaderUrl === '') {
      throw new HttpError(500, `cribl.leaderUrl is empty in ${CONFIG_PATH} - set it and restart the host`);
    }
    const groupPrefix =
      typeof groupId === 'string' && groupId !== '' ? `/m/${encodeURIComponent(groupId)}` : '';
    const target = `${cribl.leaderUrl}/api/v1${groupPrefix}/packs?filename=${encodeURIComponent(fileName)}`;

    const token = await auth.getLeaderToken(false);
    const first = await sendUpload(target, bytes, token);
    if (first.status !== 401 || auth.type === 'token') {
      return first;
    }
    // 401 with a mintable auth type: re-auth ONCE and retry ONCE.
    const fresh = await auth.getLeaderToken(true);
    return sendUpload(target, bytes, fresh);
  }

  /**
   * @param {string} target
   * @param {Buffer} bytes
   * @param {string} token
   * @returns {Promise<{ status: number, body: unknown }>}
   */
  async function sendUpload(target, bytes, token) {
    const res = await leaderRequest(target, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      rawBody: bytes,
      contentType: 'application/octet-stream',
      agent: httpsAgent,
    });
    return { status: res.status, body: res.body };
  }

  return { request, listGroups, uploadPack };
}

/**
 * Low-level leader HTTP exchange: node:http(s).request with the caller's
 * https.Agent (rejectUnauthorized scope), the standard ~30s abort bound, and
 * described transport errors (timeout, DNS/connect, TLS with the self-signed
 * hint). Exported for cribl-auth.mjs's /auth/login call so login and proxy
 * calls fail identically. Response headers are included for the login flow's
 * 429 retry-after handling; the proxy drops them.
 *
 * @param {string} target Absolute URL on the leader.
 * @param {{
 *   method: string,
 *   headers?: Record<string, string>,
 *   body?: unknown,
 *   rawBody?: Buffer,
 *   contentType?: string,
 *   agent: import('node:https').Agent,
 * }} opts
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: unknown }>}
 */
export async function leaderRequest(target, opts) {
  const url = new URL(target);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  /** @type {Record<string, string | number>} */
  const headers = { ...(opts.headers ?? {}) };
  let payload;
  if (opts.rawBody !== undefined) {
    // Pre-serialized bytes (e.g. an octet-stream .crbl upload): send verbatim
    // with the caller's content type, never JSON-encoded.
    payload = opts.rawBody;
    headers['Content-Type'] = opts.contentType ?? 'application/octet-stream';
    headers['Content-Length'] = payload.length;
  } else if (opts.body !== undefined) {
    payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }

  // Same ~30s upper bound as every other upstream call, via AbortSignal
  // (node:http(s).request honors the signal and errors with ABORT_ERR).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_UPSTREAM_TIMEOUT_MS);
  try {
    return await new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method: opts.method,
          headers,
          agent: isHttps ? opts.agent : undefined,
          signal: controller.signal,
        },
        (res) => {
          /** @type {Buffer[]} */
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: parseUpstreamBody(Buffer.concat(chunks).toString('utf8')),
            });
          });
          res.on('error', (err) => reject(describeLeaderError(err, opts.method, target)));
        }
      );
      req.on('error', (err) => {
        if (controller.signal.aborted) {
          reject(
            new Error(
              `Cribl leader request timed out after ${DEFAULT_UPSTREAM_TIMEOUT_MS / 1000}s: ${opts.method} ${target}`
            )
          );
          return;
        }
        reject(describeLeaderError(err, opts.method, target));
      });
      if (payload !== undefined) {
        req.end(payload);
      } else {
        req.end();
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wrap a leader transport error with the request context and, for TLS
 * verification failures, the rejectUnauthorized hint. Uses
 * describeNetworkError so dual-stack AggregateErrors (whose own message is
 * empty) and cause chains still yield the real per-address failure, and
 * checks the whole chain for the self-signed codes. DNS/connect failures
 * (ENOTFOUND, ECONNREFUSED) get the leader-address hint.
 *
 * @param {NodeJS.ErrnoException} err
 * @param {string} method
 * @param {string} target
 */
function describeLeaderError(err, method, target) {
  let message = `Cribl leader request failed: ${method} ${target} - ${describeNetworkError(err)}`;
  if (hasSelfSignedCode(err)) {
    message +=
      `\nThe leader presented a certificate this host does not trust. For self-signed on-prem leaders, ` +
      `set "cribl.rejectUnauthorized": false in ${CONFIG_PATH} (leader calls only) and restart.`;
  } else if (hasCode(err, 'ENOTFOUND') || hasCode(err, 'ECONNREFUSED')) {
    message += `\nThe leader is unreachable - check cribl.leaderUrl (address and port) in ${CONFIG_PATH}.`;
  }
  return new Error(message);
}

/**
 * True when `err` (or any error in its cause/errors chain) carries one of
 * the TLS verification failure codes.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function hasSelfSignedCode(err) {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = /** @type {NodeJS.ErrnoException} */ (err).code;
  if (typeof code === 'string' && SELF_SIGNED_CODES.has(code)) {
    return true;
  }
  if (Array.isArray(/** @type {{ errors?: unknown[] }} */ (err).errors)) {
    for (const sub of /** @type {{ errors: unknown[] }} */ (err).errors) {
      if (hasSelfSignedCode(sub)) {
        return true;
      }
    }
  }
  return hasSelfSignedCode(err.cause);
}

/**
 * True when `err` (or any error in its cause/errors chain) carries the given
 * errno code.
 *
 * @param {unknown} err
 * @param {string} wanted
 * @returns {boolean}
 */
function hasCode(err, wanted) {
  if (!(err instanceof Error)) {
    return false;
  }
  if (/** @type {NodeJS.ErrnoException} */ (err).code === wanted) {
    return true;
  }
  if (Array.isArray(/** @type {{ errors?: unknown[] }} */ (err).errors)) {
    for (const sub of /** @type {{ errors: unknown[] }} */ (err).errors) {
      if (hasCode(sub, wanted)) {
        return true;
      }
    }
  }
  return hasCode(err.cause, wanted);
}
