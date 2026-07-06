// HTTP server and API router for the local host. Binds 127.0.0.1 ONLY
// (single-operator localhost tool; there is deliberately NO API auth - the
// boundary is the loopback interface). The browser-facing API mirrors the
// port surface the cloud shell gets from the Cribl App Platform, so the
// shared UI binds a thin fetch-based adapter set against these routes:
//
//   GET    /api/config              non-secret Azure config + leader URL
//   POST   /api/azure/request       ARM proxy (host owns the token flow)
//   POST   /api/azure/request-url   ARM full-URL proxy for nextLink pagination
//                                   (HARD https://management.azure.com/ prefix
//                                   check - SSRF guard - before any request)
//   POST   /api/cribl/request       leader proxy (host attaches the token)
//   GET    /api/cribl/groups        convenience /master/groups mapping
//   POST   /api/cribl/upload        pack .crbl octet-stream PUT to the leader
//                                   ({ groupId, fileName, crblBase64 } ->
//                                   { status, body }; step 1 of pack install)
//   GET    /api/packs               pack build records (StoredPack[])
//   POST   /api/packs               upsert one StoredPack { record, definition }
//   GET    /api/packs/{id}          { pack } - StoredPack or null
//   DELETE /api/packs/{id}          idempotent remove by build record id
//   PUT    /api/secrets/{key}       store value ({ value, encrypted })
//   GET    /api/secrets/{key}       { value } - null when encrypted/missing
//   DELETE /api/secrets/{key}       idempotent remove
//   POST   /api/secrets-list        { prefix } -> { keys }
//   POST   /api/jobs                { kind, input } -> created record
//   GET    /api/jobs?kind=          newest-first list
//   GET    /api/jobs/{id}           record or 404
//   PATCH  /api/jobs/{id}           merge patch -> merged record or 404
//   GET    /api/tagged-samples      first-upsert-order list
//   POST   /api/tagged-samples      { logType, format, rawEvents, parsed } upsert
//   GET    /api/tagged-samples/{lt} { sample } - sample or null
//   DELETE /api/tagged-samples/{lt} idempotent remove
//   POST   /api/github/request      { url } -> { status, body } GitHub GET proxy
//                                   (api.github.com + raw.githubusercontent.com
//                                   host allowlist; PAT attached server-side)
//   GET    /api/github/pat          { hasPat, login } - never the token
//   PUT    /api/github/pat          { pat } validate-then-store -> PatManagerStatus
//   DELETE /api/github/pat          idempotent clear
//   GET    /api/content-cache/{key} { value } - parsed content, null on miss
//   PUT    /api/content-cache/{key} { value } store parsed content
//   POST   /api/logs                { entries } batch from the browser logger
//                                   (sanitized server-side, appended to
//                                   data/logs/app.log with rotation)
//   GET    /api/logs?tail=500       { lines } - the recent log tail
//   GET    /api/user                { id, username } from the OS account
//   *                               static UI from dist/web (SPA fallback)
//
// Response conventions: proxy endpoints answer HTTP 200 with the upstream
// result as {status, body} (upstream 4xx/5xx are DATA here, mirroring the
// core port contract); route-level failures answer 4xx/5xx with {error};
// upstream transport failures (timeout, DNS, TLS) answer 502 with {error}.

import http from 'node:http';
import os from 'node:os';
import { Buffer } from 'node:buffer';
import { DATA_DIR, WEB_ROOT } from './config.mjs';
import { createAzureProxy } from './azure.mjs';
import { createCriblAuth } from './cribl-auth.mjs';
import { createCriblProxy } from './cribl.mjs';
import { createSecretsStore } from './secrets.mjs';
import { createJobStore } from './jobs.mjs';
import { createPackStore } from './packs.mjs';
import { createTaggedSampleStore } from './tagged-samples.mjs';
import { createGithubProxy } from './github.mjs';
import { createContentCache } from './content-cache.mjs';
import {
  LOG_TAIL_DEFAULT,
  LOG_TAIL_MAX,
  createFileLogger,
  sanitizeLogEntries,
} from './logger.mjs';
import { createStaticHandler } from './static.mjs';
import {
  ALLOWED_PROXY_METHODS,
  HttpError,
  isPlainObject,
  readJsonBody,
  sendEmpty,
  sendJson,
  validateProxyRequest,
} from './http-util.mjs';

/**
 * Build the host's HTTP server (not yet listening).
 *
 * @param {import('./config.mjs').LocalConfig} config
 * @returns {import('node:http').Server}
 */
export function createHostServer(config) {
  // The one file logger (data/logs/app.log, rotated): browser batches and
  // the host's own events (API requests, token refreshes, upstream
  // failures) all land in the same greppable file. No secret or token value
  // ever reaches a log call - context is primitives only.
  const log = createFileLogger(DATA_DIR);
  const azure = createAzureProxy(config.azure, log);
  const criblAuth = createCriblAuth(config.cribl, log);
  const cribl = createCriblProxy(config.cribl, criblAuth);
  const secrets = createSecretsStore(DATA_DIR);
  const jobs = createJobStore(DATA_DIR);
  const packs = createPackStore(DATA_DIR);
  const taggedSamples = createTaggedSampleStore(DATA_DIR);
  const github = createGithubProxy(DATA_DIR, log);
  const contentCache = createContentCache(DATA_DIR);
  const serveStatic = createStaticHandler(WEB_ROOT);

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(req, res, method, pathname, url);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    await serveStatic(req, res, pathname);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} method
   * @param {string} pathname
   * @param {URL} url
   */
  async function handleApi(req, res, method, pathname, url) {
    // --- config -----------------------------------------------------------
    if (pathname === '/api/config' && method === 'GET') {
      // AzureConfig-shaped (see @soc/core azure-config): ONLY non-secret
      // fields. The clientSecret and Cribl credentials NEVER leave the host.
      sendJson(res, 200, {
        clientId: config.azure.clientId,
        tenantId: config.azure.tenantId,
        subscriptionId: config.azure.subscriptionId,
        resourceGroup: config.azure.resourceGroup,
        workspaceName: config.azure.workspaceName,
        setupPath: 'existing',
        criblLeaderUrl: config.cribl.leaderUrl,
      });
      return;
    }

    // --- Azure ARM proxy --------------------------------------------------
    if (pathname === '/api/azure/request' && method === 'POST') {
      const payload = await readJsonBody(req);
      const base = validateProxyRequest(payload, 'POST /api/azure/request');
      const apiVersion = isPlainObject(payload) ? payload.apiVersion : undefined;
      if (typeof apiVersion !== 'string' || apiVersion === '') {
        throw new HttpError(400, 'POST /api/azure/request: "apiVersion" must be a non-empty string');
      }
      const result = await upstream(() =>
        azure.request({ method: base.method, path: base.path, apiVersion, body: base.body, query: base.query })
      );
      sendJson(res, 200, result);
      return;
    }

    // --- Azure ARM full-URL proxy (nextLink pagination) ---------------------
    if (pathname === '/api/azure/request-url' && method === 'POST') {
      const payload = await readJsonBody(req);
      if (!isPlainObject(payload)) {
        throw new HttpError(400, 'POST /api/azure/request-url: body must be { method, url }');
      }
      const urlMethod = payload.method;
      if (typeof urlMethod !== 'string' || !ALLOWED_PROXY_METHODS.includes(urlMethod.toUpperCase())) {
        throw new HttpError(
          400,
          `POST /api/azure/request-url: "method" must be one of ${ALLOWED_PROXY_METHODS.join(', ')}`
        );
      }
      // SSRF guard at the route boundary; azure.mjs re-checks before
      // attaching the bearer, so the prefix is enforced twice on purpose.
      const targetUrl = payload.url;
      if (typeof targetUrl !== 'string' || !targetUrl.startsWith('https://management.azure.com/')) {
        throw new HttpError(
          400,
          'POST /api/azure/request-url: "url" must start with https://management.azure.com/ ' +
            '(ARM nextLink pagination) - this host refuses to proxy any other destination'
        );
      }
      const result = await upstream(() =>
        azure.requestUrl({ method: urlMethod.toUpperCase(), url: targetUrl })
      );
      sendJson(res, 200, result);
      return;
    }

    // --- Cribl leader proxy -------------------------------------------------
    if (pathname === '/api/cribl/request' && method === 'POST') {
      const payload = await readJsonBody(req);
      const base = validateProxyRequest(payload, 'POST /api/cribl/request');
      const groupId = isPlainObject(payload) ? payload.groupId : undefined;
      if (groupId !== undefined && typeof groupId !== 'string') {
        throw new HttpError(400, 'POST /api/cribl/request: "groupId" must be a string when present');
      }
      const result = await upstream(() =>
        cribl.request({ method: base.method, path: base.path, groupId, body: base.body, query: base.query })
      );
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/api/cribl/groups' && method === 'GET') {
      const groups = await upstream(() => cribl.listGroups());
      sendJson(res, 200, groups);
      return;
    }

    // Two-step pack upload, step 1: proxy the raw .crbl bytes (base64 in the
    // JSON body) as an octet-stream PUT to the leader. The install decision
    // logic (two-step, conflict retry) lives in the browser adapter over
    // @soc/core; the host only owns the binary transport + the token. Steps 2/3
    // (POST install, DELETE on conflict) ride the existing /api/cribl/request.
    if (pathname === '/api/cribl/upload' && method === 'POST') {
      const payload = await readJsonBody(req);
      if (!isPlainObject(payload) || typeof payload.fileName !== 'string' || payload.fileName === '') {
        throw new HttpError(400, 'POST /api/cribl/upload: body must be { groupId, fileName, crblBase64 }');
      }
      const groupId = payload.groupId;
      if (typeof groupId !== 'string' || groupId === '') {
        throw new HttpError(400, 'POST /api/cribl/upload: "groupId" must be a non-empty string');
      }
      if (typeof payload.crblBase64 !== 'string' || payload.crblBase64 === '') {
        throw new HttpError(400, 'POST /api/cribl/upload: "crblBase64" must be a non-empty base64 string');
      }
      let bytes;
      try {
        bytes = Buffer.from(payload.crblBase64, 'base64');
      } catch {
        throw new HttpError(400, 'POST /api/cribl/upload: "crblBase64" is not valid base64');
      }
      const result = await upstream(() => cribl.uploadPack(groupId, payload.fileName, bytes));
      sendJson(res, 200, result);
      return;
    }

    // --- secrets ------------------------------------------------------------
    if (pathname.startsWith('/api/secrets/')) {
      const key = decodeKey(pathname.slice('/api/secrets/'.length));
      if (method === 'PUT') {
        const payload = await readJsonBody(req);
        if (!isPlainObject(payload) || typeof payload.value !== 'string') {
          throw new HttpError(400, `PUT /api/secrets/${key}: body must be { value: string, encrypted?: boolean }`);
        }
        if (payload.encrypted !== undefined && typeof payload.encrypted !== 'boolean') {
          throw new HttpError(400, `PUT /api/secrets/${key}: "encrypted" must be a boolean when present`);
        }
        await secrets.set(key, payload.value, payload.encrypted === true);
        sendEmpty(res, 204);
        return;
      }
      if (method === 'GET') {
        // WRITE-ONLY parity with the cloud KV: encrypted-or-missing -> null.
        sendJson(res, 200, { value: await secrets.get(key) });
        return;
      }
      if (method === 'DELETE') {
        await secrets.delete(key);
        sendEmpty(res, 204);
        return;
      }
      res.writeHead(405, { Allow: 'GET, PUT, DELETE' });
      res.end();
      return;
    }

    if (pathname === '/api/secrets-list' && method === 'POST') {
      const payload = await readJsonBody(req);
      if (!isPlainObject(payload) || typeof payload.prefix !== 'string') {
        throw new HttpError(400, 'POST /api/secrets-list: body must be { prefix: string } (use "" for all keys)');
      }
      sendJson(res, 200, { keys: await secrets.list(payload.prefix) });
      return;
    }

    // --- jobs ---------------------------------------------------------------
    if (pathname === '/api/jobs') {
      if (method === 'POST') {
        const payload = await readJsonBody(req);
        if (!isPlainObject(payload) || typeof payload.kind !== 'string' || payload.kind === '') {
          throw new HttpError(400, 'POST /api/jobs: body must be { kind: string, input?: any }');
        }
        const record = await jobs.create(payload.kind, 'input' in payload ? payload.input : null);
        sendJson(res, 201, record);
        return;
      }
      if (method === 'GET') {
        const kind = url.searchParams.get('kind');
        const records = await jobs.list(kind === null || kind === '' ? undefined : kind);
        sendJson(res, 200, records);
        return;
      }
      res.writeHead(405, { Allow: 'GET, POST' });
      res.end();
      return;
    }

    if (pathname.startsWith('/api/jobs/')) {
      const id = decodeKey(pathname.slice('/api/jobs/'.length));
      if (method === 'GET') {
        const record = await jobs.get(id);
        if (record === null) {
          throw new HttpError(404, `no job with id "${id}"`);
        }
        sendJson(res, 200, record);
        return;
      }
      if (method === 'PATCH') {
        const payload = await readJsonBody(req);
        if (!isPlainObject(payload)) {
          throw new HttpError(400, `PATCH /api/jobs/${id}: body must be a JSON object of fields to merge`);
        }
        const merged = await jobs.update(id, payload);
        if (merged === null) {
          throw new HttpError(404, `no job with id "${id}"`);
        }
        sendJson(res, 200, merged);
        return;
      }
      res.writeHead(405, { Allow: 'GET, PATCH' });
      res.end();
      return;
    }

    // --- pack build records (porting-plan Unit 19) --------------------------
    if (pathname === '/api/packs') {
      if (method === 'GET') {
        sendJson(res, 200, await packs.list());
        return;
      }
      if (method === 'POST') {
        const payload = await readJsonBody(req);
        const record = isPlainObject(payload) ? payload.record : undefined;
        if (!isPlainObject(record) || typeof record.id !== 'string' || record.id === '') {
          throw new HttpError(400, 'POST /api/packs: body must be a StoredPack { record: { id, ... }, definition }');
        }
        if (!('definition' in payload)) {
          throw new HttpError(400, 'POST /api/packs: "definition" is required (used to regenerate the .crbl)');
        }
        await packs.put(payload);
        sendEmpty(res, 204);
        return;
      }
      res.writeHead(405, { Allow: 'GET, POST' });
      res.end();
      return;
    }

    if (pathname.startsWith('/api/packs/')) {
      const id = decodeKey(pathname.slice('/api/packs/'.length));
      if (method === 'GET') {
        sendJson(res, 200, { pack: await packs.get(id) });
        return;
      }
      if (method === 'DELETE') {
        await packs.delete(id);
        sendEmpty(res, 204);
        return;
      }
      res.writeHead(405, { Allow: 'GET, DELETE' });
      res.end();
      return;
    }

    // --- tagged samples -----------------------------------------------------
    if (pathname === '/api/tagged-samples') {
      if (method === 'GET') {
        sendJson(res, 200, await taggedSamples.list());
        return;
      }
      if (method === 'POST') {
        const payload = await readJsonBody(req);
        const sample = validateTaggedSample(payload);
        await taggedSamples.upsert(sample);
        sendEmpty(res, 204);
        return;
      }
      res.writeHead(405, { Allow: 'GET, POST' });
      res.end();
      return;
    }

    if (pathname.startsWith('/api/tagged-samples/')) {
      const logType = decodeKey(pathname.slice('/api/tagged-samples/'.length));
      if (method === 'GET') {
        sendJson(res, 200, { sample: await taggedSamples.get(logType) });
        return;
      }
      if (method === 'DELETE') {
        await taggedSamples.remove(logType);
        sendEmpty(res, 204);
        return;
      }
      res.writeHead(405, { Allow: 'GET, DELETE' });
      res.end();
      return;
    }

    // --- GitHub content proxy + PAT (porting-plan Unit 14) ------------------
    if (pathname === '/api/github/request' && method === 'POST') {
      const payload = await readJsonBody(req);
      if (!isPlainObject(payload) || typeof payload.url !== 'string') {
        throw new HttpError(400, 'POST /api/github/request: body must be { url: string }');
      }
      // github.request enforces the host allowlist (SSRF guard) itself; a
      // disallowed host throws HttpError 400 before any request leaves the host.
      const result = await upstream(() => github.request(payload.url));
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/api/github/pat') {
      if (method === 'GET') {
        // WRITE-ONLY parity with the cloud KV: only { hasPat, login } - the
        // token never leaves the host process.
        sendJson(res, 200, await github.status());
        return;
      }
      if (method === 'PUT') {
        const payload = await readJsonBody(req);
        if (!isPlainObject(payload) || typeof payload.pat !== 'string') {
          throw new HttpError(400, 'PUT /api/github/pat: body must be { pat: string }');
        }
        // validate-then-store: transport failures are surfaced as a data-level
        // { hasPat:false, error } here (not a 502), matching the cloud adapter's
        // renderer-facing PatManagerStatus.
        sendJson(res, 200, await github.validateAndStore(payload.pat));
        return;
      }
      if (method === 'DELETE') {
        await github.clear();
        sendEmpty(res, 204);
        return;
      }
      res.writeHead(405, { Allow: 'GET, PUT, DELETE' });
      res.end();
      return;
    }

    // --- parsed-content cache (porting-plan Unit 14) ------------------------
    if (pathname.startsWith('/api/content-cache/')) {
      const key = decodeKey(pathname.slice('/api/content-cache/'.length));
      if (method === 'GET') {
        sendJson(res, 200, { value: await contentCache.get(key) });
        return;
      }
      if (method === 'PUT') {
        const payload = await readJsonBody(req);
        if (!isPlainObject(payload) || !('value' in payload)) {
          throw new HttpError(400, `PUT /api/content-cache/${key}: body must be { value: ... }`);
        }
        await contentCache.set(key, payload.value);
        sendEmpty(res, 204);
        return;
      }
      res.writeHead(405, { Allow: 'GET, PUT' });
      res.end();
      return;
    }

    // --- logs ---------------------------------------------------------------
    if (pathname === '/api/logs') {
      if (method === 'POST') {
        const payload = await readJsonBody(req);
        // Server-side sanitation is the hard rule's enforcement point on
        // this boundary: only primitive context values survive, sizes are
        // capped, and anything else is dropped before touching disk.
        const entries = sanitizeLogEntries(payload, () => new Date().toISOString());
        if (entries === null) {
          throw new HttpError(400, 'POST /api/logs: body must be { entries: [...] }');
        }
        for (const entry of entries) {
          log.append(entry);
        }
        sendEmpty(res, 204);
        return;
      }
      if (method === 'GET') {
        const rawTail = url.searchParams.get('tail');
        let maxLines = LOG_TAIL_DEFAULT;
        if (rawTail !== null) {
          const parsed = Number(rawTail);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new HttpError(400, 'GET /api/logs: "tail" must be a positive integer');
          }
          maxLines = Math.min(parsed, LOG_TAIL_MAX);
        }
        sendJson(res, 200, { lines: await log.tail(maxLines) });
        return;
      }
      res.writeHead(405, { Allow: 'GET, POST' });
      res.end();
      return;
    }

    // --- user ---------------------------------------------------------------
    if (pathname === '/api/user' && method === 'GET') {
      const info = os.userInfo();
      // uid is -1 on Windows; the account name is the stable local id there.
      const id = info.uid >= 0 ? String(info.uid) : info.username;
      sendJson(res, 200, { id, username: info.username });
      return;
    }

    throw new HttpError(404, `no API route ${method} ${pathname}`);
  }

  /**
   * Log one finished API exchange through the file logger. Static requests
   * and /api/logs itself are skipped (logging the log traffic would feed
   * back into the file it reports on). Paths may carry key/id NAMES, never
   * values; request bodies are deliberately not logged.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {number} started
   * @param {string | undefined} errorText
   */
  function logApiExchange(req, res, started, errorText) {
    const pathOnly = (req.url ?? '/').split('?')[0];
    if (!pathOnly.startsWith('/api') || pathOnly === '/api/logs') {
      return;
    }
    const status = res.statusCode;
    /** @type {Record<string, string | number | boolean | null>} */
    const context = {
      method: req.method ?? '',
      path: pathOnly,
      status,
      ms: Date.now() - started,
    };
    if (errorText !== undefined) {
      context.error = errorText;
    }
    if (status >= 500) {
      log.error('api request failed', context);
    } else if (status >= 400) {
      log.warn('api request rejected', context);
    } else {
      log.info('api request', context);
    }
  }

  return http.createServer((req, res) => {
    const started = Date.now();
    handle(req, res)
      .then(() => {
        logApiExchange(req, res, started, undefined);
      })
      .catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : String(err);
        if (!(err instanceof HttpError)) {
          console.error(`[host] ${req.method} ${req.url} failed:`, err);
        }
        if (res.headersSent) {
          res.end();
        } else {
          sendJson(res, status, { error: message });
        }
        logApiExchange(req, res, started, message);
      });
  });
}

/**
 * Run an upstream (Azure/leader) call, converting transport-level rejections
 * into 502s with the original actionable message. HttpErrors (config
 * problems, bad request fields) pass through with their own status.
 *
 * @template T
 * @param {() => Promise<T>} call
 * @returns {Promise<T>}
 */
async function upstream(call) {
  try {
    return await call();
  } catch (err) {
    if (err instanceof HttpError) {
      throw err;
    }
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Validate a POST /api/tagged-samples body as a TaggedSample (@soc/core shape):
 * a non-empty logType, a format string, a rawEvents array, and a parsed object.
 * Returns the sample (any extra fields ride along) or throws HttpError 400.
 *
 * @param {unknown} payload
 * @returns {{ logType: string, format: string, rawEvents: unknown[], parsed: object }}
 */
function validateTaggedSample(payload) {
  if (!isPlainObject(payload)) {
    throw new HttpError(400, 'POST /api/tagged-samples: body must be a TaggedSample object');
  }
  if (typeof payload.logType !== 'string' || payload.logType === '') {
    throw new HttpError(400, 'POST /api/tagged-samples: "logType" must be a non-empty string');
  }
  if (typeof payload.format !== 'string') {
    throw new HttpError(400, 'POST /api/tagged-samples: "format" must be a string');
  }
  if (!Array.isArray(payload.rawEvents)) {
    throw new HttpError(400, 'POST /api/tagged-samples: "rawEvents" must be an array');
  }
  if (!isPlainObject(payload.parsed)) {
    throw new HttpError(400, 'POST /api/tagged-samples: "parsed" must be an object');
  }
  return payload;
}

/**
 * Decode a key/id captured from the URL path. Slashes are preserved so keys
 * like "connections/lab" address nested names.
 *
 * @param {string} rawKey
 * @returns {string}
 */
function decodeKey(rawKey) {
  let key;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    throw new HttpError(400, 'malformed percent-encoding in key');
  }
  if (key === '' || key.includes('\0')) {
    throw new HttpError(400, 'key must be a non-empty string');
  }
  return key;
}
