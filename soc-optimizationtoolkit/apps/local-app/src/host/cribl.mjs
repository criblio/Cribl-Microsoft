// Cribl leader proxy for the local host: the server-side twin of the cloud
// shell's PlatformCriblClient adapter (apps/cribl-app/src/platform/
// adapters.ts). Same contract: request() resolves {status, body} for every
// HTTP response and rejects only on transport failure; listGroups() maps
// /master/groups with the same tolerant shape-handling.
//
// Where the cloud shell rides the platform's authenticated fetch to the
// hosting workspace's own API, this host talks to the CONFIGURED leader
// (on-prem or Cribl.Cloud) and attaches a static bearer token from
// config/local-config.json. Leader calls use node:http(s).request instead of
// global fetch for exactly one reason: honoring cribl.rejectUnauthorized via
// an https.Agent scoped to THESE calls only (self-signed on-prem leaders) -
// Azure calls always verify TLS.

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
 * Build the leader proxy over the config's leader URL and static token.
 *
 * @param {import('./config.mjs').CriblSection} cribl
 * @returns {{
 *   request(opts: CriblProxyRequest): Promise<{ status: number, body: unknown }>,
 *   listGroups(): Promise<Array<{ id: string, product?: string }>>,
 * }}
 */
export function createCriblProxy(cribl) {
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
    if (cribl.authToken === '') {
      throw new HttpError(500, `cribl.authToken is empty in ${CONFIG_PATH} - set a bearer token and restart the host`);
    }
    const groupPrefix =
      typeof opts.groupId === 'string' && opts.groupId !== '' ? `/m/${encodeURIComponent(opts.groupId)}` : '';
    let target = `${cribl.leaderUrl}/api/v1${groupPrefix}${opts.path}`;
    if (opts.query !== undefined && Object.keys(opts.query).length > 0) {
      target += `?${new URLSearchParams(opts.query).toString()}`;
    }
    const url = new URL(target);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    /** @type {Record<string, string | number>} */
    const headers = { Authorization: `Bearer ${cribl.authToken}` };
    let payload;
    if (opts.body !== undefined) {
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
            agent: isHttps ? httpsAgent : undefined,
            signal: controller.signal,
          },
          (res) => {
            /** @type {Buffer[]} */
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              resolve({
                status: res.statusCode ?? 0,
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
   * List Worker Groups / Edge Fleets - same contract and tolerance as the
   * cloud adapter: expects CountedConfigGroup {count, items} per the vendored
   * OpenAPI spec, requires only a non-empty string id per entry, and maps
   * `product` only when it is a non-empty string. Throws (surfaced as 502 by
   * the route) on non-2xx or an unexpected shape.
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
      const product = prop(item, 'product');
      groups.push(typeof product === 'string' && product !== '' ? { id, product } : { id });
    }
    return groups;
  }

  return { request, listGroups };
}

/**
 * Wrap a leader transport error with the request context and, for TLS
 * verification failures, the rejectUnauthorized hint. Uses
 * describeNetworkError so dual-stack AggregateErrors (whose own message is
 * empty) and cause chains still yield the real per-address failure, and
 * checks the whole chain for the self-signed codes.
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
