// GitHub content proxy for the local host: the server-side twin of the cloud
// shell's PlatformSentinelContent + PlatformGithubPat adapters (apps/cribl-app/
// src/platform/adapters.ts), porting-plan Unit 14.
//
// The cloud shell reaches GitHub through the platform proxy, which injects the
// PAT from the write-only KV slot (proxies.yml). This host instead OWNS the
// token: it stores it in data/github.json (plaintext on disk, 0600 best-effort,
// gitignored) and attaches the Authorization header itself on the two allowed
// hosts. The token NEVER leaves this process - the browser-facing API returns
// only { hasPat, login }, never the token (write-only parity with the cloud KV
// slot, the same posture as the Azure client secret in local-config.json).
//
// LAZY per-solution fetching (never a whole-repo mirror) is the ADAPTER's job
// (LocalSentinelContent builds api.github.com / raw.githubusercontent.com URLs
// and calls POST /api/github/request); this module is the authenticated,
// host-restricted transport plus the PAT lifecycle. The EDR content filter that
// keeps blocklisted IOC-laden rule content off disk lives in the browser-side
// LocalSentinelContent adapter (which can import @soc/core); nothing blocked
// ever reaches this proxy's callers or the on-disk content cache.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, fetchTextWithTimeout } from './http-util.mjs';

const FILE_MODE = 0o600;

// The ONLY two hosts this proxy will touch (SSRF guard - the browser must not
// be able to steer the host, PAT attached, at arbitrary destinations).
const ALLOWED_GITHUB_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);
const GITHUB_JSON_ACCEPT = 'application/vnd.github+json';
// GitHub rejects any API request without a User-Agent with HTTP 403, and Node's
// fetch does not set one by default - send an explicit app identifier.
const GITHUB_USER_AGENT = 'cribl-soc-optimization-toolkit';
const PAT_VALIDATION_URL = 'https://api.github.com/user';
// Format precheck mirrored from @soc/core patFormatIssue (kept in sync as a
// small constant since the host cannot import the TypeScript core at runtime).
const PAT_MIN_LENGTH = 10;

/**
 * Build the GitHub proxy + PAT store over {dataDir}/github.json.
 *
 * @param {string} dataDir
 * @param {ReturnType<import('./logger.mjs').createFileLogger>} [logger]
 *   Optional file logger. Only METADATA is ever logged (login, target host,
 *   status) - the token never reaches a log line.
 */
export function createGithubProxy(dataDir, logger) {
  const filePath = path.join(dataDir, 'github.json');
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

  /** @returns {Promise<{ token: string, login: string }>} */
  async function readState() {
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { token: '', login: '' };
      }
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        token: typeof parsed.token === 'string' ? parsed.token : '',
        login: typeof parsed.login === 'string' ? parsed.login : '',
      };
    } catch {
      return { token: '', login: '' };
    }
  }

  /** @param {{ token: string, login: string }} state */
  async function writeState(state) {
    await mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: FILE_MODE });
    await rename(tmpPath, filePath);
    try {
      await chmod(filePath, FILE_MODE);
    } catch {
      // Best effort; mode bits are advisory on Windows.
    }
  }

  /** The current in-process token (read from disk each call; single operator). */
  async function currentToken() {
    return (await readState()).token;
  }

  return {
    /**
     * The non-secret PAT status the browser API returns: whether a token is
     * stored and the resolved login. NEVER the token.
     *
     * @returns {Promise<{ hasPat: boolean, login?: string }>}
     */
    status() {
      return enqueue(async () => {
        const state = await readState();
        return state.token !== ''
          ? { hasPat: true, ...(state.login !== '' ? { login: state.login } : {}) }
          : { hasPat: false };
      });
    },

    /**
     * VALIDATE-THEN-STORE: call GET /user with the submitted PAT (the host
     * attaches the header directly - no proxy-injection constraint here), and
     * store it ONLY on a 200. The token is never echoed back.
     *
     * @param {string} pat
     * @returns {Promise<{ hasPat: boolean, login?: string, error?: string }>}
     */
    validateAndStore(pat) {
      return enqueue(async () => {
        if (typeof pat !== 'string' || pat.trim().length < PAT_MIN_LENGTH) {
          return { hasPat: false, error: 'PAT is required' };
        }
        let res;
        try {
          res = await fetchTextWithTimeout(PAT_VALIDATION_URL, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${pat}`,
              Accept: GITHUB_JSON_ACCEPT,
              'User-Agent': GITHUB_USER_AGENT,
            },
          });
        } catch (err) {
          // Transport failure: store nothing, surface the actionable message.
          return { hasPat: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (res.status >= 200 && res.status < 300) {
          let login = '';
          try {
            const body = JSON.parse(res.text);
            if (typeof body.login === 'string') {
              login = body.login;
            }
          } catch {
            // A 2xx with an unparseable body still validates; login stays blank.
          }
          await writeState({ token: pat, login });
          logger?.info('github pat validated and stored', { login: login === '' ? '(unknown)' : login });
          return { hasPat: true, ...(login !== '' ? { login } : {}) };
        }
        const detail =
          res.status === 401
            ? 'GitHub rejected the token (HTTP 401) - it is invalid, expired, or revoked.'
            : res.status === 403
              ? 'GitHub refused the token (HTTP 403) - it may be rate-limited or lack access.'
              : `GitHub validation failed (HTTP ${res.status}).`;
        logger?.warn('github pat validation failed', { status: res.status });
        return { hasPat: false, error: detail };
      });
    },

    /** Remove the stored PAT (and login). Idempotent. */
    clear() {
      return enqueue(async () => {
        await writeState({ token: '', login: '' });
      });
    },

    /**
     * Proxy ONE GitHub GET to an allowed host, attaching the stored PAT as a
     * Bearer credential when present. Returns { status, body } where BODY IS THE
     * RAW RESPONSE TEXT (not JSON-parsed): the browser adapter parses the
     * contents/tree JSON itself and uses raw file text verbatim, so a fetched
     * JSON *file* is never silently turned into an object (readFile must return
     * text). Upstream 4xx/5xx are DATA per the port contract; rejects (surfaced
     * as a 502 by the route) only on a transport failure; a disallowed host is a
     * hard HttpError 400 before any request leaves the host.
     *
     * @param {string} url FULL URL on api.github.com or raw.githubusercontent.com.
     * @returns {Promise<{ status: number, body: string }>}
     */
    async request(url) {
      if (typeof url !== 'string' || url === '') {
        throw new HttpError(400, 'POST /api/github/request: "url" must be a non-empty string');
      }
      let host;
      try {
        host = new URL(url).host;
      } catch {
        throw new HttpError(400, `POST /api/github/request: "${url}" is not a valid URL`);
      }
      if (!ALLOWED_GITHUB_HOSTS.has(host)) {
        throw new HttpError(
          400,
          `POST /api/github/request: host "${host}" is not allowed - only ${[...ALLOWED_GITHUB_HOSTS].join(', ')} ` +
            'may be proxied (Microsoft Sentinel content); refusing to proxy any other destination'
        );
      }
      const token = await currentToken();
      /** @type {Record<string, string>} */
      const headers = { Accept: GITHUB_JSON_ACCEPT, 'User-Agent': GITHUB_USER_AGENT };
      if (token !== '') {
        headers.Authorization = `Bearer ${token}`;
      }
      let res = await fetchTextWithTimeout(url, { method: 'GET', headers });
      // RATE LIMITING (live report 2026-07-15: parallel per-solution reads
      // trip GitHub's 429/limited-403) - honor Retry-After / x-ratelimit-reset
      // with a capped backoff before the short 5xx-blip retries.
      for (let attempt = 0; attempt < 4; attempt++) {
        const limited =
          res.status === 429 || (res.status === 403 && res.retryAfter !== null);
        if (!limited) break;
        let waitMs;
        if (res.retryAfter !== null) {
          waitMs = Math.min(res.retryAfter * 1000, 20000);
        } else if (res.rateLimitReset !== null) {
          waitMs = Math.min(Math.max(res.rateLimitReset * 1000 - Date.now(), 0), 20000);
        } else {
          waitMs = Math.min(1000 * 2 ** attempt, 20000);
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        res = await fetchTextWithTimeout(url, { method: 'GET', headers });
      }
      // Transient GitHub 5xx blips (502 Bad Gateway pages) are routine -
      // retry a couple of times before answering (mirrors the cloud shell).
      for (const delay of [500, 1500]) {
        if (![500, 502, 503, 504].includes(res.status)) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        res = await fetchTextWithTimeout(url, { method: 'GET', headers });
      }
      return { status: res.status, body: res.text };
    },
  };
}
