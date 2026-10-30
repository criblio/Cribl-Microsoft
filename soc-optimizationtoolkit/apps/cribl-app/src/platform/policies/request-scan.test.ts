/// <reference types="node" />
// The request scan: fixtures pin the rule that tells Cribl calls from ARM calls,
// and the real-tree test fails when a Cribl call site has no API_CALLS entry.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_CALLS } from './paths';
import { covers } from './policyCoverage';
import {
  DYNAMIC_PATHS,
  MIXED_FILES,
  isTestFile,
  readPathExpression,
  scanFile,
  scanSources,
  type ScannedCall,
  type SourceFile,
} from './request-scan';

const registered = (call: Pick<ScannedCall, 'method' | 'path'>): boolean =>
  API_CALLS.some((c) => covers(c.path, call.path) && (call.method === null || call.method === c.method));

describe('request-scan rule (fixtures)', () => {
  it('flags an unregistered call in a Cribl file', () => {
    const f: SourceFile = {
      path: 'packages/core/src/usecases/x/x.ts',
      text: [
        "import type { CriblClient } from '../../ports/cribl-client';",
        'export async function f(cribl: CriblClient, g: string) {',
        "  return cribl.request({ method: 'GET', path: '/system/foo', groupId: g });",
        '}',
      ].join('\n'),
    };
    const { calls } = scanFile(f);
    expect(calls).toEqual([
      { file: f.path, line: 3, method: 'GET', path: '/m/:gid/system/foo', raw: "'/system/foo'", shape: 'object' },
    ]);
    expect(calls.filter((c) => !registered(c))).toHaveLength(1);
  });

  it('does not flag an ARM request builder in a file with no Cribl import', () => {
    const f: SourceFile = {
      path: 'packages/core/src/domain/eventhub-arm/eventhub-arm.ts',
      text: [
        'export function build(azure: { request(o: unknown): unknown }) {',
        "  const req = { method: 'GET', path: '/subscriptions/x' };",
        "  return azure.request({ method: 'GET', path: '/subscriptions/x/providers' }) ?? req;",
        '}',
      ].join('\n'),
    };
    expect(scanFile(f)).toEqual({ calls: [], dynamic: [], mixed: [] });
  });

  it('scans only Cribl files: a kit-style call in a file with no Cribl import is not a Cribl call', () => {
    const f: SourceFile = {
      path: 'packages/core/src/usecases/arm-http-like.ts',
      text: [
        "import type { AzureManagement } from '../ports/azure-management';",
        "export const r = (request: (m: string, p: string) => unknown) => request('GET', '/subscriptions/x');",
      ].join('\n'),
    };
    expect(scanFile(f)).toEqual({ calls: [], dynamic: [], mixed: [] });
  });

  it('extracts only the Cribl call from a MIXED file', () => {
    const f: SourceFile = {
      path: 'packages/core/src/usecases/mixed/mixed.ts',
      text: [
        "import type { AzureManagement } from '../../ports/azure-management';",
        "import type { CriblClient } from '../../ports/cribl-client';",
        'export async function f(azure: AzureManagement, cribl: CriblClient, g: string) {',
        "  await azure.request({ method: 'GET', path: '/subscriptions/s/resourceGroups', apiVersion: '1' });",
        "  const built = { method: 'PUT', path: '/subscriptions/s/thing' };",
        "  return cribl.request({ method: 'POST', path: '/system/inputs', groupId: g, body: built });",
        '}',
      ].join('\n'),
    };
    const r = scanFile(f);
    expect(r.mixed).toEqual([f.path]);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /m/:gid/system/inputs']);
  });

  it('reads kit transport calls as group-relative unless leader-level', () => {
    const f: SourceFile = {
      path: 'packages/core/src/kit/config-writes/commitDeploy.ts',
      text: [
        "const a = await request('GET', '/version/status');",
        "const b = await request('PATCH', `/products/stream/groups/${encodeURIComponent(g)}/deploy`, { body });",
        "const c = await request('GET', '/version?offset=0&limit=1');",
        "const d = await safeCall(request, 'GET', `/system/secrets/${encodeURIComponent(id)}`);",
      ].join('\n'),
    };
    expect(scanFile(f).calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /m/:gid/version/status',
      'PATCH /products/stream/groups/:p/deploy',
      'GET /m/:gid/version',
      'GET /m/:gid/system/secrets/:p',
    ]);
  });

  it('a call with no groupId is a leader call; a receiver without "cribl" is ignored', () => {
    const f: SourceFile = {
      path: 'packages/ui/src/x.tsx',
      text: [
        "import { usePorts } from '../ports-context';",
        "await ports.cribl.request({ method: 'GET', path: '/master/workers' });",
        "await ports.azure.request({ method: 'GET', path: '/subscriptions' });",
      ].join('\n'),
    };
    expect(scanFile(f).calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /master/workers']);
  });

  it('reports a shorthand or identifier path as dynamic instead of dropping it', () => {
    const f: SourceFile = {
      path: 'packages/core/src/usecases/y/y.ts',
      text: [
        "import type { CriblClient } from '../../ports/cribl-client';",
        'export async function f(cribl: CriblClient, groupId: string, path: string) {',
        "  await cribl.request({ method: 'GET', path, groupId });",
        "  return cribl.request({ method: 'POST', path: SOME_PATH, groupId });",
        '}',
      ].join('\n'),
    };
    const r = scanFile(f);
    expect(r.calls).toEqual([]);
    expect(r.dynamic).toEqual([
      { file: f.path, line: 3, raw: 'path' },
      { file: f.path, line: 4, raw: 'SOME_PATH' },
    ]);
  });

  it('reports a kit call with a non-literal method as dynamic, only under kit/', () => {
    const text = [
      "const a = await request(target.method, target.path, { body });",
      "const b = await request('GET', '/version/status');",
      "const c = await ports.cribl.request(built);",
    ].join('\n');
    const kit = scanFile({ path: 'packages/core/src/kit/config-writes/rmw.ts', text });
    expect(kit.dynamic).toEqual([
      { file: 'packages/core/src/kit/config-writes/rmw.ts', line: 1, raw: 'target.method, target.path' },
    ]);
    expect(kit.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /m/:gid/version/status']);
    const outside = scanFile({
      path: 'packages/core/src/usecases/z.ts',
      text: `import type { CriblClient } from '../ports/cribl-client';\n${text}`,
    });
    expect(outside.dynamic).toEqual([]);
  });

  it('normalises template holes to whole segments, and reports the rest as dynamic', () => {
    expect(readPathExpression('`/packs/${encodeURIComponent(id)}`')).toEqual({ kind: 'path', path: '/packs/:p' });
    expect(readPathExpression('`/p/${a}${b}`')).toEqual({ kind: 'dynamic' });
    expect(readPathExpression('ROUTES_API_PATH')).toEqual({ kind: 'indirect' });
    expect(readPathExpression("'/routes'")).toEqual({ kind: 'path', path: '/routes' });
  });
});

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLKIT = join(HERE, '..', '..', '..', '..', '..');
const ROOTS = ['packages/core/src', 'packages/ui/src', 'apps/cribl-app/src'];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
}

function sourceTree(): SourceFile[] {
  const files: string[] = [];
  for (const r of ROOTS) walk(join(TOOLKIT, r), files);
  return files
    .map((full) => ({ path: relative(TOOLKIT, full).split('\\').join('/'), full }))
    .filter((f) => !isTestFile(f.path))
    .map((f) => ({ path: f.path, text: readFileSync(f.full, 'utf8') }));
}

describe('request-scan over the real source tree', () => {
  const tree = sourceTree();
  const scan = scanSources(tree);

  it('reads the tree (guards against a wrong root silently scanning nothing)', () => {
    expect(tree.length).toBeGreaterThan(200);
    expect(scan.calls.length).toBeGreaterThan(20);
  });

  it('every extracted Cribl call is registered in API_CALLS', () => {
    const missing = scan.calls
      .filter((c) => !registered(c))
      .map((c) => `${c.method ?? '?'} ${c.path} (${c.file}:${c.line}, ${c.raw})`);
    expect(missing).toEqual([]);
  });

  it('the reviewed MIXED_FILES list equals the Cribl files that also import the Azure port', () => {
    expect([...scan.mixed].sort()).toEqual([...MIXED_FILES].sort());
  });

  it('the reviewed DYNAMIC_PATHS list equals the call paths the scan cannot normalise', () => {
    const found = [...new Set(scan.dynamic.map((d) => `${d.file} ${d.raw}`))].sort();
    expect(found).toEqual(DYNAMIC_PATHS.map((d) => `${d.file} ${d.raw}`).sort());
  });
});
