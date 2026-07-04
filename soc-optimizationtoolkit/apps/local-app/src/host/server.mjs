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
//   PUT    /api/secrets/{key}       store value ({ value, encrypted })
//   GET    /api/secrets/{key}       { value } - null when encrypted/missing
//   DELETE /api/secrets/{key}       idempotent remove
//   POST   /api/secrets-list        { prefix } -> { keys }
//   POST   /api/jobs                { kind, input } -> created record
//   GET    /api/jobs?kind=          newest-first list
//   GET    /api/jobs/{id}           record or 404
//   PATCH  /api/jobs/{id}           merge patch -> merged record or 404
//   GET    /api/user                { id, username } from the OS account
//   *                               static UI from dist/web (SPA fallback)
//
// Response conventions: proxy endpoints answer HTTP 200 with the upstream
// result as {status, body} (upstream 4xx/5xx are DATA here, mirroring the
// core port contract); route-level failures answer 4xx/5xx with {error};
// upstream transport failures (timeout, DNS, TLS) answer 502 with {error}.

import http from 'node:http';
import os from 'node:os';
import { DATA_DIR, WEB_ROOT } from './config.mjs';
import { createAzureProxy } from './azure.mjs';
import { createCriblAuth } from './cribl-auth.mjs';
import { createCriblProxy } from './cribl.mjs';
import { createSecretsStore } from './secrets.mjs';
import { createJobStore } from './jobs.mjs';
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
  const azure = createAzureProxy(config.azure);
  const criblAuth = createCriblAuth(config.cribl);
  const cribl = createCriblProxy(config.cribl, criblAuth);
  const secrets = createSecretsStore(DATA_DIR);
  const jobs = createJobStore(DATA_DIR);
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

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof HttpError)) {
        console.error(`[host] ${req.method} ${req.url} failed:`, err);
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, status, { error: message });
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
