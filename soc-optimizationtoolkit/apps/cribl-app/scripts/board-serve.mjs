// Serve docs/board.json as a live kanban page.
//
// The imperative half: board-html.mjs decides what the page says, this decides
// nothing. It re-reads board.json on EVERY request rather than caching, so the
// page can never be older than the file, and it watches the docs directory so
// an edit pushes a reload without a refresh.
//
// Watching the DIRECTORY, not the file: an editor that saves atomically writes
// a temp file and renames it over the target, which breaks a watch bound to the
// old inode. A directory watch survives that. (Node's fs.watch also fires more
// than once per save on Windows, hence the debounce.)
//
// Its own port, because 5173 is the Cribl dev app and a second Vite grabs 5174.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyDecision, renderBoard, validateBoard } from './board.mjs';
import { renderBoardHtml } from './board-html.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = join(__dirname, '..', '..', '..', 'docs');
const boardPath = join(docsDir, 'board.json');

const argPort = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(argPort?.slice('--port='.length) ?? process.env.BOARD_PORT ?? 5175);

/** Every open SSE response, so a file change can reach all of them. */
const clients = new Set();

function errorPage(message) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><title>Board - error</title>
<body style="background:#0f1620;color:#ffcf8a;font:14px ui-sans-serif,system-ui,sans-serif;padding:32px">
<h1 style="font-size:16px">docs/board.json could not be rendered</h1>
<pre style="white-space:pre-wrap;color:#dfe8f2">${esc(message)}</pre>
<p style="color:#8ba0b8">Fix the file and this page reloads by itself.</p>
<script>try{new EventSource('/events').onmessage=()=>location.reload()}catch{}</script>`;
}

async function page() {
  // A broken board is a thing to SHOW, not to crash on: the server is most
  // useful precisely while the JSON is being edited.
  let data;
  try {
    data = JSON.parse(await readFile(boardPath, 'utf8'));
  } catch (e) {
    return errorPage(e instanceof Error ? e.message : String(e));
  }
  const today = new Date().toISOString().slice(0, 10);
  return renderBoardHtml(data, today, validateBoard(data));
}

/**
 * Record an answer against a decision.
 *
 * Re-reads board.json first rather than trusting anything the page was
 * rendered from - it may have been hand-edited since - and validates the
 * RESULT before writing, so a click can never leave the board in a state
 * check-board would reject. board.md is re-rendered in the same breath,
 * because a write that made CI fail would be a poor kind of convenience.
 */
async function decide(body) {
  let data;
  try {
    data = JSON.parse(await readFile(boardPath, 'utf8'));
  } catch (e) {
    return { status: 500, text: `board.json could not be read: ${e}` };
  }
  const applied = applyDecision(data, body.id, body.option ?? null);
  if (!applied.ok) return { status: 400, text: applied.error };

  const findings = validateBoard(applied.data);
  if (findings.length > 0) {
    return { status: 409, text: `That answer would break the board:\n${findings.join('\n')}` };
  }

  // CRLF and two-space indent, matching what board.mjs and the repo write.
  const json = JSON.stringify(applied.data, null, 2).replace(/\n/g, '\r\n') + '\r\n';
  await writeFile(boardPath, json, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  await writeFile(join(docsDir, 'board.md'), renderBoard(applied.data, today), 'utf8');
  return { status: 200, text: 'recorded' };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      // A local dev tool still should not accept an unbounded body.
      if (raw.length > 64_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  if (url === '/decide' && req.method === 'POST') {
    let out;
    try {
      out = await decide(await readJsonBody(req));
    } catch (e) {
      out = { status: 400, text: `bad request: ${e instanceof Error ? e.message : e}` };
    }
    res.writeHead(out.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(out.text);
    return;
  }

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url === '/' || url === '/index.html') {
    const html = await page();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // The page is regenerated per request; a cached copy would defeat that.
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

let timer = null;
watch(docsDir, (_event, filename) => {
  if (filename && !String(filename).startsWith('board.json')) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const res of clients) res.write('data: changed\n\n');
  }, 120);
});

server.listen(PORT, () => {
  console.log(`Board: http://localhost:${PORT}  (watching docs/board.json)`);
});
