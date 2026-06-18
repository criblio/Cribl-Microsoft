// Scaffold golden test -- the regression guard for the pack-builder field-mapping refactor.
//
// scaffoldPack turns sample events + a destination schema into Cribl pipeline YAML and a
// FIELD_MAPPING report. The upcoming refactor routes four duplicated match blocks through a
// single resolveFieldMappings function; this test locks the *deterministic* generated output
// (the pipelines and field-mapping reports) so any drift fails loudly.
//
// Hermetic by construction:
//   - APPDATA points at a temp dir, so packs are written there (getAppDataRoot reads it live).
//   - The DCR schema is injected (no on-disk templates needed).
//   - Vendor research is stubbed to null (no network).
//   - Provided samples make field-matching deterministic.
// Synthetic sample data (data/samples/*, default/samples.yml) carries random IDs/values by
// design and is unrelated to field mapping, so it is excluded from the snapshot.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  registerPackBuilderHandlers,
  __setSchemaResolverForTests,
  __setVendorResearchForTests,
} from '../src/main/ipc/pack-builder';

const TMP_ROOT = path.join(os.tmpdir(), 'cribl-msft-scaffold-golden');

// A small, fixed CommonSecurityLog-like destination schema (post system-column filtering).
const FIXTURE_SCHEMA: Record<string, Array<{ name: string; type: string }>> = {
  CommonSecurityLog: [
    { name: 'SourceIP', type: 'string' },
    { name: 'SourcePort', type: 'int' },
    { name: 'DestinationIP', type: 'string' },
    { name: 'DeviceAction', type: 'string' },
    { name: 'Message', type: 'string' },
    { name: 'TimeGenerated', type: 'datetime' },
    { name: 'AdditionalExtensions', type: 'string' },
  ],
};

// Capture the pack:scaffold handler the way the web router does, so we can invoke scaffoldPack
// without exporting it.
function captureScaffoldHandler(): (event: unknown, options: unknown) => Promise<any> {
  const handlers = new Map<string, (event: unknown, args: unknown) => Promise<any>>();
  const fakeIpcMain = {
    handle: (channel: string, fn: (event: unknown, args: unknown) => Promise<any>) => handlers.set(channel, fn),
    on() {}, once() {}, removeHandler() {}, removeAllListeners() {},
  };
  registerPackBuilderHandlers(fakeIpcMain as any);
  const handler = handlers.get('pack:scaffold');
  if (!handler) throw new Error('pack:scaffold handler was not registered');
  return handler;
}

// Read the deterministic, field-mapping-relevant outputs: the transform pipelines and the
// FIELD_MAPPING reports. Returns a sorted path -> content map for snapshotting.
function readDeterministicOutputs(packDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Recursively collect every .yml under default/pipelines: route.yml plus the transform and
  // reduction pipelines, which live in <pipelineName>/conf.yml subdirectories.
  const pipelinesDir = path.join(packDir, 'default', 'pipelines');
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.yml')) {
        out[path.relative(packDir, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf-8');
      }
    }
  };
  if (fs.existsSync(pipelinesDir)) walk(pipelinesDir);
  for (const f of fs.readdirSync(packDir).filter((n) => n.startsWith('FIELD_MAPPING_')).sort()) {
    out[f] = fs.readFileSync(path.join(packDir, f), 'utf-8');
  }
  return out;
}

describe('scaffoldPack golden output (field-mapping -> pipelines)', () => {
  beforeAll(() => {
    process.env.APPDATA = TMP_ROOT;
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    __setSchemaResolverForTests((tableName) => FIXTURE_SCHEMA[tableName] || []);
    __setVendorResearchForTests(async () => null);
  });

  afterAll(() => {
    __setSchemaResolverForTests(null);
    __setVendorResearchForTests(null);
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('produces stable pipelines and field-mapping reports for a CEF-like sample', async () => {
    const scaffold = captureScaffoldHandler();
    const options = {
      solutionName: 'GoldenTestVendor',
      packName: 'golden-test-pack',
      version: '1.0.0',
      autoPackage: false,
      vendorSamples: [
        {
          tableName: 'CommonSecurityLog',
          format: 'json',
          source: 'golden-fixture',
          rawEvents: [
            JSON.stringify({ src: '10.0.0.1', spt: 443, dst: '8.8.8.8', act: 'blocked', msg: 'connection denied', extraVendorField: 'keep-me' }),
          ],
        },
      ],
      tables: [
        { sentinelTable: 'CommonSecurityLog', criblStream: 'golden_cef', fields: [], logType: 'cef' },
      ],
    };

    const result = await scaffold({}, options);
    expect(result?.packDir, 'scaffold should return a packDir').toBeTruthy();

    const outputs = readDeterministicOutputs(result.packDir);
    // Sanity: we actually generated a pipeline and a field-mapping report.
    expect(Object.keys(outputs).some((k) => k.startsWith('default/pipelines/'))).toBe(true);
    expect(Object.keys(outputs).some((k) => k.startsWith('FIELD_MAPPING_'))).toBe(true);

    expect(outputs).toMatchSnapshot();
  });
});
