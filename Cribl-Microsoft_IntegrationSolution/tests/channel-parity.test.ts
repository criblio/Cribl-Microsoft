// Channel parity test -- the drift guard for the dual-transport API surface.
//
// The app exposes its backend over two transports: Electron IPC (preload.ts -> window.api,
// handlers registered in ipc/index.ts) and a web server (api-client.ts -> fetch, handlers
// registered in server/api-router.ts). The channel contract is currently hand-mirrored across
// those files. This test fails the moment they drift, so a missing handler registration or an
// out-of-sync client method is caught in CI instead of as a silent runtime 404.
//
// It is intentionally hermetic: it parses source text rather than importing/executing modules.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..', 'src');
const IPC_DIR = path.join(SRC, 'main', 'ipc');

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf-8');
}

// Extract the first capture group of every match of `pattern` in `src`, deduped and sorted.
function extract(pattern: RegExp, src: string): string[] {
  const re = new RegExp(pattern.source, 'g');
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return [...out].sort();
}

// All `.handle('channel', ...)` declarations across the IPC handler modules (the universe of
// channels a transport can register).
function allHandlerChannels(): string[] {
  const out = new Set<string>();
  for (const file of fs.readdirSync(IPC_DIR)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const src = fs.readFileSync(path.join(IPC_DIR, file), 'utf-8');
    for (const ch of extract(/\.handle\(\s*'([^']+)'/, src)) out.add(ch);
  }
  return [...out].sort();
}

function setDiff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const bs = new Set(b);
  const as = new Set(a);
  return { onlyA: a.filter((x) => !bs.has(x)), onlyB: b.filter((x) => !as.has(x)) };
}

// --- Source-derived channel sets ------------------------------------------------------------

const preloadSrc = read(path.join('main', 'preload.ts'));
const clientSrc = read(path.join('renderer', 'api-client.ts'));
const indexSrc = read(path.join('main', 'ipc', 'index.ts'));
const routerSrc = read(path.join('server', 'api-router.ts'));

const handlerChannels = allHandlerChannels();

const preloadInvoke = extract(/ipcRenderer\.invoke\(\s*'([^']+)'/, preloadSrc);
const preloadOn = extract(/ipcRenderer\.on\(\s*'([^']+)'/, preloadSrc);

const clientCall = extract(/\bcall\(\s*'([^']+)'/, clientSrc);
const clientOnEvent = extract(/onEvent\(\s*'([^']+)'/, clientSrc);

// Channels the web client serves through a bespoke path rather than the generic call() helper
// (e.g. samples:parse-files uses an HTML file input + multipart upload). They are still part of
// the web surface, so count them toward invoke parity.
const BESPOKE_CLIENT_CHANNELS = ['samples:parse-files'];
const clientInvoke = [...new Set([...clientCall, ...BESPOKE_CLIENT_CHANNELS])].sort();

// Handler modules registered by each transport's registration list. Excludes the wrapper
// (registerIpcHandlers) and the `registerXxxHandlers` placeholder that appears in a comment.
const NON_MODULE_REGISTRARS = new Set(['registerIpcHandlers', 'registerXxxHandlers']);
function registeredModules(src: string): string[] {
  return extract(/\b(register\w+Handlers)\b/, src).filter((n) => !NON_MODULE_REGISTRARS.has(n));
}
const electronModules = registeredModules(indexSrc);
const webModules = registeredModules(routerSrc);

// Handlers that exist but are intentionally not bridged to either renderer (internal/main-only).
const UNEXPOSED_HANDLERS = new Set([
  'app:paths',
  'app:link-repo',
  'app:unlink-repo',
  'changes:delete-snapshot',
  'samples:list-libraries',
  'samples:load-library-file',
]);

describe('Channel parity (dual-transport API surface)', () => {
  it('registers the same handler modules in Electron (ipc/index.ts) and web (api-router.ts)', () => {
    const { onlyA, onlyB } = setDiff(electronModules, webModules);
    expect(
      { electronOnly: onlyA, webOnly: onlyB },
      `Handler module registration lists drifted. Electron-only: ${onlyA.join(', ') || '(none)'}; ` +
        `web-only: ${onlyB.join(', ') || '(none)'}. Both ipc/index.ts and server/api-router.ts must register the same modules.`,
    ).toEqual({ electronOnly: [], webOnly: [] });
  });

  it('exposes identical invoke channels in preload (Electron) and api-client (web)', () => {
    const { onlyA, onlyB } = setDiff(preloadInvoke, clientInvoke);
    expect(
      { preloadOnly: onlyA, clientOnly: onlyB },
      `Invoke-channel drift. In preload but not web client: ${onlyA.join(', ') || '(none)'}; ` +
        `in web client but not preload: ${onlyB.join(', ') || '(none)'}.`,
    ).toEqual({ preloadOnly: [], clientOnly: [] });
  });

  it('exposes identical push (event) channels in preload and api-client', () => {
    const { onlyA, onlyB } = setDiff(preloadOn, clientOnEvent);
    expect(
      { preloadOnly: onlyA, clientOnly: onlyB },
      `Push-channel drift. In preload but not web client: ${onlyA.join(', ') || '(none)'}; ` +
        `in web client but not preload: ${onlyB.join(', ') || '(none)'}.`,
    ).toEqual({ preloadOnly: [], clientOnly: [] });
  });

  it('has a registered handler for every channel the renderers invoke (no dangling calls)', () => {
    const handlerSet = new Set(handlerChannels);
    const danglingPreload = preloadInvoke.filter((c) => !handlerSet.has(c));
    const danglingClient = clientCall.filter((c) => !handlerSet.has(c));
    expect(
      { danglingPreload, danglingClient },
      `Renderer invokes a channel with no ipcMain.handle(): preload=${danglingPreload.join(', ') || '(none)'}, ` +
        `client=${danglingClient.join(', ') || '(none)'}.`,
    ).toEqual({ danglingPreload: [], danglingClient: [] });
  });

  it('exposes every renderer-facing handler through both transports (no unbridged channels)', () => {
    // Every handler channel that is meant for the renderer should be reachable from preload.
    const exposable = handlerChannels.filter((c) => !UNEXPOSED_HANDLERS.has(c));
    const preloadSet = new Set(preloadInvoke);
    const unbridged = exposable.filter((c) => !preloadSet.has(c));
    expect(
      unbridged,
      `Handler channels exist but are not exposed via preload (add to preload + api-client, or to ` +
        `UNEXPOSED_HANDLERS if intentionally main-only): ${unbridged.join(', ') || '(none)'}.`,
    ).toEqual([]);
  });

  it('guards against a broken regex by asserting minimum channel counts', () => {
    expect(handlerChannels.length).toBeGreaterThanOrEqual(130);
    expect(preloadInvoke.length).toBeGreaterThanOrEqual(130);
    expect(clientInvoke.length).toBeGreaterThanOrEqual(130);
    expect(preloadOn.length).toBeGreaterThanOrEqual(10);
    expect(clientOnEvent.length).toBeGreaterThanOrEqual(10);
    expect(electronModules.length).toBeGreaterThanOrEqual(20);
  });
});
