// Azure Resource Manager proxy for the local host: the server-side twin of
// the cloud shell's PlatformAzureManagement adapter (apps/cribl-app/src/
// platform/adapters.ts). Same contract: {status, body} for every HTTP
// response including 4xx/5xx; throws only on transport/token failure; on an
// upstream 401 it refreshes the token ONCE and retries ONCE, returning the
// retry's response as-is.
//
// Where the cloud shell stores the token in the write-only KV slot for
// proxies.yml header injection, this host keeps the token in process memory
// and attaches the Authorization header itself. The client secret comes ONLY
// from config/local-config.json; it never leaves this process.

import { HttpError, fetchTextWithTimeout, parseUpstreamBody } from './http-util.mjs';
import { CONFIG_PATH } from './config.mjs';

const ARM_BASE_URL = 'https://management.azure.com';
// The ONLY URL prefix the full-URL proxy (requestUrl) will touch. ARM list
// pagination hands back absolute nextLink URLs; anything outside this prefix
// is rejected BEFORE any request is sent (SSRF guard - the browser must not
// be able to steer the host, bearer token attached, at arbitrary hosts).
const ARM_URL_PREFIX = 'https://management.azure.com/';
// Refresh the cached token when it is within 5 minutes of expiry.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Fallback lifetime when the token endpoint omits expires_in.
const DEFAULT_TOKEN_LIFETIME_S = 3600;

/**
 * @typedef {object} AzureProxyRequest
 * @property {string} method
 * @property {string} path ARM path, e.g. "/subscriptions/{id}/...".
 * @property {string} apiVersion Appended as the api-version query parameter.
 * @property {unknown} [body]
 * @property {Record<string, string>} [query]
 */

/**
 * @typedef {object} AzureProxyUrlRequest
 * @property {string} method
 * @property {string} url FULL URL - MUST start with https://management.azure.com/.
 */

/**
 * Build the ARM proxy over the config's client-credentials identity.
 *
 * @param {import('./config.mjs').AzureSection} azure
 * @returns {{
 *   request(opts: AzureProxyRequest): Promise<{ status: number, body: unknown }>,
 *   requestUrl(opts: AzureProxyUrlRequest): Promise<{ status: number, body: unknown }>,
 * }}
 */
export function createAzureProxy(azure) {
  /** @type {{ accessToken: string, expiresAt: number } | null} */
  let cached = null;

  function requireField(name, value) {
    if (value === '') {
      throw new HttpError(500, `azure.${name} is empty in ${CONFIG_PATH} - set it and restart the host`);
    }
    return value;
  }

  /** Acquire a fresh ARM token via the client_credentials flow. */
  async function acquireToken() {
    const tenantId = requireField('tenantId', azure.tenantId);
    const clientId = requireField('clientId', azure.clientId);
    const clientSecret = requireField('clientSecret', azure.clientSecret);
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://management.azure.com/.default',
    });
    const res = await fetchTextWithTimeout(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }
    );
    const text = res.text;
    if (!res.ok) {
      throw new Error(
        `Azure token endpoint returned HTTP ${res.status} - check azure.tenantId/clientId/clientSecret in ${CONFIG_PATH}\n${text}`
      );
    }
    let token;
    try {
      token = JSON.parse(text);
    } catch {
      throw new Error(`Azure token endpoint returned HTTP ${res.status} but the body is not JSON\n${text}`);
    }
    if (typeof token.access_token !== 'string' || token.access_token === '') {
      throw new Error(`Azure token endpoint returned HTTP ${res.status} but no access_token\n${text}`);
    }
    const lifetimeS = typeof token.expires_in === 'number' ? token.expires_in : DEFAULT_TOKEN_LIFETIME_S;
    cached = { accessToken: token.access_token, expiresAt: Date.now() + lifetimeS * 1000 };
    return cached.accessToken;
  }

  /**
   * Return a token, reusing the cache until ~5 minutes before expiry.
   * @param {boolean} force Discard the cache (401 recovery path).
   */
  async function ensureToken(force) {
    if (!force && cached !== null && Date.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return cached.accessToken;
    }
    return acquireToken();
  }

  /**
   * @param {AzureProxyRequest} opts
   * @param {string} accessToken
   */
  async function send(opts, accessToken) {
    const params = new URLSearchParams({ ...(opts.query ?? {}), 'api-version': opts.apiVersion });
    /** @type {RequestInit} */
    const init = {
      method: opts.method,
      headers: { Authorization: `Bearer ${accessToken}` },
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetchTextWithTimeout(`${ARM_BASE_URL}${opts.path}?${params.toString()}`, init);
    return { status: res.status, body: parseUpstreamBody(res.text) };
  }

  /**
   * Send a request against a FULL, already-validated ARM URL. No body: the
   * only caller shape is ARM nextLink pagination (the URL carries its whole
   * query string, continuation token included).
   *
   * @param {AzureProxyUrlRequest} opts
   * @param {string} accessToken
   */
  async function sendUrl(opts, accessToken) {
    /** @type {RequestInit} */
    const init = {
      method: opts.method,
      headers: { Authorization: `Bearer ${accessToken}` },
    };
    const res = await fetchTextWithTimeout(opts.url, init);
    return { status: res.status, body: parseUpstreamBody(res.text) };
  }

  return {
    async request(opts) {
      if (typeof opts.apiVersion !== 'string' || opts.apiVersion === '') {
        throw new HttpError(400, 'POST /api/azure/request: "apiVersion" must be a non-empty string');
      }
      const token = await ensureToken(false);
      const first = await send(opts, token);
      if (first.status !== 401) {
        return first;
      }
      // 401: the cached token was rejected (expired or revoked). Re-acquire
      // ONCE and retry ONCE; whatever comes back is the answer.
      const fresh = await ensureToken(true);
      return send(opts, fresh);
    },

    async requestUrl(opts) {
      // SSRF guard, enforced HERE regardless of what the route validated:
      // the bearer token is attached below, so any URL outside the ARM
      // prefix is a HARD reject before a single byte leaves the host.
      if (typeof opts.url !== 'string' || !opts.url.startsWith(ARM_URL_PREFIX)) {
        throw new HttpError(
          400,
          `POST /api/azure/request-url: "url" must start with ${ARM_URL_PREFIX} ` +
            '(ARM nextLink pagination) - refusing to proxy any other host',
        );
      }
      const token = await ensureToken(false);
      const first = await sendUrl(opts, token);
      if (first.status !== 401) {
        return first;
      }
      const fresh = await ensureToken(true);
      return sendUrl(opts, fresh);
    },
  };
}
