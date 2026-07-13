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
  ContentCache,
  FetchedSampleFile,
  RemoteSampleSource,
  CriblClient,
  CriblGroupSummary,
  CriblRequest,
  GithubPatManager,
  GraphDirectory,
  InstalledPack,
  JobRecord,
  JobStore,
  Logger,
  PatManagerStatus,
  PortHttpResponse,
  SecretSetOptions,
  SecretsStore,
  SentinelContent,
  ServicePrincipalRef,
  SolutionFileRef,
  SolutionRef,
  TaggedSample,
  TaggedSampleStore,
  UserContext,
  UserIdentity,
} from '@soc/core';
import {
  TAGGED_SAMPLE_MAX_BYTES,
  blockedSolutionNames,
  capTaggedSampleBytes,
  classifySolutionDeprecation,
  deriveGroupProduct,
  findConnectorDirName,
  interpretInstallResponse,
  isPathAllowedByEdr,
  packIdFromCrblFileName,
  parsePackListResponse,
  parseUploadResponse,
  patFormatIssue,
  patStatusFrom,
  selectConnectorFiles,
} from '@soc/core';
// Pack store + install-client contracts are @soc/ui-owned ports (they carry the
// StoredPack definition the UI regenerates from); the CloudPorts bundle
// satisfies them structurally.
import type {
  DeployedGroupPacks,
  PackInstallClient,
  PackRecordStore,
  StoredPack,
} from '@soc/ui';
import { acquireArmToken, acquireGraphToken, fetchWithTimeout, kvDelete, kvUrl } from './http';

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
    const first = await this.throttleAware(() => this.send(opts));
    if (first.status !== 401) {
      return first;
    }
    // 401: the stored token was rejected (expired or evicted). Re-acquire
    // ONCE and retry the request once; whatever comes back is the answer.
    await this.ensureArmToken();
    return this.throttleAware(() => this.send(opts));
  }

  /**
   * ARM THROTTLING (live 2026-07-13: a deploy died on its FIRST read with
   * HTTP 429 "Too many requests"): retry 429s up to three times, honoring
   * Retry-After when ARM sends one (seconds form) and otherwise backing off
   * 2s/4s/8s, capped at 30s per wait. Applies to every ARM call this
   * adapter makes - deploys, browsing, role grants - so a throttled tenant
   * degrades to slower instead of failed.
   */
  private async throttleAware(
    send: () => Promise<ArmResponse>,
  ): Promise<ArmResponse> {
    let response = await send();
    for (let attempt = 1; attempt <= 3 && response.status === 429; attempt++) {
      const retryAfter = response.retryAfterSeconds;
      const waitMs = Math.min(
        (retryAfter !== undefined ? retryAfter : 2 ** attempt) * 1000,
        30000,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      response = await send();
    }
    return response;
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
    const first = await this.throttleAware(() => this.sendUrl(opts));
    if (first.status !== 401) {
      return first;
    }
    await this.ensureArmToken();
    return this.throttleAware(() => this.sendUrl(opts));
  }

  private async sendUrl(
    opts: AzureManagementUrlRequest,
  ): Promise<ArmResponse> {
    // No body and no headers: a nextLink carries its full query string, and
    // the proxy injects Authorization server-side.
    const res = await fetchWithTimeout(opts.url, { method: opts.method }, ARM_TIMEOUT_MS);
    return {
      status: res.status,
      body: await readPortBody(res),
      retryAfterSeconds: retryAfterSecondsOf(res),
    };
  }

  private async send(opts: AzureManagementRequest): Promise<ArmResponse> {
    const params = new URLSearchParams({ ...(opts.query ?? {}), 'api-version': opts.apiVersion });
    const init: RequestInit = { method: opts.method };
    if (opts.body !== undefined) {
      // Content-Type is on the proxies.yml headers allowlist for
      // management.azure.com; Authorization is never set here.
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetchWithTimeout(`${ARM_BASE_URL}${opts.path}?${params.toString()}`, init, ARM_TIMEOUT_MS);
    return {
      status: res.status,
      body: await readPortBody(res),
      retryAfterSeconds: retryAfterSecondsOf(res),
    };
  }
}

/** A PortHttpResponse plus the throttle hint the retry loop consumes. */
interface ArmResponse extends PortHttpResponse {
  retryAfterSeconds?: number;
}

/** Parse a Retry-After response header (seconds form) or undefined. */
function retryAfterSecondsOf(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

// ---------------------------------------------------------------------------
// GraphDirectory (B3)
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = 'https://graph.microsoft.com';
const GRAPH_TIMEOUT_MS = 25000;
// The FIXED encrypted KV key proxies.yml injects as `Bearer ${kv.azureGraphToken}`
// on graph.microsoft.com requests. Separate slot from azureArmToken: the Graph
// audience differs, so ARM and Graph tokens cannot be shared.
const GRAPH_TOKEN_KV_KEY = 'azureGraphToken';
// Bound on @odata.nextLink pages the service-principal enumeration will follow.
const GRAPH_MAX_PAGES = 20;
// A generous page size; the picker only needs id/appId/displayName per SP.
const GRAPH_SP_URL =
  `${GRAPH_BASE_URL}/v1.0/servicePrincipals?$select=id,appId,displayName&$top=100`;

/** Map one Graph servicePrincipals `value[]` body into ServicePrincipalRefs. */
function mapServicePrincipals(body: unknown): ServicePrincipalRef[] {
  const value = prop(body, 'value');
  if (!Array.isArray(value)) return [];
  const out: ServicePrincipalRef[] = [];
  for (const entry of value) {
    const id = prop(entry, 'id');
    if (typeof id !== 'string' || id === '') continue;
    const appId = prop(entry, 'appId');
    const displayName = prop(entry, 'displayName');
    out.push({
      id,
      appId: typeof appId === 'string' ? appId : '',
      displayName: typeof displayName === 'string' ? displayName : id,
    });
  }
  return out;
}

/**
 * GraphDirectory over the platform proxy. Same token discipline as
 * PlatformAzureManagement: no client-set Authorization (proxies.yml injects
 * `Bearer ${kv.azureGraphToken}`), a Graph-audience token acquired lazily on
 * the first call and re-acquired once on a 401. A 403 is surfaced as a thrown
 * error with an Application.Read.All hint so the picker degrades to manual
 * object-id entry (the directory read needs that permission consented).
 */
export class PlatformGraphDirectory implements GraphDirectory {
  private readonly tenantId: string;
  private tokenEnsured = false;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  private async ensureGraphToken(): Promise<void> {
    const token = await acquireGraphToken(this.tenantId);
    const res = await fetchWithTimeout(kvUrl(`${GRAPH_TOKEN_KV_KEY}?encrypted=true`), {
      method: 'PUT',
      body: token.access_token,
    });
    if (!res.ok) {
      throw new Error(
        `PUT ${GRAPH_TOKEN_KV_KEY}?encrypted=true: HTTP ${res.status}\n${await res.text()}`,
      );
    }
    this.tokenEnsured = true;
  }

  private async page(url: string): Promise<PortHttpResponse> {
    // No headers: a nextLink carries its full query and the proxy injects
    // Authorization server-side.
    const res = await fetchWithTimeout(url, { method: 'GET' }, GRAPH_TIMEOUT_MS);
    return { status: res.status, body: await readPortBody(res) };
  }

  async listServicePrincipals(): Promise<ServicePrincipalRef[]> {
    if (!this.tokenEnsured) {
      await this.ensureGraphToken();
    }
    let res = await this.page(GRAPH_SP_URL);
    if (res.status === 401 || res.status === 403) {
      // 401 = token expired/evicted. 403 can also mean the CACHED token predates
      // a just-granted Application.Read.All consent - app-role claims are baked
      // into the token at issuance, so a token minted before consent will 403
      // forever. Re-acquire ONCE (a fresh redemption reflects current consent)
      // and retry; a genuine missing-permission 403 simply repeats and is
      // surfaced with the hint below.
      await this.ensureGraphToken();
      res = await this.page(GRAPH_SP_URL);
    }
    if (res.status !== 200) {
      const hint =
        res.status === 403
          ? ' - the app registration needs Application.Read.All (or Directory.Read.All) consented to read the directory'
          : '';
      throw new Error(`Graph servicePrincipals: HTTP ${res.status}${hint}`);
    }
    const out: ServicePrincipalRef[] = [];
    let body: unknown = res.body;
    for (let pages = 0; ; pages += 1) {
      out.push(...mapServicePrincipals(body));
      const next = prop(body, '@odata.nextLink');
      if (typeof next !== 'string' || next === '' || pages >= GRAPH_MAX_PAGES) {
        break;
      }
      const page = await this.page(next);
      if (page.status !== 200) break;
      body = page.body;
    }
    return out;
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
      // Derive the product from whichever signal the leader reports so the
      // UI's Stream-only filter actually bites: the explicit product string,
      // the ConfigGroup `type` (edge/outpost/search/stream - what marks
      // Outpost groups), or the deprecated isFleet/isSearch booleans.
      const product = deriveGroupProduct(
        prop(item, 'product'),
        prop(item, 'type'),
        prop(item, 'isFleet'),
        prop(item, 'isSearch'),
      );
      groups.push(product !== undefined ? { id, product } : { id });
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
    // The KV entry is bounded by the leader's request-body limit (a BYTE budget,
    // not an event count), and that limit is UNKNOWN and smaller than our budget
    // for some verbose log types (e.g. PAN-OS TRAFFIC). So: byte-cap first, then
    // SHRINK-ON-413 - each 413 halves the budget (trimming more events) and
    // retries until the write fits or a single event remains. This adapts to the
    // real limit without hard-coding it, and a stored TaggedSample carries the
    // per-event data three times (rawEvents + parsed.rawEvents + parsed.records)
    // so trimming events shrinks it fast.
    let budget = TAGGED_SAMPLE_MAX_BYTES;
    let capped = capTaggedSampleBytes(sample, budget);
    let res = await fetchWithTimeout(kvUrl(key), {
      method: 'PUT',
      body: JSON.stringify(capped.sample),
    });
    while (res.status === 413 && capped.keptEvents > 1) {
      budget = Math.floor(budget / 2);
      capped = capTaggedSampleBytes(sample, budget);
      res = await fetchWithTimeout(kvUrl(key), {
        method: 'PUT',
        body: JSON.stringify(capped.sample),
      });
    }
    if (capped.trimmed) {
      console.warn(
        `[tagged-samples] "${sample.logType}" stored ${capped.keptEvents} of ` +
          `${sample.rawEvents.length} events (trimmed to fit the KV size limit)`,
      );
    }
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
// SentinelContent (GitHub) - porting-plan Unit 14
// ---------------------------------------------------------------------------

// The Microsoft Sentinel content repo. LAZY per-solution tree queries only -
// NEVER a whole-repo recursive tree walk (the mirror-and-scan architecture
// deliberately does not port; catalog line 103). The PAT is injected
// server-side by proxies.yml on both hosts below; this adapter sets no
// Authorization header.
const SENTINEL_OWNER = 'Azure';
const SENTINEL_REPO = 'Azure-Sentinel';
const SENTINEL_BRANCH = 'master';
const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
// Proxied external requests hit a 30s server-side timeout; racing at 25s keeps
// the client-side failure loud and ahead of the platform's (same as ARM).
const GITHUB_TIMEOUT_MS = 25000;
const GITHUB_JSON_ACCEPT = 'application/vnd.github+json';

// Transient GitHub 5xx blips (502 Bad Gateway pages) are routine; retry a
// couple of times before surfacing (live report 2026-07-09: one 502 on a
// sample_data listing degraded the whole Sentinel browse tier).
const GITHUB_RETRY_STATUSES = new Set([500, 502, 503, 504]);
const GITHUB_RETRY_DELAYS_MS = [500, 1500];

async function githubFetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let res = await fetchWithTimeout(url, init, GITHUB_TIMEOUT_MS);
  for (const delay of GITHUB_RETRY_DELAYS_MS) {
    if (!GITHUB_RETRY_STATUSES.has(res.status)) {
      return res;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    res = await fetchWithTimeout(url, init, GITHUB_TIMEOUT_MS);
  }
  return res;
}

// A failed GitHub call answers with a FULL HTML error page (inline base64
// image included). Keep thrown messages human: strip tags, collapse
// whitespace, cap the length.
function errorSnippet(text: string): string {
  const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > 160 ? `${plain.slice(0, 160)}...` : plain;
}

// Encode a repo-relative path for a URL, preserving the "/" separators while
// percent-encoding each segment (paths carry spaces and parentheses, e.g.
// "Solutions/Forescout (Legacy)/...").
function encodeRepoPath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

// One entry of a GitHub "contents" directory listing (the fields used here).
interface GithubContentEntry {
  name: string;
  path: string;
  type: string;
  size?: number;
  sha?: string;
}

function asContentEntries(body: unknown): GithubContentEntry[] {
  if (!Array.isArray(body)) {
    return [];
  }
  const out: GithubContentEntry[] = [];
  for (const raw of body) {
    const name = prop(raw, 'name');
    const path = prop(raw, 'path');
    const type = prop(raw, 'type');
    if (typeof name === 'string' && typeof path === 'string' && typeof type === 'string') {
      const size = prop(raw, 'size');
      const sha = prop(raw, 'sha');
      out.push({
        name,
        path,
        type,
        ...(typeof size === 'number' ? { size } : {}),
        ...(typeof sha === 'string' ? { sha } : {}),
      });
    }
  }
  return out;
}

/**
 * SentinelContent over the proxied GitHub API (porting-plan Unit 14). Reads are
 * LAZY: listSolutions is one `contents/Solutions` call; listConnectorFiles is a
 * single per-solution `git/trees/{sha}?recursive=1` on the solution's connector
 * directory (a PER-SOLUTION subtree, never the whole repo). readFile/rawFetch
 * pull raw bytes from raw.githubusercontent.com. The PAT is injected server-side
 * (proxies.yml); this adapter never sets an Authorization header.
 *
 * Error semantics per the port: list methods resolve [] when the target is
 * absent (404); readFile/rawFetch resolve null for a missing file; a rejected
 * PAT (401/403) or other non-404 error REJECTS so the PAT UI can surface it.
 *
 * EDR guard: readFile/rawFetch resolve null for any Solutions/ path whose owning
 * solution is on the built-in blocklist, so IOC-laden rule content never leaves
 * the proxy toward a cache (harmless here - the cloud shell has no disk - but
 * kept identical to the local adapter where the disk-persistence guard is
 * MANDATORY; core edr-filter isPathAllowedByEdr).
 */
export class PlatformSentinelContent implements SentinelContent {
  private readonly blocked = blockedSolutionNames();

  private async apiGet(path: string): Promise<Response> {
    return githubFetchWithRetry(`${GITHUB_API}${path}`, {
      method: 'GET',
      headers: { Accept: GITHUB_JSON_ACCEPT },
    });
  }

  async getCommitSha(): Promise<string | null> {
    const res = await this.apiGet(
      `/repos/${SENTINEL_OWNER}/${SENTINEL_REPO}/commits/${SENTINEL_BRANCH}`,
    );
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GET GitHub commits/${SENTINEL_BRANCH}: HTTP ${res.status}\n${errorSnippet(await res.text())}`);
    }
    const sha = prop(await readPortBody(res), 'sha');
    return typeof sha === 'string' && sha !== '' ? sha : null;
  }

  async listSolutions(): Promise<SolutionRef[]> {
    const res = await this.apiGet(`/repos/${SENTINEL_OWNER}/${SENTINEL_REPO}/contents/Solutions`);
    if (res.status === 404) {
      return [];
    }
    if (!res.ok) {
      throw new Error(`GET GitHub contents/Solutions: HTTP ${res.status}\n${errorSnippet(await res.text())}`);
    }
    const entries = asContentEntries(await readPortBody(res));
    const refs: SolutionRef[] = [];
    for (const entry of entries) {
      if (entry.type !== 'dir') {
        continue;
      }
      // Index-time deprecation is NAME-BASED only (cheap, lazy); the full
      // content-based classifier (Solution_*.json / all-connectors) runs
      // per-solution when a solution is opened.
      const { deprecated, reason } = classifySolutionDeprecation({ name: entry.name });
      const ref: SolutionRef = { name: entry.name, path: entry.path };
      if (deprecated) {
        ref.deprecated = true;
        if (reason !== undefined) {
          ref.deprecationReason = reason;
        }
      }
      refs.push(ref);
    }
    refs.sort((a, b) => a.name.localeCompare(b.name));
    return refs;
  }

  async listSolutionFiles(solutionName: string, subDir: string): Promise<SolutionFileRef[]> {
    return this.listRepoFiles(`Solutions/${solutionName}/${subDir}`);
  }

  async listRepoFiles(dirPath: string): Promise<SolutionFileRef[]> {
    const res = await this.apiGet(
      `/repos/${SENTINEL_OWNER}/${SENTINEL_REPO}/contents/${encodeRepoPath(dirPath)}`,
    );
    if (res.status === 404) {
      return [];
    }
    if (!res.ok) {
      throw new Error(
        `GET GitHub contents ${dirPath}: HTTP ${res.status}\n${errorSnippet(await res.text())}`,
      );
    }
    const files: SolutionFileRef[] = [];
    for (const entry of asContentEntries(await readPortBody(res))) {
      if (entry.type === 'file') {
        files.push({ name: entry.name, path: entry.path, size: entry.size ?? 0 });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  async listConnectorFiles(solutionName: string): Promise<SolutionFileRef[]> {
    // 1) One level: find the connector directory variant this solution uses.
    const topRes = await this.apiGet(
      `/repos/${SENTINEL_OWNER}/${SENTINEL_REPO}/contents/${encodeRepoPath(`Solutions/${solutionName}`)}`,
    );
    if (topRes.status === 404) {
      return [];
    }
    if (!topRes.ok) {
      throw new Error(
        `GET GitHub contents Solutions/${solutionName}: HTTP ${topRes.status}\n${errorSnippet(await topRes.text())}`,
      );
    }
    const topEntries = asContentEntries(await readPortBody(topRes));
    const dirNames = topEntries.filter((e) => e.type === 'dir').map((e) => e.name);
    const connectorDir = findConnectorDirName(dirNames);
    if (connectorDir === null) {
      return [];
    }
    const connectorEntry = topEntries.find((e) => e.name === connectorDir && e.type === 'dir');
    if (connectorEntry?.sha === undefined) {
      return [];
    }
    // 2) One PER-SOLUTION recursive tree query on the connector subtree (NOT
    // the whole repo). Tree paths are relative to the connector directory.
    const treeRes = await this.apiGet(
      `/repos/${SENTINEL_OWNER}/${SENTINEL_REPO}/git/trees/${connectorEntry.sha}?recursive=1`,
    );
    if (!treeRes.ok) {
      throw new Error(
        `GET GitHub git/trees for Solutions/${solutionName}/${connectorDir}: HTTP ${treeRes.status}\n${await treeRes.text()}`,
      );
    }
    const tree = prop(await readPortBody(treeRes), 'tree');
    const prefix = `Solutions/${solutionName}/${connectorDir}/`;
    const allPaths: string[] = [];
    const sizeByPath = new Map<string, number>();
    if (Array.isArray(tree)) {
      for (const node of tree) {
        if (prop(node, 'type') !== 'blob') {
          continue;
        }
        const rel = prop(node, 'path');
        if (typeof rel !== 'string' || rel === '') {
          continue;
        }
        const full = `${prefix}${rel}`;
        allPaths.push(full);
        const size = prop(node, 'size');
        if (typeof size === 'number') {
          sizeByPath.set(full, size);
        }
      }
    }
    // Reuse the characterized recursive selection (the TEST 10 pin).
    return selectConnectorFiles(allPaths, solutionName, (p) => sizeByPath.get(p) ?? 0);
  }

  async readFile(relativePath: string): Promise<string | null> {
    if (!isPathAllowedByEdr(relativePath, this.blocked)) {
      return null;
    }
    return this.fetchRaw(`${GITHUB_RAW}/${SENTINEL_OWNER}/${SENTINEL_REPO}/${SENTINEL_BRANCH}/${encodeRepoPath(relativePath)}`, relativePath);
  }

  async rawFetch(relativePath: string, commitSha: string): Promise<string | null> {
    if (!isPathAllowedByEdr(relativePath, this.blocked)) {
      return null;
    }
    const ref = commitSha === '' ? SENTINEL_BRANCH : commitSha;
    return this.fetchRaw(`${GITHUB_RAW}/${SENTINEL_OWNER}/${SENTINEL_REPO}/${ref}/${encodeRepoPath(relativePath)}`, relativePath);
  }

  private async fetchRaw(url: string, relativePath: string): Promise<string | null> {
    const res = await githubFetchWithRetry(url, { method: 'GET' });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GET raw ${relativePath}: HTTP ${res.status}\n${errorSnippet(await res.text())}`);
    }
    return res.text();
  }
}

// ---------------------------------------------------------------------------
// RemoteSampleSource (Elastic integrations + Cribl packs) - porting-plan Unit 16
// ---------------------------------------------------------------------------

const ELASTIC_OWNER_REPO = 'elastic/integrations';
const ELASTIC_BRANCH = 'main';
const CRIBLPACKS_OWNER = 'criblpacks';
const CRIBLPACKS_BRANCH = 'main';

// The Elastic test-pipeline raw sample files: the .log inputs and .json inputs,
// excluding the pipeline's -expected outputs and -config files (legacy filter).
function isElasticSampleFile(name: string): boolean {
  return (
    name.endsWith('.log') ||
    (name.endsWith('.json') && !name.includes('-expected') && !name.includes('-config'))
  );
}

/**
 * RemoteSampleSource over the proxied GitHub API (porting-plan Unit 16): the two
 * sibling repos the SentinelContent port cannot address. Elastic test-pipeline
 * files for a package + data stream (raw vendor samples) and a Cribl pack repo's
 * data/samples. Same hosts as PlatformSentinelContent (api.github.com +
 * raw.githubusercontent.com); the PAT is injected server-side (proxies.yml), so
 * this adapter never sets an Authorization header. A missing directory (404)
 * resolves to []; a missing raw file resolves to null and is skipped.
 */
export class PlatformRemoteSampleSource implements RemoteSampleSource {
  private async listContents(path: string): Promise<GithubContentEntry[]> {
    const res = await githubFetchWithRetry(`${GITHUB_API}${path}`, {
      method: 'GET',
      headers: { Accept: GITHUB_JSON_ACCEPT },
    });
    if (res.status === 404) {
      return [];
    }
    if (!res.ok) {
      throw new Error(`GET GitHub ${path}: HTTP ${res.status}\n${errorSnippet(await res.text())}`);
    }
    return asContentEntries(await readPortBody(res));
  }

  private async fetchRawText(url: string): Promise<string | null> {
    const res = await githubFetchWithRetry(url, { method: 'GET' });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GET raw ${url}: HTTP ${res.status}`);
    }
    return res.text();
  }

  async listElasticTestFiles(packageName: string, stream: string): Promise<FetchedSampleFile[]> {
    const dir = `packages/${packageName}/data_stream/${stream}/_dev/test/pipeline`;
    const entries = await this.listContents(
      `/repos/${ELASTIC_OWNER_REPO}/contents/${encodeRepoPath(dir)}`,
    );
    const out: FetchedSampleFile[] = [];
    for (const e of entries) {
      if (e.type !== 'file' || !isElasticSampleFile(e.name)) {
        continue;
      }
      const text = await this.fetchRawText(
        `${GITHUB_RAW}/${ELASTIC_OWNER_REPO}/${ELASTIC_BRANCH}/${encodeRepoPath(`${dir}/${e.name}`)}`,
      );
      if (text !== null) {
        out.push({ fileName: e.name, content: text });
      }
    }
    return out;
  }

  async listCriblPackSamples(repoName: string): Promise<FetchedSampleFile[]> {
    const dir = 'data/samples';
    const entries = await this.listContents(
      `/repos/${CRIBLPACKS_OWNER}/${repoName}/contents/${dir}`,
    );
    const out: FetchedSampleFile[] = [];
    for (const e of entries) {
      if (e.type !== 'file') {
        continue;
      }
      const text = await this.fetchRawText(
        `${GITHUB_RAW}/${CRIBLPACKS_OWNER}/${repoName}/${CRIBLPACKS_BRANCH}/${dir}/${encodeURIComponent(e.name)}`,
      );
      if (text !== null) {
        out.push({ fileName: e.name, content: text });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// ContentCache (KV) - porting-plan Unit 14
// ---------------------------------------------------------------------------

// Parsed content-cache entries live under this plain (unencrypted) KV prefix,
// keyed by a HASH of the @soc/core contentCacheKey. Only PARSED results are
// cached here - never raw bytes - and they are not secrets.
//
// KV KEY SHAPE: the leader's KV store only reliably round-trips a key that is a
// SINGLE path segment of [A-Za-z0-9-] - the shape proven live (`githubPat`,
// `spike-plain`). The @soc/core cache key uses `~` separators plus `_ . /`
// segment characters; the original `content-cache/` + encodeURIComponent form
// 404'd against the real leader (it rejects the extra path segment / escaped
// chars). Rather than depend on which characters the leader accepts, hash the
// logical key to hex so the physical KV key is always `content-cache-<hex>`:
// one segment, [a-z0-9-], and still prefix-listable under `content-cache-`.
const CONTENT_CACHE_KV_PREFIX = 'content-cache-';

/**
 * Deterministic 64-bit hex key (two rolling 32-bit FNV-style accumulators) for a
 * content cache entry. No crypto/Date; the collision space is ample for a
 * per-commit content cache and the physical key is always KV-path-safe.
 */
function contentCacheKvKey(cacheKey: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < cacheKey.length; i++) {
    const c = cacheKey.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return (
    CONTENT_CACHE_KV_PREFIX +
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0')
  );
}

/**
 * ContentCache over plain KV entries (porting-plan Unit 14). The @soc/core
 * cache keys embed the commit SHA, so entries self-invalidate on a new commit;
 * this adapter only stores/reads the JSON-serialized parsed value.
 */
export class KvContentCache implements ContentCache {
  private key(cacheKey: string): string {
    return contentCacheKvKey(cacheKey);
  }

  async get(cacheKey: string): Promise<unknown | null> {
    const res = await fetchWithTimeout(kvUrl(this.key(cacheKey)));
    if (res.status === 404 || res.status === 403) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GET content-cache ${cacheKey}: HTTP ${res.status}\n${await res.text()}`);
    }
    const text = await res.text();
    if (text === '') {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A corrupt entry reads as a miss rather than poisoning the caller.
      return null;
    }
  }

  async set(cacheKey: string, value: unknown): Promise<void> {
    const res = await fetchWithTimeout(kvUrl(this.key(cacheKey)), {
      method: 'PUT',
      body: JSON.stringify(value),
    });
    if (!res.ok) {
      throw new Error(`PUT content-cache ${cacheKey}: HTTP ${res.status}\n${await res.text()}`);
    }
  }
}

// ---------------------------------------------------------------------------
// GithubPatManager (KV) - porting-plan Unit 14
// ---------------------------------------------------------------------------

// The FIXED encrypted KV key proxies.yml injects as `Bearer ${kv.githubPat}` on
// api.github.com / raw.githubusercontent.com requests. Write-only, like
// azureBasic/azureArmToken - it can never be read back.
const GITHUB_PAT_KV_KEY = 'githubPat';
// A plain, READABLE companion holding only the non-secret status (hasPat +
// login) so status() can report without ever touching the token.
const GITHUB_PAT_STATUS_KEY = 'githubPatStatus';

/**
 * GithubPatManager over the KV store (porting-plan Unit 14; ENG-30).
 *
 * PLATFORM CONSTRAINT drives the order: proxies.yml injects the PAT from the
 * encrypted KV slot, so a token can only be validated (GET /user) AFTER it is
 * stored. validateAndStore therefore STORES the encrypted token first, calls
 * GET /user through the proxy, and on a non-2xx ROLLS BACK (deletes the token
 * and clears the status) - the net effect is still "only a valid token
 * persists". The token never crosses back to the renderer: status() reads the
 * plain githubPatStatus companion (hasPat + login), never the secret.
 */
export class PlatformGithubPat implements GithubPatManager {
  async status(): Promise<PatManagerStatus> {
    const res = await fetchWithTimeout(kvUrl(GITHUB_PAT_STATUS_KEY));
    if (res.status === 404 || res.status === 403) {
      return { hasPat: false };
    }
    if (!res.ok) {
      throw new Error(`GET ${GITHUB_PAT_STATUS_KEY}: HTTP ${res.status}\n${await res.text()}`);
    }
    const text = await res.text();
    if (text === '') {
      return { hasPat: false };
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      const hasPat = prop(parsed, 'hasPat') === true;
      const login = prop(parsed, 'login');
      return hasPat
        ? { hasPat: true, ...(typeof login === 'string' ? { login } : {}) }
        : { hasPat: false };
    } catch {
      return { hasPat: false };
    }
  }

  async validateAndStore(pat: string): Promise<PatManagerStatus> {
    const formatIssue = patFormatIssue(pat);
    if (formatIssue !== null) {
      return { hasPat: false, error: formatIssue };
    }
    // Store encrypted FIRST so proxies.yml can inject it on the validation call.
    const putRes = await fetchWithTimeout(kvUrl(`${GITHUB_PAT_KV_KEY}?encrypted=true`), {
      method: 'PUT',
      body: pat,
    });
    if (!putRes.ok) {
      throw new Error(`PUT ${GITHUB_PAT_KV_KEY}?encrypted=true: HTTP ${putRes.status}\n${await putRes.text()}`);
    }
    // Validate: GET /user with the just-stored token (injected server-side).
    let userRes: Response;
    try {
      userRes = await fetchWithTimeout(
        `${GITHUB_API}/user`,
        { method: 'GET', headers: { Accept: GITHUB_JSON_ACCEPT } },
        GITHUB_TIMEOUT_MS,
      );
    } catch (err) {
      // Transport failure: roll back the provisional token, then surface.
      await this.clear();
      throw err;
    }
    if (userRes.ok) {
      const login = prop(await readPortBody(userRes), 'login');
      const status = patStatusFrom({
        ok: true,
        ...(typeof login === 'string' ? { login } : {}),
      });
      await fetchWithTimeout(kvUrl(GITHUB_PAT_STATUS_KEY), {
        method: 'PUT',
        body: JSON.stringify(status),
      });
      return status;
    }
    // Invalid token: roll it back so nothing usable persists.
    await this.clear();
    const detail =
      userRes.status === 401
        ? 'GitHub rejected the token (HTTP 401) - it is invalid, expired, or revoked.'
        : userRes.status === 403
          ? 'GitHub refused the token (HTTP 403) - it may be rate-limited or lack access.'
          : `GitHub validation failed (HTTP ${userRes.status}).`;
    return { hasPat: false, error: detail };
  }

  async clear(): Promise<void> {
    // Independent fire-and-forget deletes: KV DELETE responses are lost by the
    // bridge, so never sequence one after another (kvDelete owns that quirk).
    kvDelete(GITHUB_PAT_KV_KEY);
    kvDelete(GITHUB_PAT_STATUS_KEY);
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// PackRecordStore (KV) - porting-plan Unit 19 (ENG-09)
// ---------------------------------------------------------------------------

// Each pack build is one plain (unencrypted) KV entry under pack-builds/{id};
// the flat pack-builds-index entry holds the JSON array of ids in insert order.
// Kept outside the pack-builds/ prefix so a prefix listing of records never
// returns the index itself (same shape as PlatformJobStore). The stored value
// is the StoredPack {record, definition} - the DEFINITION, not the archive
// bytes: cloud regenerates the identical .crbl on demand (2026-07-04 decision),
// so a KV entry stays small.
const PACK_BUILD_KEY_PREFIX = 'pack-builds/';
const PACK_BUILD_INDEX_KEY = 'pack-builds-index';

function packBuildKey(id: string): string {
  return `${PACK_BUILD_KEY_PREFIX}${encodeURIComponent(id)}`;
}

/**
 * PackRecordStore over plain KV entries. Upsert PUTs the entry and appends the
 * id to the index only when new; delete removes the entry and prunes the index;
 * list walks the index and GETs each entry, skipping any that 404. Cloud NEVER
 * writes archive bytes here (no cachedCrblBase64) - only the definition, so the
 * UI regenerates deterministically. Last-writer-wins; single-operator UI.
 */
export class PlatformPackStore implements PackRecordStore {
  async list(): Promise<StoredPack[]> {
    const ids = await this.readIndex();
    const packs: StoredPack[] = [];
    for (const id of ids) {
      const pack = await this.get(id);
      if (pack !== null) {
        packs.push(pack);
      }
    }
    return packs;
  }

  async get(id: string): Promise<StoredPack | null> {
    const res = await fetchWithTimeout(kvUrl(packBuildKey(id)));
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GET kvstore/${packBuildKey(id)}: HTTP ${res.status}\n${await res.text()}`);
    }
    const text = await res.text();
    if (text === '') {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`pack build ${packBuildKey(id)} is not valid JSON`);
    }
    if (typeof prop(prop(parsed, 'record'), 'id') !== 'string') {
      throw new Error(`pack build ${packBuildKey(id)} has an unexpected shape\n${text}`);
    }
    // Written exclusively by this adapter as serialized StoredPacks, so after
    // the shape check the cast is sound (same reasoning as the KV JobRecords).
    return parsed as StoredPack;
  }

  async put(pack: StoredPack): Promise<void> {
    const id = pack.record.id;
    if (id === '') {
      throw new Error('PlatformPackStore.put: record.id must be non-empty');
    }
    // Cloud never persists the archive bytes (KV size); drop any cache before
    // writing so the entry stays a small definition.
    const toStore: StoredPack = { record: pack.record, definition: pack.definition };
    const res = await fetchWithTimeout(kvUrl(packBuildKey(id)), {
      method: 'PUT',
      body: JSON.stringify(toStore),
    });
    if (!res.ok) {
      throw new Error(`PUT kvstore/${packBuildKey(id)}: HTTP ${res.status}\n${await res.text()}`);
    }
    const index = await this.readIndex();
    if (!index.includes(id)) {
      index.push(id);
      await this.writeIndex(index);
    }
  }

  async delete(id: string): Promise<void> {
    // kvDelete owns the platform quirk: the delete is processed server-side but
    // its response may be lost by the bridge, so nothing is sequenced on it.
    await kvDelete(packBuildKey(id));
    const index = await this.readIndex();
    const next = index.filter((x) => x !== id);
    if (next.length !== index.length) {
      await this.writeIndex(next);
    }
  }

  private async readIndex(): Promise<string[]> {
    const res = await fetchWithTimeout(kvUrl(PACK_BUILD_INDEX_KEY));
    if (res.status === 404) {
      return [];
    }
    if (!res.ok) {
      throw new Error(`GET kvstore/${PACK_BUILD_INDEX_KEY}: HTTP ${res.status}\n${await res.text()}`);
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
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  }

  private async writeIndex(ids: string[]): Promise<void> {
    const res = await fetchWithTimeout(kvUrl(PACK_BUILD_INDEX_KEY), {
      method: 'PUT',
      body: JSON.stringify(ids),
    });
    if (!res.ok) {
      throw new Error(`PUT kvstore/${PACK_BUILD_INDEX_KEY}: HTTP ${res.status}\n${await res.text()}`);
    }
  }
}

// ---------------------------------------------------------------------------
// PackInstallClient - porting-plan Unit 19 (ENG-07/28)
// ---------------------------------------------------------------------------

// Render a CriblClient response body (parsed JSON or raw text) back to the
// string the @soc/core install interpreters expect (they JSON.parse / substring
// it). null becomes '' so a bodyless response interprets cleanly.
function criblBodyText(body: unknown): string {
  if (body === null || body === undefined) {
    return '';
  }
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
 * PackInstallClient over the hosting workspace's own product API. The two-step
 * upload protocol and its decision rules are @soc/core's: the binary PUT
 * ?filename= (raw octet-stream; the platform proxy injects auth), then the
 * randomized `source` from parseUploadResponse drives the JSON POST install; a
 * duplicate-conflict (interpretInstallResponse === 'conflict') deletes the
 * existing pack (id from packIdFromCrblFileName) and retries once. Deployed
 * status is read from each group's live packs list (parsePackListResponse) -
 * never from local storage. JSON ops reuse the injected CriblClient (auth,
 * groupId prefixing); only the binary PUT is done directly.
 */
export class PlatformPackInstall implements PackInstallClient {
  private readonly cribl: CriblClient;

  constructor(cribl: CriblClient) {
    this.cribl = cribl;
  }

  async listDeployed(groups: readonly string[]): Promise<DeployedGroupPacks[]> {
    const out: DeployedGroupPacks[] = [];
    for (const group of groups) {
      const res = await this.cribl.request({ method: 'GET', path: '/packs', groupId: group });
      const parsed = parsePackListResponse(res.status, criblBodyText(res.body));
      out.push({ group, packs: parsed.ok ? parsed.packs : [] });
    }
    return out;
  }

  async install(group: string, fileName: string, crbl: Uint8Array): Promise<InstalledPack> {
    // Step 1: binary PUT ?filename= directly against the workspace API (the
    // JSON CriblClient cannot carry an octet-stream body). Auth is proxy-injected.
    const uploadUrl =
      `${window.CRIBL_API_URL}/m/${encodeURIComponent(group)}` +
      `/packs?filename=${encodeURIComponent(fileName)}`;
    const putRes = await fetchWithTimeout(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(crbl),
    });
    const upload = parseUploadResponse(putRes.status, await putRes.text());
    if (!upload.ok) {
      throw new Error(upload.error);
    }

    // Step 2: POST the returned (randomized) source; on a duplicate conflict,
    // delete the existing pack and retry once.
    let outcome = interpretInstallResponse(...(await this.postInstall(group, upload.source)));
    if (outcome.kind === 'conflict') {
      const packId = packIdFromCrblFileName(fileName);
      await this.cribl.request({
        method: 'DELETE',
        path: `/packs/${encodeURIComponent(packId)}`,
        groupId: group,
      });
      outcome = interpretInstallResponse(...(await this.postInstall(group, upload.source)));
    }
    if (outcome.kind !== 'installed') {
      throw new Error(outcome.kind === 'conflict' ? 'Pack install still conflicts after delete-and-retry' : outcome.error);
    }
    return outcome.pack;
  }

  // POST /packs {source} in the group context; returns [status, bodyText] for
  // the @soc/core interpreter.
  private async postInstall(group: string, source: string): Promise<[number, string]> {
    const res = await this.cribl.request({
      method: 'POST',
      path: '/packs',
      groupId: group,
      body: { source },
    });
    return [res.status, criblBodyText(res.body)];
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
  /** Lazy Sentinel content over the proxied GitHub API (porting-plan Unit 14). */
  content: SentinelContent;
  /** Parsed-content cache over plain KV entries, keyed by solution+commit (Unit 14). */
  contentCache: ContentCache;
  /** Elastic + Cribl-pack raw sample fetch over the proxied GitHub API (Unit 16). */
  sampleSource: RemoteSampleSource;
  /** GitHub PAT lifecycle: validate-then-store, hasPat-only (Unit 14). */
  githubPat: GithubPatManager;
  /** Pack build-record store over plain KV entries - definitions only (Unit 19). */
  packs: PackRecordStore;
  /** Pack install + deployed-status client over the workspace API (Unit 19). */
  packInstall: PackInstallClient;
  /** Entra directory reader for the ingestion service-principal picker (B3). */
  graph: GraphDirectory;
  /**
   * Shell-minted GUID provider for role-assignment names (Unit 8, ENG-37
   * runtime half). The SHELL owns id conventions - @soc/core never mints - so
   * the assign-dcr-role usecase takes its per-assignment name from here. The
   * platform iframe has Web Crypto; randomUUID yields the RFC 4122 v4 GUID ARM
   * expects for a roleAssignments name.
   */
  mintAssignmentName: () => string;
  /** The shell's Logger (platform/logger.ts PlatformLogger instance). */
  logger: Logger;
  /**
   * The Cribl deployment flavor (porting-plan Unit 20): the app runs INSIDE a
   * Cribl.Cloud workspace, so this is always "cloud" - it enables the cloud-only
   * Cribl Lake federation in the post-deploy source wiring.
   */
  criblDeploymentType: 'cloud' | 'onprem';
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
  // One CriblClient shared with the pack installer (it reuses request() for the
  // JSON install/list/delete ops; only the binary upload is done directly).
  const cribl = new PlatformCriblClient();
  return {
    secrets: new PlatformSecretsStore(),
    azure: new PlatformAzureManagement(tenantId),
    cribl,
    jobs: new PlatformJobStore(),
    user: new PlatformUserContext(),
    artifacts: new PlatformArtifactSink(),
    samples: new PlatformTaggedSampleStore(),
    content: new PlatformSentinelContent(),
    contentCache: new KvContentCache(),
    sampleSource: new PlatformRemoteSampleSource(),
    githubPat: new PlatformGithubPat(),
    packs: new PlatformPackStore(),
    packInstall: new PlatformPackInstall(cribl),
    graph: new PlatformGraphDirectory(tenantId),
    mintAssignmentName: () => crypto.randomUUID(),
    logger,
    // The app is hosted inside a Cribl.Cloud workspace: Lake federation applies.
    criblDeploymentType: 'cloud',
  };
}
