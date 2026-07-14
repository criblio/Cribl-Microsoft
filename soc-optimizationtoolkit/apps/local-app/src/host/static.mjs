// Static file serving for the built UI (dist/web, produced by the Web
// step's vite build). Serves at "/" with an index.html fallback for client
// routing; when the build output is missing, "/" answers with a friendly
// page pointing at the build command instead of a bare 404.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

/** Content types for the asset extensions a vite build emits. */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const BUILD_MISSING_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>SOC Optimization Toolkit - build required</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; line-height: 1.5;">
<h1>UI build not found</h1>
<p>The local host is running, but the web UI has not been built yet
(<code>dist/web</code> is missing).</p>
<p>From the repository's <code>soc-optimizationtoolkit</code> directory, run:</p>
<pre><code>npm run build --workspace @soc/local-app</code></pre>
<p>then reload this page. The API endpoints under <code>/api/</code> are already available.</p>
</body>
</html>
`;

/**
 * Build the static handler over a web root directory.
 *
 * @param {string} webRoot Absolute path of the vite build output (dist/web).
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) => Promise<void>}
 */
export function createStaticHandler(webRoot) {
  const rootPrefix = webRoot.endsWith(path.sep) ? webRoot : webRoot + path.sep;

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {string} contentType
   * @param {string | Buffer} content
   * @param {boolean} headOnly
   */
  function send(res, status, contentType, content, headOnly) {
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(content),
      ...(contentType.startsWith('text/html') ? { 'Cache-Control': 'no-store' } : {}),
    });
    res.end(headOnly ? undefined : content);
  }

  return async function serveStatic(req, res, pathname) {
    const headOnly = req.method === 'HEAD';

    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      send(res, 400, 'text/plain; charset=utf-8', 'bad request path', headOnly);
      return;
    }
    if (decoded.includes('\0')) {
      send(res, 400, 'text/plain; charset=utf-8', 'bad request path', headOnly);
      return;
    }

    // Resolve inside the web root only; anything escaping it is a 404.
    const relative = decoded.replace(/^\/+/, '');
    const resolved = relative === '' ? path.join(webRoot, 'index.html') : path.resolve(webRoot, relative);
    if (resolved !== webRoot && !resolved.startsWith(rootPrefix)) {
      send(res, 404, 'text/plain; charset=utf-8', 'not found', headOnly);
      return;
    }

    const direct = await tryRead(resolved);
    if (direct !== null) {
      const ext = path.extname(resolved).toLowerCase();
      send(res, 200, CONTENT_TYPES[ext] ?? 'application/octet-stream', direct, headOnly);
      return;
    }

    // Not a real file. Requests that look like assets (they carry an
    // extension) 404; everything else is client-side routing and falls back
    // to index.html.
    if (path.extname(resolved) !== '' && relative !== '') {
      send(res, 404, 'text/plain; charset=utf-8', 'not found', headOnly);
      return;
    }
    const index = await tryRead(path.join(webRoot, 'index.html'));
    if (index !== null) {
      send(res, 200, CONTENT_TYPES['.html'], index, headOnly);
      return;
    }
    // No build output at all: friendly instructions instead of a bare 404.
    send(res, 200, CONTENT_TYPES['.html'], BUILD_MISSING_PAGE, headOnly);
  };
}

/**
 * Read a file, returning null for anything unreadable (missing, a
 * directory, permission trouble) so the caller can fall through.
 *
 * @param {string} filePath
 * @returns {Promise<Buffer | null>}
 */
async function tryRead(filePath) {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}
