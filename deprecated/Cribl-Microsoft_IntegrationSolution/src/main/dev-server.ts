// Dev Diagnostic Server
// Runs a tiny HTTP server on localhost:9999 in dev mode only.
// Exposes endpoints for automated testing and debugging.
// ONLY binds to 127.0.0.1 -- not accessible from network.

import http from 'http';
import { BrowserWindow } from 'electron';
import https from 'https';
import fs from 'fs';
import path from 'path';

const PORT = 9999;
let server: http.Server | null = null;
const logs: string[] = [];
const MAX_LOGS = 500;

// Capture console output
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

function captureLog(level: string, args: unknown[]) {
  const msg = `[${new Date().toISOString()}] [${level}] ${args.map((a) => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
  logs.push(msg);
  if (logs.length > MAX_LOGS) logs.shift();
}

console.log = (...args: unknown[]) => { captureLog('LOG', args); origLog(...args); };
console.error = (...args: unknown[]) => { captureLog('ERR', args); origError(...args); };
console.warn = (...args: unknown[]) => { captureLog('WARN', args); origWarn(...args); };

// Proxy an HTTPS GET request (for testing Cribl API paths)
function proxyGet(url: string, token: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Cribl-Microsoft-DiagServer/1.0',
        'Accept': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          respHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v || '');
        }
        resolve({ status: res.statusCode || 0, body: data, headers: respHeaders });
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// Load Cribl auth token
async function getCriblToken(): Promise<{ token: string; baseUrl: string } | null> {
  try {
    const { loadCriblAuth, getCriblToken: getToken } = await import('./ipc/auth');
    // loadCriblAuth is not exported -- read directly from stored auth
    const appData = process.env.APPDATA || process.env.HOME || '';
    const authDir = path.join(appData, '.cribl-microsoft', 'auth');
    const plainPath = path.join(authDir, 'cribl-auth.json');

    let auth: Record<string, unknown> | null = null;
    if (fs.existsSync(plainPath)) {
      try { auth = JSON.parse(fs.readFileSync(plainPath, 'utf-8')); } catch { /* skip */ }
    }

    // Try encrypted
    if (!auth) {
      const encPath = path.join(authDir, 'cribl-auth');
      if (fs.existsSync(encPath)) {
        try {
          const { safeStorage, app } = await import('electron');
          if (app.isReady() && safeStorage.isEncryptionAvailable()) {
            const raw = safeStorage.decryptString(fs.readFileSync(encPath));
            auth = JSON.parse(raw);
          }
        } catch { /* skip */ }
      }
    }

    if (!auth || !auth.clientId || !auth.clientSecret) return null;

    const token = await getToken(auth as any);
    return { token, baseUrl: String(auth.baseUrl || '') };
  } catch {
    return null;
  }
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data, null, 2));
}

export function startDevServer() {

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      // Health check
      if (pathname === '/api/health') {
        const cribl = await getCriblToken();
        jsonResponse(res, 200, {
          status: 'ok',
          criblConnected: !!cribl,
          criblBaseUrl: cribl?.baseUrl || '',
          logCount: logs.length,
          uptime: process.uptime(),
        });
        return;
      }

      // Recent logs
      if (pathname === '/api/logs') {
        const count = parseInt(url.searchParams.get('count') || '50', 10);
        jsonResponse(res, 200, { logs: logs.slice(-count) });
        return;
      }

      // Proxy a Cribl API call -- /api/cribl/proxy?path=/api/v1/master/groups
      if (pathname === '/api/cribl/proxy') {
        const apiPath = url.searchParams.get('path');
        if (!apiPath) {
          jsonResponse(res, 400, { error: 'Missing ?path= parameter' });
          return;
        }
        const cribl = await getCriblToken();
        if (!cribl) {
          jsonResponse(res, 401, { error: 'Cribl not connected -- no auth token available' });
          return;
        }
        const fullUrl = `${cribl.baseUrl}${apiPath}`;
        console.log(`[DIAG] Proxying: ${fullUrl}`);
        const result = await proxyGet(fullUrl, cribl.token);
        let parsedBody: unknown = result.body;
        try { parsedBody = JSON.parse(result.body); } catch { /* raw string */ }
        jsonResponse(res, 200, {
          requestUrl: fullUrl,
          status: result.status,
          responseHeaders: result.headers,
          body: parsedBody,
        });
        return;
      }

      // Run a battery of API endpoint tests
      if (pathname === '/api/cribl/diagnose') {
        const group = url.searchParams.get('group') || 'default';
        const sourceId = url.searchParams.get('source') || '';
        const cribl = await getCriblToken();
        if (!cribl) {
          jsonResponse(res, 401, { error: 'Cribl not connected' });
          return;
        }

        const tests = [
          `/api/v1/master/groups`,
          `/api/v1/m/${group}/system/inputs`,
          `/api/v1/m/${group}/system/outputs`,
          `/api/v1/m/${group}/lib/samples`,
          `/api/v1/m/${group}/samples`,
          `/api/v1/m/${group}/system/samples`,
          `/api/v1/m/${group}/lib/jobs`,
          `/api/v1/m/${group}/preview`,
          `/api/v1/m/${group}/pipelines`,
          `/api/v1/m/${group}/packs`,
          ...(sourceId ? [
            `/api/v1/m/${group}/system/inputs/${sourceId}`,
          ] : []),
        ];

        const results: Array<{ path: string; url: string; status: number; bodyPreview: string }> = [];
        for (const testPath of tests) {
          try {
            const fullUrl = `${cribl.baseUrl}${testPath}`;
            const result = await proxyGet(fullUrl, cribl.token);
            results.push({
              path: testPath,
              url: fullUrl,
              status: result.status,
              bodyPreview: result.body.slice(0, 500),
            });
          } catch (err) {
            results.push({
              path: testPath,
              url: `${cribl.baseUrl}${testPath}`,
              status: 0,
              bodyPreview: err instanceof Error ? err.message : String(err),
            });
          }
        }

        jsonResponse(res, 200, {
          group,
          sourceId,
          baseUrl: cribl.baseUrl,
          results,
        });
        return;
      }

      // Screenshot (captures the focused window)
      if (pathname === '/api/screenshot') {
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        if (win) {
          const image = await win.webContents.capturePage();
          const png = image.toPNG();
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
          res.end(png);
        } else {
          jsonResponse(res, 404, { error: 'No window available' });
        }
        return;
      }

      // 404
      jsonResponse(res, 404, {
        error: 'Not found',
        endpoints: [
          'GET /api/health',
          'GET /api/logs?count=50',
          'GET /api/cribl/proxy?path=/api/v1/master/groups',
          'GET /api/cribl/diagnose?group=DatacenterEast&source=pfsense',
          'GET /api/screenshot',
        ],
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[DEV] Diagnostic server running at http://127.0.0.1:${PORT}`);
    console.log(`[DEV] Endpoints: /api/health, /api/logs, /api/cribl/proxy?path=..., /api/cribl/diagnose?group=...&source=..., /api/screenshot`);
  });

  server.on('error', (err) => {
    console.error(`[DEV] Diagnostic server failed to start: ${err.message}`);
  });
}

export function stopDevServer() {
  if (server) {
    server.close();
    server = null;
  }
}
