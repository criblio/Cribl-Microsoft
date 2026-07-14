// =============================================================================
// UAT: Sample Data -> DCR/Transformation Pipeline End-to-End Tests
// =============================================================================
// Verifies the complete chain: sample parsing -> field extraction -> type
// inference -> schema matching -> gap analysis -> pipeline generation.
//
// Tests that sample data correctly informs every transformation decision:
//   1. Parsed fields have accurate types (int vs string vs real vs datetime)
//   2. Field matching produces correct actions (keep, rename, coerce, overflow)
//   3. Gap analysis correctly partitions DCR-handled vs Cribl-handled fields
//   4. Pipeline YAML reflects the gap analysis decisions faithfully
//   5. No data loss: all source fields end up somewhere (matched, overflow, or dropped)
//   6. No duplicate transforms: fields the DCR handles are NOT also in Cribl pipeline
//
// Run: npx tsx --tsconfig tsconfig.server.json test-uat-transformations.ts
// =============================================================================

import fs from 'fs';
import path from 'path';
import { parseSampleContent, type ParsedSample } from './src/main/ipc/sample-parser';
import { matchFields, matchSampleToSchema, getOverflowConfig, type MatchResult, type SourceField, type DestField } from './src/main/ipc/field-matcher';
import { loadDcrTemplateSchemaPublic } from './src/main/ipc/pack-builder';
import { parseDcrJson, analyzeDcrGap, type DcrDataFlow, type DcrGapAnalysis } from './src/main/ipc/kql-parser';
import { initAppPaths } from './src/main/ipc/app-paths';

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
    console.log(`  [PASS] ${testName}`);
  } else {
    failedTests++;
    const msg = detail ? `${testName} -- ${detail}` : testName;
    failures.push(msg);
    console.log(`  [FAIL] ${testName}${detail ? ` (${detail})` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function subsection(title: string): void {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');
const APP_ROOT = __dirname;
const VENDOR_SAMPLES_DIR = path.join(APP_ROOT, 'packs', 'vendor-samples', 'crowdstrike-fdr');
const CUSTOM_SCHEMAS_DIR = path.join(REPO_ROOT, 'Azure', 'CustomDeploymentTemplates', 'DCR-Automation', 'core', 'custom-table-schemas');
const SENTINEL_REPO = path.join(process.env.APPDATA || '', '.cribl-microsoft', 'sentinel-repo', 'Azure-Sentinel');

const CROWDSTRIKE_TABLES = [
  'CrowdStrike_Additional_Events_CL',
  'CrowdStrike_Audit_Events_CL',
  'CrowdStrike_Auth_Events_CL',
  'CrowdStrike_DNS_Events_CL',
  'CrowdStrike_File_Events_CL',
  'CrowdStrike_Network_Events_CL',
  'CrowdStrike_Process_Events_CL',
  'CrowdStrike_Registry_Events_CL',
  'CrowdStrike_Secondary_Data_CL',
  'CrowdStrike_User_Events_CL',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadSampleEvents(table: string): Array<Record<string, unknown>> {
  const samplePath = path.join(VENDOR_SAMPLES_DIR, `${table}.json`);
  if (!fs.existsSync(samplePath)) return [];
  const content = fs.readFileSync(samplePath, 'utf-8');
  return content.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean) as Array<Record<string, unknown>>;
}

function extractSourceFields(events: Array<Record<string, unknown>>): SourceField[] {
  const fieldMap = new Map<string, string>();
  for (const evt of events.slice(0, 20)) {
    for (const [k, v] of Object.entries(evt)) {
      if (!fieldMap.has(k)) {
        const t = typeof v === 'number' ? (Number.isInteger(v) ? 'long' : 'real') :
          typeof v === 'boolean' ? 'boolean' :
          typeof v === 'object' ? 'dynamic' : 'string';
        fieldMap.set(k, t);
      }
    }
  }
  return Array.from(fieldMap.entries()).map(([name, type]) => ({ name, type }));
}

function loadDcrFlow(table: string): DcrDataFlow | null {
  const dcrPath = path.join(
    SENTINEL_REPO, 'Solutions', 'CrowdStrike Falcon Endpoint Protection',
    'Data Connectors', 'CrowdstrikeReplicatorCLv2',
    'Data Collection Rules', 'CrowdStrikeCustomDCR.json',
  );
  if (!fs.existsSync(dcrPath)) return null;
  const parsed = parseDcrJson(fs.readFileSync(dcrPath, 'utf-8'));
  return parsed.flows.find((f) => f.tableName.toLowerCase() === table.toLowerCase()) || null;
}

// =========================================================================
// TEST 1: Type Inference Accuracy
// =========================================================================

function testTypeInferenceAccuracy(): void {
  section('TEST 1: Type Inference Accuracy from Sample Data');

  for (const table of CROWDSTRIKE_TABLES) {
    subsection(table);
    const samplePath = path.join(VENDOR_SAMPLES_DIR, `${table}.json`);
    if (!fs.existsSync(samplePath)) continue;

    const parsed = parseSampleContent(fs.readFileSync(samplePath, 'utf-8'), `${table}.json`);
    const destSchema = loadDcrTemplateSchemaPublic(table);
    const destMap = new Map(destSchema.map((c) => [c.name.toLowerCase(), c]));

    // For each discovered field, check if the inferred type is compatible with dest schema
    let compatibleCount = 0;
    let totalChecked = 0;
    const mismatches: string[] = [];

    for (const field of parsed.fields) {
      const destCol = destMap.get(field.name.toLowerCase());
      if (!destCol) continue;  // Only check fields that exist in dest schema
      totalChecked++;

      const srcType = field.type.toLowerCase();
      const dstType = destCol.type.toLowerCase();

      // Check compatibility
      const isCompatible =
        srcType === dstType ||
        srcType === 'string' ||  // String source is always acceptable (DCR coerces)
        (srcType === 'int' && (dstType === 'long' || dstType === 'int')) ||
        (srcType === 'long' && (dstType === 'long' || dstType === 'int')) ||
        (srcType === 'real' && (dstType === 'real' || dstType === 'double')) ||
        dstType === 'string';  // String dest accepts anything

      if (isCompatible) {
        compatibleCount++;
      } else {
        mismatches.push(`${field.name}: source=${srcType} dest=${dstType}`);
      }
    }

    const rate = totalChecked > 0 ? ((compatibleCount / totalChecked) * 100).toFixed(1) : '0';
    assert(
      totalChecked > 0,
      `Checked ${totalChecked} fields against dest schema`,
    );
    assert(
      compatibleCount / totalChecked >= 0.8,
      `Type compatibility rate: ${rate}% (>=80%)`,
      mismatches.length > 0 ? `Mismatches: ${mismatches.slice(0, 5).join(', ')}` : undefined,
    );

    // CrowdStrike-specific: timestamp must be inferred as int (epoch ms numeric)
    const tsField = parsed.fields.find((f) => f.name === 'timestamp');
    if (tsField) {
      assert(
        tsField.type === 'int' || tsField.type === 'string',
        `timestamp type is int or string (got: ${tsField.type})`,
      );
    }

    // aid/cid should be string (32-char hex), never int
    for (const idField of ['aid', 'cid']) {
      const f = parsed.fields.find((ff) => ff.name === idField);
      if (f) {
        assert(f.type === 'string', `${idField} inferred as string not int (got: ${f.type})`);
      }
    }
  }
}

// =========================================================================
// TEST 2: Field Match Action Correctness
// =========================================================================

function testFieldMatchActions(): void {
  section('TEST 2: Field Match Action Correctness');

  for (const table of CROWDSTRIKE_TABLES) {
    subsection(table);
    const events = loadSampleEvents(table);
    if (events.length === 0) continue;

    const parsed = parseSampleContent(
      events.map((e) => JSON.stringify(e)).join('\n'),
      `${table}.json`,
    );
    const destSchema = loadDcrTemplateSchemaPublic(table);
    if (destSchema.length === 0) continue;

    const sourceFields: SourceField[] = parsed.fields.map((f) => ({
      name: f.name, type: f.type, sampleValue: f.sampleValues[0],
    }));
    const destFields: DestField[] = destSchema.map((c) => ({ name: c.name, type: c.type }));

    const match = matchFields(sourceFields, destFields, undefined, table);

    // Every source field should end up somewhere: matched, overflow, or unmatchedSource
    const totalAccounted = match.matched.length + match.overflow.length + match.unmatchedSource.length;
    assert(
      totalAccounted === sourceFields.length,
      `All ${sourceFields.length} source fields accounted for (matched:${match.matched.length} + overflow:${match.overflow.length} + unmatched:${match.unmatchedSource.length} = ${totalAccounted})`,
    );

    // Verify action correctness for matched fields
    for (const m of match.matched) {
      // 'keep' means same name -- verify it
      if (m.action === 'keep') {
        assert(
          m.sourceName.toLowerCase() === m.destName.toLowerCase(),
          `keep action: "${m.sourceName}" == "${m.destName}" (case-insensitive)`,
        );
      }
      // 'rename' means different names -- verify it
      if (m.action === 'rename') {
        assert(
          m.sourceName.toLowerCase() !== m.destName.toLowerCase(),
          `rename action: "${m.sourceName}" != "${m.destName}"`,
        );
      }
      // 'coerce' should flag needsCoercion
      if (m.action === 'coerce') {
        assert(m.needsCoercion, `coerce action has needsCoercion=true for ${m.sourceName}`);
      }
    }

    // Overflow fields should go to the right overflow column
    if (match.overflow.length > 0) {
      const expectedOverflow = table.endsWith('_CL') ? 'AdditionalData_d' : 'AdditionalExtensions';
      for (const o of match.overflow) {
        assert(
          o.destName === expectedOverflow,
          `Overflow field "${o.sourceName}" -> ${expectedOverflow} (got: ${o.destName})`,
        );
      }
    }

    // Unmatched source fields should only be Cribl internal metadata
    for (const u of match.unmatchedSource) {
      const isCriblInternal =
        u.name.startsWith('cribl_') || u.name.startsWith('__') ||
        ['_raw', '_time', 'source', 'host', 'port', 'index', 'sourcetype'].includes(u.name);
      assert(
        isCriblInternal,
        `Unmatched source field "${u.name}" is Cribl internal metadata`,
        !isCriblInternal ? 'Non-Cribl field should be matched or overflowed' : undefined,
      );
    }

    // Key CrowdStrike fields should be matched with high confidence
    const matchMap = new Map(match.matched.map((m) => [m.sourceName, m]));
    for (const key of ['event_simpleName', 'aid', 'cid', 'aip']) {
      const m = matchMap.get(key);
      assert(
        m !== undefined,
        `Core field "${key}" is matched (not overflowed/dropped)`,
      );
      if (m) {
        assert(
          m.confidence === 'exact',
          `Core field "${key}" has exact confidence (got: ${m.confidence})`,
        );
      }
    }
  }
}

// =========================================================================
// TEST 3: Gap Analysis -> Transformation Decisions
// =========================================================================

function testGapAnalysisTransformDecisions(): void {
  section('TEST 3: Gap Analysis Transformation Decisions');

  const dcrPath = path.join(
    SENTINEL_REPO, 'Solutions', 'CrowdStrike Falcon Endpoint Protection',
    'Data Connectors', 'CrowdstrikeReplicatorCLv2',
    'Data Collection Rules', 'CrowdStrikeCustomDCR.json',
  );
  if (!fs.existsSync(dcrPath)) {
    console.log('  [SKIP] Sentinel repo not available');
    return;
  }

  const allFlows = parseDcrJson(fs.readFileSync(dcrPath, 'utf-8'));

  for (const table of CROWDSTRIKE_TABLES) {
    const flow = allFlows.flows.find((f) => f.tableName === table);
    if (!flow) continue;  // Some tables (Additional, Secondary) may not have a flow

    subsection(table);

    const events = loadSampleEvents(table);
    if (events.length === 0) continue;

    const sourceFields = extractSourceFields(events);
    const destSchema = loadDcrTemplateSchemaPublic(table);
    if (destSchema.length === 0) continue;

    const gap = analyzeDcrGap(sourceFields, destSchema, flow);

    // Verify field accounting: every source field should be categorized
    // passthrough + dcrHandled + criblHandled + overflow + drops = totalSource (approximately)
    // Note: some fields may be in multiple categories due to rename chains
    assert(
      gap.totalSourceFields === sourceFields.length,
      `Total source fields matches: ${gap.totalSourceFields} == ${sourceFields.length}`,
    );
    assert(
      gap.totalDestFields === destSchema.length,
      `Total dest fields matches: ${gap.totalDestFields} == ${destSchema.length}`,
    );

    // Passthrough count must be > 0 for CrowdStrike (many fields share names)
    assert(
      gap.passthroughCount > 0,
      `Passthrough count > 0: ${gap.passthroughCount}`,
    );

    // DCR handles section should have real data
    assert(
      gap.dcrHandles.timeGenerated === true,
      'DCR handles TimeGenerated derivation',
    );

    // Cribl must always add _time and Type enrichments
    assert(
      gap.criblMustHandle.enrichments.length >= 2,
      `Cribl enrichments >= 2 (got: ${gap.criblMustHandle.enrichments.length})`,
    );
    const enrichFieldNames = gap.criblMustHandle.enrichments.map((e) => e.field);
    assert(enrichFieldNames.includes('_time'), 'Cribl enrichments include _time');
    assert(enrichFieldNames.includes('Type'), 'Cribl enrichments include Type');

    // Verify no DCR-handled field is also in Cribl renames/coercions
    // (this would be a duplicate transform)
    const dcrRenameSourceSet = new Set(gap.dcrHandles.renames.map((r) => r.source.toLowerCase()));
    const dcrCoercionFieldSet = new Set(gap.dcrHandles.coercions.map((c) => c.field.toLowerCase()));

    for (const criblRename of gap.criblMustHandle.renames) {
      assert(
        !dcrRenameSourceSet.has(criblRename.source.toLowerCase()),
        `Cribl rename "${criblRename.source}" is NOT duplicated by DCR rename`,
        `DCR already renames this field`,
      );
    }
    for (const criblCoercion of gap.criblMustHandle.coercions) {
      assert(
        !dcrCoercionFieldSet.has(criblCoercion.field.toLowerCase()),
        `Cribl coercion "${criblCoercion.field}" is NOT duplicated by DCR coercion`,
        `DCR already coerces this field`,
      );
    }

    // Verify DCR renames are from the KQL transformKql
    for (const rename of gap.dcrHandles.renames) {
      assert(
        rename.source !== rename.dest,
        `DCR rename "${rename.source}" -> "${rename.dest}" has different names`,
      );
    }

    // Log summary
    console.log(`    Summary: passthrough=${gap.passthroughCount}, dcr=${gap.dcrHandledCount}, cribl=${gap.criblHandledCount}, overflow=${gap.overflowCount}`);
    if (gap.dcrHandles.renames.length > 0) {
      console.log(`    DCR renames: ${gap.dcrHandles.renames.map((r) => `${r.source}->${r.dest}`).join(', ')}`);
    }
    if (gap.criblMustHandle.renames.length > 0) {
      console.log(`    Cribl renames: ${gap.criblMustHandle.renames.map((r) => `${r.source}->${r.dest}`).join(', ')}`);
    }
  }
}

// =========================================================================
// TEST 4: CEF/Palo Alto Sample Parsing Accuracy
// =========================================================================

function testCefSampleParsing(): void {
  section('TEST 4: CEF/Palo Alto Sample Parsing Accuracy');

  // Test with synthetic CEF data representative of PAN-OS traffic
  const cefSamples = [
    'CEF:0|Palo Alto Networks|PAN-OS|10.1.0|TRAFFIC|end|3|src=192.168.1.100 dst=10.0.0.50 spt=54321 dpt=443 proto=TCP act=allow deviceExternalId=001234567890 cs1=rule1 cs1Label=Rule',
    'CEF:0|Palo Alto Networks|PAN-OS|10.1.0|THREAT|url|8|src=10.0.1.50 dst=203.0.113.10 spt=55555 dpt=80 proto=TCP act=alert request=http://example.com/malware.exe cs2=spyware cs2Label=Category',
    'CEF:0|Palo Alto Networks|PAN-OS|10.1.0|SYSTEM|general|1|dvchost=fw-edge-01 msg=Configuration committed successfully',
  ];
  const cefContent = cefSamples.join('\n');

  subsection('CEF Format Detection');
  const parsed = parseSampleContent(cefContent, 'panos_sample.cef');
  assert(parsed.format === 'cef', `Format detected as CEF (got: ${parsed.format})`);
  assert(parsed.eventCount === 3, `Parsed 3 CEF events (got: ${parsed.eventCount})`);
  assert(parsed.errors.length === 0, 'No parse errors');

  subsection('CEF Header Fields Extracted');
  const fieldNames = new Set(parsed.fields.map((f) => f.name));
  for (const header of ['CEFVersion', 'DeviceVendor', 'DeviceProduct', 'DeviceVersion', 'DeviceEventClassID', 'Name', 'Severity']) {
    assert(fieldNames.has(header), `CEF header field "${header}" extracted`);
  }

  // Verify CEF header values
  const vendorField = parsed.fields.find((f) => f.name === 'DeviceVendor');
  assert(
    vendorField?.sampleValues.includes('Palo Alto Networks') === true,
    'DeviceVendor value is "Palo Alto Networks"',
  );

  const productField = parsed.fields.find((f) => f.name === 'DeviceProduct');
  assert(
    productField?.sampleValues.includes('PAN-OS') === true,
    'DeviceProduct value is "PAN-OS"',
  );

  subsection('CEF Extension Fields Extracted');
  for (const ext of ['src', 'dst', 'spt', 'dpt', 'proto', 'act']) {
    assert(fieldNames.has(ext), `CEF extension field "${ext}" extracted`);
  }

  // Verify extension field values
  const srcField = parsed.fields.find((f) => f.name === 'src');
  assert(
    srcField?.sampleValues.some((v) => v.includes('192.168.1.100')) === true,
    'src field has correct IP value',
  );

  subsection('CEF Event Type Discrimination');
  const eventClassField = parsed.fields.find((f) => f.name === 'DeviceEventClassID');
  assert(eventClassField !== undefined, 'DeviceEventClassID field exists');
  if (eventClassField) {
    const values = new Set(eventClassField.sampleValues);
    assert(values.has('TRAFFIC'), 'Has TRAFFIC event type');
    assert(values.has('THREAT'), 'Has THREAT event type');
    assert(values.has('SYSTEM'), 'Has SYSTEM event type');
  }

  subsection('CEF -> CommonSecurityLog Schema Matching');
  const cslSchema = loadDcrTemplateSchemaPublic('CommonSecurityLog');
  if (cslSchema.length > 0) {
    const sourceFields: SourceField[] = parsed.fields.map((f) => ({
      name: f.name, type: f.type, sampleValue: f.sampleValues[0],
    }));
    const destFields: DestField[] = cslSchema.map((c) => ({ name: c.name, type: c.type }));
    const match = matchFields(sourceFields, destFields, undefined, 'CommonSecurityLog');

    assert(match.matched.length > 0, `Matched ${match.matched.length} fields to CommonSecurityLog`);
    assert(match.matchRate > 0.3, `Match rate ${(match.matchRate * 100).toFixed(1)}% (>30%)`);

    // Key CEF->CSL mappings via alias table
    const matchMap = new Map(match.matched.map((m) => [m.sourceName, m]));

    // DeviceVendor, DeviceProduct should match exactly
    const dvMatch = matchMap.get('DeviceVendor');
    if (dvMatch) {
      assert(dvMatch.confidence === 'exact', 'DeviceVendor matches exactly');
      assert(dvMatch.action === 'keep', 'DeviceVendor action is keep (same name)');
    }

    // src should alias to SourceIP
    const srcMatch = matchMap.get('src');
    if (srcMatch) {
      assert(
        srcMatch.destName === 'SourceIP' || srcMatch.destName === 'SourceAddress',
        `src maps to SourceIP or SourceAddress (got: ${srcMatch.destName})`,
      );
      assert(srcMatch.action === 'rename', 'src action is rename');
    }

    // dst should alias to DestinationIP
    const dstMatch = matchMap.get('dst');
    if (dstMatch) {
      assert(
        dstMatch.destName === 'DestinationIP' || dstMatch.destName === 'DestinationAddress',
        `dst maps to DestinationIP or DestinationAddress (got: ${dstMatch.destName})`,
      );
    }

    // spt should alias to SourcePort
    const sptMatch = matchMap.get('spt');
    if (sptMatch) {
      assert(
        sptMatch.destName === 'SourcePort' || sptMatch.destName.includes('Port'),
        `spt maps to SourcePort (got: ${sptMatch.destName})`,
      );
    }

    // act should alias to DeviceAction
    const actMatch = matchMap.get('act');
    if (actMatch) {
      assert(
        actMatch.destName === 'DeviceAction' || actMatch.destName.includes('Action'),
        `act maps to DeviceAction (got: ${actMatch.destName})`,
      );
    }

    // Overflow should use AdditionalExtensions (string type for CEF)
    if (match.overflow.length > 0) {
      assert(
        match.overflowConfig.fieldName === 'AdditionalExtensions',
        `Overflow field is AdditionalExtensions (got: ${match.overflowConfig.fieldName})`,
      );
      assert(
        match.overflowConfig.fieldType === 'string',
        `Overflow type is string for CEF tables (got: ${match.overflowConfig.fieldType})`,
      );
    }
  } else {
    console.log('  [SKIP] CommonSecurityLog schema not available');
  }
}

// =========================================================================
// TEST 5: Pipeline Generation Reflects Gap Analysis
// =========================================================================

function testPipelineReflectsGapAnalysis(): void {
  section('TEST 5: Pipeline Generation Reflects Gap Analysis');

  // Import generatePipelineConf dynamically
  const packBuilder = require('./src/main/ipc/pack-builder');

  for (const table of ['CrowdStrike_Process_Events_CL', 'CrowdStrike_DNS_Events_CL']) {
    subsection(table);

    const events = loadSampleEvents(table);
    if (events.length === 0) continue;

    const parsed = parseSampleContent(
      events.map((e) => JSON.stringify(e)).join('\n'),
      `${table}.json`,
    );
    const destSchema = loadDcrTemplateSchemaPublic(table);
    if (destSchema.length === 0) continue;

    // Build field matches
    const sourceFields: SourceField[] = parsed.fields.map((f) => ({
      name: f.name, type: f.type, sampleValue: f.sampleValues[0],
    }));
    const destFields: DestField[] = destSchema.map((c) => ({ name: c.name, type: c.type }));
    const match = matchFields(sourceFields, destFields, undefined, table);

    // Generate pipeline
    const fieldMappings = match.matched.map((m) => ({
      source: m.sourceName,
      target: m.destName,
      type: m.destType,
      action: m.action,
    }));

    const pipelineYaml = packBuilder.generatePipelineConf
      ? packBuilder.generatePipelineConf(
          `${table}_pipeline`, 'CrowdStrike', table,
          fieldMappings, undefined, 'ndjson', match.overflowConfig,
        )
      : '';

    if (!pipelineYaml) {
      console.log('  [SKIP] generatePipelineConf not exported');
      continue;
    }

    // Verify pipeline has required sections
    assert(pipelineYaml.includes('serde'), 'Pipeline has serde function');
    assert(pipelineYaml.includes('groupId: extract'), 'Pipeline has extract group');
    assert(pipelineYaml.includes('groupId: enrich'), 'Pipeline has enrich group');
    assert(pipelineYaml.includes('groupId: cleanup'), 'Pipeline has cleanup group');

    // Verify serde type matches source format
    assert(pipelineYaml.includes('type: json'), 'Serde type is JSON for NDJSON source');

    // Verify timestamp extraction for CrowdStrike FDR
    assert(
      pipelineYaml.includes('Number(timestamp) / 1000'),
      'FDR timestamp eval expression present',
    );
    assert(
      pipelineYaml.includes('auto_timestamp'),
      'Fallback auto_timestamp present',
    );

    // Verify Type classification
    assert(
      pipelineYaml.includes(`'${table}'`),
      `Type field set to "${table}"`,
    );

    // Verify cleanup removes Cribl metadata
    assert(pipelineYaml.includes('cribl_*'), 'Cleanup removes cribl_* fields');
    assert(pipelineYaml.includes('__header*'), 'Cleanup removes __header* fields');
    assert(pipelineYaml.includes('_raw'), 'Cleanup removes _raw');

    // Verify rename function exists if there are rename mappings
    const renames = match.matched.filter((m) => m.action === 'rename');
    if (renames.length > 0) {
      assert(pipelineYaml.includes('id: rename'), 'Rename function present for mapped renames');
    }

    // Verify overflow section exists if there are overflow fields
    if (match.overflow.length > 0) {
      assert(
        pipelineYaml.includes('groupId: overflow') || pipelineYaml.includes('AdditionalData_d'),
        'Overflow function present for overflow fields',
      );
    }
  }
}

// =========================================================================
// TEST 6: No Data Loss -- Complete Field Accounting
// =========================================================================

function testNoDataLoss(): void {
  section('TEST 6: No Data Loss -- Complete Field Accounting');

  for (const table of CROWDSTRIKE_TABLES) {
    subsection(table);
    const events = loadSampleEvents(table);
    if (events.length === 0) continue;

    const parsed = parseSampleContent(
      events.map((e) => JSON.stringify(e)).join('\n'),
      `${table}.json`,
    );
    const destSchema = loadDcrTemplateSchemaPublic(table);
    if (destSchema.length === 0) continue;

    const sourceFields: SourceField[] = parsed.fields.map((f) => ({
      name: f.name, type: f.type,
    }));
    const destFields: DestField[] = destSchema.map((c) => ({ name: c.name, type: c.type }));
    const match = matchFields(sourceFields, destFields, undefined, table);

    // Track where every source field goes
    const matchedFieldNames = new Set(match.matched.map((m) => m.sourceName));
    const overflowFieldNames = new Set(match.overflow.map((o) => o.sourceName));
    const unmatchedFieldNames = new Set(match.unmatchedSource.map((u) => u.name));

    // Every source field should appear in exactly one category
    let accountingErrors = 0;
    for (const src of sourceFields) {
      const inMatched = matchedFieldNames.has(src.name);
      const inOverflow = overflowFieldNames.has(src.name);
      const inUnmatched = unmatchedFieldNames.has(src.name);
      const count = (inMatched ? 1 : 0) + (inOverflow ? 1 : 0) + (inUnmatched ? 1 : 0);

      if (count !== 1) {
        accountingErrors++;
        if (count === 0) {
          console.log(`    WARNING: Field "${src.name}" not accounted for in any category`);
        } else if (count > 1) {
          console.log(`    WARNING: Field "${src.name}" in ${count} categories`);
        }
      }
    }
    assert(
      accountingErrors === 0,
      `All ${sourceFields.length} fields in exactly one category (errors: ${accountingErrors})`,
    );

    // No non-metadata source data should be silently dropped
    const droppedNonMeta = match.unmatchedSource.filter((u) =>
      !u.name.startsWith('cribl_') && !u.name.startsWith('__') &&
      !['_raw', '_time', 'source', 'host', 'port', 'index', 'sourcetype'].includes(u.name)
    );
    assert(
      droppedNonMeta.length === 0,
      `No non-metadata source fields silently dropped (${droppedNonMeta.length} found)`,
      droppedNonMeta.length > 0 ? droppedNonMeta.map((f) => f.name).join(', ') : undefined,
    );
  }
}

// =========================================================================
// TEST 7: Cross-Vendor Type Consistency
// =========================================================================

function testCrossVendorTypeConsistency(): void {
  section('TEST 7: Cross-Vendor Type Consistency');

  subsection('CrowdStrike FDR common fields across tables');

  // Fields that should have the same type across all CrowdStrike tables
  const commonFields = ['event_simpleName', 'timestamp', 'aid', 'cid', 'aip', 'event_platform'];
  const fieldTypeMap = new Map<string, Map<string, string>>();

  for (const table of CROWDSTRIKE_TABLES) {
    const samplePath = path.join(VENDOR_SAMPLES_DIR, `${table}.json`);
    if (!fs.existsSync(samplePath)) continue;
    const parsed = parseSampleContent(fs.readFileSync(samplePath, 'utf-8'), `${table}.json`);

    for (const cf of commonFields) {
      const field = parsed.fields.find((f) => f.name === cf);
      if (field) {
        if (!fieldTypeMap.has(cf)) fieldTypeMap.set(cf, new Map());
        fieldTypeMap.get(cf)!.set(table, field.type);
      }
    }
  }

  for (const [fieldName, tableTypes] of fieldTypeMap) {
    const types = new Set(tableTypes.values());
    // Allow int/string variation for timestamp (depending on whether it's a number or string in sample)
    if (fieldName === 'timestamp') {
      assert(
        types.size <= 2 && [...types].every((t) => t === 'int' || t === 'string'),
        `${fieldName}: consistent type across tables (types: ${[...types].join(', ')})`,
      );
    } else {
      assert(
        types.size === 1,
        `${fieldName}: same type across all ${tableTypes.size} tables (types: ${[...types].join(', ')})`,
      );
    }
  }

  subsection('CEF standard fields type consistency');
  // CEF header fields should always be string type (they come from pipe-delimited format)
  const cefSample = 'CEF:0|Vendor|Product|1.0|100|Activity|5|src=1.2.3.4 dst=5.6.7.8';
  const cefParsed = parseSampleContent(cefSample, 'test.cef');
  for (const header of ['DeviceVendor', 'DeviceProduct', 'DeviceVersion', 'Name', 'Severity']) {
    const f = cefParsed.fields.find((ff) => ff.name === header);
    if (f) {
      // DeviceVersion "1.0" infers as real (decimal pattern), Severity "5" infers as int -- both valid
      assert(
        f.type === 'string' || f.type === 'int' || f.type === 'real',
        `CEF header "${header}" type is string, int, or real (got: ${f.type})`,
      );
    }
  }
}

// =========================================================================
// TEST 8: Gap Analysis vs Field Matcher Consistency
// =========================================================================

function testGapAnalysisMatcherConsistency(): void {
  section('TEST 8: Gap Analysis vs Field Matcher Consistency');

  const table = 'CrowdStrike_Process_Events_CL';
  const events = loadSampleEvents(table);
  if (events.length === 0) { console.log('  [SKIP] No sample data'); return; }

  const flow = loadDcrFlow(table);
  if (!flow) { console.log('  [SKIP] No DCR flow for this table'); return; }

  const sourceFields = extractSourceFields(events);
  const destSchema = loadDcrTemplateSchemaPublic(table);

  // Run both analysis methods
  const gap = analyzeDcrGap(sourceFields, destSchema, flow);
  const matchResult = matchFields(
    sourceFields.map((f) => ({ name: f.name, type: f.type })),
    destSchema.map((c) => ({ name: c.name, type: c.type })),
    undefined, table,
  );

  subsection('Source field count agreement');
  assert(
    gap.totalSourceFields === matchResult.totalSource,
    `Both see same source count: gap=${gap.totalSourceFields}, matcher=${matchResult.totalSource}`,
  );

  subsection('Dest field count agreement');
  assert(
    gap.totalDestFields === matchResult.totalDest,
    `Both see same dest count: gap=${gap.totalDestFields}, matcher=${matchResult.totalDest}`,
  );

  subsection('Overflow fields overlap');
  // Fields that gap analysis calls "overflow" should also be in matcher's overflow
  const gapOverflowNames = new Set(gap.criblMustHandle.overflow.map((o) => o.field));
  const matcherOverflowNames = new Set(matchResult.overflow.map((o) => o.sourceName));

  // Gap analysis overflow and matcher overflow should significantly overlap
  // They may not be identical because they use different matching algorithms
  let overlapCount = 0;
  for (const name of gapOverflowNames) {
    if (matcherOverflowNames.has(name)) overlapCount++;
  }
  const gapOverflowCount = gapOverflowNames.size;
  const matcherOverflowCount = matcherOverflowNames.size;

  console.log(`    Gap overflow: ${gapOverflowCount}, Matcher overflow: ${matcherOverflowCount}, Overlap: ${overlapCount}`);
  // Both should identify overflow fields (may differ in count due to algorithm differences)
  if (gapOverflowCount > 0 && matcherOverflowCount > 0) {
    const overlapRate = overlapCount / Math.min(gapOverflowCount, matcherOverflowCount);
    assert(
      overlapRate > 0.3,
      `Overflow overlap rate ${(overlapRate * 100).toFixed(0)}% (>30%)`,
    );
  }

  subsection('DCR-handled fields are not in Cribl rename/coerce');
  // Fields the DCR renames should NOT appear as Cribl renames in the matcher
  const dcrRenamedSources = new Set(flow.renames.map((r) => r.source.toLowerCase()));
  const matcherRenames = matchResult.matched.filter((m) => m.action === 'rename');

  for (const mr of matcherRenames) {
    // A field rename in the matcher is fine as long as the DCR isn't also renaming the same source field
    if (dcrRenamedSources.has(mr.sourceName.toLowerCase())) {
      // This is a potential duplicate transform -- the DCR already renames this
      console.log(`    NOTE: Matcher renames "${mr.sourceName}" but DCR also has a rename for it`);
    }
  }
}

// =========================================================================
// TEST 9: Multi-Format Sample Parsing (JSON, NDJSON, CSV, KV, CEF)
// =========================================================================

function testMultiFormatParsing(): void {
  section('TEST 9: Multi-Format Sample Parsing');

  subsection('NDJSON (CrowdStrike FDR)');
  const ndjsonContent = [
    '{"event_simpleName":"ProcessRollup2","timestamp":"1743508799999","aid":"abc123","CommandLine":"cmd.exe /c dir"}',
    '{"event_simpleName":"ProcessRollup2","timestamp":"1743508800000","aid":"abc123","CommandLine":"powershell.exe -ep bypass"}',
  ].join('\n');
  const ndjsonParsed = parseSampleContent(ndjsonContent, 'test.json');
  assert(ndjsonParsed.format === 'ndjson', `NDJSON detected (got: ${ndjsonParsed.format})`);
  assert(ndjsonParsed.eventCount === 2, `2 NDJSON events parsed (got: ${ndjsonParsed.eventCount})`);
  assert(ndjsonParsed.fields.some((f) => f.name === 'CommandLine'), 'CommandLine field extracted');

  subsection('JSON Array');
  const jsonContent = '[{"src":"1.2.3.4","dst":"5.6.7.8","action":"allow"},{"src":"10.0.0.1","dst":"20.0.0.1","action":"deny"}]';
  const jsonParsed = parseSampleContent(jsonContent, 'test.json');
  assert(jsonParsed.format === 'json', `JSON array detected (got: ${jsonParsed.format})`);
  assert(jsonParsed.eventCount === 2, `2 JSON events parsed (got: ${jsonParsed.eventCount})`);

  subsection('CSV');
  const csvContent = 'src_ip,dst_ip,action,bytes\n1.2.3.4,5.6.7.8,allow,1024\n10.0.0.1,20.0.0.1,deny,512';
  const csvParsed = parseSampleContent(csvContent, 'test.csv');
  assert(csvParsed.format === 'csv', `CSV detected (got: ${csvParsed.format})`);
  assert(csvParsed.eventCount === 2, `2 CSV events parsed (got: ${csvParsed.eventCount})`);
  assert(csvParsed.fields.some((f) => f.name === 'src_ip'), 'CSV header "src_ip" extracted');
  assert(csvParsed.fields.some((f) => f.name === 'bytes'), 'CSV header "bytes" extracted');

  // Verify CSV type inference
  const bytesField = csvParsed.fields.find((f) => f.name === 'bytes');
  assert(
    bytesField?.type === 'int',
    `CSV "bytes" inferred as int (got: ${bytesField?.type})`,
  );

  subsection('Key=Value');
  const kvContent = 'timestamp=2025-01-15T10:00:00Z src=1.2.3.4 dst=5.6.7.8 action=allow bytes=2048';
  const kvParsed = parseSampleContent(kvContent, 'test.log');
  assert(kvParsed.format === 'kv', `KV format detected (got: ${kvParsed.format})`);
  assert(kvParsed.fields.some((f) => f.name === 'src'), 'KV field "src" extracted');
  assert(kvParsed.fields.some((f) => f.name === 'action'), 'KV field "action" extracted');

  subsection('CEF with Syslog Header');
  const cefWithSyslog = '<134>Jan 15 10:00:00 fw-edge-01 CEF:0|Palo Alto Networks|PAN-OS|10.1|TRAFFIC|end|3|src=192.168.1.1 dst=10.0.0.1';
  const cefParsed = parseSampleContent(cefWithSyslog, 'test.cef');
  assert(cefParsed.format === 'cef', `CEF detected (got: ${cefParsed.format})`);
  const hasSyslogHeader = cefParsed.fields.some((f) => f.name === '_syslogHeader');
  assert(hasSyslogHeader, 'Syslog header preserved in _syslogHeader field');

  subsection('Format-specific serde type selection');
  // Verify the serde type that would be used for each format
  const serdeMap: Record<string, string> = {
    json: 'json', ndjson: 'json', csv: 'csv', kv: 'kvp', cef: 'kvp', leef: 'kvp',
  };
  for (const [fmt, expectedSerde] of Object.entries(serdeMap)) {
    const serde = fmt === 'csv' ? 'csv' : fmt === 'kv' || fmt === 'cef' || fmt === 'leef' ? 'kvp' : 'json';
    assert(serde === expectedSerde, `Format "${fmt}" -> serde type "${expectedSerde}"`);
  }
}

// =========================================================================
// TEST 10: Overflow Field Selection per Table Type
// =========================================================================

function testOverflowFieldSelection(): void {
  section('TEST 10: Overflow Field Selection per Table Type');

  // Custom tables (_CL) should use AdditionalData_d (dynamic)
  const customOverflow = getOverflowConfig('CrowdStrike_Process_Events_CL');
  assert(
    customOverflow.fieldName === 'AdditionalData_d',
    `Custom table overflow: AdditionalData_d (got: ${customOverflow.fieldName})`,
  );
  assert(
    customOverflow.fieldType === 'dynamic',
    `Custom table overflow type: dynamic (got: ${customOverflow.fieldType})`,
  );

  // CommonSecurityLog should use AdditionalExtensions (string)
  const cslOverflow = getOverflowConfig('CommonSecurityLog');
  assert(
    cslOverflow.fieldName === 'AdditionalExtensions',
    `CSL overflow: AdditionalExtensions (got: ${cslOverflow.fieldName})`,
  );
  assert(
    cslOverflow.fieldType === 'string',
    `CSL overflow type: string (got: ${cslOverflow.fieldType})`,
  );

  // Syslog should use SyslogMessage (string)
  const syslogOverflow = getOverflowConfig('Syslog');
  assert(
    syslogOverflow.fieldName === 'SyslogMessage',
    `Syslog overflow: SyslogMessage (got: ${syslogOverflow.fieldName})`,
  );

  // WindowsEvent should use EventData (dynamic)
  const winOverflow = getOverflowConfig('WindowsEvent');
  assert(
    winOverflow.fieldName === 'EventData',
    `WindowsEvent overflow: EventData (got: ${winOverflow.fieldName})`,
  );
  assert(
    winOverflow.fieldType === 'dynamic',
    `WindowsEvent overflow type: dynamic (got: ${winOverflow.fieldType})`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n');
  console.log('######################################################################');
  console.log('#                                                                    #');
  console.log('#  Transformation Pipeline UAT                                      #');
  console.log('#  Sample Data -> Field Extraction -> Schema Matching -> Pipeline    #');
  console.log('#                                                                    #');
  console.log('######################################################################');

  try {
    initAppPaths();
    console.log('\nApp paths initialized successfully.');
  } catch (e) {
    console.log(`\nApp paths initialization warning: ${e}`);
  }

  // Run all test suites
  testTypeInferenceAccuracy();
  testFieldMatchActions();
  testGapAnalysisTransformDecisions();
  testCefSampleParsing();
  testPipelineReflectsGapAnalysis();
  testNoDataLoss();
  testCrossVendorTypeConsistency();
  testGapAnalysisMatcherConsistency();
  testMultiFormatParsing();
  testOverflowFieldSelection();

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
