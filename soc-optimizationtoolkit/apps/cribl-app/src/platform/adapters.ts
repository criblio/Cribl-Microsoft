// Cloud-shell port adapters: the REAL implementations of the six @soc/core
// ports for the Cribl App Platform. Everything here rides on the proven
// primitives in platform/http.ts (bridge-safe fetchWithTimeout, kvUrl,
// kvDelete, acquireArmToken) - see that module's header for the platform
// findings these adapters are built around.
//
// No UI concerns live here. The shells wire these adapters into @soc/core
// usecases (e.g. onboardTable) via makeCloudPorts(tenantId).

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
  TaggedSample,
  TaggedSampleStore,
  UserContext,
  UserIdentity,
} from '@soc/core';
import { acquireArmToken, fetchWithTimeout, kvDelete, kvUrl } from './http';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Read a Response body as the port-level `body`: parsed JSON when the service
// returned JSON, the raw text otherwise, null when empty. Ports surface raw
// {status, body} pairs and never throw on HTTP-level errors.
async function readPortBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// Read a property of an unknown value, or undefined when not an object.
function prop(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

// Render a body for error messages without ever throwing.
function bodyText(body: unknown): string {
  if (typeof body === 'string') {
    return body;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

// ---------------------------------------------------------------------------
// SecretsStore
// ---------------------------------------------------------------------------

/**
 * SecretsStore over the platform KV store (app-scoped /kvstore API).
 *
 * WRITE-ONLY ENCRYPTED ENTRIES: values written with `{ encrypted: true }`
 * (PUT ...?encrypted=true) can NEVER be read back - GET returns HTTP 403
 * {"message":"Cannot read encrypted value"} (verified live; the docs'
 * "redacted placeholder" does not happen). This adapter maps that 403 to
 * null, same as a missing key, so callers must treat "null" as "not readable
 * here" and re-`set` rather than read-modify-write secrets. Encrypted values
 * are still USABLE server-side via proxies.yml `kv.*` header injection.
 */
export class PlatformSecretsStore implements SecretsStore {
  async set(key: string, value: string, opts?: SecretSetOptions): Promise<void> {
    const suffix = opts?.encrypted === true ? '?encrypted=true' : '';
    const res = await fetchWithTimeout(kvUrl(`${key}${suffix}`), { method: 'PUT', body: value });
    if (!res.ok) {
      throw new Error(`PUT kvstore/${key}${suffix}: HTTP ${res.status}\n${await res.text()}`);
    }
  }

  async get(key: string): Promise<string | null> {
    const res = await fetchWithTimeout(kvUrl(key));
    // 404: the key does not exist. 403: the key exists but was written
    // encrypted and is write-only ("Cannot read encrypted value") - the
    // plaintext is unreadable by design, so surface it as absent too.
    if (res.status === 404 || res.status === 403) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GET kvstore/${key}: HTTP ${res.status}\n${await res.text()}`);
    }
    return await res.text();
  }

  async delete(key: string): Promise<void> {
    // kvDelete owns the platform quirk: the delete is processed server-side
    // but its response is lost by the bridge, so timeout means success and
    // nothing may ever be sequenced on the response.
    await kvDelete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const res = await fetchWithTimeout(`${window.CRIBL_API_URL}/kvstore/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix }),
    });
    if (!res.ok) {
      throw new Error(`POST kvstore/keys (prefix '${prefix}'): HTTP ${res.status}\n${await res.text()}`);
    }
    const body = await readPortBody(res);
    // Tolerant extraction: accept a bare array or an {items|keys: [...]}
    // wrapper, with entries that are either strings or {key|id} objects.
    const entries = Array.isArray(body)
      ? body
      : Array.isArray(prop(body, 'items'))
        ? (prop(body, 'items') as unknown[])
        : Array.isArray(prop(body, 'keys'))
          ? (prop(body, 'keys') as unknown[])
          : null;
    if (entries === null) {
      throw new Error(`POST kvstore/keys: unexpected response shape\n${bodyText(body)}`);
    }
    const names: string[] = [];
    for (const entry of entries) {
      const name =
        typeof entry === 'string'
          ? entry
          : typeof prop(entry, 'key') === 'string'
            ? (prop(entry, 'key') as string)
            : typeof prop(entry, 'id') === 'string'
              ? (prop(entry, 'id') as string)
              : null;
      // Defensive prefix filter: the port contract is "keys starting with
      // prefix" regardless of how the backend interprets its prefix param.
      if (name !== null && name.startsWith(prefix)) {
        names.push(name);
      }
    }
    return names;
  }
}

// ---------------------------------------------------------------------------
// AzureManagement
// ---------------------------------------------------------------------------

const ARM_BASE_URL = 'https://management.azure.com';
// Proxied external requests hit a 30s server-side timeout; racing at 25s
// keeps the client-side failure loud and ahead of the platform's.
const ARM_TIMEOUT_MS = 25000;
// The FIXED encrypted KV key proxies.yml injects as `Bearer ${kv.azureArmToken}`
// on management.azure.com requests. Single shared slot: one token is live at
// a time, for the tenant this adapter was constructed with.
const ARM_TOKEN_KV_KEY = 'azureArmToken';

/**
 * AzureManagement over the platform proxy. The app NEVER sets an
 * Authorization header: proxies.yml injects `Bearer ${kv.azureArmToken}`
 * server-side on every management.azure.com request (client-sent auth
 * headers are stripped by the proxy anyway).
 *
 * Token freshness: the adapter is constructed with the ACTIVE tenant id.
 * Before the first request of a sequence it acquires an ARM token via the
 * client_credentials flow (acquireArmToken - Basic auth injected from
 * kv.azureBasic) and PUTs it encrypted under azureArmToken. When a request
 * later comes back 401 (token expired mid-session), it re-acquires ONCE and
 * retries that request once; the retry's response is returned as-is.
 *
 * Per the port contract this resolves {status, body} for every HTTP response
 * (4xx/5xx included) and rejects only on transport failure - which includes
 * token acquisition failure (no secret connected, bad tenant, bridge down).
 */
export class PlatformAzureManagement implements AzureManagement {
  private readonly tenantId: string;
  private tokenEnsured = false;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  /**
   * Acquire a fresh ARM token for the constructed tenant and store it
   * encrypted under azureArmToken so the proxy can inject it. Callable
   * directly before a request sequence; request() also invokes it lazily
   * (first call) and on a 401 (once).
   */
  async ensureArmToken(): Promise<void> {
    const token = await acquireArmToken(this.tenantId);
    const res = await fetchWithTimeout(kvUrl(`${ARM_TOKEN_KV_KEY}?encrypted=true`), {
      method: 'PUT',
      body: token.access_token,
    });
    if (!res.ok) {
      throw new Error(`PUT ${ARM_TOKEN_KV_KEY}?encrypted=true: HTTP ${res.status}\n${await res.text()}`);
    }
    this.tokenEnsured = true;
  }

  async request(opts: AzureManagementRequest): Promise<PortHttpResponse> {
    if (!this.tokenEnsured) {
      await this.ensureArmToken();
    }
    const first = await this.send(opts);
    if (first.status !== 401) {
      return first;
    }
    // 401: the stored token was rejected (expired or evicted). Re-acquire
    // ONCE and retry the request once; whatever comes back is the answer.
    await this.ensureArmToken();
    return this.send(opts);
  }

  /**
   * Execute a request against a FULL ARM URL (an ARM list `nextLink` -
   * pagination is the one ARM surface that arrives as an absolute URL).
   * RESTRICTED to https://management.azure.com/ per the port contract: any
   * other host is rejected BEFORE a request is sent - this port grants
   * access to ARM and nothing else (and only management.azure.com is
   * declared in proxies.yml anyway). Same token flow and 401-retry-once
   * semantics as request().
   */
  async requestUrl(opts: AzureManagementUrlRequest): Promise<PortHttpResponse> {
    if (!opts.url.startsWith(`${ARM_BASE_URL}/`)) {
      throw new Error(
        `requestUrl refused '${opts.url}': only ${ARM_BASE_URL}/ URLs are allowed ` +
          '(ARM nextLink pagination) - refusing to request any other host',
      );
    }
    if (!this.tokenEnsured) {
      await this.ensureArmToken();
    }
    const first = await this.sendUrl(opts);
    if (first.status !== 401) {
      return first;
    }
    await this.ensureArmToken();
    return this.sendUrl(opts);
  }

  private async sendUrl(opts: AzureManagementUrlRequest): Promise<PortHttpResponse> {
    // No body and no headers: a nextLink carries its full query string, and
    // the proxy injects Authorization server-side.
    const res = await fetchWithTimeout(opts.url, { method: opts.method }, ARM_TIMEOUT_MS);
    return { status: res.status, body: await readPortBody(res) };
  }

  private async send(opts: AzureManagementRequest): Promise<PortHttpResponse> {
    const params = new URLSearchParams({ ...(opts.query ?? {}), 'api-version': opts.apiVersion });
    const init: RequestInit = { method: opts.method };
    if (opts.body !== undefined) {
      // Content-Type is on the proxies.yml headers allowlist for
      // management.azure.com; Authorization is never set here.
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetchWithTimeout(`${ARM_BASE_URL}${opts.path}?${params.toString()}`, init, ARM_TIMEOUT_MS);
    return { status: res.status, body: await readPortBody(res) };
  }
}

// ---------------------------------------------------------------------------
// CriblClient
// ---------------------------------------------------------------------------

/**
 * CriblClient over the hosting workspace's own product API. Requests go to
 * window.CRIBL_API_URL; the platform's fetch proxy injects authentication,
 * so this adapter sets no auth headers. A groupId prefixes the path with
 * /m/{groupId} (config-group context); without one the request addresses the
 * leader's top-level API. Every product API path this adapter is used for
 * must be declared in config/policies.yml (same-PR contract).
 */
export class PlatformCriblClient implements CriblClient {
  async request(opts: CriblRequest): Promise<PortHttpResponse> {
    const prefix = opts.groupId !== undefined && opts.groupId !== ''
      ? `/m/${encodeURIComponent(opts.groupId)}`
      : '';
    let url = `${window.CRIBL_API_URL}${prefix}${opts.path}`;
    if (opts.query !== undefined && Object.keys(opts.query).length > 0) {
      url += `?${new URLSearchParams(opts.query).toString()}`;
    }
    const init: RequestInit = { method: opts.method };
    if (opts.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetchWithTimeout(url, init);
    return { status: res.status, body: await readPortBody(res) };
  }

  async listGroups(): Promise<CriblGroupSummary[]> {
    const response = await this.request({ method: 'GET', path: '/master/groups' });
    // listGroups is a convenience that must yield a real list; an HTTP error
    // here leaves nothing sensible to return, so it surfaces as a rejection
    // with the raw status and body.
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GET /master/groups: HTTP ${response.status}\n${bodyText(response.body)}`);
    }
    // Response shape per the vendored cribl-openapi.json: CountedConfigGroup
    // {count, items: ConfigGroup[]} where ConfigGroup requires only `id`.
    // `product` is not in the vendored spec but is reported by current
    // leaders; map it only when present as a string.
    const items = prop(response.body, 'items');
    if (!Array.isArray(items)) {
      throw new Error(`GET /master/groups: unexpected response shape\n${bodyText(response.body)}`);
    }
    const groups: CriblGroupSummary[] = [];
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
}

// ---------------------------------------------------------------------------
// JobStore
// ---------------------------------------------------------------------------

// Each job is one plain (unencrypted) KV entry under jobs/{id}; the flat
// jobs-index entry holds the JSON array of ids in creation order (appended
// on create). Kept outside the jobs/ prefix so a prefix listing of records
// never returns the index itself.
const JOB_KEY_PREFIX = 'jobs/';
const JOB_INDEX_KEY = 'jobs-index';

/**
 * JobStore over plain KV entries. The shell owns identity and time: ids come
 * from crypto.randomUUID() and timestamps from new Date().toISOString()
 * (@soc/core stays clock- and randomness-free).
 *
 * Concurrency: last-writer-wins on both records and the index; the cloud
 * shell is a single-operator UI, so no KV-level locking is attempted.
 */
export class PlatformJobStore implements JobStore {
  async create(kind: string, input: unknown): Promise<JobRecord> {
    const now = new Date().toISOString();
    const record: JobRecord = {
      id: crypto.randomUUID(),
      kind,
      status: 'pending',
      input,
      steps: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.putRecord(record);
    const ids = await this.readIndex();
    ids.push(record.id);
    await this.writeIndex(ids);
    return record;
  }

  async update(id: string, patch: Partial<Omit<JobRecord, 'id'>>): Promise<void> {
    const existing = await this.get(id);
    if (existing === null) {
      throw new Error(`PlatformJobStore.update: no job with id "${id}"`);
    }
    // Shallow merge, patch fields win; id and createdAt are store-managed and
    // updatedAt is always refreshed (same contract as the in-memory fake).
    const merged: JobRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.putRecord(merged);
  }

  async get(id: string): Promise<JobRecord | null> {
    const res = await fetchWithTimeout(kvUrl(`${JOB_KEY_PREFIX}${id}`));
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GET kvstore/${JOB_KEY_PREFIX}${id}: HTTP ${res.status}\n${await res.text()}`);
    }
    const text = await res.text();
    if (text === '') {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`job record ${JOB_KEY_PREFIX}${id} is not valid JSON`);
    }
    if (typeof prop(parsed, 'id') !== 'string' || typeof prop(parsed, 'createdAt') !== 'string') {
      throw new Error(`job record ${JOB_KEY_PREFIX}${id} has an unexpected shape\n${text}`);
    }
    // Records are written exclusively by this adapter as serialized
    // JobRecords, so after the sanity check above the cast is sound.
    return parsed as JobRecord;
  }

  async list(kind?: string): Promise<JobRecord[]> {
    const ids = await this.readIndex();
    const records: JobRecord[] = [];
    // Walk the index newest-appended-first so the stable sort below keeps
    // creation order for records sharing a createdAt timestamp.
    for (const id of [...ids].reverse()) {
      const record = await this.get(id);
      if (record !== null && (kind === undefined || record.kind === kind)) {
        records.push(record);
      }
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records;
  }

  private async putRecord(record: JobRecord): Promise<void> {
    const key = `${JOB_KEY_PREFIX}${record.id}`;
    const res = await fetchWithTimeout(kvUrl(key), {
      method: 'PUT',
      body: JSON.stringify(record),
    });
    if (!res.ok) {
      throw new Error(`PUT kvstore/${key}: HTTP ${res.status}\n${await res.text()}`);
    }
  }

  private async readIndex(): Promise<string[]> {
    const res = await fetchWithTimeout(kvUrl(JOB_INDEX_KEY));
    if (res.status === 404) {
      return [];
    }
    if (!res.ok) {
      throw new Error(`GET kvstore/${JOB_INDEX_KEY}: HTTP ${res.status}\n${await res.text()}`);
    }
    const text = await res.text();
    if (text === '') {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  }

  private async writeIndex(ids: string[]): Promise<void> {
    const res = await fetchWithTimeout(kvUrl(JOB_INDEX_KEY), {
      method: 'PUT',
      body: JSON.stringify(ids),
    });
    if (!res.ok) {
      throw new Error(`PUT kvstore/${JOB_INDEX_KEY}: HTTP ${res.status}\n${await res.text()}`);
    }
  }
}

// ---------------------------------------------------------------------------
// TaggedSampleStore
// ---------------------------------------------------------------------------

// Each tagged sample is one plain KV entry under tagged-samples/{encodedLogType}
// (the 200-event rawEvents cap the core applies keeps each entry small); the
// flat tagged-samples-index entry holds the JSON array of log types in insert
// order. Kept outside the tagged-samples/ prefix so a prefix listing of records
// never returns the index itself (same shape as PlatformJobStore).
const TAGGED_SAMPLE_KEY_PREFIX = 'tagged-samples/';
const TAGGED_SAMPLE_INDEX_KEY = 'tagged-samples-index';

function taggedSampleKey(logType: string): string {
  return `${TAGGED_SAMPLE_KEY_PREFIX}${encodeURIComponent(logType)}`;
}

// Sanity-check a KV-read value before trusting it as a TaggedSample. Entries
// are written exclusively by this adapter as serialized TaggedSamples, so after
// the shape check the cast is sound (same reasoning as the KV JobRecords).
function asTaggedSample(label: string, parsed: unknown): TaggedSample {
  if (
    typeof prop(parsed, 'logType') !== 'string' ||
    typeof prop(parsed, 'format') !== 'string' ||
    !Array.isArray(prop(parsed, 'rawEvents')) ||
    typeof prop(parsed, 'parsed') !== 'object' ||
    prop(parsed, 'parsed') === null
  ) {
    throw new Error(`${label}: unexpected tagged-sample shape\n${bodyText(parsed)}`);
  }
  return parsed as TaggedSample;
}

/**
 * TaggedSampleStore over plain KV entries (porting-plan Unit 11). Keyed by log
 * type with replace-by-logType semantics: upsert PUTs the entry and appends the
 * log type to the index only when new; remove deletes the entry and prunes the
 * index. list() walks the index and GETs each entry, skipping any that 404
 * (a delete whose response the bridge lost still removed the entry server-side).
 * Last-writer-wins; the cloud shell is a single-operator UI so no locking.
 */
export class PlatformTaggedSampleStore implements TaggedSampleStore {
  async upsert(sample: TaggedSample): Promise<void> {
    if (sample.logType === '') {
      throw new Error('PlatformTaggedSampleStore.upsert: logType must be non-empty');
    }
    const key = taggedSampleKey(sample.logType);
    const res = await fetchWithTimeout(kvUrl(key), {
      method: 'PUT',
      body: JSON.stringify(sample),
    });
    if (!res.ok) {
      throw new Error(`PUT kvstore/${key}: HTTP ${res.status}\n${await res.text()}`);
    }
    const index = await this.readIndex();
    if (!index.includes(sample.logType)) {
      index.push(sample.logType);
      await this.writeIndex(index);
    }
  }

  async get(logType: string): Promise<TaggedSample | null> {
    const key = taggedSampleKey(logType);
    const res = await fetchWithTimeout(kvUrl(key));
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GET kvstore/${key}: HTTP ${res.status}\n${await res.text()}`);
    }
    const text = await res.text();
    if (text === '') {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`tagged sample ${key} is not valid JSON`);
    }
    return asTaggedSample(`GET kvstore/${key}`, parsed);
  }

  async list(): Promise<TaggedSample[]> {
    const index = await this.readIndex();
    const samples: TaggedSample[] = [];
    for (const logType of index) {
      const sample = await this.get(logType);
      if (sample !== null) {
        samples.push(sample);
      }
    }
    return samples;
  }

  async remove(logType: string): Promise<void> {
    // kvDelete owns the platform quirk: the delete is processed server-side but
    // its response may be lost by the bridge, so nothing is sequenced on it.
    await kvDelete(taggedSampleKey(logType));
    const index = await this.readIndex();
    const next = index.filter((t) => t !== logType);
    if (next.length !== index.length) {
      await this.writeIndex(next);
    }
  }

  private async readIndex(): Promise<string[]> {
    const res = await fetchWithTimeout(kvUrl(TAGGED_SAMPLE_INDEX_KEY));
    if (res.status === 404) {
      return [];
    }
    if (!res.ok) {
      throw new Error(`GET kvstore/${TAGGED_SAMPLE_INDEX_KEY}: HTTP ${res.status}\n${await res.text()}`);
    }
    const text = await res.text();
    if (text === '') {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  }

  private async writeIndex(logTypes: string[]): Promise<void> {
    const res = await fetchWithTimeout(kvUrl(TAGGED_SAMPLE_INDEX_KEY), {
      method: 'PUT',
      body: JSON.stringify(logTypes),
    });
    if (!res.ok) {
      throw new Error(`PUT kvstore/${TAGGED_SAMPLE_INDEX_KEY}: HTTP ${res.status}\n${await res.text()}`);
    }
  }
}

// ---------------------------------------------------------------------------
// UserContext
// ---------------------------------------------------------------------------

/**
 * UserContext over the platform session: window.getCriblUser() resolves the
 * signed-in Cribl.Cloud user (memoized by the platform). Rejection when
 * there is no authenticated session comes from the platform call itself.
 */
export class PlatformUserContext implements UserContext {
  async current(): Promise<UserIdentity> {
    const user = await window.getCriblUser();
    const identity: UserIdentity = { id: user.id, username: user.username };
    if (user.email !== undefined) {
      identity.email = user.email;
    }
    if (user.firstName !== undefined) {
      identity.firstName = user.firstName;
    }
    if (user.lastName !== undefined) {
      identity.lastName = user.lastName;
    }
    return identity;
  }
}

// ---------------------------------------------------------------------------
// ArtifactSink
// ---------------------------------------------------------------------------

/**
 * ArtifactSink over a browser download: Blob object URL plus a programmatic
 * anchor click with the download attribute - the exact mechanics the panel-7
 * spike proved work from inside the sandboxed iframe. Resolving means the
 * click was dispatched; the browser owns everything after that (there is no
 * DOM signal for "the file landed in Downloads").
 */
export class PlatformArtifactSink implements ArtifactSink {
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
    // Same delayed revoke as the proven panel: revoking synchronously can
    // cancel the download the click just started.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** The full set of cloud-shell adapters, typed against the @soc/core ports. */
export interface CloudPorts {
  secrets: SecretsStore;
  azure: AzureManagement;
  cribl: CriblClient;
  jobs: JobStore;
  user: UserContext;
  artifacts: ArtifactSink;
  /** Tagged-sample store over plain KV entries (porting-plan Unit 11). */
  samples: TaggedSampleStore;
  /** The shell's Logger (platform/logger.ts PlatformLogger instance). */
  logger: Logger;
}

/**
 * Build the cloud-shell adapter bundle. `tenantId` is the ACTIVE
 * connection's Entra tenant, baked into the AzureManagement adapter's token
 * flow - build a fresh set when the active connection changes. `logger` is
 * the app-lifetime PlatformLogger instance (passed BY REFERENCE so its ring
 * survives connection switches; construction here would reset it). The
 * azure/cribl/jobs/logger fields satisfy usecase port bundles (e.g.
 * OnboardTablePorts) structurally, so usecases invoked with this bundle log
 * for free.
 */
export function makeCloudPorts(tenantId: string, logger: Logger): CloudPorts {
  return {
    secrets: new PlatformSecretsStore(),
    azure: new PlatformAzureManagement(tenantId),
    cribl: new PlatformCriblClient(),
    jobs: new PlatformJobStore(),
    user: new PlatformUserContext(),
    artifacts: new PlatformArtifactSink(),
    samples: new PlatformTaggedSampleStore(),
    logger,
  };
}
