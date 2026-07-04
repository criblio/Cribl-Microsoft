// Local-shell port adapters: the browser-side implementations of the six
// @soc/core ports, bound to the local Node host's API (src/host/server.mjs).
// The DUAL-TARGET twin of apps/cribl-app/src/platform/adapters.ts: the same
// @soc/ui screens render against the same port contracts; only the transport
// differs. Where the cloud shell rides the platform's locked fetch bridge and
// KV store, this shell talks plain same-origin HTTP to the loopback host,
// which owns all secrets and every upstream (Azure/leader) call.
//
// SECURITY POSTURE PARITY: values stored with { encrypted: true } are
// WRITE-ONLY through this API - get resolves null, exactly like the cloud
// KV's unreadable encrypted entries. The Azure client secret and Cribl token
// never reach this code: they live in the host's config file and are used
// server-side only.

import type {
  ArtifactSink,
  AzureManagement,
  AzureManagementRequest,
  AzureManagementUrlRequest,
  CriblClient,
  CriblGroupSummary,
  CriblRequest,
  JobRecord,
  JobStore,
  Logger,
  PortHttpResponse,
  SecretSetOptions,
  SecretsStore,
  UserContext,
  UserIdentity,
} from '@soc/core';

// ---------------------------------------------------------------------------
// HTTP primitives
// ---------------------------------------------------------------------------

// Host proxy endpoints bound every upstream request at ~30s server-side
// (AbortController in the host); racing at 35s lets the host's actionable
// 502 message win over a bare browser timeout.
const PROXY_TIMEOUT_MS = 35000;

// fetch with a hard client-side timeout, same race-based helper as the cloud
// shell (apps/cribl-app/src/platform/http.ts) for browser-side consistency.
// The local host is a plain Node server and honors AbortSignal, so the abort
// genuinely cancels the request here - but the race keeps the failure mode
// identical across shells: the promise always settles, loudly, on our timer.
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `timed out after ${timeoutMs / 1000}s - the local host did not respond. ` +
            'Check that the host is still running (npm run local) and that nothing ' +
            'else is holding its port.'
        )
      );
    }, timeoutMs);
  });
  const request = fetch(url, { ...init, signal: controller.signal });
  // Keep an eventual late rejection of the losing fetch from surfacing as an
  // unhandled rejection.
  request.catch(() => undefined);
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/**
 * Read a host error response ({error: string} per the server conventions)
 * and build a throwable Error carrying the route context.
 */
async function hostError(label: string, res: Response): Promise<Error> {
  const text = await res.text();
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    const detail = prop(parsed, 'error');
    if (typeof detail === 'string' && detail !== '') {
      message = detail;
    }
  } catch {
    // Non-JSON error body: keep the raw text.
  }
  return new Error(`${label}: HTTP ${res.status}${message === '' ? '' : `\n${message}`}`);
}

/** Fetch a host route and parse its JSON body, throwing on any non-ok status. */
async function hostJson(label: string, url: string, init?: RequestInit, timeoutMs?: number): Promise<unknown> {
  const res = await fetchWithTimeout(url, init, timeoutMs);
  if (!res.ok) {
    throw await hostError(label, res);
  }
  const text = await res.text();
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label}: the host returned invalid JSON\n${text}`);
  }
}

/** JSON POST init for the host API. */
function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Validate a proxied upstream result: the host answers HTTP 200 with the
 * upstream {status, body} pair (upstream 4xx/5xx are DATA, per the port
 * contract); anything else is a transport-level failure and throws.
 */
function asPortResponse(label: string, payload: unknown): PortHttpResponse {
  const status = prop(payload, 'status');
  if (typeof status !== 'number') {
    throw new Error(`${label}: unexpected host response shape (missing numeric "status")`);
  }
  return { status, body: prop(payload, 'body') };
}

// ---------------------------------------------------------------------------
// AzureManagement
// ---------------------------------------------------------------------------

/**
 * AzureManagement over POST /api/azure/request. The host owns the whole
 * Entra token flow (client_credentials from its config file, cached, one
 * re-acquire-and-retry on upstream 401) and returns the upstream
 * {status, body} verbatim. Rejections here are transport-level only: host
 * unreachable, host 4xx/5xx ({error}), or upstream transport failure (502).
 */
export class LocalAzureManagement implements AzureManagement {
  async request(opts: AzureManagementRequest): Promise<PortHttpResponse> {
    const label = `POST /api/azure/request (${opts.method} ${opts.path})`;
    const payload = await hostJson(
      label,
      '/api/azure/request',
      jsonInit('POST', {
        method: opts.method,
        path: opts.path,
        apiVersion: opts.apiVersion,
        body: opts.body,
        query: opts.query,
      }),
      PROXY_TIMEOUT_MS
    );
    return asPortResponse(label, payload);
  }

  /**
   * Execute a request against a FULL ARM URL (an ARM list `nextLink`) via
   * POST /api/azure/request-url. The HOST enforces the
   * https://management.azure.com/ prefix (hard reject - SSRF guard) and
   * attaches the bearer; this adapter just relays {method, url} with the
   * same bounded timeout as request().
   */
  async requestUrl(opts: AzureManagementUrlRequest): Promise<PortHttpResponse> {
    const label = `POST /api/azure/request-url (${opts.method} ${opts.url})`;
    const payload = await hostJson(
      label,
      '/api/azure/request-url',
      jsonInit('POST', { method: opts.method, url: opts.url }),
      PROXY_TIMEOUT_MS
    );
    return asPortResponse(label, payload);
  }
}

// ---------------------------------------------------------------------------
// CriblClient
// ---------------------------------------------------------------------------

/**
 * CriblClient over the host's leader proxy. The host attaches the static
 * bearer token from its config file and applies rejectUnauthorized to leader
 * calls only; this adapter never sees credentials. listGroups uses the
 * host's GET /api/cribl/groups convenience, which already applies the same
 * tolerant /master/groups mapping as the cloud adapter.
 */
export class LocalCriblClient implements CriblClient {
  async request(opts: CriblRequest): Promise<PortHttpResponse> {
    const label = `POST /api/cribl/request (${opts.method} ${opts.path})`;
    const payload = await hostJson(
      label,
      '/api/cribl/request',
      jsonInit('POST', {
        method: opts.method,
        path: opts.path,
        groupId: opts.groupId,
        body: opts.body,
        query: opts.query,
      }),
      PROXY_TIMEOUT_MS
    );
    return asPortResponse(label, payload);
  }

  async listGroups(): Promise<CriblGroupSummary[]> {
    const label = 'GET /api/cribl/groups';
    const payload = await hostJson(label, '/api/cribl/groups', undefined, PROXY_TIMEOUT_MS);
    if (!Array.isArray(payload)) {
      throw new Error(`${label}: unexpected host response shape (expected an array)`);
    }
    const groups: CriblGroupSummary[] = [];
    for (const item of payload) {
      const id = prop(item, 'id');
      if (typeof id !== 'string' || id === '') {
        continue;
      }
      const product = prop(item, 'product');
      groups.push(typeof product === 'string' && product !== '' ? { id, product } : { id });
    }
    return groups;
  }
}

// ---------------------------------------------------------------------------
// SecretsStore
// ---------------------------------------------------------------------------

/**
 * SecretsStore over the host's /api/secrets endpoints (data/secrets.json on
 * the host side). WRITE-ONLY PARITY with the cloud KV: entries stored with
 * { encrypted: true } can never be read back through this API - the host's
 * GET answers { value: null } for encrypted (and missing) keys, so `get`
 * resolves null and callers must re-`set` rather than read-modify-write
 * secrets, exactly as on the cloud shell.
 */
export class LocalSecretsStore implements SecretsStore {
  async set(key: string, value: string, opts?: SecretSetOptions): Promise<void> {
    const res = await fetchWithTimeout(
      secretUrl(key),
      jsonInit('PUT', { value, encrypted: opts?.encrypted === true })
    );
    if (!res.ok) {
      throw await hostError(`PUT /api/secrets/${key}`, res);
    }
  }

  async get(key: string): Promise<string | null> {
    const payload = await hostJson(`GET /api/secrets/${key}`, secretUrl(key));
    const value = prop(payload, 'value');
    return typeof value === 'string' ? value : null;
  }

  async delete(key: string): Promise<void> {
    const res = await fetchWithTimeout(secretUrl(key), { method: 'DELETE' });
    if (!res.ok) {
      throw await hostError(`DELETE /api/secrets/${key}`, res);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const payload = await hostJson('POST /api/secrets-list', '/api/secrets-list', jsonInit('POST', { prefix }));
    const keys = prop(payload, 'keys');
    if (!Array.isArray(keys)) {
      throw new Error('POST /api/secrets-list: unexpected host response shape (missing "keys" array)');
    }
    return keys.filter((key): key is string => typeof key === 'string');
  }
}

// encodeURIComponent keeps slash-bearing keys ("connections/lab") intact:
// the host percent-decodes the captured segment and preserves the slashes.
function secretUrl(key: string): string {
  return `/api/secrets/${encodeURIComponent(key)}`;
}

// ---------------------------------------------------------------------------
// JobStore
// ---------------------------------------------------------------------------

/**
 * JobStore over the host's /api/jobs endpoints (data/jobs.json, atomic-ish
 * writes on the host side). The host owns identity and time: it mints ids,
 * sets createdAt/updatedAt, applies patch-wins shallow merges, and lists
 * newest-first - the same contract as the cloud PlatformJobStore.
 */
export class LocalJobStore implements JobStore {
  async create(kind: string, input: unknown): Promise<JobRecord> {
    const payload = await hostJson(
      'POST /api/jobs',
      '/api/jobs',
      jsonInit('POST', { kind, input: input === undefined ? null : input })
    );
    return asJobRecord('POST /api/jobs', payload);
  }

  async update(id: string, patch: Partial<Omit<JobRecord, 'id'>>): Promise<void> {
    // The host answers 404 for an unknown id, which hostJson surfaces as a
    // rejection - matching the port contract ("rejects when id is unknown").
    await hostJson(`PATCH /api/jobs/${id}`, jobUrl(id), jsonInit('PATCH', patch));
  }

  async get(id: string): Promise<JobRecord | null> {
    const label = `GET /api/jobs/${id}`;
    const res = await fetchWithTimeout(jobUrl(id));
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw await hostError(label, res);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${label}: the host returned invalid JSON\n${text}`);
    }
    return asJobRecord(label, parsed);
  }

  async list(kind?: string): Promise<JobRecord[]> {
    const url = kind === undefined || kind === '' ? '/api/jobs' : `/api/jobs?kind=${encodeURIComponent(kind)}`;
    const payload = await hostJson('GET /api/jobs', url);
    if (!Array.isArray(payload)) {
      throw new Error('GET /api/jobs: unexpected host response shape (expected an array)');
    }
    return payload.map((record) => asJobRecord('GET /api/jobs', record));
  }
}

function jobUrl(id: string): string {
  return `/api/jobs/${encodeURIComponent(id)}`;
}

/**
 * Sanity-check a host job payload before trusting it as a JobRecord. Records
 * are written exclusively by the host's job store as serialized JobRecords,
 * so after the shape check the cast is sound (same reasoning as the cloud
 * adapter's KV-backed records).
 */
function asJobRecord(label: string, payload: unknown): JobRecord {
  if (typeof prop(payload, 'id') !== 'string' || typeof prop(payload, 'createdAt') !== 'string') {
    throw new Error(`${label}: unexpected job record shape`);
  }
  return payload as JobRecord;
}

// ---------------------------------------------------------------------------
// UserContext
// ---------------------------------------------------------------------------

/**
 * UserContext over GET /api/user: the OS account driving the host process
 * (node:os userInfo), the local stand-in for the cloud shell's signed-in
 * Cribl.Cloud user.
 */
export class LocalUserContext implements UserContext {
  async current(): Promise<UserIdentity> {
    const payload = await hostJson('GET /api/user', '/api/user');
    const id = prop(payload, 'id');
    const username = prop(payload, 'username');
    if (typeof id !== 'string' || typeof username !== 'string') {
      throw new Error('GET /api/user: unexpected host response shape');
    }
    return { id, username };
  }
}

// ---------------------------------------------------------------------------
// ArtifactSink
// ---------------------------------------------------------------------------

/**
 * ArtifactSink over a browser download: Blob object URL plus a programmatic
 * anchor click with the download attribute - the same pattern as the cloud
 * shell, running here in a first-party page (no iframe sandbox in play).
 * Resolving means the click was dispatched; the browser owns everything
 * after that.
 */
export class LocalArtifactSink implements ArtifactSink {
  async save(name: string, mimeType: string, data: Uint8Array | string): Promise<void> {
    // The port hands over a bare file name; anything path-like is rejected
    // rather than sanitized so a bad caller fails loudly.
    if (name === '' || /[/\\]/.test(name)) {
      throw new Error(`artifact name '${name}' must be a bare file name without path separators`);
    }
    // Strings become UTF-8 via the Blob constructor; binary payloads are
    // copied into a fresh ArrayBuffer-backed view (normalizes offset views
    // and satisfies BlobPart's ArrayBuffer-backed requirement).
    const part: BlobPart = typeof data === 'string' ? data : new Uint8Array(data);
    const blob = new Blob([part], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Delayed revoke: revoking synchronously can cancel the download the
    // click just started.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** The full set of local-shell adapters, typed against the @soc/core ports. */
export interface LocalPorts {
  secrets: SecretsStore;
  azure: AzureManagement;
  cribl: CriblClient;
  jobs: JobStore;
  user: UserContext;
  artifacts: ArtifactSink;
  /** The shell's Logger (web/logger.ts HostLogger, batching to the host). */
  logger: Logger;
}

/**
 * Build the local-shell adapter bundle. Unlike the cloud factory this takes
 * no tenant id: the host reads the Azure identity (tenant, client id,
 * secret) from its config file and owns the token flow end to end. `logger`
 * is the page-lifetime HostLogger instance (constructed by the shell root
 * and passed in - keeping this module import-cycle-free with web/logger.ts,
 * which imports fetchWithTimeout from here). Construction is side-effect
 * free; the shape satisfies @soc/ui's UiPorts and usecase port bundles
 * (e.g. OnboardTablePorts) structurally, so usecases log for free.
 */
export function makeLocalPorts(logger: Logger): LocalPorts {
  return {
    secrets: new LocalSecretsStore(),
    azure: new LocalAzureManagement(),
    cribl: new LocalCriblClient(),
    jobs: new LocalJobStore(),
    user: new LocalUserContext(),
    artifacts: new LocalArtifactSink(),
    logger,
  };
}
