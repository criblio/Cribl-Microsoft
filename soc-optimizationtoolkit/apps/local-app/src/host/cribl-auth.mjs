// Cribl leader auth manager for the local host: turns the credentials in
// config/local-config.json into the bearer token every leader call carries,
// so operators supply credentials once instead of hand-minting tokens.
// Mirrors azure.mjs conventions: an in-memory cache refreshed ~5 minutes
// before expiry, actionable errors naming the exact config field and file,
// and bounded (~30s abort) upstream calls.
//
// Three auth types (config cribl.auth.type):
//   'cloud'  - Cribl.Cloud OAuth client credentials (created in the
//              Cribl.Cloud UI under Organization > API Credentials). Minted
//              at the FIXED endpoint https://login.cribl.cloud/oauth/token
//              with a JSON body (Auth0 accepts JSON; proven working) and the
//              mandatory audience "https://api.cribl.cloud". expires_in is
//              honored (86400s in practice). token_type is assumed Bearer.
//   'onprem' - leader-local username/password against
//              {leaderUrl}/api/v1/auth/login (unavailable on Cribl.Cloud).
//              The response is {token, forcePasswordChange} with NO
//              expires_in, so the lifetime is ASSUMED 3600s; leaders
//              configured with a shorter auth timeout are covered by the
//              proxy's 401-triggered re-login (getLeaderToken(true)).
//   'token'  - static passthrough of a hand-minted bearer. The host cannot
//              refresh it; the proxy surfaces leader 401s as data with a
//              logged expiry hint instead of retrying.
//
// SECURITY POSTURE: clientSecret/password/token come ONLY from the config
// file and never appear in any HTTP response or log line. Error messages
// echo upstream FAILURE bodies (which carry no tokens) truncated to 200
// chars, and never echo 2xx token-response bodies.
//
// The cache is per-manager (one manager per process, built from one config),
// so the legacy app's cross-profile stale-token bug cannot occur here - a
// config change requires a host restart, which drops the cache.

import https from 'node:https';
import { HttpError, fetchTextWithTimeout, isPlainObject } from './http-util.mjs';
import { CONFIG_PATH } from './config.mjs';
import { leaderRequest } from './cribl.mjs';

/** Fixed Cribl.Cloud token endpoint (Auth0); NOT the workspace leader. */
const CLOUD_TOKEN_URL = 'https://login.cribl.cloud/oauth/token';

/** Mandatory, constant audience for the Cribl.Cloud client-credentials flow. */
const CLOUD_TOKEN_AUDIENCE = 'https://api.cribl.cloud';

// Refresh the cached token when it is within 5 minutes of expiry (same
// margin as azure.mjs; Cribl.Cloud tokens run 24h, on-prem ~1h assumed).
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Fallback lifetime when the cloud token endpoint omits expires_in. */
const DEFAULT_CLOUD_LIFETIME_S = 3600;

// /auth/login returns no expires_in; assume the leader default auth.timeout
// of 3600s. Shorter real lifetimes surface as leader 401s, which the proxy
// recovers from via one forced re-login.
const ONPREM_ASSUMED_LIFETIME_S = 3600;

/**
 * @typedef {object} CriblAuthManager
 * @property {'cloud' | 'onprem' | 'token'} type Auth type from the config;
 *   'token' means the proxy must NOT attempt a 401-triggered refresh.
 * @property {(force?: boolean) => Promise<string>} getLeaderToken Resolve the
 *   bearer for leader calls. `force` discards the cache (401 recovery path);
 *   ignored for type 'token', which always returns the static token.
 */

/**
 * Build the leader auth manager for the configured auth type.
 *
 * @param {import('./config.mjs').CriblSection} cribl
 * @returns {CriblAuthManager}
 */
export function createCriblAuth(cribl) {
  const auth = cribl.auth;
  /** @type {{ token: string, expiresAt: number } | null} */
  let cached = null;

  // The on-prem login targets the leader itself, so it honors
  // cribl.rejectUnauthorized exactly like every other leader call. The cloud
  // mint goes to login.cribl.cloud (public CA) and ALWAYS verifies TLS.
  const loginAgent = new https.Agent({ rejectUnauthorized: cribl.rejectUnauthorized });

  /**
   * @param {string} name Field name under cribl.auth.
   * @param {string} value
   * @param {string} [hint] Extra guidance appended to the error.
   */
  function requireField(name, value, hint) {
    if (value === '') {
      throw new HttpError(
        500,
        `cribl.auth.${name} is empty in ${CONFIG_PATH} - set it and restart the host${hint === undefined ? '' : ` (${hint})`}`
      );
    }
    return value;
  }

  /** Mint a bearer via the Cribl.Cloud client-credentials flow. */
  async function mintCloudToken() {
    const clientId = requireField(
      'clientId',
      auth.clientId,
      'create org API credentials in the Cribl.Cloud UI under Organization > API Credentials'
    );
    const clientSecret = requireField('clientSecret', auth.clientSecret);
    const res = await fetchTextWithTimeout(CLOUD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        audience: CLOUD_TOKEN_AUDIENCE,
      }),
    });
    if (!res.ok) {
      // Auth0 returns the SAME 401 access_denied for a bad id and a bad
      // secret, so the hint names both fields.
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Cribl.Cloud rejected the credentials (HTTP ${res.status}): invalid client id or secret. ` +
            `Check cribl.auth.clientId and cribl.auth.clientSecret in ${CONFIG_PATH} ` +
            `(create credentials in the Cribl.Cloud UI under Organization > API Credentials).\n${res.text.slice(0, 200)}`
        );
      }
      throw new Error(
        `Cribl.Cloud token endpoint ${CLOUD_TOKEN_URL} returned HTTP ${res.status} - ` +
          `cannot mint a token for cribl.auth.clientId in ${CONFIG_PATH}.\n${res.text.slice(0, 200)}`
      );
    }
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      // Deliberately do NOT echo a 2xx body: a token response must never
      // reach a log line or HTTP response.
      throw new Error(`Cribl.Cloud token endpoint returned HTTP ${res.status} but the body is not JSON`);
    }
    const token = readTokenField(parsed, ['access_token', 'token']);
    if (token === '') {
      throw new Error(
        `Cribl.Cloud token endpoint returned HTTP ${res.status} but no access_token field in the response`
      );
    }
    const expiresIn =
      isPlainObject(parsed) && typeof parsed.expires_in === 'number' ? parsed.expires_in : DEFAULT_CLOUD_LIFETIME_S;
    cached = { token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  }

  /** Log in to the on-prem leader for a fresh session token. */
  async function loginOnprem() {
    const username = requireField('username', auth.username);
    const password = requireField('password', auth.password);
    if (cribl.leaderUrl === '') {
      throw new HttpError(500, `cribl.leaderUrl is empty in ${CONFIG_PATH} - set it and restart the host`);
    }
    const target = `${cribl.leaderUrl}/api/v1/auth/login`;
    // leaderRequest already maps DNS/connect/TLS failures to actionable
    // messages (unreachable leader, self-signed hint).
    const res = await leaderRequest(target, {
      method: 'POST',
      body: { username, password },
      agent: loginAgent,
    });
    if (res.status === 401) {
      throw new Error(
        `Cribl leader rejected the login (HTTP 401): invalid username or password. ` +
          `Check cribl.auth.username and cribl.auth.password in ${CONFIG_PATH}.${cloudLeaderHint(target)}`
      );
    }
    if (res.status === 429) {
      const retryAfter = res.headers['retry-after'];
      throw new Error(
        `Cribl leader rate limited the login (HTTP 429)` +
          `${typeof retryAfter === 'string' && retryAfter !== '' ? ` - retry after ${retryAfter} seconds` : ''}. ` +
          `Repeated failed logins trigger this; verify cribl.auth.username/password in ${CONFIG_PATH} before retrying.`
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `Cribl leader login at ${target} failed (HTTP ${res.status}).${cloudLeaderHint(target)}\n${bodySnippet(res.body)}`
      );
    }
    // AuthToken schema per the vendored OpenAPI spec: {token,
    // forcePasswordChange}. The field is `token`, not `access_token`; accept
    // both for tolerance.
    const token = readTokenField(res.body, ['token', 'access_token']);
    if (token === '') {
      throw new Error(
        `Cribl leader login at ${target} returned HTTP ${res.status} but no "token" field - ` +
          `is cribl.leaderUrl in ${CONFIG_PATH} really a Cribl leader?`
      );
    }
    if (isPlainObject(res.body) && res.body.forcePasswordChange === true) {
      console.warn(
        `[host] the Cribl leader requires a password change for cribl.auth.username - ` +
          `log in to the leader UI to change it, then update ${CONFIG_PATH}`
      );
    }
    cached = { token, expiresAt: Date.now() + ONPREM_ASSUMED_LIFETIME_S * 1000 };
    return token;
  }

  return {
    type: auth.type,

    async getLeaderToken(force = false) {
      if (auth.type === 'token') {
        return requireField('token', auth.token, 'or switch cribl.auth.type to "cloud"/"onprem" to mint tokens');
      }
      if (!force && cached !== null && Date.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
        return cached.token;
      }
      return auth.type === 'cloud' ? mintCloudToken() : loginOnprem();
    },
  };
}

/**
 * Read the first non-empty string among `keys` from a parsed token
 * response, or "".
 *
 * @param {unknown} body
 * @param {string[]} keys
 * @returns {string}
 */
function readTokenField(body, keys) {
  if (!isPlainObject(body)) {
    return '';
  }
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return '';
}

/**
 * Hint appended to on-prem login failures against a *.cribl.cloud host:
 * /auth/login does not exist on Cribl.Cloud leaders.
 *
 * @param {string} target
 * @returns {string}
 */
function cloudLeaderHint(target) {
  let host;
  try {
    host = new URL(target).hostname;
  } catch {
    return '';
  }
  if (!host.toLowerCase().endsWith('.cribl.cloud')) {
    return '';
  }
  return (
    ' Note: /api/v1/auth/login is not available on Cribl.Cloud - ' +
    'set cribl.auth.type to "cloud" with org API credentials instead.'
  );
}

/**
 * Render a FAILURE body for error messages, truncated; never used on 2xx
 * token responses.
 *
 * @param {unknown} body
 * @returns {string}
 */
function bodySnippet(body) {
  if (typeof body === 'string') {
    return body.slice(0, 200);
  }
  try {
    return JSON.stringify(body).slice(0, 200);
  } catch {
    return String(body).slice(0, 200);
  }
}
