// Authentication Module
// Manages Cribl API OAuth tokens and Azure session state.
// Provides a unified auth check so the E2E orchestrator knows
// whether both sides are ready before starting.

// Electron-safe imports: gracefully degrade when running outside Electron (web server mode)
const _safeStorageFallback = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
const _appFallback = { isReady: () => true };
let safeStorage = _safeStorageFallback as typeof _safeStorageFallback;
let app = _appFallback as typeof _appFallback;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const e = eval("require")('electron');
  if (e && e.app && typeof e.app.isReady === 'function') {
    app = e.app;
    safeStorage = e.safeStorage || _safeStorageFallback;
  }
} catch {
  // Not in Electron -- use fallbacks
}
import { azureParametersPath as appAzureParamsPath, authDir as appAuthDir } from './app-paths';
import { execFile, spawn } from 'child_process';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

// Select http or https module based on URL protocol
function httpModule(url: string): typeof https {
  return url.startsWith('http://') ? http as unknown as typeof https : https;
}
function defaultPort(url: string): number {
  return url.startsWith('http://') ? 80 : 443;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CriblAuth {
  clientId: string;
  clientSecret: string;
  organizationId?: string;
  deploymentType: 'cloud' | 'self-managed';
  baseUrl: string;           // e.g., "https://main-myorg.cribl.cloud" or "https://cribl.internal:9000"
  accessToken?: string;
  tokenExpiry?: number;
}

export interface AzureAuth {
  loggedIn: boolean;
  accountId: string;         // UPN or service principal
  subscriptionId: string;
  subscriptionName: string;
  tenantId: string;
}

export interface AuthStatus {
  cribl: { connected: boolean; baseUrl: string; deploymentType?: string; error?: string };
  azure: AzureAuth & { error?: string };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function getAuthDir(): string {
  return appAuthDir();
}

function getCriblAuthPath(deploymentType?: 'cloud' | 'self-managed'): string {
  if (deploymentType) {
    return path.join(getAuthDir(), `cribl-auth-${deploymentType}`);
  }
  // Legacy path (pre-dual-save) -- used for migration
  return path.join(getAuthDir(), 'cribl-auth');
}

function saveCriblAuth(auth: CriblAuth, includeSecret: boolean): void {
  const safe = { ...auth };
  delete safe.accessToken;
  delete safe.tokenExpiry;
  if (!includeSecret) {
    safe.clientSecret = '';
  }

  // Save to the deployment-type-specific file
  const basePath = getCriblAuthPath(auth.deploymentType);
  try {
    const json = JSON.stringify(safe, null, 2);
    const encPath = basePath + '.enc';
    const plainPath = basePath + '.json';

    // Try Electron safeStorage first (OS-level encryption)
    if (app.isReady() && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json);
      fs.writeFileSync(encPath, encrypted);
      // Remove plaintext if it exists
      if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath);
    } else {
      // Fallback to plaintext (web server mode)
      fs.writeFileSync(plainPath, json);
    }
  } catch { /* non-fatal */ }

  // Also save to legacy path so loadCriblAuth() (used for active connection) finds it
  try {
    const legacyBase = getCriblAuthPath();
    const json = JSON.stringify(safe, null, 2);
    const encPath = legacyBase + '.enc';
    const plainPath = legacyBase + '.json';
    if (app.isReady() && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json);
      fs.writeFileSync(encPath, encrypted);
      if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath);
    } else {
      fs.writeFileSync(plainPath, json);
    }
  } catch { /* non-fatal */ }
}

function loadCriblAuthForType(deploymentType: 'cloud' | 'self-managed'): CriblAuth | null {
  const basePath = getCriblAuthPath(deploymentType);
  const encPath = basePath + '.enc';
  const plainPath = basePath + '.json';

  if (fs.existsSync(encPath) && app.isReady() && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = fs.readFileSync(encPath);
      const json = safeStorage.decryptString(encrypted);
      return JSON.parse(json) as CriblAuth;
    } catch { /* decryption failed */ }
  }
  if (fs.existsSync(plainPath)) {
    try {
      return JSON.parse(fs.readFileSync(plainPath, 'utf-8')) as CriblAuth;
    } catch { /* corrupt */ }
  }
  return null;
}

function loadCriblAuth(): CriblAuth | null {
  // In-memory auth takes priority (has the secret for current session)
  if (inMemoryAuth) return inMemoryAuth;

  // Try per-type files first, then fall back to legacy path
  // Prefer the most recently saved type by checking both
  const cloud = loadCriblAuthForType('cloud');
  const selfManaged = loadCriblAuthForType('self-managed');

  // If both exist, use the legacy file to determine which was last active
  if (cloud && selfManaged) {
    const legacyAuth = loadCriblAuthFromPath(getCriblAuthPath());
    if (legacyAuth) return legacyAuth;
    // Fallback: prefer cloud
    return cloud;
  }
  if (cloud) return cloud;
  if (selfManaged) return selfManaged;

  // Fall back to legacy path (migration from single-file storage)
  return loadCriblAuthFromPath(getCriblAuthPath());
}

function loadCriblAuthFromPath(basePath: string): CriblAuth | null {
  const encPath = basePath + '.enc';
  const plainPath = basePath + '.json';

  // Try encrypted file first (Electron mode)
  if (fs.existsSync(encPath) && app.isReady() && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = fs.readFileSync(encPath);
      const json = safeStorage.decryptString(encrypted);
      return JSON.parse(json) as CriblAuth;
    } catch (err) {
      console.error('[cribl-auth] Decryption failed:', err instanceof Error ? err.message : err);
      console.error('[cribl-auth] This usually means Windows DPAPI key changed. Re-enter credentials to save a new encrypted copy.');
    }
  }

  // Fallback to plaintext
  if (fs.existsSync(plainPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(plainPath, 'utf-8')) as CriblAuth;
      return saved;
    } catch { /* corrupt */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// GitHub PAT Storage (for authenticated git operations -- higher rate limits)
// ---------------------------------------------------------------------------

function getGitHubAuthPath(): string {
  return path.join(getAuthDir(), 'github-auth');
}

function saveGitHubPat(pat: string): void {
  try {
    const encPath = getGitHubAuthPath() + '.enc';
    const plainPath = getGitHubAuthPath() + '.json';
    const payload = JSON.stringify({ pat });

    if (app.isReady() && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(payload);
      fs.writeFileSync(encPath, encrypted);
      if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath);
    } else {
      fs.writeFileSync(plainPath, payload);
    }
  } catch { /* non-fatal */ }
}

export function loadGitHubPat(): string | null {
  const encPath = getGitHubAuthPath() + '.enc';
  const plainPath = getGitHubAuthPath() + '.json';

  if (fs.existsSync(encPath) && app.isReady() && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = fs.readFileSync(encPath);
      const json = safeStorage.decryptString(encrypted);
      return JSON.parse(json).pat || null;
    } catch { /* fall through */ }
  }

  if (fs.existsSync(plainPath)) {
    try {
      return JSON.parse(fs.readFileSync(plainPath, 'utf-8')).pat || null;
    } catch { /* corrupt */ }
  }

  return null;
}

function clearGitHubPat(): void {
  const encPath = getGitHubAuthPath() + '.enc';
  const plainPath = getGitHubAuthPath() + '.json';
  try { if (fs.existsSync(encPath)) fs.unlinkSync(encPath); } catch { /* skip */ }
  try { if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath); } catch { /* skip */ }
}

// Validate a PAT by calling the authenticated user endpoint
async function testGitHubPat(pat: string): Promise<{ ok: boolean; login?: string; error?: string }> {
  return new Promise((resolve) => {
    const req = https.request('https://api.github.com/user', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Cribl-Microsoft-Integration',
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(body);
            resolve({ ok: true, login: parsed.login });
          } catch {
            resolve({ ok: false, error: 'Invalid response from GitHub' });
          }
        } else {
          resolve({ ok: false, error: `GitHub returned ${res.statusCode}: ${body.slice(0, 200)}` });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

// In-memory auth (for sessions where user chose not to save)
let inMemoryAuth: CriblAuth | null = null;

// In-memory token cache
let cachedToken: { token: string; expiry: number } | null = null;

// ---------------------------------------------------------------------------
// Cribl API Auth
// ---------------------------------------------------------------------------

function httpsPost(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = httpModule(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || defaultPort(url),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      rejectUnauthorized: url.startsWith('https://'),
      timeout: 90000,
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, body: data });
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsPut(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = httpModule(url);
    const req = mod.request({
      hostname: parsed.hostname, port: parsed.port || defaultPort(url),
      path: parsed.pathname + parsed.search, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      rejectUnauthorized: url.startsWith('https://'), timeout: 90000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsPatch(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = httpModule(url);
    const req = mod.request({
      hostname: parsed.hostname, port: parsed.port || defaultPort(url),
      path: parsed.pathname + parsed.search, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      rejectUnauthorized: url.startsWith('https://'), timeout: 90000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = httpModule(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || defaultPort(url),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...headers,
      },
      rejectUnauthorized: url.startsWith('https://'),
      timeout: 90000,
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, body: data });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Get an OAuth access token for the Cribl API
export async function getCriblToken(auth: CriblAuth): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && cachedToken.expiry > Date.now() + 60000) {
    return cachedToken.token;
  }

  let tokenUrl: string;
  let body: string;

  if (auth.deploymentType === 'cloud') {
    // Cribl Cloud: OAuth client credentials via login.cribl.cloud
    tokenUrl = 'https://login.cribl.cloud/oauth/token';
    body = JSON.stringify({
      grant_type: 'client_credentials',
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      audience: 'https://api.cribl.cloud',
    });
  } else {
    // Self-managed: direct token endpoint
    tokenUrl = `${auth.baseUrl}/api/v1/auth/login`;
    body = JSON.stringify({
      username: auth.clientId,
      password: auth.clientSecret,
    });
  }

  const response = await httpsPost(tokenUrl, body, {});

  if (response.status >= 200 && response.status < 300) {
    const parsed = JSON.parse(response.body);
    const token = parsed.access_token || parsed.token || '';
    const expiresIn = parsed.expires_in || 3600;
    cachedToken = { token, expiry: Date.now() + expiresIn * 1000 };
    return token;
  }

  throw new Error(`Cribl auth failed (${response.status}): ${response.body.slice(0, 200)}`);
}

// Test Cribl API connectivity
async function testCriblConnection(auth: CriblAuth): Promise<{ ok: boolean; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    // For cloud, use the API base URL; for self-managed, use the leader URL
    const apiBase = auth.deploymentType === 'cloud'
      ? `https://api.cribl.cloud/v1/organizations/${auth.organizationId || 'default'}`
      : auth.baseUrl;
    const healthUrl = auth.deploymentType === 'cloud'
      ? `${apiBase}/health`
      : `${apiBase}/api/v1/health`;
    const response = await httpsGet(healthUrl, { Authorization: `Bearer ${token}` });
    if (response.status >= 200 && response.status < 300) {
      return { ok: true };
    }
    // For cloud, a successful token is proof enough of connectivity
    if (auth.deploymentType === 'cloud' && token) {
      return { ok: true };
    }
    return { ok: false, error: `Health check returned ${response.status}` };
  } catch (err) {
    // If token was obtained successfully, treat cloud as connected even if health endpoint differs
    if (auth.deploymentType === 'cloud' && cachedToken?.token) {
      return { ok: true };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Cribl API Operations
// ---------------------------------------------------------------------------

// Create a Sentinel destination in Cribl Stream via API
export async function criblCreateDestination(
  auth: CriblAuth,
  destination: Record<string, unknown>,
  workerGroup: string = 'default',
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    const url = `${auth.baseUrl}/api/v1/m/${workerGroup}/system/outputs`;
    const body = JSON.stringify(destination);
    const response = await httpsPost(url, body, {
      Authorization: `Bearer ${token}`,
    });

    if (response.status >= 200 && response.status < 300) {
      return { success: true };
    }
    return { success: false, error: `API returned ${response.status}: ${response.body.slice(0, 200)}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Upload a .crbl pack to Cribl Stream via API
// Deploy a .crbl pack to Cribl via the REST API.
// Step 1: PUT /packs?filename={name}.crbl with binary body to upload the file
// Step 2: POST /packs {"source":"{uploadedFilename}"} to install it
export async function criblUploadPack(
  auth: CriblAuth,
  crblPath: string,
  workerGroup: string = 'default',
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    const fileName = path.basename(crblPath);

    // Step 1: Upload the .crbl file via PUT
    const putUrl = `${auth.baseUrl}/api/v1/m/${workerGroup}/packs?filename=${encodeURIComponent(fileName)}`;
    const fileData = fs.readFileSync(crblPath);

    const putResp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const parsed = new URL(putUrl);
      const mod = httpModule(putUrl);
      const req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port || defaultPort(putUrl),
        path: parsed.pathname + parsed.search,
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileData.length,
        },
        rejectUnauthorized: putUrl.startsWith('https://'),
        timeout: 90000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      });
      req.on('error', reject);
      req.write(fileData);
      req.end();
    });

    if (putResp.status < 200 || putResp.status >= 300) {
      return { success: false, error: `Upload failed (${putResp.status}): ${putResp.body.slice(0, 200)}` };
    }

    // Extract the uploaded filename from the response (e.g., "paloalto-sentinel.h1i8P1M.crbl")
    let uploadedSource = '';
    try {
      const putResult = JSON.parse(putResp.body);
      uploadedSource = putResult.source || '';
    } catch {
      return { success: false, error: `Upload succeeded but response not parseable: ${putResp.body.slice(0, 200)}` };
    }

    if (!uploadedSource) {
      return { success: false, error: 'Upload succeeded but no source filename returned' };
    }

    // Step 2: Install the pack from the uploaded .crbl
    const installResp = await httpsPost(
      apiUrl(auth, workerGroup, '/packs'),
      JSON.stringify({ source: uploadedSource }),
      { Authorization: `Bearer ${token}` },
    );

    if (installResp.status >= 200 && installResp.status < 300) {
      const installResult = JSON.parse(installResp.body);
      const pack = installResult.items?.[0] || {};
      return {
        success: true,
        error: `Pack "${pack.displayName || pack.id}" v${pack.version || '?'} installed on ${workerGroup} from ${uploadedSource}`,
      };
    }

    // If install fails due to duplicate pack ID, delete the existing pack and retry
    if (installResp.status === 500 && installResp.body.includes('conflicts with existing Pack')) {
      // Extract pack ID from the .crbl filename (e.g., "crowdstrike-fdr-sentinel_1.0.0.crbl" -> "crowdstrike-fdr-sentinel")
      const packId = fileName.replace(/_[\d.]+\.crbl$/, '').replace(/\.[^.]+\.crbl$/, '');

      // Delete existing pack
      const deleteResp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const delUrl = new URL(apiUrl(auth, workerGroup, `/packs/${encodeURIComponent(packId)}`));
        const delUrlStr = delUrl.toString();
        const mod = httpModule(delUrlStr);
        const req = mod.request({
          hostname: delUrl.hostname,
          port: delUrl.port || defaultPort(delUrlStr),
          path: delUrl.pathname,
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
          rejectUnauthorized: delUrlStr.startsWith('https://'),
          timeout: 30000,
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
        });
        req.on('error', reject);
        req.end();
      });

      if (deleteResp.status >= 200 && deleteResp.status < 300) {
        // Retry install after delete
        const retryResp = await httpsPost(
          apiUrl(auth, workerGroup, '/packs'),
          JSON.stringify({ source: uploadedSource }),
          { Authorization: `Bearer ${token}` },
        );

        if (retryResp.status >= 200 && retryResp.status < 300) {
          const retryResult = JSON.parse(retryResp.body);
          const pack = retryResult.items?.[0] || {};
          return {
            success: true,
            error: `Pack "${pack.displayName || pack.id}" v${pack.version || '?'} updated on ${workerGroup}`,
          };
        }
        return { success: false, error: `Retry install failed (${retryResp.status}): ${retryResp.body.slice(0, 200)}` };
      }
    }

    return { success: false, error: `Install failed (${installResp.status}): ${installResp.body.slice(0, 200)}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// List existing Cribl destinations to check for conflicts
export async function criblListDestinations(
  auth: CriblAuth,
  workerGroup: string = 'default',
): Promise<{ success: boolean; destinations: string[]; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    const url = `${auth.baseUrl}/api/v1/m/${workerGroup}/system/outputs`;
    const response = await httpsGet(url, { Authorization: `Bearer ${token}` });

    if (response.status >= 200 && response.status < 300) {
      const parsed = JSON.parse(response.body);
      const items = parsed.items || parsed.data || [];
      const ids = items.map((item: Record<string, unknown>) => item.id as string).filter(Boolean);
      return { success: true, destinations: ids };
    }
    return { success: false, destinations: [], error: `API returned ${response.status}` };
  } catch (err) {
    return { success: false, destinations: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// List Cribl Cloud workspaces
export async function criblListWorkspaces(
  auth: CriblAuth,
): Promise<{ success: boolean; workspaces: Array<{ id: string; name: string; description: string }>; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    // Both Cloud and self-managed: /api/v1/master/groups lists worker groups
    // Cloud workspaces are a management plane concept -- use the org's data plane
    const url = `${auth.baseUrl}/api/v1/master/groups`;
    const response = await httpsGet(url, { Authorization: `Bearer ${token}` });
    if (response.status >= 200 && response.status < 300) {
      const parsed = JSON.parse(response.body);
      const items = parsed.items || parsed.data || parsed || [];
      const workspaces = (Array.isArray(items) ? items : []).map((w: Record<string, unknown>) => ({
        id: String(w.id || w.name || ''),
        name: String(w.name || w.id || ''),
        description: String(w.description || ''),
      }));
      return { success: true, workspaces };
    }
    return { success: false, workspaces: [], error: `API returned ${response.status}` };
  } catch (err) {
    return { success: false, workspaces: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// List worker groups
export async function criblListWorkerGroups(
  auth: CriblAuth,
  workspaceId?: string,
): Promise<{ success: boolean; groups: Array<{ id: string; name: string; workerCount: number; description: string }>; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    // /api/v1/master/groups returns worker groups for both Cloud and self-managed
    const url = `${auth.baseUrl}/api/v1/master/groups`;
    const response = await httpsGet(url, { Authorization: `Bearer ${token}` });
    if (response.status >= 200 && response.status < 300) {
      const parsed = JSON.parse(response.body);
      const items = parsed.items || parsed.data || parsed || [];
      const groups = (Array.isArray(items) ? items : [])
        // Filter out edge fleets -- only show worker groups
        .filter((g: Record<string, unknown>) => {
          const isFleet = g.isFleet === true || g.configType === 'edge';
          return !isFleet;
        })
        .map((g: Record<string, unknown>) => ({
          id: String(g.id || g.name || ''),
          name: String(g.name || g.id || ''),
          workerCount: Number(g.workerCount || g.worker_count || 0),
          description: String(g.description || ''),
        }));
      return { success: true, groups };
    }
    return { success: false, groups: [], error: `API returned ${response.status}` };
  } catch (err) {
    return { success: false, groups: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// List packs installed on a worker group
export async function criblListPacks(
  auth: CriblAuth,
  workerGroup: string = 'default',
): Promise<{ success: boolean; packs: Array<{ id: string; name: string; version: string }>; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    const url = `${auth.baseUrl}/api/v1/m/${workerGroup}/packs`;
    const response = await httpsGet(url, { Authorization: `Bearer ${token}` });
    if (response.status >= 200 && response.status < 300) {
      const parsed = JSON.parse(response.body);
      const items = parsed.items || parsed.data || parsed || [];
      const packs = (Array.isArray(items) ? items : []).map((p: Record<string, unknown>) => ({
        id: String(p.id || p.name || ''),
        name: String(p.displayName || p.name || p.id || ''),
        version: String(p.version || ''),
      }));
      return { success: true, packs };
    }
    return { success: false, packs: [], error: `API returned ${response.status}` };
  } catch (err) {
    return { success: false, packs: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// Deploy a .crbl pack to multiple worker groups
export async function criblDeployPackToGroups(
  auth: CriblAuth,
  crblPath: string,
  workerGroups: string[],
): Promise<Array<{ group: string; success: boolean; error?: string }>> {
  const results: Array<{ group: string; success: boolean; error?: string }> = [];
  for (const group of workerGroups) {
    const result = await criblUploadPack(auth, crblPath, group);
    results.push({ group, success: result.success, error: result.error });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Live Data Capture & Search
// ---------------------------------------------------------------------------

// Build the API base URL for a worker group.
// Both Cloud and self-managed use the same data plane pattern:
//   {baseUrl}/api/v1/m/{group}/{endpoint}
// The baseUrl for Cloud is https://main-{org}.cribl.cloud
function apiUrl(auth: CriblAuth, workerGroup: string, endpoint: string): string {
  // Both Cloud and self-managed use the leader/main URL for worker group scoped APIs.
  // Cloud leader: https://main-{orgId}.cribl.cloud/api/v1/m/{group}/...
  // Self-managed: https://{leader}:9000/api/v1/m/{group}/...
  return `${auth.baseUrl}/api/v1/m/${workerGroup}${endpoint}`;
}

// List available sources on a worker group
export async function criblListSources(
  auth: CriblAuth,
  workerGroup: string = 'default',
): Promise<{ success: boolean; sources: Array<{ id: string; type: string; disabled: boolean; description: string }>; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    const url = apiUrl(auth, workerGroup, '/system/inputs');
    const response = await httpsGet(url, { Authorization: `Bearer ${token}` });
    if (response.status >= 200 && response.status < 300) {
      const parsed = JSON.parse(response.body);
      const items = parsed.items || parsed.data || [];
      const sources = (Array.isArray(items) ? items : []).map((s: Record<string, unknown>) => ({
        id: String(s.id || ''),
        type: String(s.type || ''),
        disabled: Boolean(s.disabled),
        description: String(s.description || s.id || ''),
      }));
      return { success: true, sources };
    }
    return { success: false, sources: [], error: `API returned ${response.status}` };
  } catch (err) {
    return { success: false, sources: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// List available routes on a worker group
export async function criblListRoutes(
  auth: CriblAuth,
  workerGroup: string = 'default',
): Promise<{ success: boolean; routes: Array<{ id: string; name: string; description: string }>; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    const url = apiUrl(auth, workerGroup, '/system/pipelines/route');
    const response = await httpsGet(url, { Authorization: `Bearer ${token}` });
    if (response.status >= 200 && response.status < 300) {
      const parsed = JSON.parse(response.body);
      const routes = parsed.routes || parsed.items || [];
      return {
        success: true,
        routes: (Array.isArray(routes) ? routes : []).map((r: Record<string, unknown>) => ({
          id: String(r.id || ''),
          name: String(r.name || r.id || ''),
          description: String(r.description || ''),
        })),
      };
    }
    return { success: false, routes: [], error: `API returned ${response.status}` };
  } catch (err) {
    return { success: false, routes: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// Capture sample events from a live source.
// Uses the Cribl API: /system/samples for listing, /system/samples/{id}/content for data.
export async function criblCaptureSample(
  auth: CriblAuth,
  workerGroup: string,
  sourceId: string,
  count: number = 10,
  durationMs: number = 60000,
): Promise<{ success: boolean; events: Array<Record<string, unknown>>; error?: string }> {
  const errors: string[] = [];
  try {
    const token = await getCriblToken(auth);
    const headers = { Authorization: `Bearer ${token}` };

    // Strategy 1: GET /system/samples to list available sample files,
    // then GET /system/samples/{id}/content to get the actual events.
    try {
      const samplesListUrl = apiUrl(auth, workerGroup, '/system/samples');
      const listResp = await httpsGet(samplesListUrl, headers);
      if (listResp.status >= 200 && listResp.status < 300) {
        const samplesData = JSON.parse(listResp.body);
        const items = samplesData.items || samplesData || [];
        if (Array.isArray(items) && items.length > 0) {
          // Try to find a sample matching this source by ID, name, or fuzzy word match.
          // e.g., sourceId "PaloAltoDatgen" should match sample "palo_alto_traffic"
          const srcLower = sourceId.toLowerCase().replace(/[^a-z0-9]/g, '');
          const srcWords = sourceId.toLowerCase().replace(/[_\-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/).filter((w) => w.length > 2);
          const matchedSample = items.find((s: Record<string, unknown>) => {
            const id = String(s.id || '').toLowerCase();
            const name = String(s.sampleName || '').toLowerCase();
            const idNorm = id.replace(/[^a-z0-9]/g, '');
            const nameNorm = name.replace(/[^a-z0-9]/g, '');
            // Exact or substring match
            if (idNorm.includes(srcLower) || srcLower.includes(idNorm)) return true;
            if (nameNorm.includes(srcLower) || srcLower.includes(nameNorm)) return true;
            // Word overlap: "PaloAlto" matches "palo_alto_traffic" via shared words
            const sampleWords = (id + ' ' + name).replace(/[_\-\.]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
            const overlap = srcWords.filter((w) => sampleWords.some((sw) => sw.includes(w) || w.includes(sw)));
            return overlap.length >= 2 || (overlap.length === 1 && overlap[0].length > 4);
          });

          // If no match by source name, just use the first available sample
          const sampleToUse = matchedSample || items[0];
          if (sampleToUse) {
            const sampleId = String(sampleToUse.id || sampleToUse.name || '');
            if (sampleId) {
              const sampleUrl = apiUrl(auth, workerGroup, `/system/samples/${encodeURIComponent(sampleId)}/content`);
              const sampleResp = await httpsGet(sampleUrl, headers);
              if (sampleResp.status >= 200 && sampleResp.status < 300) {
                const body = sampleResp.body.trim();
                let events: Array<Record<string, unknown>> = [];
                try {
                  if (body.startsWith('[')) {
                    events = JSON.parse(body);
                  } else {
                    events = body.split('\n').filter(Boolean).map((line) => {
                      try { return JSON.parse(line); } catch { return { _raw: line }; }
                    });
                  }
                } catch {
                  // Treat entire body as a single raw event
                  events = [{ _raw: body.slice(0, 5000) }];
                }
                if (events.length > 0) {
                  return {
                    success: true,
                    events: events.slice(0, count),
                    error: matchedSample ? undefined : `Using sample "${sampleId}" (no exact match for "${sourceId}")`,
                  };
                }
              } else {
                errors.push(`Sample fetch returned ${sampleResp.status}`);
              }
            }
          }
        } else {
          errors.push('No sample files found in the samples library');
        }
      } else {
        errors.push(`Samples list returned ${listResp.status}`);
      }
    } catch (err) {
      errors.push(`Samples: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Strategy 2: Live capture via POST /api/v1/m/{group}/lib/jobs
    // Creates an ad-hoc collection job that captures from the source.
    try {
      const jobUrl = apiUrl(auth, workerGroup, '/lib/jobs');
      const jobBody = JSON.stringify({
        type: 'collection',
        ttl: '60s',
        reschedule: false,
        schedule: {},
        collector: {
          conf: {
            discovery: { discoverType: 'none' },
            collectMethod: 'get',
          },
          type: 'collection',
        },
        input: {
          type: 'collection',
          staleChannelFlushMs: 10000,
          sendToRoutes: false,
          connections: [{ input: sourceId }],
        },
        maxEvents: count,
      });
      const jobResp = await httpsPost(jobUrl, jobBody, headers);
      if (jobResp.status >= 200 && jobResp.status < 300) {
        const jobData = JSON.parse(jobResp.body);
        const events = jobData.items || jobData.events || [];
        if (Array.isArray(events) && events.length > 0) {
          return { success: true, events: events.slice(0, count) };
        }
        errors.push('Collection job returned no events');
      } else {
        errors.push(`Collection job returned ${jobResp.status}`);
      }
    } catch (err) {
      errors.push(`Jobs: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Strategy 3: Try preview endpoint with capture mode
    try {
      const previewUrl = apiUrl(auth, workerGroup, '/preview');
      const previewBody = JSON.stringify({
        mode: 'capture',
        inputId: `${sourceId}`,
        sampleId: 0,
        count,
        timeout: Math.ceil(durationMs / 1000),
      });
      const previewResp = await httpsPost(previewUrl, previewBody, headers);
      if (previewResp.status >= 200 && previewResp.status < 300) {
        const data = JSON.parse(previewResp.body);
        const events = data.items || data.events || [];
        if (Array.isArray(events) && events.length > 0) {
          return { success: true, events: events.slice(0, count) };
        }
        errors.push('Preview returned no events');
      } else {
        errors.push(`Preview returned ${previewResp.status}`);
      }
    } catch (err) {
      errors.push(`Preview: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      success: false,
      events: [],
      error: `Capture failed. Tried 3 strategies:\n${errors.join('\n')}\n\nTry uploading a sample file manually, or check that data is flowing through "${sourceId}".`,
    };
  } catch (err) {
    return { success: false, events: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// Preview pipeline: run sample events through a pipeline config and return output
export async function criblPreviewPipeline(
  auth: CriblAuth,
  workerGroup: string,
  pipelineConf: Record<string, unknown>,
  sampleEvents: Array<Record<string, unknown>>,
): Promise<{ success: boolean; events: Array<Record<string, unknown>>; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    const url = apiUrl(auth, workerGroup, '/preview');
    const body = JSON.stringify({
      pipeline: pipelineConf,
      events: sampleEvents,
    });
    const response = await httpsPost(url, body, { Authorization: `Bearer ${token}` });
    if (response.status >= 200 && response.status < 300) {
      const data = JSON.parse(response.body);
      const events = data.items || data.events || data || [];
      return { success: true, events: Array.isArray(events) ? events : [] };
    }
    return { success: false, events: [], error: `Preview returned ${response.status}` };
  } catch (err) {
    return { success: false, events: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// Cribl Search: run a query against Cribl Lake datasets
export async function criblSearch(
  auth: CriblAuth,
  query: string,
  earliest: string = '-1h',
  latest: string = 'now',
  maxResults: number = 100,
): Promise<{ success: boolean; events: Array<Record<string, unknown>>; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    const searchBase = `${auth.baseUrl}/api/v1/search`;

    // Create search job
    const createUrl = `${searchBase}/jobs`;
    const body = JSON.stringify({
      query,
      earliest,
      latest,
      limit: maxResults,
    });
    const createResp = await httpsPost(createUrl, body, { Authorization: `Bearer ${token}` });

    if (createResp.status >= 200 && createResp.status < 300) {
      const job = JSON.parse(createResp.body);
      const jobId = job.id || job.jobId || '';

      if (!jobId) {
        // Synchronous response -- events returned directly
        const events = job.items || job.events || job.results || [];
        if (Array.isArray(events) && events.length > 0) {
          return { success: true, events };
        }
      }

      // Poll for completion
      const maxWait = 60000;
      const start = Date.now();
      while (jobId && Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 2000));
        const statusUrl = `${searchBase}/jobs/${jobId}`;
        const statusResp = await httpsGet(statusUrl, { Authorization: `Bearer ${token}` });
        if (statusResp.status >= 200 && statusResp.status < 300) {
          const statusData = JSON.parse(statusResp.body);
          const state = String(statusData.state || statusData.status || '').toLowerCase();
          if (state === 'finished' || state === 'completed' || state === 'done') {
            const resultsUrl = `${searchBase}/jobs/${jobId}/results`;
            const resultsResp = await httpsGet(resultsUrl, { Authorization: `Bearer ${token}` });
            if (resultsResp.status >= 200 && resultsResp.status < 300) {
              const results = JSON.parse(resultsResp.body);
              const events = results.items || results.events || results.results || [];
              return { success: true, events: Array.isArray(events) ? events : [] };
            }
            break;
          }
          if (state === 'failed' || state === 'error' || state === 'cancelled') {
            return { success: false, events: [], error: `Search failed: ${statusData.error || state}` };
          }
        }
      }
      return { success: false, events: [], error: 'Search timed out after 60s' };
    }

    return { success: false, events: [], error: `Search API returned ${createResp.status}` };
  } catch (err) {
    return { success: false, events: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// List Cribl Lake datasets (for search target dropdown)
export async function criblListDatasets(
  auth: CriblAuth,
): Promise<{ success: boolean; datasets: Array<{ id: string; name: string }>; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    const headers = { Authorization: `Bearer ${token}` };
    // Try multiple endpoint paths -- varies by Cribl version and deployment type
    const paths = [
      `${auth.baseUrl}/api/v1/datasets`,
      `${auth.baseUrl}/api/v1/lib/datasets`,
      `${auth.baseUrl}/api/v1/m/default/lib/datasets`,
    ];
    for (const url of paths) {
      try {
        const response = await httpsGet(url, headers);
        if (response.status >= 200 && response.status < 300) {
          const parsed = JSON.parse(response.body);
          const items = parsed.items || parsed.data || parsed.datasets || [];
          const datasets = (Array.isArray(items) ? items : []).map((d: Record<string, unknown>) => ({
            id: String(d.id || ''),
            name: String(d.name || d.id || ''),
          })).filter((d) => d.id);
          if (datasets.length > 0) return { success: true, datasets };
        }
      } catch { /* try next path */ }
    }
    return { success: true, datasets: [], error: 'No datasets found (Lake may not be configured)' };
  } catch (err) {
    return { success: false, datasets: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// Create a new Cribl Lake dataset
export async function criblCreateDataset(
  auth: CriblAuth,
  datasetId: string,
  description?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await getCriblToken(auth);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const body = JSON.stringify({
      id: datasetId,
      name: datasetId,
      description: description || `Created by Cribl SOC Toolkit`,
      type: 'event',
    });
    // Try multiple endpoint paths -- varies by Cribl version and deployment type
    const paths = [
      `${auth.baseUrl}/api/v1/datasets`,
      `${auth.baseUrl}/api/v1/lib/datasets`,
      `${auth.baseUrl}/api/v1/m/default/lib/datasets`,
      `${auth.baseUrl}/api/v1/lake/datasets`,
    ];
    for (const url of paths) {
      try {
        const resp = await httpsPost(url, body, headers);
        if (resp.status >= 200 && resp.status < 300) return { success: true };
        if (resp.status === 409) return { success: true, error: 'Dataset already exists' };
      } catch { /* try next */ }
    }
    return { success: false, error: 'Failed to create dataset (all endpoints failed)' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Azure Session Management
// ---------------------------------------------------------------------------

// Validate GUID format to prevent PowerShell injection
function isValidGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// Sanitize a string for safe PowerShell interpolation (escape single quotes)
function sanitizeForPs(value: string): string {
  return value.replace(/'/g, "''");
}

function runPowershell(command: string, timeoutMs: number = 60000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile', '-Command', command,
    ], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: stderr || err.message });
      } else {
        resolve({ ok: true, output: (stdout || '').trim() });
      }
    });
  });
}

async function checkAzureSession(): Promise<AzureAuth> {
  const result = await runPowershell(
    "try { $ctx = Get-AzContext -ErrorAction Stop; if ($ctx -and $ctx.Account) { " +
    "$ctx.Account.Id + '|' + $ctx.Subscription.Id + '|' + $ctx.Subscription.Name + '|' + $ctx.Tenant.Id " +
    "} else { 'NOT_LOGGED_IN' } } catch { 'NOT_LOGGED_IN' }"
  );

  if (!result.ok || result.output.includes('NOT_LOGGED_IN') || !result.output.includes('|')) {
    return { loggedIn: false, accountId: '', subscriptionId: '', subscriptionName: '', tenantId: '' };
  }

  const parts = result.output.split('|');
  return {
    loggedIn: true,
    accountId: parts[0] || '',
    subscriptionId: parts[1] || '',
    subscriptionName: parts[2] || '',
    tenantId: parts[3] || '',
  };
}

// Trigger Connect-AzAccount (opens browser for interactive login)
function azureLogin(sender: Electron.WebContents): Promise<AzureAuth> {
  return new Promise((resolve) => {
    const id = `azure-login-${Date.now()}`;

    if (!sender.isDestroyed()) {
      sender.send('ps:output', { id, stream: 'stdout', data: '> Connect-AzAccount (browser login)\n' });
    }

    // Open a visible PowerShell window for interactive login.
    // The user completes auth in the browser, then the PS window closes automatically.
    // We poll for a valid session after launching.
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NoExit', '-Command',
      "$WarningPreference = 'SilentlyContinue'; " +
      "Write-Host 'Logging in to Azure... Complete the sign-in in your browser.' -ForegroundColor Cyan; " +
      'Connect-AzAccount | Out-Null; ' +
      "$ctx = Get-AzContext; " +
      "if ($ctx -and $ctx.Account) { " +
      "  Write-Host ('Logged in as ' + $ctx.Account.Id) -ForegroundColor Green; " +
      "  $ctx.Account.Id + '|' + $ctx.Subscription.Id + '|' + $ctx.Subscription.Name + '|' + $ctx.Tenant.Id; " +
      "} else { Write-Host 'Login failed' -ForegroundColor Red; 'LOGIN_FAILED' }; " +
      "exit",
    ], { windowsHide: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });

    let output = '';
    proc.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stdout', data: data.toString() });
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      // Ignore stderr (MFA warnings)
    });

    proc.on('close', () => {
      if (!sender.isDestroyed()) {
        sender.send('ps:exit', { id, code: 0 });
      }
      // Find the pipe-delimited line in output (skip any warning text that leaked through)
      const lines = output.trim().split('\n');
      const accountLine = lines.find((l) => l.includes('|') && !l.startsWith('WARNING'));
      if (accountLine) {
        const parts = accountLine.trim().split('|');
        if (parts.length >= 4) {
          resolve({
            loggedIn: true,
            accountId: parts[0], subscriptionId: parts[1],
            subscriptionName: parts[2], tenantId: parts[3],
          });
          return;
        }
      }
      resolve({ loggedIn: false, accountId: '', subscriptionId: '', subscriptionName: '', tenantId: '' });
    });
  });
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerAuthHandlers(ipcMain: any) {
  // Get full auth status (both Cribl + Azure)
  ipcMain.handle('auth:status', async () => {
    // Check integration mode -- skip auth checks for skipped services
    let mode = 'full';
    try {
      const modeFile = path.join(configDir(), 'integration-mode.json');
      if (fs.existsSync(modeFile)) {
        mode = JSON.parse(fs.readFileSync(modeFile, 'utf-8')).mode || 'full';
      }
    } catch { /* default to full */ }

    const skipCribl = mode === 'air-gapped' || mode === 'azure-only';
    const skipAzure = mode === 'air-gapped' || mode === 'cribl-only';

    const azure = skipAzure
      ? { loggedIn: false, accountId: '', subscriptionId: '', subscriptionName: '', tenantId: '' }
      : await checkAzureSession();

    let criblStatus: { connected: boolean; baseUrl: string; deploymentType?: string; error: string } = { connected: false, baseUrl: '', error: '' };
    if (!skipCribl) {
      const criblAuth = loadCriblAuth();
      if (criblAuth) {
        const test = await testCriblConnection(criblAuth);
        criblStatus = {
          connected: test.ok,
          baseUrl: criblAuth.baseUrl,
          deploymentType: criblAuth.deploymentType,
          error: test.error || '',
        };
      }
    }

    return { cribl: criblStatus, azure: { ...azure, error: '' } } as AuthStatus;
  });

  // Test Cribl credentials and optionally save them
  ipcMain.handle('auth:cribl-connect', async (_event, config: {
    clientId: string;
    clientSecret: string;
    baseUrl: string;
    deploymentType: 'cloud' | 'self-managed';
    organizationId?: string;
    saveCredentials?: boolean;
  }) => {
    const auth: CriblAuth = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      baseUrl: config.baseUrl.replace(/\/$/, ''),
      deploymentType: config.deploymentType,
      organizationId: config.organizationId,
    };

    // Keep auth in memory for this session regardless of save preference
    inMemoryAuth = auth;

    const test = await testCriblConnection(auth);
    if (test.ok && config.saveCredentials) {
      saveCriblAuth(auth, true);
    } else if (test.ok && !config.saveCredentials) {
      // Save connection info without the secret so the UI remembers org/deployment type
      saveCriblAuth(auth, false);
    }

    return { success: test.ok, error: test.error };
  });

  // Disconnect Cribl (clear saved auth)
  ipcMain.handle('auth:cribl-disconnect', async () => {
    cachedToken = null;
    inMemoryAuth = null;
    const encPath = getCriblAuthPath() + '.enc';
    const plainPath = getCriblAuthPath() + '.json';
    if (fs.existsSync(encPath)) fs.unlinkSync(encPath);
    if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath);
  });

  // Return saved Cribl connection info (without secrets) for wizard pre-fill.
  // Returns both cloud and self-managed profiles so the UI can swap on toggle.
  ipcMain.handle('auth:cribl-saved', async () => {
    const cloud = loadCriblAuthForType('cloud');
    const selfManaged = loadCriblAuthForType('self-managed');

    // Migration: if no per-type files exist, try the legacy single file
    if (!cloud && !selfManaged) {
      const legacy = loadCriblAuthFromPath(getCriblAuthPath());
      if (!legacy) return null;
      return {
        clientId: legacy.clientId,
        deploymentType: legacy.deploymentType,
        baseUrl: legacy.baseUrl,
        organizationId: legacy.organizationId || '',
        hasSecret: !!legacy.clientSecret,
        // Profiles for both types (only the active one populated from legacy)
        cloud: legacy.deploymentType === 'cloud' ? {
          clientId: legacy.clientId,
          organizationId: legacy.organizationId || '',
          hasSecret: !!legacy.clientSecret,
        } : null,
        selfManaged: legacy.deploymentType === 'self-managed' ? {
          clientId: legacy.clientId,
          baseUrl: legacy.baseUrl,
          hasSecret: !!legacy.clientSecret,
        } : null,
      };
    }

    // Determine which was the last active deployment type
    const lastActive = loadCriblAuthFromPath(getCriblAuthPath());
    const activeType = lastActive?.deploymentType || (cloud ? 'cloud' : 'self-managed');
    const active = activeType === 'cloud' ? cloud : selfManaged;

    return {
      clientId: active?.clientId || '',
      deploymentType: activeType,
      baseUrl: active?.baseUrl || '',
      organizationId: active?.organizationId || '',
      hasSecret: !!(active?.clientSecret),
      cloud: cloud ? {
        clientId: cloud.clientId,
        organizationId: cloud.organizationId || '',
        hasSecret: !!cloud.clientSecret,
      } : null,
      selfManaged: selfManaged ? {
        clientId: selfManaged.clientId,
        baseUrl: selfManaged.baseUrl,
        hasSecret: !!selfManaged.clientSecret,
      } : null,
    };
  });

  // Reconnect using saved encrypted credentials (secret never leaves main process).
  // Accepts optional overrides so the UI can update deployment type / base URL / org
  // without the user having to re-enter the secret.
  ipcMain.handle('auth:cribl-reconnect', async (_event, overrides?: {
    deploymentType?: 'cloud' | 'self-managed';
    baseUrl?: string;
    organizationId?: string;
    clientId?: string;
  }) => {
    // If the deployment type is specified in overrides, load credentials for that specific type.
    // This prevents using self-managed credentials when reconnecting as Cloud (or vice versa).
    let auth: CriblAuth | null = null;
    if (overrides?.deploymentType) {
      auth = loadCriblAuthForType(overrides.deploymentType);
    }
    if (!auth) {
      auth = loadCriblAuth();
    }
    if (!auth) {
      return { success: false, error: 'No saved credentials found (decryption may have failed)' };
    }
    if (!auth.clientSecret) {
      return { success: false, error: 'Saved credentials have no secret -- credentials were saved without "remember me"' };
    }
    // Apply UI overrides (org ID, base URL, client ID may have changed in the form)
    if (overrides) {
      if (overrides.deploymentType) auth.deploymentType = overrides.deploymentType;
      if (overrides.baseUrl) auth.baseUrl = overrides.baseUrl.replace(/\/$/, '');
      if (overrides.organizationId !== undefined) auth.organizationId = overrides.organizationId;
      if (overrides.clientId) auth.clientId = overrides.clientId;
    }
    // Clear cached token so a fresh token is obtained for the correct deployment type
    cachedToken = null;
    inMemoryAuth = auth;
    const test = await testCriblConnection(auth);
    if (test.ok) {
      saveCriblAuth(auth, true);
    }
    return { success: test.ok, error: test.error || (test.ok ? undefined : 'Connection test failed') };
  });

  // GitHub PAT: check if one is saved
  ipcMain.handle('auth:github-saved', async () => {
    const pat = loadGitHubPat();
    return { hasPat: !!pat };
  });

  // GitHub PAT: save and validate
  ipcMain.handle('auth:github-save', async (_event, { pat }: { pat: string }) => {
    if (!pat || pat.trim().length < 10) {
      return { success: false, error: 'PAT is required' };
    }
    const test = await testGitHubPat(pat.trim());
    if (!test.ok) {
      return { success: false, error: test.error || 'Invalid token' };
    }
    saveGitHubPat(pat.trim());
    return { success: true, login: test.login };
  });

  // GitHub PAT: clear saved
  ipcMain.handle('auth:github-clear', async () => {
    clearGitHubPat();
    return { success: true };
  });

  // Check Azure session only
  ipcMain.handle('auth:azure-status', async () => {
    return checkAzureSession();
  });

  // Trigger Azure login (opens browser)
  ipcMain.handle('auth:azure-login', async (event) => {
    return azureLogin(event.sender);
  });

  // Set Azure subscription context
  ipcMain.handle('auth:azure-set-subscription', async (_event, { subscriptionId }: { subscriptionId: string }) => {
    if (!isValidGuid(subscriptionId)) {
      return { success: false, error: 'Invalid subscription ID format' };
    }
    const result = await runPowershell(
      `Set-AzContext -Subscription '${subscriptionId}' | Out-Null; 'OK'`
    );
    return { success: result.ok && result.output.includes('OK') };
  });

  // List Azure subscriptions accessible to the current user
  ipcMain.handle('auth:azure-subscriptions', async () => {
    const result = await runPowershell(
      "Get-AzSubscription | ForEach-Object { $_.Id + '|' + $_.Name + '|' + $_.State } | Out-String"
    );
    if (!result.ok) return { success: false, subscriptions: [], error: result.output };
    const subscriptions = result.output.split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((line) => {
        const [id, name, state] = line.split('|');
        return { id: id || '', name: name || '', state: state || '' };
      })
      .filter((s) => s.id && s.state === 'Enabled');
    return { success: true, subscriptions };
  });

  // List Log Analytics workspaces in the current subscription (or all subscriptions)
  ipcMain.handle('auth:azure-workspaces', async (_event, args) => {
    const subscriptionId = args?.subscriptionId as string | undefined;
    if (subscriptionId && !isValidGuid(subscriptionId)) {
      return { success: false, workspaces: [], error: 'Invalid subscription ID' };
    }
    const cmd = subscriptionId
      ? `Set-AzContext -Subscription '${subscriptionId}' | Out-Null; ` +
        "Get-AzOperationalInsightsWorkspace | ForEach-Object { " +
        "$_.Name + '|' + $_.ResourceGroupName + '|' + $_.Location + '|' + " +
        "$_.CustomerId + '|' + $_.Sku.Name } | Out-String"
      : "Get-AzOperationalInsightsWorkspace | ForEach-Object { " +
        "$_.Name + '|' + $_.ResourceGroupName + '|' + $_.Location + '|' + " +
        "$_.CustomerId + '|' + $_.Sku.Name } | Out-String";

    const result = await runPowershell(cmd);
    if (!result.ok) return { success: false, workspaces: [], error: result.output };
    const workspaces = result.output.split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((line) => {
        const [name, resourceGroup, location, customerId, sku] = line.split('|');
        return {
          name: name || '',
          resourceGroup: resourceGroup || '',
          location: location || '',
          customerId: customerId || '',
          sku: sku || '',
        };
      })
      .filter((w) => w.name);
    return { success: true, workspaces };
  });

  // List resource groups in the current subscription
  ipcMain.handle('auth:azure-resource-groups', async (_event, args) => {
    const subscriptionId = args?.subscriptionId as string | undefined;
    const setCtx = subscriptionId && isValidGuid(subscriptionId)
      ? `Set-AzContext -Subscription '${subscriptionId}' | Out-Null; `
      : '';
    const cmd = setCtx +
      "Get-AzResourceGroup | ForEach-Object { $_.ResourceGroupName + '|' + $_.Location } | Out-String";
    const result = await runPowershell(cmd);
    if (!result.ok) return { success: false, resourceGroups: [], error: result.output };
    const resourceGroups = result.output.split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((line) => {
        const [name, location] = line.split('|');
        return { name: name || '', location: location || '' };
      })
      .filter((rg) => rg.name);
    return { success: true, resourceGroups };
  });

  // Create a new resource group
  ipcMain.handle('auth:azure-create-resource-group', async (_event, {
    name, location, subscriptionId,
  }: { name: string; location: string; subscriptionId?: string }) => {
    const setCtx = subscriptionId && isValidGuid(subscriptionId)
      ? `Set-AzContext -Subscription '${subscriptionId}' | Out-Null; `
      : '';
    const result = await runPowershell(
      setCtx + `New-AzResourceGroup -Name '${name}' -Location '${location}' -Force | Out-Null; Write-Output 'OK'`,
      60000, // 60s timeout -- Set-AzContext can be slow on first call
    );
    return { success: result.ok && result.output.includes('OK'), error: result.ok ? '' : result.output };
  });

  // Create a new Log Analytics workspace
  ipcMain.handle('auth:azure-create-workspace', async (_event, {
    name, resourceGroup, location, subscriptionId,
  }: { name: string; resourceGroup: string; location: string; subscriptionId?: string }) => {
    const setCtx = subscriptionId && isValidGuid(subscriptionId)
      ? `Set-AzContext -Subscription '${subscriptionId}' | Out-Null; `
      : '';
    const cmd = setCtx +
      `$ws = New-AzOperationalInsightsWorkspace ` +
      `-ResourceGroupName '${sanitizeForPs(resourceGroup)}' ` +
      `-Name '${sanitizeForPs(name)}' ` +
      `-Location '${sanitizeForPs(location)}' ` +
      `-Sku 'PerGB2018' ` +
      `-RetentionInDays 90 -ErrorAction Stop; ` +
      `$ws.CustomerId.ToString() + '|' + $ws.ResourceGroupName + '|' + $ws.Location`;
    const result = await runPowershell(cmd, 120000); // 2 min timeout for workspace creation
    if (!result.ok || !result.output.includes('|')) {
      return { success: false, error: result.output || 'Failed to create workspace' };
    }
    const parts = result.output.trim().split('|');
    return {
      success: true,
      customerId: parts[0] || '',
      resourceGroup: parts[1] || resourceGroup,
      location: parts[2] || location,
    };
  });

  // Enable Microsoft Sentinel on a Log Analytics workspace
  ipcMain.handle('auth:azure-enable-sentinel', async (_event, {
    workspaceName, resourceGroup, subscriptionId,
  }: { workspaceName: string; resourceGroup: string; subscriptionId?: string }) => {
    const setCtx = subscriptionId && isValidGuid(subscriptionId)
      ? `Set-AzContext -Subscription '${subscriptionId}' | Out-Null; `
      : '';
    // Check if already enabled
    const checkCmd = setCtx +
      `$existing = Get-AzResource -ResourceGroupName '${sanitizeForPs(resourceGroup)}' ` +
      `-ResourceType 'Microsoft.OperationsManagement/solutions' ` +
      `-ResourceName 'SecurityInsights(${sanitizeForPs(workspaceName)})' -ErrorAction SilentlyContinue; ` +
      `if ($existing) { Write-Output 'ALREADY_ENABLED' } else { Write-Output 'NOT_ENABLED' }`;
    const checkResult = await runPowershell(checkCmd);
    if (checkResult.ok && checkResult.output.includes('ALREADY_ENABLED')) {
      return { success: true, alreadyEnabled: true };
    }
    // Deploy Sentinel via ARM template
    const deployCmd = setCtx +
      `$lawId = (Get-AzOperationalInsightsWorkspace -ResourceGroupName '${sanitizeForPs(resourceGroup)}' ` +
      `-Name '${sanitizeForPs(workspaceName)}').ResourceId; ` +
      `$template = @{ ` +
      `  '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#'; ` +
      `  contentVersion = '1.0.0.0'; ` +
      `  resources = @( ` +
      `    @{ ` +
      `      type = 'Microsoft.OperationsManagement/solutions'; ` +
      `      apiVersion = '2015-11-01-preview'; ` +
      `      name = 'SecurityInsights(${sanitizeForPs(workspaceName)})'; ` +
      `      location = '${sanitizeForPs((checkResult.output.split('|')[2] || 'eastus').trim())}'; ` +
      `      plan = @{ name = 'SecurityInsights(${sanitizeForPs(workspaceName)})'; publisher = 'Microsoft'; product = 'OMSGallery/SecurityInsights'; promotionCode = '' }; ` +
      `      properties = @{ workspaceResourceId = $lawId } ` +
      `    } ` +
      `  ) ` +
      `}; ` +
      `New-AzResourceGroupDeployment -ResourceGroupName '${sanitizeForPs(resourceGroup)}' ` +
      `-Name 'enable-sentinel' -TemplateObject $template -ErrorAction Stop | Out-Null; ` +
      `Write-Output 'OK'`;
    const deployResult = await runPowershell(deployCmd, 120000); // 2 min timeout for ARM deployment
    return {
      success: deployResult.ok && deployResult.output.includes('OK'),
      alreadyEnabled: false,
      error: deployResult.ok ? '' : deployResult.output,
    };
  });

  // Select a workspace: updates azure-parameters.json with the chosen workspace details
  ipcMain.handle('auth:azure-select-workspace', async (_event, {
    workspaceName, resourceGroupName, location, subscriptionId,
  }: {
    workspaceName: string; resourceGroupName: string; location: string; subscriptionId: string;
  }) => {
    const paramPath = appAzureParamsPath();

    let params: Record<string, unknown> = {};
    if (fs.existsSync(paramPath)) {
      try { params = JSON.parse(fs.readFileSync(paramPath, 'utf-8')); } catch { /* fresh */ }
    }

    params.workspaceName = workspaceName;
    params.resourceGroupName = resourceGroupName;
    params.location = location;
    params.subscriptionId = subscriptionId;

    const dir = path.dirname(paramPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(paramPath, JSON.stringify(params, null, 2) + '\n');

    return { success: true };
  });

  // Cribl API: create destination
  ipcMain.handle('auth:cribl-create-destination', async (_event, {
    destination, workerGroup,
  }: { destination: Record<string, unknown>; workerGroup?: string }) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, error: 'Cribl not connected' };
    return criblCreateDestination(auth, destination, workerGroup);
  });

  // Cribl API: upload pack
  ipcMain.handle('auth:cribl-upload-pack', async (_event, {
    crblPath, workerGroup,
  }: { crblPath: string; workerGroup?: string }) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, error: 'Cribl not connected' };
    return criblUploadPack(auth, crblPath, workerGroup);
  });

  // Cribl API: list destinations
  ipcMain.handle('auth:cribl-list-destinations', async (_event, {
    workerGroup,
  } = {}) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, destinations: [], error: 'Cribl not connected' };
    return criblListDestinations(auth, arguments[1]?.workerGroup);
  });

  // List workspaces
  ipcMain.handle('auth:cribl-workspaces', async () => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, workspaces: [], error: 'Cribl not connected' };
    return criblListWorkspaces(auth);
  });

  // List worker groups
  ipcMain.handle('auth:cribl-worker-groups', async (_event, {
    workspaceId,
  }: { workspaceId?: string } = {}) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, groups: [], error: 'Cribl not connected' };
    return criblListWorkerGroups(auth, workspaceId);
  });

  // List packs on a worker group
  ipcMain.handle('auth:cribl-list-packs', async (_event, {
    workerGroup,
  }: { workerGroup?: string } = {}) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, packs: [], error: 'Cribl not connected' };
    return criblListPacks(auth, workerGroup || 'default');
  });

  // Deploy pack to multiple worker groups
  ipcMain.handle('auth:cribl-deploy-multi', async (_event, {
    crblPath, workerGroups,
  }: { crblPath: string; workerGroups: string[] }) => {
    const auth = loadCriblAuth();
    if (!auth) return { results: [], error: 'Cribl not connected' };
    const results = await criblDeployPackToGroups(auth, crblPath, workerGroups);
    return { results };
  });

  // List sources on a worker group
  ipcMain.handle('auth:cribl-sources', async (_event, { workerGroup }: { workerGroup?: string } = {}) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, sources: [], error: 'Cribl not connected' };
    return criblListSources(auth, workerGroup || 'default');
  });

  // List routes on a worker group
  ipcMain.handle('auth:cribl-routes', async (_event, { workerGroup }: { workerGroup?: string } = {}) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, routes: [], error: 'Cribl not connected' };
    return criblListRoutes(auth, workerGroup || 'default');
  });

  // Capture sample events from a live source
  ipcMain.handle('auth:cribl-capture', async (_event, {
    workerGroup, sourceId, count, durationMs,
  }: { workerGroup: string; sourceId: string; count?: number; durationMs?: number }) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, events: [], error: 'Cribl not connected' };
    return criblCaptureSample(auth, workerGroup, sourceId, count || 10, durationMs || 60000);
  });

  // Preview pipeline with sample events
  ipcMain.handle('auth:cribl-preview', async (_event, {
    workerGroup, pipelineConf, sampleEvents,
  }: { workerGroup: string; pipelineConf: Record<string, unknown>; sampleEvents: Array<Record<string, unknown>> }) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, events: [], error: 'Cribl not connected' };
    return criblPreviewPipeline(auth, workerGroup, pipelineConf, sampleEvents);
  });

  // Run a Cribl Search query
  ipcMain.handle('auth:cribl-search', async (_event, {
    query, earliest, latest, maxResults,
  }: { query: string; earliest?: string; latest?: string; maxResults?: number }) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, events: [], error: 'Cribl not connected' };
    return criblSearch(auth, query, earliest || '-1h', latest || 'now', maxResults || 100);
  });

  // List Cribl Lake datasets
  ipcMain.handle('auth:cribl-datasets', async () => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, datasets: [], error: 'Cribl not connected' };
    return criblListDatasets(auth);
  });

  // Create a new Cribl Lake dataset
  ipcMain.handle('auth:cribl-create-dataset', async (_event, {
    datasetId, description,
  }: { datasetId: string; description?: string }) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, error: 'Cribl not connected' };
    return criblCreateDataset(auth, datasetId, description);
  });

  // Create a route on a worker group that directs source data to a pack.
  // Tries multiple API path patterns since the endpoint varies by Cribl version.
  ipcMain.handle('auth:cribl-create-route', async (_event, {
    workerGroup, routeId, name, filter, packId, output, description, final: isFinal,
  }: {
    workerGroup: string; routeId: string; name: string;
    filter: string; packId: string; output?: string; description?: string; final?: boolean;
  }) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, error: 'Cribl not connected' };
    try {
      const token = await getCriblToken(auth);
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      // Try multiple route endpoint paths (varies by Cribl version/deployment)
      const routePaths = [
        apiUrl(auth, workerGroup, '/pipelines/route'),
        apiUrl(auth, workerGroup, '/routes'),
        apiUrl(auth, workerGroup, '/system/routes'),
        apiUrl(auth, workerGroup, '/system/pipelines/route'),
      ];

      let routeConfig: any = null;
      let routeUrl = '';
      const errors: string[] = [];
      for (const url of routePaths) {
        try {
          const resp = await httpsGet(url, headers);
          if (resp.status >= 200 && resp.status < 300) {
            routeConfig = JSON.parse(resp.body);
            routeUrl = url;
            break;
          }
          errors.push(`${url.split('/m/')[1] || url}: ${resp.status}`);
        } catch (err) {
          errors.push(`${url.split('/m/')[1] || url}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!routeConfig) {
        return { success: false, error: `Failed to get routes from ${workerGroup}: ${errors.join('; ')}` };
      }

      // Handle different response shapes
      // GET response shape: { items: [...routes...], count: N }
      const routes = routeConfig.items || routeConfig.routes || [];

      // Check if route already exists
      if (routes.some((r: Record<string, unknown>) => r.id === routeId)) {
        return { success: true, error: `Route "${routeId}" already exists` };
      }

      // Build the new route entry
      const newRoute = {
        id: routeId,
        name,
        filter,
        pipeline: packId === 'passthru' ? 'passthru' : `pack:${packId}`,
        output: output || 'default',
        final: isFinal !== undefined ? isFinal : true,
        disabled: false,
        description: description || `Route ${name} data to ${packId} pack`,
      };

      // Try multiple write endpoints for route creation.
      // Cribl's API varies between versions and Cloud vs self-managed.
      const writeEndpoints = [
        apiUrl(auth, workerGroup, '/pipelines/route'),
        apiUrl(auth, workerGroup, '/system/pipelines/route'),
        apiUrl(auth, workerGroup, '/pipelines'),
        apiUrl(auth, workerGroup, '/system/routes'),
      ];

      let writeSuccess = false;
      const writeErrors: string[] = [];

      for (const writeUrl of writeEndpoints) {
        try {
          // GET the config object first
          const getResp = await httpsGet(writeUrl, headers);
          if (getResp.status < 200 || getResp.status >= 300) {
            writeErrors.push(`GET ${writeUrl.split('/m/')[1]}: ${getResp.status}`);
            continue;
          }

          const config = JSON.parse(getResp.body);
          // Extract routes array from whatever shape the response has
          let existingRoutes: any[];
          let updatePayload: any;

          if (config.routes && Array.isArray(config.routes)) {
            // Shape: { id: "default", routes: [...] }
            existingRoutes = config.routes;
            existingRoutes.unshift(newRoute);
            updatePayload = { ...config, routes: existingRoutes };
          } else if (config.items && Array.isArray(config.items)) {
            if (config.items[0]?.routes) {
              // Shape: { items: [{ id: "default", routes: [...] }] }
              existingRoutes = config.items[0].routes;
              existingRoutes.unshift(newRoute);
              updatePayload = { ...config.items[0], routes: existingRoutes };
            } else {
              // Shape: { items: [...route objects...] } -- the items ARE the routes
              existingRoutes = config.items;
              existingRoutes.unshift(newRoute);
              updatePayload = { id: 'default', routes: existingRoutes };
            }
          } else {
            writeErrors.push(`GET ${writeUrl.split('/m/')[1]}: unexpected shape ${JSON.stringify(Object.keys(config))}`);
            continue;
          }

          // Try PATCH
          const patchResp = await httpsPatch(writeUrl, JSON.stringify(updatePayload), headers);
          if (patchResp.status >= 200 && patchResp.status < 300) {
            writeSuccess = true;
            break;
          }
          writeErrors.push(`PATCH ${writeUrl.split('/m/')[1]}: ${patchResp.status}`);

          // Try PUT
          const putResp = await httpsPut(writeUrl, JSON.stringify(updatePayload), headers);
          if (putResp.status >= 200 && putResp.status < 300) {
            writeSuccess = true;
            break;
          }
          writeErrors.push(`PUT ${writeUrl.split('/m/')[1]}: ${putResp.status}`);
        } catch (err) {
          writeErrors.push(`${writeUrl.split('/m/')[1]}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!writeSuccess) {
        return { success: false, error: `Failed to create route: ${writeErrors.join('; ')}` };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Commit pending configuration changes (version control).
  // Tries multiple endpoint paths -- varies by Cribl version and Cloud vs self-managed.
  ipcMain.handle('auth:cribl-commit', async (_event, { message }: { message: string }) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, error: 'Cribl not connected' };
    try {
      const token = await getCriblToken(auth);
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const body = JSON.stringify({ message: message || 'Configuration update' });

      const paths = [
        `${auth.baseUrl}/api/v1/version/commit`,
        `${auth.baseUrl}/api/v1/m/default/version/commit`,
      ];
      for (const url of paths) {
        try {
          const resp = await httpsPost(url, body, headers);
          if (resp.status >= 200 && resp.status < 300) return { success: true };
          if (resp.status === 409) return { success: true, error: 'No pending changes to commit' };
        } catch { /* try next */ }
      }
      // For Cribl Cloud, commit may not be needed (auto-commits on save)
      if (auth.deploymentType === 'cloud') {
        return { success: true, error: 'Cloud mode: changes auto-committed' };
      }
      return { success: false, error: 'Commit failed (all endpoints returned errors)' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Deploy committed configuration to a worker group.
  // Tries multiple paths -- Cribl Cloud may auto-deploy or use a different endpoint.
  ipcMain.handle('auth:cribl-deploy-config', async (_event, { workerGroup }: { workerGroup: string }) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, error: 'Cribl not connected' };
    try {
      const token = await getCriblToken(auth);
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const body = JSON.stringify({});

      const paths = [
        `${auth.baseUrl}/api/v1/master/groups/${workerGroup}/deploy`,
        `${auth.baseUrl}/api/v1/m/${workerGroup}/deploy`,
        `${auth.baseUrl}/api/v1/master/groups/${workerGroup}/configVersion/deploy`,
      ];
      for (const url of paths) {
        try {
          const resp = await httpsPost(url, body, headers);
          if (resp.status >= 200 && resp.status < 300) return { success: true };
        } catch { /* try next */ }
      }
      // For Cribl Cloud, deploy may not be needed (auto-deploys)
      if (auth.deploymentType === 'cloud') {
        return { success: true, error: 'Cloud mode: changes auto-deployed' };
      }
      return { success: false, error: `Deploy failed for ${workerGroup} (all endpoints returned errors)` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Create or update an event breaker ruleset on a worker group
  ipcMain.handle('auth:cribl-create-breaker', async (_event, {
    workerGroup, breakerId, breakerConfig,
  }: {
    workerGroup: string;
    breakerId: string;
    breakerConfig: Record<string, unknown>;
  }) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, error: 'Cribl not connected' };
    try {
      const token = await getCriblToken(auth);
      const breakerUrl = apiUrl(auth, workerGroup, '/lib/breakers');

      // Check if breaker already exists
      const getResp = await httpsGet(breakerUrl, { Authorization: `Bearer ${token}` });
      let existing = false;
      if (getResp.status >= 200 && getResp.status < 300) {
        const parsed = JSON.parse(getResp.body);
        const items = parsed.items || parsed || [];
        existing = items.some((b: Record<string, unknown>) => b.id === breakerId);
      }

      if (existing) {
        // Update existing breaker via PATCH
        const patchUrl = apiUrl(auth, workerGroup, `/lib/breakers/${encodeURIComponent(breakerId)}`);
        const patchResp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const parsed = new URL(patchUrl);
          const body = JSON.stringify(breakerConfig);
          const mod = httpModule(patchUrl);
          const req = mod.request({
            hostname: parsed.hostname, port: parsed.port || defaultPort(patchUrl),
            path: parsed.pathname + parsed.search, method: 'PATCH',
            headers: {
              Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
            rejectUnauthorized: patchUrl.startsWith('https://'), timeout: 30000,
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
          });
          req.on('error', reject);
          req.write(body);
          req.end();
        });
        if (patchResp.status >= 200 && patchResp.status < 300) {
          return { success: true, action: 'updated' };
        }
        return { success: false, error: `Update failed (${patchResp.status}): ${patchResp.body.slice(0, 200)}` };
      }

      // Create new breaker via POST
      const postResp = await httpsPost(
        breakerUrl,
        JSON.stringify(breakerConfig),
        { Authorization: `Bearer ${token}` },
      );
      if (postResp.status >= 200 && postResp.status < 300) {
        return { success: true, action: 'created' };
      }
      return { success: false, error: `Create failed (${postResp.status}): ${postResp.body.slice(0, 200)}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Create or update a secret in Cribl's internal secret store
  ipcMain.handle('auth:cribl-create-secret', async (_event, {
    workerGroup, secretId, secretValue, description,
  }: {
    workerGroup: string; secretId: string; secretValue: string; description?: string;
  }) => {
    const auth = loadCriblAuth();
    if (!auth) return { success: false, error: 'Cribl not connected' };
    try {
      const token = await getCriblToken(auth);
      const secretUrl = apiUrl(auth, workerGroup, '/system/secrets');

      // Check if secret already exists
      const getResp = await httpsGet(secretUrl, { Authorization: `Bearer ${token}` });
      let exists = false;
      if (getResp.status >= 200 && getResp.status < 300) {
        const parsed = JSON.parse(getResp.body);
        const items = parsed.items || [];
        exists = items.some((s: Record<string, unknown>) => s.id === secretId);
      }

      const secretBody = JSON.stringify({
        id: secretId,
        value: secretValue,
        description: description || 'Auto-created by Cribl SOC Toolkit',
        tags: 'sentinel,integration',
      });

      if (exists) {
        // Update via PATCH
        const patchUrl = apiUrl(auth, workerGroup, '/system/secrets/' + encodeURIComponent(secretId));
        const patchResp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const parsed = new URL(patchUrl);
          const mod = httpModule(patchUrl);
          const req = mod.request({
            hostname: parsed.hostname, port: parsed.port || defaultPort(patchUrl),
            path: parsed.pathname, method: 'PATCH',
            headers: {
              Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(secretBody),
            },
            rejectUnauthorized: patchUrl.startsWith('https://'), timeout: 30000,
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
          });
          req.on('error', reject);
          req.write(secretBody);
          req.end();
        });
        return { success: patchResp.status >= 200 && patchResp.status < 300, action: 'updated' };
      }

      // Create new secret
      const postResp = await httpsPost(secretUrl, secretBody, { Authorization: `Bearer ${token}` });
      const created = postResp.status >= 200 && postResp.status < 300;
      if (!created) {
        return { success: false, error: 'Create failed (' + postResp.status + '): ' + postResp.body.slice(0, 200) };
      }
      return { success: true, action: 'created' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Debug: test an arbitrary Cribl API endpoint
  ipcMain.handle('auth:cribl-test-url', async (_event, { urlPath }: { urlPath: string }) => {
    const auth = loadCriblAuth();
    if (!auth) return { status: 0, body: 'Not connected' };
    try {
      const token = await getCriblToken(auth);
      const fullUrl = `${auth.baseUrl}${urlPath}`;
      const resp = await httpsGet(fullUrl, { Authorization: `Bearer ${token}` });
      return { status: resp.status, body: resp.body.slice(0, 2000), url: fullUrl };
    } catch (err) {
      return { status: 0, body: err instanceof Error ? err.message : String(err) };
    }
  });

  // Query Azure Log Analytics workspace (destination stage in data flow view)
  ipcMain.handle('auth:azure-query', async (_event, {
    query, timespan,
  }: { query: string; timespan?: string }) => {
    if (!query || typeof query !== 'string') {
      return { success: false, rows: [], error: 'Query is required' };
    }
    const safeQuery = query.replace(/'/g, "''");
    const ts = sanitizeForPs(timespan || 'PT1H');
    const cmd =
      "try { " +
      "$ws = Get-AzOperationalInsightsWorkspace -ErrorAction Stop | Select-Object -First 1; " +
      "if (-not $ws) { Write-Output 'ERROR:No workspace found'; return }; " +
      "$wsId = $ws.CustomerId.ToString(); " +
      "$token = (Get-AzAccessToken -ResourceUrl 'https://api.loganalytics.io').Token; " +
      "$headers = @{ Authorization = \"Bearer $token\"; 'Content-Type' = 'application/json' }; " +
      "$body = @{ query = '" + safeQuery + "'; timespan = '" + ts + "' } | ConvertTo-Json; " +
      "$resp = Invoke-RestMethod -Uri \"https://api.loganalytics.io/v1/workspaces/$wsId/query\" -Method POST -Headers $headers -Body $body -ErrorAction Stop; " +
      "$cols = $resp.tables[0].columns | ForEach-Object { $_.name }; " +
      "$rows = @(); " +
      "foreach ($row in $resp.tables[0].rows) { " +
      "$obj = @{}; for ($i = 0; $i -lt $cols.Count; $i++) { $obj[$cols[$i]] = $row[$i] }; " +
      "$rows += ($obj | ConvertTo-Json -Compress) }; " +
      "Write-Output (\"ROWS:\" + ($rows -join '|||'))" +
      "} catch { Write-Output (\"ERROR:\" + $_.Exception.Message) }";

    const result = await runPowershell(cmd);
    if (!result.ok) return { success: false, rows: [], error: result.output.slice(0, 300) };
    // Find ROWS: or ERROR: anywhere in output (PS warnings may precede)
    const output = result.output;
    const errorIdx = output.indexOf('ERROR:');
    const rowsIdx = output.indexOf('ROWS:');
    if (errorIdx >= 0 && (rowsIdx < 0 || errorIdx < rowsIdx)) {
      return { success: false, rows: [], error: output.slice(errorIdx + 6).trim().slice(0, 300) };
    }
    if (rowsIdx >= 0) {
      const rowsData = output.slice(rowsIdx + 5);
      const rowStrings = rowsData.split('|||').filter(Boolean);
      const rows = rowStrings.map((r) => { try { return JSON.parse(r.trim()); } catch { return {}; } }).filter((r) => Object.keys(r).length > 0);
      return { success: true, rows };
    }
    // No ROWS: found -- might be empty result set
    if (output.includes('TABLES:1') && output.includes('ROWS:0')) {
      return { success: true, rows: [] };
    }
    return { success: false, rows: [], error: `No results. Output: ${output.slice(0, 200)}` };
  });
}
