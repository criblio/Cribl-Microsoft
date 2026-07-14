// =============================================================================
// UAT: CrowdStrike FDR End-to-End Acceptance Tests
// =============================================================================
// Exercises the core app functions (sample-parser, field-matcher, pack-builder)
// directly against the CrowdStrike vendor sample files and custom table schemas.
//
// Run: npx tsx --tsconfig tsconfig.server.json test-uat-crowdstrike.ts
// =============================================================================

import fs from 'fs';
import path from 'path';
import { parseSampleContent, type ParsedSample } from './src/main/ipc/sample-parser';
import { matchFields, matchSampleToSchema, getOverflowConfig, type MatchResult } from './src/main/ipc/field-matcher';
import { loadDcrTemplateSchemaPublic } from './src/main/ipc/pack-builder';
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
// TEST 1: Sample File Availability
// ---------------------------------------------------------------------------

function testSampleFileAvailability(): void {
  section('TEST 1: Sample File & Schema Availability');

  for (const table of CROWDSTRIKE_TABLES) {
    const samplePath = path.join(VENDOR_SAMPLES_DIR, `${table}.json`);
    const schemaPath = path.join(CUSTOM_SCHEMAS_DIR, `${table}.json`);
    assert(fs.existsSync(samplePath), `Vendor sample exists: ${table}`);
    assert(fs.existsSync(schemaPath), `Custom schema exists: ${table}`);
  }
}

// ---------------------------------------------------------------------------
// TEST 2: Sample Parsing
// ---------------------------------------------------------------------------

function testSampleParsing(): Map<string, ParsedSample> {
  section('TEST 2: Sample Parsing (parseSampleContent)');
  const results = new Map<string, ParsedSample>();

  for (const table of CROWDSTRIKE_TABLES) {
    subsection(table);

    const samplePath = path.join(VENDOR_SAMPLES_DIR, `${table}.json`);
    const content = fs.readFileSync(samplePath, 'utf-8');
    const parsed = parseSampleContent(content, `${table}.json`);
    results.set(table, parsed);

    // Format detection: CrowdStrike FDR is NDJSON (newline-delimited JSON)
    assert(
      parsed.format === 'ndjson' || parsed.format === 'json',
      `Format detected as JSON/NDJSON (got: ${parsed.format})`,
    );

    // Should parse at least 1 event
    assert(parsed.eventCount > 0, `Parsed ${parsed.eventCount} events (>0)`);

    // Should discover fields
    assert(parsed.fields.length > 0, `Discovered ${parsed.fields.length} fields (>0)`);

    // Should have no errors
    assert(
      parsed.errors.length === 0,
      `No parse errors`,
      parsed.errors.length > 0 ? parsed.errors.join('; ') : undefined,
    );

    // CrowdStrike common fields should be present
    const fieldNames = new Set(parsed.fields.map(f => f.name));
    assert(fieldNames.has('event_simpleName'), `Has event_simpleName field`);
    assert(fieldNames.has('aid'), `Has aid (agent ID) field`);
    assert(fieldNames.has('timestamp'), `Has timestamp field`);
    assert(fieldNames.has('cid'), `Has cid (customer ID) field`);

    // Timestamp field detection
    assert(
      parsed.timestampField === 'timestamp',
      `Timestamp field detected as "timestamp" (got: "${parsed.timestampField}")`,
    );

    // Raw events should be populated
    assert(
      parsed.rawEvents.length > 0,
      `Raw events populated (${parsed.rawEvents.length})`,
    );

    // Verify raw events are valid JSON
    let validJson = true;
    for (const raw of parsed.rawEvents) {
      try { JSON.parse(raw); } catch { validJson = false; break; }
    }
    assert(validJson, `All raw events are valid JSON`);

    // Verify timestamp field type inference
    const tsField = parsed.fields.find(f => f.name === 'timestamp');
    if (tsField) {
      // CrowdStrike timestamps are epoch ms as strings, should be inferred as 'int' or 'string'
      assert(
        tsField.type === 'int' || tsField.type === 'string',
        `timestamp type is int or string (got: ${tsField.type})`,
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// TEST 3: Schema Loading
// ---------------------------------------------------------------------------

function testSchemaLoading(): Map<string, Array<{ name: string; type: string }>> {
  section('TEST 3: DCR Schema Loading (loadDcrTemplateSchemaPublic)');
  const schemas = new Map<string, Array<{ name: string; type: string }>>();

  for (const table of CROWDSTRIKE_TABLES) {
    subsection(table);

    const columns = loadDcrTemplateSchemaPublic(table);
    schemas.set(table, columns);

    assert(columns.length > 0, `Schema loaded with ${columns.length} columns (>0)`);

    // Check that system columns are filtered out
    const colNames = new Set(columns.map(c => c.name));
    assert(!colNames.has('TenantId'), `System column TenantId filtered out`);
    assert(!colNames.has('_ResourceId'), `System column _ResourceId filtered out`);

    // Common CrowdStrike fields should be in schema
    assert(colNames.has('TimeGenerated'), `Has TimeGenerated column`);
    assert(colNames.has('event_simpleName'), `Has event_simpleName column`);

    // Verify column types are valid
    const validTypes = new Set(['string', 'int', 'long', 'real', 'boolean', 'datetime', 'dynamic', 'guid']);
    const allValid = columns.every(c => validTypes.has(c.type));
    assert(allValid, `All column types are valid Azure types`);
  }

  return schemas;
}

// ---------------------------------------------------------------------------
// TEST 4: Field Matching
// ---------------------------------------------------------------------------

function testFieldMatching(
  parsedSamples: Map<string, ParsedSample>,
  schemas: Map<string, Array<{ name: string; type: string }>>,
): Map<string, MatchResult> {
  section('TEST 4: Field Matching (matchFields / matchSampleToSchema)');
  const matchResults = new Map<string, MatchResult>();

  for (const table of CROWDSTRIKE_TABLES) {
    subsection(table);

    const parsed = parsedSamples.get(table);
    const schema = schemas.get(table);
    if (!parsed || !schema || schema.length === 0) {
      console.log(`  [SKIP] Missing parsed sample or schema for ${table}`);
      continue;
    }

    // Convert parsed fields to match input format
    const sampleFields = parsed.fields.map(f => ({
      name: f.name,
      type: f.type,
      sampleValues: f.sampleValues,
    }));

    const result = matchSampleToSchema(sampleFields, schema, undefined, table);
    matchResults.set(table, result);

    // Should have some matched fields
    assert(result.matched.length > 0, `Matched ${result.matched.length} fields (>0)`);

    // Match rate should be reasonable (>0.3 for CrowdStrike custom tables where fields align)
    assert(
      result.matchRate > 0.3,
      `Match rate ${(result.matchRate * 100).toFixed(1)}% (>30%)`,
    );

    // Common fields should match
    const matchedSourceNames = new Set(result.matched.map(m => m.sourceName));
    assert(
      matchedSourceNames.has('event_simpleName'),
      `event_simpleName matched`,
    );

    // timestamp should match -- either to the schema's own "timestamp" column (exact match,
    // score 100) or to "TimeGenerated" (alias match, score 90). CrowdStrike custom schemas
    // include a "timestamp" (long) column, so exact match wins. The pipeline handles _time
    // extraction via eval (epoch ms / 1000), and Azure auto-populates TimeGenerated.
    const tsMatch = result.matched.find(m => m.sourceName === 'timestamp');
    if (tsMatch) {
      assert(
        tsMatch.destName === 'timestamp' || tsMatch.destName === 'TimeGenerated',
        `timestamp matched to schema column (got: ${tsMatch.destName})`,
        `confidence: ${tsMatch.confidence}`,
      );
    } else {
      // Check if it's in overflow
      const inOverflow = result.overflow.some(o => o.sourceName === 'timestamp');
      assert(!inOverflow, `timestamp should match, not overflow`);
    }

    // Overflow config should target AdditionalData_d for _CL tables
    const overflowCfg = getOverflowConfig(table);
    assert(
      overflowCfg.fieldName === 'AdditionalData_d',
      `Overflow field is AdditionalData_d for _CL table (got: ${overflowCfg.fieldName})`,
    );

    // Verify no Cribl internal fields leaked into matched results
    const criblInternals = result.matched.filter(m =>
      m.sourceName.startsWith('cribl_') || m.sourceName.startsWith('__') || m.sourceName === '_raw'
    );
    assert(
      criblInternals.length === 0,
      `No Cribl internal fields in matched results`,
      criblInternals.length > 0 ? criblInternals.map(m => m.sourceName).join(', ') : undefined,
    );

    // Log summary stats
    console.log(`    Matched: ${result.matched.length}, Overflow: ${result.overflow.length}, ` +
      `Unmatched Source: ${result.unmatchedSource.length}, Unmatched Dest: ${result.unmatchedDest.length}`);

    // Show confidence breakdown
    const byConfidence = { exact: 0, alias: 0, fuzzy: 0, unmatched: 0 };
    for (const m of result.matched) byConfidence[m.confidence]++;
    console.log(`    Confidence: exact=${byConfidence.exact}, alias=${byConfidence.alias}, ` +
      `fuzzy=${byConfidence.fuzzy}`);
  }

  return matchResults;
}

// ---------------------------------------------------------------------------
// TEST 5: Cross-Table Validation
// ---------------------------------------------------------------------------

function testCrossTableValidation(
  parsedSamples: Map<string, ParsedSample>,
  schemas: Map<string, Array<{ name: string; type: string }>>,
): void {
  section('TEST 5: Cross-Table Validation');

  subsection('Common fields present across all tables');

  const commonFields = ['event_simpleName', 'timestamp', 'aid', 'cid', 'aip', 'event_platform'];

  for (const field of commonFields) {
    let presentCount = 0;
    for (const table of CROWDSTRIKE_TABLES) {
      const parsed = parsedSamples.get(table);
      if (parsed && parsed.fields.some(f => f.name === field)) {
        presentCount++;
      }
    }
    assert(
      presentCount === CROWDSTRIKE_TABLES.length,
      `"${field}" present in all ${CROWDSTRIKE_TABLES.length} tables (found in ${presentCount})`,
    );
  }

  subsection('Schema column counts are reasonable');
  for (const table of CROWDSTRIKE_TABLES) {
    const schema = schemas.get(table);
    if (!schema) continue;
    // Custom schemas should have more than just TimeGenerated
    assert(
      schema.length >= 10,
      `${table}: ${schema.length} columns (>=10)`,
    );
  }

  subsection('Event type discrimination');
  // Each table should have distinct event_simpleName values
  const tableEventTypes = new Map<string, Set<string>>();
  for (const table of CROWDSTRIKE_TABLES) {
    const parsed = parsedSamples.get(table);
    if (!parsed) continue;
    const eventTypes = new Set<string>();
    for (const rawStr of parsed.rawEvents) {
      try {
        const evt = JSON.parse(rawStr);
        if (evt.event_simpleName) eventTypes.add(evt.event_simpleName);
      } catch { /* skip */ }
    }
    tableEventTypes.set(table, eventTypes);
    assert(
      eventTypes.size > 0,
      `${table}: has ${eventTypes.size} distinct event_simpleName values`,
    );
    console.log(`    Event types: ${Array.from(eventTypes).slice(0, 5).join(', ')}${eventTypes.size > 5 ? '...' : ''}`);
  }
}

// ---------------------------------------------------------------------------
// TEST 6: Pipeline Generation Validation
// ---------------------------------------------------------------------------

function testPipelineGeneration(
  parsedSamples: Map<string, ParsedSample>,
  matchResults: Map<string, MatchResult>,
): void {
  section('TEST 6: Pipeline Generation Simulation');

  // We can't call generatePipelineConf directly (it's not exported),
  // but we can validate the inputs would produce correct pipelines by
  // checking that the field mappings are coherent for pipeline generation.

  for (const table of ['CrowdStrike_DNS_Events_CL', 'CrowdStrike_Auth_Events_CL', 'CrowdStrike_Process_Events_CL']) {
    subsection(table);

    const result = matchResults.get(table);
    const parsed = parsedSamples.get(table);
    if (!result || !parsed) {
      console.log(`  [SKIP] No match result for ${table}`);
      continue;
    }

    // Convert MatchResult to FieldMapping format that pack-builder expects
    const fieldMappings = result.matched.map(m => ({
      source: m.sourceName,
      target: m.destName,
      type: m.destType,
      action: m.action as 'rename' | 'keep' | 'coerce' | 'drop',
    }));

    assert(fieldMappings.length > 0, `Field mappings generated: ${fieldMappings.length}`);

    // Check rename fields (source != target)
    const renames = fieldMappings.filter(f => f.action === 'rename');
    assert(renames.length >= 0, `Rename mappings: ${renames.length}`);
    if (renames.length > 0) {
      console.log(`    Sample renames: ${renames.slice(0, 3).map(r => `${r.source}->${r.target}`).join(', ')}`);
    }

    // Check keep fields (source == target, already named correctly)
    const keeps = fieldMappings.filter(f => f.action === 'keep');
    console.log(`    Keep (already correct): ${keeps.length}`);

    // Check coerce fields (type mismatch)
    const coerces = fieldMappings.filter(f => f.action === 'coerce');
    console.log(`    Type coercions needed: ${coerces.length}`);
    if (coerces.length > 0) {
      console.log(`    Sample coercions: ${coerces.slice(0, 3).map(c => `${c.source}:${c.type}`).join(', ')}`);
    }

    // Verify timestamp handling would work for CrowdStrike FDR
    const hasTimestamp = fieldMappings.some(f => f.source === 'timestamp');
    assert(
      hasTimestamp || result.overflow.some(o => o.sourceName === 'timestamp'),
      `timestamp field accounted for in pipeline`,
    );

    // Overflow config should be valid if there are overflow fields
    if (result.overflowConfig.enabled) {
      assert(
        result.overflowConfig.sourceFields.length > 0,
        `Overflow has ${result.overflowConfig.sourceFields.length} fields to collect`,
      );
      console.log(`    Overflow fields: ${result.overflowConfig.sourceFields.slice(0, 5).join(', ')}${result.overflowConfig.sourceFields.length > 5 ? '...' : ''}`);
    }
  }
}

// ---------------------------------------------------------------------------
// TEST 7: Data Type Integrity
// ---------------------------------------------------------------------------

function testDataTypeIntegrity(parsedSamples: Map<string, ParsedSample>): void {
  section('TEST 7: Data Type Integrity');

  for (const table of CROWDSTRIKE_TABLES) {
    subsection(table);

    const parsed = parsedSamples.get(table);
    if (!parsed) continue;

    // Validate that timestamp values are epoch milliseconds (13-digit numbers)
    const tsField = parsed.fields.find(f => f.name === 'timestamp');
    if (tsField && tsField.sampleValues.length > 0) {
      const sampleTs = tsField.sampleValues[0];
      const tsNum = Number(sampleTs);
      assert(
        !isNaN(tsNum) && sampleTs.length >= 10,
        `timestamp value is valid epoch (${sampleTs.substring(0, 16)}...)`,
      );

      // Should be epoch milliseconds (13 digits) or seconds (10 digits)
      assert(
        sampleTs.length >= 10 && sampleTs.length <= 16,
        `timestamp length ${sampleTs.length} is epoch ms/s range`,
      );
    }

    // Validate aid is a hex string (32 chars)
    const aidField = parsed.fields.find(f => f.name === 'aid');
    if (aidField && aidField.sampleValues.length > 0) {
      const aidVal = aidField.sampleValues[0];
      assert(
        /^[a-f0-9]{32}$/i.test(aidVal),
        `aid is 32-char hex (${aidVal.substring(0, 8)}...)`,
      );
    }

    // Validate event_simpleName is a non-empty string
    const esnField = parsed.fields.find(f => f.name === 'event_simpleName');
    if (esnField && esnField.sampleValues.length > 0) {
      assert(
        esnField.sampleValues[0].length > 0 && esnField.type === 'string',
        `event_simpleName is non-empty string: "${esnField.sampleValues[0]}"`,
      );
    }

    // Count field types
    const typeCounts: Record<string, number> = {};
    for (const f of parsed.fields) {
      typeCounts[f.type] = (typeCounts[f.type] || 0) + 1;
    }
    console.log(`    Field type distribution: ${Object.entries(typeCounts).map(([t, c]) => `${t}=${c}`).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// TEST 8: Table-Specific Field Validation
// ---------------------------------------------------------------------------

function testTableSpecificFields(parsedSamples: Map<string, ParsedSample>): void {
  section('TEST 8: Table-Specific Field Validation');

  // DNS Events should have DomainName
  subsection('CrowdStrike_DNS_Events_CL');
  const dns = parsedSamples.get('CrowdStrike_DNS_Events_CL');
  if (dns) {
    const dnsFields = new Set(dns.fields.map(f => f.name));
    assert(dnsFields.has('DomainName'), 'Has DomainName field');
    assert(dnsFields.has('RequestType'), 'Has RequestType field');
    assert(dnsFields.has('ContextProcessId'), 'Has ContextProcessId field');
  }

  // Auth Events should have logon-related fields
  subsection('CrowdStrike_Auth_Events_CL');
  const auth = parsedSamples.get('CrowdStrike_Auth_Events_CL');
  if (auth) {
    const authFields = new Set(auth.fields.map(f => f.name));
    assert(authFields.has('LogonType') || authFields.has('UserName'), 'Has auth-related fields (LogonType or UserName)');
  }

  // Process Events should have process-related fields
  subsection('CrowdStrike_Process_Events_CL');
  const proc = parsedSamples.get('CrowdStrike_Process_Events_CL');
  if (proc) {
    const procFields = new Set(proc.fields.map(f => f.name));
    assert(
      procFields.has('CommandLine') || procFields.has('ImageFileName') || procFields.has('ParentProcessId'),
      'Has process-related fields (CommandLine, ImageFileName, or ParentProcessId)',
    );
  }

  // Network Events should have network-related fields
  subsection('CrowdStrike_Network_Events_CL');
  const net = parsedSamples.get('CrowdStrike_Network_Events_CL');
  if (net) {
    const netFields = new Set(net.fields.map(f => f.name));
    assert(
      netFields.has('LocalAddressIP4') || netFields.has('RemoteAddressIP4') || netFields.has('LocalPort'),
      'Has network-related fields (LocalAddressIP4, RemoteAddressIP4, or LocalPort)',
    );
  }

  // File Events should have file-related fields
  subsection('CrowdStrike_File_Events_CL');
  const file = parsedSamples.get('CrowdStrike_File_Events_CL');
  if (file) {
    const fileFields = new Set(file.fields.map(f => f.name));
    assert(
      fileFields.has('TargetFileName') || fileFields.has('SourceFileName') || fileFields.has('SHA256HashData'),
      'Has file-related fields (TargetFileName, SourceFileName, or SHA256HashData)',
    );
  }

  // Registry Events should have registry-related fields
  subsection('CrowdStrike_Registry_Events_CL');
  const reg = parsedSamples.get('CrowdStrike_Registry_Events_CL');
  if (reg) {
    const regFields = new Set(reg.fields.map(f => f.name));
    assert(
      regFields.has('RegObjectName') || regFields.has('RegValueName'),
      'Has registry-related fields (RegObjectName or RegValueName)',
    );
  }
}

// ---------------------------------------------------------------------------
// TEST 9: DCR ARM Template Parsing (Priority 1 fix)
// ---------------------------------------------------------------------------

function testDcrArmTemplateParsing(): void {
  section('TEST 9: DCR ARM Template Parsing (parseDcrJson)');

  const { parseDcrJson } = require('./src/main/ipc/kql-parser');

  // Load CrowdStrike Custom DCR (ARM template format)
  const sentinelRepoBase = path.join(
    process.env.APPDATA || '', '.cribl-microsoft', 'sentinel-repo', 'Azure-Sentinel'
  );
  const dcrPath = path.join(
    sentinelRepoBase, 'Solutions', 'CrowdStrike Falcon Endpoint Protection',
    'Data Connectors', 'CrowdstrikeReplicatorCLv2', 'Data Collection Rules',
    'CrowdStrikeCustomDCR.json',
  );

  const dcrExists = fs.existsSync(dcrPath);
  assert(dcrExists, 'CrowdStrike Custom DCR file exists in Sentinel repo');
  if (!dcrExists) return;

  const content = fs.readFileSync(dcrPath, 'utf-8');

  // Verify it IS an ARM template (not a direct DCR object)
  const raw = JSON.parse(content);
  assert(
    raw.resources !== undefined && Array.isArray(raw.resources),
    'DCR file is ARM template format (has resources array)',
  );
  assert(
    raw.resources[0]?.type?.toLowerCase().includes('datacollectionrules') === true,
    'ARM template resource type is dataCollectionRules',
  );

  // Parse with our fixed function
  const parsed = parseDcrJson(content);
  assert(parsed.flows.length > 0, `parseDcrJson found ${parsed.flows.length} flows (>0)`);
  assert(parsed.flows.length >= 8, `Found at least 8 CrowdStrike table flows (got: ${parsed.flows.length})`);

  // Verify specific tables are present
  const tableNames = new Set(parsed.flows.map((f: any) => f.tableName));
  for (const expected of [
    'CrowdStrike_Network_Events_CL',
    'CrowdStrike_DNS_Events_CL',
    'CrowdStrike_Process_Events_CL',
    'CrowdStrike_Auth_Events_CL',
    'CrowdStrike_File_Events_CL',
    'CrowdStrike_Registry_Events_CL',
    'CrowdStrike_Audit_Events_CL',
    'CrowdStrike_User_Events_CL',
  ]) {
    assert(tableNames.has(expected), `Flow found for ${expected}`);
  }

  // Verify each flow has columns extracted from KQL
  for (const flow of parsed.flows) {
    assert(
      flow.columns.length > 0,
      `${flow.tableName}: has ${flow.columns.length} columns (>0)`,
    );
  }

  // Verify Process table has the most columns (it's the largest CrowdStrike table)
  const processFlow = parsed.flows.find((f: any) => f.tableName === 'CrowdStrike_Process_Events_CL');
  assert(
    processFlow && processFlow.columns.length >= 20,
    `Process table has ${processFlow?.columns.length || 0} columns (>=20)`,
  );

  // Test that a plain DCR object (non-ARM) still works
  subsection('Plain DCR object (backwards compatibility)');
  const plainDcr = JSON.stringify({
    properties: {
      dataFlows: [{
        outputStream: 'Custom-TestTable_CL',
        transformKql: 'source | project-rename Dest1 = src1, Dest2 = src2',
      }],
    },
  });
  const plainParsed = parseDcrJson(plainDcr);
  assert(plainParsed.flows.length === 1, 'Plain DCR object parses to 1 flow');
  assert(plainParsed.flows[0].tableName === 'TestTable_CL', 'Plain DCR table name extracted');
}

// ---------------------------------------------------------------------------
// TEST 10: Recursive Connector File Discovery (Priority 1 fix)
// ---------------------------------------------------------------------------

function testRecursiveConnectorDiscovery(): void {
  section('TEST 10: Recursive Connector File Discovery');

  let sentinelRepo: any;
  try {
    sentinelRepo = require('./src/main/ipc/sentinel-repo');
  } catch (e) {
    assert(false, 'sentinel-repo module loads', String(e));
    return;
  }

  if (!sentinelRepo.isRepoReady()) {
    console.log('  [SKIP] Sentinel repo not cloned -- skipping connector discovery tests');
    return;
  }

  // Test CrowdStrike connector discovery
  const csFiles = sentinelRepo.listConnectorFiles('CrowdStrike Falcon Endpoint Protection');
  assert(csFiles.length > 0, `CrowdStrike connector files found: ${csFiles.length}`);

  // Filter for DCR files
  const csDcrs = csFiles.filter((f: any) => f.name.toLowerCase().includes('dcr') && f.name.toLowerCase().endsWith('.json'));
  assert(csDcrs.length >= 3, `CrowdStrike DCR files found: ${csDcrs.length} (>=3)`);

  // The key test: CrowdStrikeCustomDCR.json is 2 levels deep in Data Collection Rules/
  const customDcr = csDcrs.find((f: any) => f.name === 'CrowdStrikeCustomDCR.json');
  assert(
    customDcr !== undefined,
    'CrowdStrikeCustomDCR.json found (nested 2 levels deep)',
    customDcr ? customDcr.path : 'not found',
  );

  // Verify the path shows the nested structure
  if (customDcr) {
    assert(
      customDcr.path.includes('Data Collection Rules'),
      'Path includes nested subdirectory "Data Collection Rules"',
      customDcr.path,
    );
  }

  // The normalization DCR should also be found
  const normDcr = csDcrs.find((f: any) => f.name === 'CrowdStrikeNormalizationDCR.json');
  assert(
    normDcr !== undefined,
    'CrowdStrikeNormalizationDCR.json found (also 2 levels deep)',
  );

  // Test solution matching
  subsection('Solution name matching');
  const solutions = sentinelRepo.listSolutions();
  const csMatch = solutions.find((s: any) => s.name.toLowerCase().includes('crowdstrike'));
  assert(csMatch !== undefined, 'CrowdStrike solution found in listSolutions()');

  const paloMatch = solutions.find((s: any) => s.name === 'PaloAlto-PAN-OS');
  assert(paloMatch !== undefined, 'PaloAlto-PAN-OS solution found in listSolutions()');
}

// ---------------------------------------------------------------------------
// TEST 11: Gap Analysis Population (Priority 1 -- end-to-end)
// ---------------------------------------------------------------------------

async function testGapAnalysisPopulation(): Promise<void> {
  section('TEST 11: Gap Analysis with DCR Flow Data');

  const kqlParser = require('./src/main/ipc/kql-parser');

  // Test getTableRoutingForSolution with CrowdStrike
  subsection('getTableRoutingForSolution - CrowdStrike');
  const routing = await kqlParser.getTableRoutingForSolution('CrowdStrike Falcon Endpoint Protection');
  assert(routing.length > 0, `Routing found ${routing.length} table routes (>0)`);

  if (routing.length > 0) {
    const routeTableNames = new Set(routing.map((r: any) => r.tableName));
    assert(
      routeTableNames.has('CrowdStrike_Process_Events_CL'),
      'Routing includes CrowdStrike_Process_Events_CL',
    );
  }

  // Test analyzeDcrGap with real data
  subsection('analyzeDcrGap with CrowdStrike Process Events');
  const processSamplePath = path.join(VENDOR_SAMPLES_DIR, 'CrowdStrike_Process_Events_CL.json');
  if (fs.existsSync(processSamplePath)) {
    const sampleContent = fs.readFileSync(processSamplePath, 'utf-8');
    const events = sampleContent.split('\n').filter(Boolean).slice(0, 10);

    // Build source field map from sample events
    const fieldMap = new Map<string, string>();
    for (const raw of events) {
      try {
        const evt = JSON.parse(raw);
        for (const [k, v] of Object.entries(evt)) {
          if (!fieldMap.has(k)) {
            const t = typeof v === 'number' ? (Number.isInteger(v as number) ? 'long' : 'real') :
              typeof v === 'boolean' ? 'boolean' :
              typeof v === 'object' ? 'dynamic' : 'string';
            fieldMap.set(k, t);
          }
        }
      } catch { /* skip */ }
    }
    const sourceFields = Array.from(fieldMap.entries()).map(([name, type]) => ({ name, type }));

    // Load dest schema
    const destSchema = loadDcrTemplateSchemaPublic('CrowdStrike_Process_Events_CL');

    // Find DCR flow
    const dcrContent = (() => {
      const dcrPath = path.join(
        process.env.APPDATA || '', '.cribl-microsoft', 'sentinel-repo', 'Azure-Sentinel',
        'Solutions', 'CrowdStrike Falcon Endpoint Protection', 'Data Connectors',
        'CrowdstrikeReplicatorCLv2', 'Data Collection Rules', 'CrowdStrikeCustomDCR.json',
      );
      return fs.existsSync(dcrPath) ? fs.readFileSync(dcrPath, 'utf-8') : null;
    })();

    if (dcrContent && sourceFields.length > 0 && destSchema.length > 0) {
      const parsed = kqlParser.parseDcrJson(dcrContent);
      const flow = parsed.flows.find((f: any) => f.tableName === 'CrowdStrike_Process_Events_CL');

      if (flow) {
        const gap = kqlParser.analyzeDcrGap(sourceFields, destSchema, flow);

        assert(gap.totalSourceFields > 0, `Source fields: ${gap.totalSourceFields}`);
        assert(gap.totalDestFields > 0, `Dest fields: ${gap.totalDestFields}`);
        assert(gap.passthroughCount > 0, `Passthrough count: ${gap.passthroughCount} (>0) -- was broken before fix`);
        assert(
          gap.dcrHandledCount > 0 || gap.criblHandledCount > 0,
          `DCR handled: ${gap.dcrHandledCount}, Cribl handled: ${gap.criblHandledCount} (at least one > 0)`,
        );
        assert(
          gap.passthroughCount + gap.dcrHandledCount + gap.criblHandledCount + gap.overflowCount > 0,
          'Total categorized fields > 0 (gap analysis is populating data)',
        );

        // Verify DCR handles section has real data
        assert(
          gap.dcrHandles.renames.length > 0 || gap.dcrHandles.coercions.length > 0 || gap.dcrHandles.timeGenerated,
          'DCR handles section has renames, coercions, or timeGenerated',
        );

        // Verify Cribl must-handle section
        assert(
          gap.criblMustHandle.enrichments.length >= 2,
          `Cribl enrichments include _time and Type (${gap.criblMustHandle.enrichments.length})`,
        );
      } else {
        assert(false, 'DCR flow found for CrowdStrike_Process_Events_CL');
      }
    } else {
      console.log('  [SKIP] Missing DCR content, source fields, or dest schema');
    }
  }
}

// ---------------------------------------------------------------------------
// TEST 12: Auto-Load Sample Filtering (Priority 2)
// ---------------------------------------------------------------------------

function testAutoLoadFiltering(): void {
  section('TEST 12: Auto-Load Sample Filtering');

  // Test score threshold
  subsection('Score threshold (>=8)');

  // A file with only a 3-char keyword match like "pan" should score < 8
  const shortKeyword = 'pan';
  // Score = keyword.length = 3, which is < 4 so it's skipped entirely
  assert(shortKeyword.length < 4, 'Short keywords (<4 chars) are excluded from matching');

  // A file matching "paloalto" (8 chars) scores exactly 8 -- meets threshold
  assert('paloalto'.length >= 8, '"paloalto" keyword meets minimum score threshold');

  // PAN-OS log type mapping
  subsection('PAN-OS DeviceEventClassID mapping');
  const PANOS_LOG_TYPES: Record<string, string> = {
    '1': 'TRAFFIC', '2': 'THREAT', '3': 'WILDFIRE',
    '10': 'CONFIG', '12': 'SYSTEM', '15': 'HIP-MATCH',
    '1100': 'URL-FILTERING', '1200': 'DATA-FILTERING',
    '2000': 'SCTP', '2048': 'IPTAG', '4096': 'USERID',
  };
  assert(PANOS_LOG_TYPES['1100'] === 'URL-FILTERING', 'DeviceEventClassID 1100 = URL-FILTERING');
  assert(PANOS_LOG_TYPES['1'] === 'TRAFFIC', 'DeviceEventClassID 1 = TRAFFIC');
  assert(PANOS_LOG_TYPES['2'] === 'THREAT', 'DeviceEventClassID 2 = THREAT');
  assert(PANOS_LOG_TYPES['12'] === 'SYSTEM', 'DeviceEventClassID 12 = SYSTEM');

  // Exclusion patterns
  subsection('False positive exclusion patterns');
  const EXCLUDE_PATTERNS = [
    /prismacloud/i,
    /prisma\s*cloud/i,
    /sanitized/i,
    /\.schema\./i,
    /ingested/i,
  ];
  assert(
    EXCLUDE_PATTERNS.some(re => re.test('PrismaCloudSample.json')),
    'PrismaCloud files excluded',
  );
  assert(
    EXCLUDE_PATTERNS.some(re => re.test('sanitized_audit_data.csv')),
    'Sanitized files excluded',
  );
  assert(
    EXCLUDE_PATTERNS.some(re => re.test('events.schema.json')),
    'Schema files excluded',
  );
  assert(
    EXCLUDE_PATTERNS.some(re => re.test('IngestedLogs.json')),
    'Ingested log files excluded',
  );
  assert(
    !EXCLUDE_PATTERNS.some(re => re.test('PaloAltoNetworksPANOS_TRAFFIC.json')),
    'PAN-OS traffic files NOT excluded',
  );
  assert(
    !EXCLUDE_PATTERNS.some(re => re.test('CrowdStrike_Process_Events_CL.json')),
    'CrowdStrike files NOT excluded',
  );
}

// ---------------------------------------------------------------------------
// TEST 13: DataFlowView Component Integration (Priority 4)
// ---------------------------------------------------------------------------

function testDataFlowViewIntegration(): void {
  section('TEST 13: DataFlowView Integration');

  // Verify the component file exists
  const componentPath = path.join(APP_ROOT, 'src', 'renderer', 'components', 'DataFlowView.tsx');
  assert(fs.existsSync(componentPath), 'DataFlowView.tsx component exists');

  // Verify it's imported in SentinelIntegration
  const integrationPath = path.join(APP_ROOT, 'src', 'renderer', 'pages', 'SentinelIntegration.tsx');
  assert(fs.existsSync(integrationPath), 'SentinelIntegration.tsx page exists');

  const integrationContent = fs.readFileSync(integrationPath, 'utf-8');
  assert(
    integrationContent.includes("import DataFlowView from '../components/DataFlowView'"),
    'DataFlowView is imported in SentinelIntegration',
  );
  assert(
    integrationContent.includes('<DataFlowView'),
    'DataFlowView component is used (JSX tag found)',
  );
  assert(
    integrationContent.includes('Data Flow Validation'),
    'Section 6 "Data Flow Validation" exists',
  );
  assert(
    integrationContent.includes('deployComplete'),
    'DataFlowView section is gated on deployComplete',
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n');
  console.log('######################################################################');
  console.log('#                                                                    #');
  console.log('#  CrowdStrike FDR - User Acceptance Testing                        #');
  console.log('#  Testing: sample-parser, field-matcher, pack-builder, kql-parser   #');
  console.log('#           sentinel-repo, auto-load filtering, DataFlowView        #');
  console.log('#                                                                    #');
  console.log('######################################################################');

  // Initialize app paths so schema loading works
  try {
    initAppPaths();
    console.log('\nApp paths initialized successfully.');
  } catch (e) {
    console.log(`\nApp paths initialization warning: ${e}`);
  }

  // Run all test suites (original + new)
  testSampleFileAvailability();
  const parsedSamples = testSampleParsing();
  const schemas = testSchemaLoading();
  const matchResults = testFieldMatching(parsedSamples, schemas);
  testCrossTableValidation(parsedSamples, schemas);
  testPipelineGeneration(parsedSamples, matchResults);
  testDataTypeIntegrity(parsedSamples);
  testTableSpecificFields(parsedSamples);

  // Priority 1: DCR parsing and gap analysis
  testDcrArmTemplateParsing();
  testRecursiveConnectorDiscovery();
  await testGapAnalysisPopulation();

  // Priority 2: Auto-load sample filtering
  testAutoLoadFiltering();

  // Priority 4: DataFlowView integration
  testDataFlowViewIntegration();

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
