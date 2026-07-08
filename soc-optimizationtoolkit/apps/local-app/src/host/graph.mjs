// Microsoft Graph proxy for the local host: the server-side twin of the cloud
// shell's PlatformGraphDirectory adapter (apps/cribl-app/src/platform/
// adapters.ts). It enumerates the tenant's service principals for the
// ingestion-identity picker (role-assignment step, B3).
//
// Like azure.mjs it owns the whole client_credentials token flow from
// config/local-config.json and keeps the token in process memory - but with the
// GRAPH audience (https://graph.microsoft.com/.default), which the ARM token
// cannot serve. The client secret never leaves this process. Reading the
// directory requires the app registration to have Application.Read.All (or
// Directory.Read.All) consented; without it Graph answers 403 and this proxy
// throws so the picker degrades to manual object-id entry.

import { HttpError, fetchTextWithTimeout, parseUpstreamBody } from './http-util.mjs';
import { CONFIG_PATH } from './config.mjs';

const GRAPH_BASE_URL = 'https://graph.microsoft.com';
const GRAPH_SP_PATH = '/v1.0/servicePrincipals?$select=id,appId,displayName&$top=100';
// Bound on @odata.nextLink pages the enumeration will follow.
const GRAPH_MAX_PAGES = 20;
// Refresh the cached token when it is within 5 minutes of expiry.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Fallback lifetime when the token endpoint omits expires_in.
const DEFAULT_TOKEN_LIFETIME_S = 3600;

/**
 * Build the Graph proxy over the config's client-credentials identity.
 *
 * @param {import('./config.mjs').AzureSection} azure
 * @param {ReturnType<import('./logger.mjs').createFileLogger>} [logger]
 * @returns {{ listServicePrincipals(): Promise<Array<{id: string, appId: string, displayName: string}>> }}
 */
export function createGraphProxy(azure, logger) {
  /** @type {{ accessToken: string, expiresAt: number } | null} */
  let cached = null;

  function requireField(name, value) {
    if (value === '') {
      throw new HttpError(500, `azure.${name} is empty in ${CONFIG_PATH} - set it and restart the host`);
    }
    return value;
  }

  /** Acquire a fresh GRAPH-audience token via the client_credentials flow. */
  async function acquireToken() {
    const tenantId = requireField('tenantId', azure.tenantId);
    const clientId = requireField('clientId', azure.clientId);
    const clientSecret = requireField('clientSecret', azure.clientSecret);
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
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
        `Graph token endpoint returned HTTP ${res.status} - check azure.tenantId/clientId/clientSecret in ${CONFIG_PATH}\n${text}`
      );
    }
    let token;
    try {
      token = JSON.parse(text);
    } catch {
      // Never echo a 2xx token body (same guard as azure.mjs/cribl-auth.mjs).
      throw new Error(`Graph token endpoint returned HTTP ${res.status} but the body is not JSON`);
    }
    if (typeof token.access_token !== 'string' || token.access_token === '') {
      throw new Error(`Graph token endpoint returned HTTP ${res.status} but no access_token field in the response`);
    }
    const lifetimeS = typeof token.expires_in === 'number' ? token.expires_in : DEFAULT_TOKEN_LIFETIME_S;
    cached = { accessToken: token.access_token, expiresAt: Date.now() + lifetimeS * 1000 };
    logger?.info('graph token acquired', { expiresInS: lifetimeS });
    return cached.accessToken;
  }

  async function ensureToken(force) {
    if (!force && cached !== null && Date.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return cached.accessToken;
    }
    try {
      return await acquireToken();
    } catch (err) {
      logger?.error('graph token acquisition failed', {
        forced: force,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** @param {string} url @param {string} accessToken */
  async function fetchPage(url, accessToken) {
    const res = await fetchTextWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { status: res.status, body: parseUpstreamBody(res.text) };
  }

  /** Map one Graph servicePrincipals `value[]` body into picker refs. */
  function mapPage(body) {
    const value = body !== null && typeof body === 'object' ? body.value : undefined;
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue;
      const id = entry.id;
      if (typeof id !== 'string' || id === '') continue;
      out.push({
        id,
        appId: typeof entry.appId === 'string' ? entry.appId : '',
        displayName: typeof entry.displayName === 'string' ? entry.displayName : id,
      });
    }
    return out;
  }

  return {
    async listServicePrincipals() {
      let token = await ensureToken(false);
      let res = await fetchPage(`${GRAPH_BASE_URL}${GRAPH_SP_PATH}`, token);
      if (res.status === 401) {
        // Cached token rejected (expired/revoked): re-acquire ONCE and retry.
        logger?.warn('graph request got 401 - re-acquiring token and retrying once', {});
        token = await ensureToken(true);
        res = await fetchPage(`${GRAPH_BASE_URL}${GRAPH_SP_PATH}`, token);
      }
      if (res.status !== 200) {
        const hint =
          res.status === 403
            ? ' - the app registration needs Application.Read.All (or Directory.Read.All) consented to read the directory'
            : '';
        throw new HttpError(res.status === 403 ? 403 : 502, `Graph servicePrincipals: HTTP ${res.status}${hint}`);
      }
      const out = [];
      let body = res.body;
      for (let pages = 0; ; pages += 1) {
        out.push(...mapPage(body));
        const next = body !== null && typeof body === 'object' ? body['@odata.nextLink'] : undefined;
        if (typeof next !== 'string' || next === '' || pages >= GRAPH_MAX_PAGES) break;
        const page = await fetchPage(next, token);
        if (page.status !== 200) break;
        body = page.body;
      }
      return out;
    },
  };
}
