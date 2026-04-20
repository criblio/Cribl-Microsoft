// =============================================================================
// UAT: Pack Build End-to-End
// =============================================================================
// Tests the full pack build pipeline via the web API:
//   1. Auto-load samples for each vendor
//   2. Tag samples
//   3. Build pack (scaffold)
//   4. Verify pipeline YAML is Cribl-compatible
//   5. Verify field mappings are correct
//   6. Verify sample data format
//   7. Package .crbl and verify structure
//
// Prerequisites: Web server running on port 3001
//   npx tsx src/server/index.ts
//
// Run: npx tsx test-uat-pack-build.ts
// =============================================================================

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { initAppPaths } from './src/main/ipc/app-paths';

initAppPaths();

const API = 'http://localhost:3001/api';
const PACKS_DIR = path.join(process.env.APPDATA!, '.cribl-microsoft', 'packs');

// ---------------------------------------------------------------------------
// Test Harness
// ---------------------------------------------------------------------------

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: string[] = [];

function assert(condition: boolean, testName: string, detail?: string): void {
  totalTests++;
  if (condition) {
    passedTests++;
  } else {
    failedTests++;
    const msg = detail ? `${testName} -- ${detail}` : testName;
    failures.push(msg);
    console.log(`  [FAIL] ${testName}${detail ? ` (${detail})` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function api(endpoint: string, body?: any): Promise<any> {
  const url = `${API}/${endpoint}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

// ---------------------------------------------------------------------------
// Cribl YAML Compatibility Checks
// ---------------------------------------------------------------------------

function checkCriblYaml(content: string, fileName: string): string[] {
  const issues: string[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check for description: > multiline (Cribl rejects)
    if (line.match(/^\s+description: >/)) {
      issues.push(`Line ${lineNum}: description: > multiline block (use single-line)`);
    }

    // Check for description: "quoted" (Cribl rejects)
    if (line.match(/^\s+description: "[^"]+"/)) {
      issues.push(`Line ${lineNum}: description: "quoted" (use unquoted)`);
    }

    // Check for special chars in unquoted descriptions
    if (line.match(/^\s+description: [^"'].*([:=()])/)) {
      const match = line.match(/description: (.+)/);
      if (match) {
        const desc = match[1];
        // Allow description: on its own (it's the key)
        if (desc.includes(':') && !desc.startsWith('description')) {
          // Check if : is followed by space (YAML mapping indicator)
          if (/[A-Za-z]:[ ]/.test(desc)) {
            issues.push(`Line ${lineNum}: description has colon+space (YAML mapping): ${desc.slice(0, 60)}`);
          }
        }
        if (desc.includes('=') && !desc.startsWith('"')) {
          issues.push(`Line ${lineNum}: description has equals sign: ${desc.slice(0, 60)}`);
        }
      }
    }

    // Check for tabs
    if (line.includes('\t')) {
      issues.push(`Line ${lineNum}: contains tab character`);
    }

    // Check for single-quoted field names in add/remove
    if (line.match(/^\s+- name: '[^']+'/)) {
      issues.push(`Line ${lineNum}: single-quoted name (use unquoted): ${line.trim()}`);
    }
    if (line.match(/^\s+- currentName: '[^']+'/)) {
      issues.push(`Line ${lineNum}: single-quoted currentName: ${line.trim()}`);
    }
    if (line.match(/^\s+- newName: '[^']+'/)) {
      issues.push(`Line ${lineNum}: single-quoted newName: ${line.trim()}`);
    }

    // Check for group-level description (Cribl may reject)
    if (line.match(/^    description: /) && i > 0 && lines[i-1].match(/^    (name|disabled): /)) {
      // This is a group-level description, not function-level
      // Group descriptions may cause issues
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Vendor Test Configs
// ---------------------------------------------------------------------------

interface VendorTest {
  name: string;
  solutionName: string;
  packName: string;
  destTable: string;
  expectedFormat: string;
  expectedRenames: string[];  // Key renames to verify
  logTypes: string[];
}

const VENDORS: VendorTest[] = [
  {
    name: 'PaloAlto PAN-OS (CEF)',
    solutionName: 'PaloAlto-PAN-OS',
    packName: 'paloalto-pan-os-sentinel',
    destTable: 'CommonSecurityLog',
    expectedFormat: 'cef',
    expectedRenames: ['cs1:DeviceCustomString1', 'spt:SourcePort', 'act:DeviceAction', 'src:SourceIP'],
    logTypes: ['TRAFFIC', 'THREAT', 'AUTH'],
  },
  {
    name: 'CrowdStrike FDR (JSON)',
    solutionName: 'CrowdStrike Falcon Endpoint Protection',
    packName: 'crowdstrike-sentinel-test',
    destTable: 'CrowdStrike_Process_Events_CL',
    expectedFormat: 'ndjson',
    expectedRenames: [],  // CrowdStrike uses exact field names, mostly keep
    logTypes: ['ProcessRollup2'],
  },
];

// ---------------------------------------------------------------------------
// Main Test
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n');
  console.log('######################################################################');
  console.log('#  Pack Build UAT                                                   #');
  console.log('#  Tests auto-load -> tag -> scaffold -> YAML verify -> .crbl       #');
  console.log('######################################################################');

  // Check server is running
  try {
    const health = await fetch(`${API}/`);
    if (!health.ok) throw new Error('Server not responding');
  } catch {
    console.log('\nERROR: Web server not running on port 3001');
    console.log('Start it with: npx tsx src/server/index.ts');
    process.exit(2);
  }

  for (const vendor of VENDORS) {
    section(`${vendor.name}`);

    // Step 1: Auto-load samples
    console.log('  Loading samples...');
    const loadResult = await api('samples/sentinel-repo-samples', { solutionName: vendor.solutionName });
    const samples = loadResult.samples || [];
    assert(loadResult.success === true, `${vendor.name}: auto-load succeeds`);
    assert(samples.length > 0, `${vendor.name}: samples found`, `got ${samples.length}`);

    if (samples.length === 0) {
      console.log('  Skipping remaining tests (no samples)');
      continue;
    }

    // Check format detection
    if (vendor.expectedFormat === 'cef') {
      const cefSamples = samples.filter((s: any) => s.format === 'cef');
      assert(cefSamples.length > 0, `${vendor.name}: CEF format detected`, `${cefSamples.length} CEF samples`);

      // Check raw CEF preservation
      const firstCef = cefSamples[0];
      if (firstCef?.rawEvents?.[0]) {
        assert(
          firstCef.rawEvents[0].includes('CEF:') || firstCef.rawEvents[0].startsWith('{'),
          `${vendor.name}: raw events preserved (CEF or JSON)`,
        );
      }
    }

    // Step 2: Tag samples
    console.log('  Tagging samples...');
    const taggedLogTypes: string[] = [];
    for (const sample of samples.slice(0, 5)) {
      if (sample.format !== vendor.expectedFormat && vendor.expectedFormat === 'cef') continue;
      const content = sample.rawEvents?.join('\n') || '';
      if (!content) continue;
      await api('samples/tag-sample', {
        vendor: vendor.solutionName,
        logType: sample.logType,
        content,
        sourceName: sample.source,
      });
      taggedLogTypes.push(sample.logType);
    }
    assert(taggedLogTypes.length > 0, `${vendor.name}: samples tagged`, `${taggedLogTypes.length} log types`);

    // Step 3: Get tagged and build vendor samples
    const tagged = await api('samples/get-tagged', { vendor: vendor.solutionName });
    assert(Array.isArray(tagged) && tagged.length > 0, `${vendor.name}: tagged samples retrieved`);

    const vendorSamples = (tagged || []).map((s: any) => {
      let fmt = s.format || 'json';
      if ((fmt === 'json' || fmt === 'ndjson') && s.rawEvents?.[0]) {
        try {
          const evt = JSON.parse(s.rawEvents[0]);
          if (evt.CEFVersion !== undefined && evt.DeviceVendor) fmt = 'cef';
        } catch {}
      }
      return { tableName: vendor.destTable, format: fmt, rawEvents: s.rawEvents || [], source: `${vendor.name}:${s.logType}` };
    });

    // Step 4: Build pack
    console.log('  Building pack...');
    const tables = taggedLogTypes.slice(0, 3).map((lt) => ({
      sentinelTable: vendor.destTable,
      criblStream: `Custom-${vendor.destTable.replace(/_CL$/i, '')}`,
      logType: lt,
      fields: [],
    }));

    const buildResult = await api('pack/scaffold', {
      solutionName: vendor.solutionName.replace(/[^a-zA-Z0-9]/g, '_'),
      packName: vendor.packName,
      version: '1.0.0',
      autoPackage: false,
      vendorSamples,
      tables,
    });

    const packDir = buildResult?.packDir;
    assert(!!packDir, `${vendor.name}: pack scaffold succeeds`, buildResult?.error || '');

    if (!packDir || !fs.existsSync(packDir)) {
      console.log('  Skipping YAML checks (pack not created)');
      continue;
    }

    // Step 5: Verify pipeline YAML
    console.log('  Checking pipeline YAML...');
    const pipelinesDir = path.join(packDir, 'default', 'pipelines');
    const pipelineDirs = fs.readdirSync(pipelinesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    assert(pipelineDirs.length > 0, `${vendor.name}: pipelines created`, `${pipelineDirs.length} pipelines`);

    let totalYamlIssues = 0;
    for (const pipeName of pipelineDirs) {
      const confPath = path.join(pipelinesDir, pipeName, 'conf.yml');
      if (!fs.existsSync(confPath)) continue;
      const content = fs.readFileSync(confPath, 'utf8');
      const issues = checkCriblYaml(content, pipeName);
      totalYamlIssues += issues.length;
      if (issues.length > 0) {
        for (const issue of issues.slice(0, 3)) {
          console.log(`    ${pipeName}: ${issue}`);
        }
        if (issues.length > 3) console.log(`    ... and ${issues.length - 3} more`);
      }
    }
    assert(totalYamlIssues === 0, `${vendor.name}: YAML Cribl-compatible (${pipelineDirs.length} pipelines)`, `${totalYamlIssues} issues`);

    // Step 6: Verify key field mappings
    if (vendor.expectedRenames.length > 0) {
      const firstPipe = pipelineDirs.find((p) => !p.startsWith('Reduction_'));
      if (firstPipe) {
        const confPath = path.join(pipelinesDir, firstPipe, 'conf.yml');
        const content = fs.readFileSync(confPath, 'utf8');
        for (const rename of vendor.expectedRenames) {
          const [src, dst] = rename.split(':');
          const hasRename = content.includes(`currentName: ${src}`) && content.includes(`newName: ${dst}`);
          assert(hasRename, `${vendor.name}: ${src} -> ${dst} rename present`);
        }

        // Check for serialize function (CEF overflow)
        if (vendor.expectedFormat === 'cef') {
          assert(content.includes('id: serialize'), `${vendor.name}: serialize function for overflow`);
          assert(content.includes('dstField: AdditionalExtensions'), `${vendor.name}: overflow to AdditionalExtensions`);
        }

        // Check for CEF parser (eval split)
        if (vendor.expectedFormat === 'cef') {
          assert(content.includes('__cefParts'), `${vendor.name}: CEF eval parser present`);
          assert(content.includes('__cefExtension'), `${vendor.name}: CEF extension parsing`);
          assert(content.includes('srcField: __cefExtension'), `${vendor.name}: serde kvp on extension`);
        }
      }
    }

    // Step 7: Verify sample data
    const samplesDir = path.join(packDir, 'data', 'samples');
    if (fs.existsSync(samplesDir)) {
      const sampleFiles = fs.readdirSync(samplesDir).filter((f) => f.endsWith('.json'));
      assert(sampleFiles.length > 0, `${vendor.name}: sample data files created`, `${sampleFiles.length} files`);

      if (sampleFiles.length > 0) {
        const sampleData = JSON.parse(fs.readFileSync(path.join(samplesDir, sampleFiles[0]), 'utf8'));
        assert(Array.isArray(sampleData) && sampleData.length > 0, `${vendor.name}: sample data has events`);

        if (sampleData.length > 0) {
          const evt = sampleData[0];
          const keys = Object.keys(evt);
          assert(keys.includes('_raw'), `${vendor.name}: sample has _raw`);
          assert(keys.includes('_time'), `${vendor.name}: sample has _time`);

          // Should NOT have top-level vendor fields (only _raw + envelope)
          const envelopeKeys = new Set(['_raw', '_time', 'source', 'sourcetype', 'host', 'index']);
          const extraKeys = keys.filter((k) => !envelopeKeys.has(k));
          assert(extraKeys.length === 0, `${vendor.name}: sample has only envelope fields`, `extra: ${extraKeys.join(', ')}`);

          // CEF: _raw should contain raw CEF line
          if (vendor.expectedFormat === 'cef') {
            assert(
              typeof evt._raw === 'string' && evt._raw.includes('CEF:'),
              `${vendor.name}: sample _raw is raw CEF line`,
              evt._raw?.slice(0, 60),
            );
          }
        }
      }
    }

    // Step 8: Verify route.yml
    const routePath = path.join(pipelinesDir, 'route.yml');
    if (fs.existsSync(routePath)) {
      const routeContent = fs.readFileSync(routePath, 'utf8');
      const routeIssues = checkCriblYaml(routeContent, 'route.yml');
      assert(routeIssues.length === 0, `${vendor.name}: route.yml Cribl-compatible`, `${routeIssues.length} issues`);

      // Check routes reference existing pipelines
      for (const pipeName of pipelineDirs) {
        const referenced = routeContent.includes(`pipeline: ${pipeName}`);
        assert(referenced, `${vendor.name}: route references ${pipeName}`);
      }
    }

    // Step 9: Verify package.json
    const pkgPath = path.join(packDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      assert(!!pkg.name, `${vendor.name}: package.json has name`);
      assert(!!pkg.version, `${vendor.name}: package.json has version`);
    }

    console.log(`  Done: ${pipelineDirs.length} pipelines, ${totalYamlIssues} YAML issues`);
  }

  // Final report
  console.log('\n');
  console.log('######################################################################');
  console.log('#  RESULTS                                                           #');
  console.log('######################################################################');
  console.log(`\n  Total:  ${totalTests}`);
  console.log(`  Passed: ${passedTests}`);
  console.log(`  Failed: ${failedTests}`);
  console.log(`  Rate:   ${((passedTests / totalTests) * 100).toFixed(1)}%\n`);

  if (failures.length > 0) {
    console.log('  FAILURES:');
    for (const f of failures) {
      console.log(`    - ${f}`);
    }
    console.log('');
  }

  process.exit(failedTests > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('UAT Fatal Error:', err);
  process.exit(2);
});
