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
  ContentCache,
  CriblClient,
  CriblGroupSummary,
  CriblRequest,
  GithubPatManager,
  JobRecord,
  JobStore,
  Logger,
  PatManagerStatus,
  PortHttpResponse,
  SecretSetOptions,
  SecretsStore,
  SentinelContent,
  SolutionFileRef,
  SolutionRef,
  TaggedSample,
  TaggedSampleStore,
  UserContext,
  UserIdentity,
} from '@soc/core';
import type { InstalledPack } from '@soc/core';
import {
  blockedSolutionNames,
  classifySolutionDeprecation,
  findConnectorDirName,
  interpretInstallResponse,
  isPathAllowedByEdr,
  packIdFromCrblFileName,
  parsePackListResponse,
  parseUploadResponse,
  selectConnectorFiles,
} from '@soc/core';
// Pack store + install-client contracts are @soc/ui-owned ports; the LocalPorts
// bundle satisfies them structurally.
import type {
  DeployedGroupPacks,
  PackInstallClient,
  PackRecordStore,
  StoredPack,
} from '@soc/ui';

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
// TaggedSampleStore
// ---------------------------------------------------------------------------

/** URL for one tagged sample; encodeURIComponent keeps odd log types intact. */
function taggedSampleUrl(logType: string): string {
  return `/api/tagged-samples/${encodeURIComponent(logType)}`;
}

/** Shape guard for a host-returned tagged sample (the host validates on write). */
function isTaggedSampleShape(value: unknown): value is TaggedSample {
  return (
    typeof prop(value, 'logType') === 'string' &&
    typeof prop(value, 'format') === 'string' &&
    Array.isArray(prop(value, 'rawEvents')) &&
    typeof prop(value, 'parsed') === 'object' &&
    prop(value, 'parsed') !== null
  );
}

/**
 * TaggedSampleStore over the host's /api/tagged-samples endpoints
 * (data/tagged-samples.json on the host side). The host owns replace-by-logType
 * semantics and first-upsert ordering - the same contract as the cloud
 * PlatformTaggedSampleStore (porting-plan Unit 11).
 */
export class LocalTaggedSampleStore implements TaggedSampleStore {
  async upsert(sample: TaggedSample): Promise<void> {
    const res = await fetchWithTimeout('/api/tagged-samples', jsonInit('POST', sample));
    if (!res.ok) {
      throw await hostError('POST /api/tagged-samples', res);
    }
  }

  async get(logType: string): Promise<TaggedSample | null> {
    const payload = await hostJson(`GET /api/tagged-samples/${logType}`, taggedSampleUrl(logType));
    const sample = prop(payload, 'sample');
    return isTaggedSampleShape(sample) ? sample : null;
  }

  async list(): Promise<TaggedSample[]> {
    const payload = await hostJson('GET /api/tagged-samples', '/api/tagged-samples');
    if (!Array.isArray(payload)) {
      throw new Error('GET /api/tagged-samples: unexpected host response shape (expected an array)');
    }
    return payload.filter(isTaggedSampleShape);
  }

  async remove(logType: string): Promise<void> {
    const res = await fetchWithTimeout(taggedSampleUrl(logType), { method: 'DELETE' });
    if (!res.ok) {
      throw await hostError(`DELETE /api/tagged-samples/${logType}`, res);
    }
  }
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
// SentinelContent (GitHub) - porting-plan Unit 14
// ---------------------------------------------------------------------------

// The Microsoft Sentinel content repo (same targets as the cloud adapter).
// LAZY per-solution tree queries only - never a whole-repo recursive tree walk.
const SENTINEL_OWNER = 'Azure';
const SENTINEL_REPO = 'Azure-Sentinel';
const SENTINEL_BRANCH = 'master';
const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';

// Encode a repo-relative path for a URL, preserving "/" while percent-encoding
// each segment (paths carry spaces/parentheses).
function encodeRepoPath(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** One entry of a GitHub "contents" directory listing (fields used here). */
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
 * SentinelContent over the host's GitHub proxy (POST /api/github/request),
 * porting-plan Unit 14. The transport differs from the cloud adapter (the host
 * attaches the PAT and returns { status, body } with BODY as raw text), but the
 * shape and laziness are identical: listSolutions is one contents call,
 * listConnectorFiles is a single per-solution git/trees query on the connector
 * subtree, readFile/rawFetch pull raw file text.
 *
 * EDR GUARD (MANDATORY - local disk persistence): readFile/rawFetch resolve null
 * for any Solutions/ path whose owning solution is on the built-in EDR
 * blocklist (core isPathAllowedByEdr), so blocklisted IOC-laden rule content
 * never reaches the browser and therefore never lands in the host's on-disk
 * content cache. This is the single enforcement point the catalog requires on
 * the disk-persistence path.
 */
export class LocalSentinelContent implements SentinelContent {
  private readonly blocked = blockedSolutionNames();

  // One proxied GitHub GET via the host: returns { status, bodyText }.
  private async proxied(url: string): Promise<{ status: number; bodyText: string }> {
    const payload = await hostJson(
      `POST /api/github/request (${url})`,
      '/api/github/request',
      jsonInit('POST', { url }),
      PROXY_TIMEOUT_MS
    );
    const status = prop(payload, 'status');
    const body = prop(payload, 'body');
    if (typeof status !== 'number') {
      throw new Error(`POST /api/github/request: unexpected host response shape (missing numeric "status")`);
    }
    return { status, bodyText: typeof body === 'string' ? body : '' };
  }

  // A proxied GitHub API (JSON) GET: parse the raw text body, or throw with the
  // status on a non-2xx that the caller does not translate to [] / null.
  private async apiJson(apiPath: string): Promise<{ status: number; value: unknown }> {
    const { status, bodyText } = await this.proxied(`${GITHUB_API}${apiPath}`);
    if (status === 404) {
      return { status, value: null };
    }
    if (status < 200 || status >= 300) {
      throw new Error(`GET GitHub ${apiPath}: HTTP ${status}${bodyText === '' ? '' : `\n${bodyText}`}`);
    }
    let value: unknown = null;
    try {
      value = bodyText === '' ? null : JSON.parse(bodyText);
    } catch {
      value = null;
    }
    return { status, value };
  }

  async getCommitSha(): Promise<string | null> {
    const { status, value } = await this.apiJson(
      `/repos/${SENTINEL_OWNER}/${SENTINEL_REPO}/commits/${SENTINEL_BRANCH}`
    );
    if (status === 404) {
      return null;
    }
    const sha = prop(value, 'sha');
    return typeof sha === 'string' && sha !== '' ? sha : null;
  }

  async listSolutions(): Promise<SolutionRef[]> {
    const { status, value } = await this.apiJson(
      `/repos/${SENTINEL_OWNER}/${SENTINEL_REPO}/contents/Solutions`
    );
    if (status === 404) {
      return [];
    }
    const refs: SolutionRef[] = [];
    for (const entry of asContentEntries(value)) {
      if (entry.type !== 'dir') {
        continue;
      }
      // Index-time deprecation is NAME-BASED only (cheap, lazy).
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
    const { status, value } = await this.apiJson(
      `/repos/${SENTINEL_OWNER}/${SENTINEL_REPO}/contents/${encodeRepoPath(
        `Solutions/${solutionName}/${subDir}`
      )}`
    );
    if (status === 404) {
      return [];
    }
    const files: SolutionFileRef[] = [];
    for (const entry of asContentEntries(value)) {
      if (entry.type === 'file') {
        files.push({ name: entry.name, path: entry.path, size: entry.size ?? 0 });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  async listConnectorFiles(solutionName: string): Promise<SolutionFileRef[]> {
    const top = await this.apiJson(
      `/repos/${SENTINEL_OWNER}/${SENTINEL_REPO}/contents/${encodeRepoPath(`Solutions/${solutionName}`)}`
    );
    if (top.status === 404) {
      return [];
    }
    const topEntries = asContentEntries(top.value);
    const dirNames = topEntries.filter((e) => e.type === 'dir').map((e) => e.name);
    const connectorDir = findConnectorDirName(dirNames);
    if (connectorDir === null) {
      return [];
    }
    const connectorEntry = topEntries.find((e) => e.name === connectorDir && e.type === 'dir');
    if (connectorEntry?.sha === undefined) {
      return [];
    }
    // One PER-SOLUTION recursive tree query on the connector subtree.
    const tree = await this.apiJson(
      `/repos/${SENTINEL_OWNER}/${SENTINEL_REPO}/git/trees/${connectorEntry.sha}?recursive=1`
    );
    const nodes = prop(tree.value, 'tree');
    const prefix = `Solutions/${solutionName}/${connectorDir}/`;
    const allPaths: string[] = [];
    const sizeByPath = new Map<string, number>();
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
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
    return selectConnectorFiles(allPaths, solutionName, (p) => sizeByPath.get(p) ?? 0);
  }

  async readFile(relativePath: string): Promise<string | null> {
    if (!isPathAllowedByEdr(relativePath, this.blocked)) {
      return null;
    }
    return this.fetchRaw(
      `${GITHUB_RAW}/${SENTINEL_OWNER}/${SENTINEL_REPO}/${SENTINEL_BRANCH}/${encodeRepoPath(relativePath)}`,
      relativePath
    );
  }

  async rawFetch(relativePath: string, commitSha: string): Promise<string | null> {
    if (!isPathAllowedByEdr(relativePath, this.blocked)) {
      return null;
    }
    const ref = commitSha === '' ? SENTINEL_BRANCH : commitSha;
    return this.fetchRaw(
      `${GITHUB_RAW}/${SENTINEL_OWNER}/${SENTINEL_REPO}/${ref}/${encodeRepoPath(relativePath)}`,
      relativePath
    );
  }

  private async fetchRaw(url: string, relativePath: string): Promise<string | null> {
    const { status, bodyText } = await this.proxied(url);
    if (status === 404) {
      return null;
    }
    if (status < 200 || status >= 300) {
      throw new Error(`GET raw ${relativePath}: HTTP ${status}${bodyText === '' ? '' : `\n${bodyText}`}`);
    }
    return bodyText;
  }
}

// ---------------------------------------------------------------------------
// ContentCache (host store) - porting-plan Unit 14
// ---------------------------------------------------------------------------

// URL for one content-cache entry; encodeURIComponent keeps the ':'-bearing
// @soc/core cache keys intact as a single path segment.
function contentCacheUrl(key: string): string {
  return `/api/content-cache/${encodeURIComponent(key)}`;
}

/**
 * ContentCache over the host's /api/content-cache endpoints (data/content-cache
 * .json), porting-plan Unit 14. Only PARSED results are cached; the cache key
 * embeds the commit SHA so entries self-invalidate on a new commit.
 */
export class LocalContentCache implements ContentCache {
  async get(key: string): Promise<unknown | null> {
    const payload = await hostJson(`GET ${contentCacheUrl(key)}`, contentCacheUrl(key));
    const value = prop(payload, 'value');
    return value === undefined ? null : value;
  }

  async set(key: string, value: unknown): Promise<void> {
    const res = await fetchWithTimeout(contentCacheUrl(key), jsonInit('PUT', { value }));
    if (!res.ok) {
      throw await hostError(`PUT ${contentCacheUrl(key)}`, res);
    }
  }
}

// ---------------------------------------------------------------------------
// GithubPatManager (host store) - porting-plan Unit 14
// ---------------------------------------------------------------------------

/** Shape-guard a host PatManagerStatus payload. */
function asPatStatus(label: string, payload: unknown): PatManagerStatus {
  const hasPat = prop(payload, 'hasPat');
  if (typeof hasPat !== 'boolean') {
    throw new Error(`${label}: unexpected host response shape (missing boolean "hasPat")`);
  }
  const login = prop(payload, 'login');
  const error = prop(payload, 'error');
  return {
    hasPat,
    ...(typeof login === 'string' ? { login } : {}),
    ...(typeof error === 'string' ? { error } : {}),
  };
}

/**
 * GithubPatManager over the host's /api/github/pat endpoints (porting-plan Unit
 * 14; ENG-30). The HOST owns validate-then-store and holds the token in
 * data/github.json server-side; this adapter only ever sees { hasPat, login }.
 */
export class LocalGithubPat implements GithubPatManager {
  async status(): Promise<PatManagerStatus> {
    return asPatStatus('GET /api/github/pat', await hostJson('GET /api/github/pat', '/api/github/pat'));
  }

  async validateAndStore(pat: string): Promise<PatManagerStatus> {
    return asPatStatus(
      'PUT /api/github/pat',
      await hostJson('PUT /api/github/pat', '/api/github/pat', jsonInit('PUT', { pat }), PROXY_TIMEOUT_MS)
    );
  }

  async clear(): Promise<void> {
    const res = await fetchWithTimeout('/api/github/pat', { method: 'DELETE' });
    if (!res.ok) {
      throw await hostError('DELETE /api/github/pat', res);
    }
  }
}

// ---------------------------------------------------------------------------
// PackRecordStore (host store) - porting-plan Unit 19 (ENG-09)
// ---------------------------------------------------------------------------

/** URL for one pack build record; encodeURIComponent keeps odd ids intact. */
function packUrl(id: string): string {
  return `/api/packs/${encodeURIComponent(id)}`;
}

/** Shape-guard a host-returned StoredPack (the host validates on write). */
function isStoredPackShape(value: unknown): value is StoredPack {
  const record = prop(value, 'record');
  return (
    typeof prop(record, 'id') === 'string' &&
    prop(record, 'id') !== '' &&
    prop(value, 'definition') !== undefined
  );
}

/**
 * PackRecordStore over the host's /api/packs endpoints (data/packs.json on the
 * host side). The host owns upsert-by-record-id and insert ordering - the same
 * contract as the cloud PlatformPackStore, storing the StoredPack definition so
 * the UI regenerates the .crbl deterministically.
 */
export class LocalPackStore implements PackRecordStore {
  async list(): Promise<StoredPack[]> {
    const payload = await hostJson('GET /api/packs', '/api/packs');
    if (!Array.isArray(payload)) {
      throw new Error('GET /api/packs: unexpected host response shape (expected an array)');
    }
    return payload.filter(isStoredPackShape);
  }

  async get(id: string): Promise<StoredPack | null> {
    const payload = await hostJson(`GET /api/packs/${id}`, packUrl(id));
    const pack = prop(payload, 'pack');
    return isStoredPackShape(pack) ? pack : null;
  }

  async put(pack: StoredPack): Promise<void> {
    const res = await fetchWithTimeout('/api/packs', jsonInit('POST', pack));
    if (!res.ok) {
      throw await hostError('POST /api/packs', res);
    }
  }

  async delete(id: string): Promise<void> {
    const res = await fetchWithTimeout(packUrl(id), { method: 'DELETE' });
    if (!res.ok) {
      throw await hostError(`DELETE /api/packs/${id}`, res);
    }
  }
}

// ---------------------------------------------------------------------------
// PackInstallClient - porting-plan Unit 19 (ENG-07/28)
// ---------------------------------------------------------------------------

// Render a CriblClient response body (parsed JSON or raw text) back to the
// string the @soc/core install interpreters expect.
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

// Base64-encode raw bytes for the JSON upload envelope (the host decodes it
// back to a Buffer and PUTs the octet-stream to the leader).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * PackInstallClient over the host. The @soc/core install DECISION LOGIC lives
 * here (browser side): the binary upload rides POST /api/cribl/upload (the host
 * PUTs the octet-stream to the leader), parseUploadResponse reads the randomized
 * source, then the JSON POST install / DELETE conflict retry ride the shared
 * CriblClient (LocalCriblClient over /api/cribl/request). Deployed status is the
 * live packs list per group (parsePackListResponse) - never local storage.
 */
export class LocalPackInstall implements PackInstallClient {
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
    // Step 1: upload the bytes through the host's octet-stream proxy.
    const uploadPayload = await hostJson(
      'POST /api/cribl/upload',
      '/api/cribl/upload',
      jsonInit('POST', { groupId: group, fileName, crblBase64: bytesToBase64(crbl) }),
      PROXY_TIMEOUT_MS
    );
    const uploaded = asPortResponse('POST /api/cribl/upload', uploadPayload);
    const upload = parseUploadResponse(uploaded.status, criblBodyText(uploaded.body));
    if (!upload.ok) {
      throw new Error(upload.error);
    }

    // Step 2: POST the returned source; on duplicate conflict delete + retry once.
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
      throw new Error(
        outcome.kind === 'conflict'
          ? 'Pack install still conflicts after delete-and-retry'
          : outcome.error
      );
    }
    return outcome.pack;
  }

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

/** The full set of local-shell adapters, typed against the @soc/core ports. */
export interface LocalPorts {
  secrets: SecretsStore;
  azure: AzureManagement;
  cribl: CriblClient;
  jobs: JobStore;
  user: UserContext;
  artifacts: ArtifactSink;
  /** Tagged-sample store over the host's /api/tagged-samples (Unit 11). */
  samples: TaggedSampleStore;
  /** Lazy Sentinel content over the host's GitHub proxy (porting-plan Unit 14). */
  content: SentinelContent;
  /** Parsed-content cache over the host store, keyed by solution+commit (Unit 14). */
  contentCache: ContentCache;
  /** GitHub PAT lifecycle over the host store: validate-then-store, hasPat-only (Unit 14). */
  githubPat: GithubPatManager;
  /** Pack build-record store over the host's /api/packs (Unit 19). */
  packs: PackRecordStore;
  /** Pack install + deployed-status client over the host leader proxy (Unit 19). */
  packInstall: PackInstallClient;
  /**
   * Shell-minted GUID provider for role-assignment names (Unit 8, ENG-37
   * runtime half). The SHELL owns id conventions - @soc/core never mints - so
   * the assign-dcr-role usecase takes its per-assignment name from here. The
   * local web layer runs in a browser with Web Crypto; randomUUID yields the
   * RFC 4122 v4 GUID ARM expects for a roleAssignments name.
   */
  mintAssignmentName: () => string;
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
  // One CriblClient shared with the pack installer (it reuses request() for the
  // JSON install/list/delete ops; only the binary upload goes through the host's
  // dedicated /api/cribl/upload route).
  const cribl = new LocalCriblClient();
  return {
    secrets: new LocalSecretsStore(),
    azure: new LocalAzureManagement(),
    cribl,
    jobs: new LocalJobStore(),
    user: new LocalUserContext(),
    artifacts: new LocalArtifactSink(),
    samples: new LocalTaggedSampleStore(),
    content: new LocalSentinelContent(),
    contentCache: new LocalContentCache(),
    githubPat: new LocalGithubPat(),
    packs: new LocalPackStore(),
    packInstall: new LocalPackInstall(cribl),
    mintAssignmentName: () => crypto.randomUUID(),
    logger,
  };
}
