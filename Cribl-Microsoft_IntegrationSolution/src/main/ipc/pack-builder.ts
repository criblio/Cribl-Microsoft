import { IpcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { findReductionRules, TableReductionRules, ReductionRule, SuppressRule } from './reduction-rules';
import { OverflowConfig } from './field-matcher';
import { SOURCE_TYPES, VENDOR_SOURCE_HINTS, suggestSourceType, generateInputsYml, SourceConfig, SourceTypeDefinition } from './source-types';
import { performVendorResearch, VendorResearchResult, FieldMapping as VendorFieldMapping } from './vendor-research';
import { captureSnapshot } from './change-detection';
import logger from './logger';
import { findDestinationForTable, readAzureParameters, generateOutputsYmlFromDestinations, DeployedDestination } from './azure-deploy';
import * as sentinelRepo from './sentinel-repo';
import * as kqlParser from './kql-parser';
import {
  packsDir as appPacksDir, dcrTemplatesDir as appDcrTemplatesDir,
  isRepoLinked, repoPath as getRepoPath, dcrAutomationCwd,
} from './app-paths';

interface FieldMapping {
  source: string;
  target: string;
  type: string;
  action: 'rename' | 'keep' | 'coerce' | 'drop';
}

interface VendorSample {
  tableName: string;
  format: string;
  rawEvents: string[];
  source: string;
}

interface PackScaffoldOptions {
  solutionName: string;
  packName: string;
  version: string;
  autoPackage: boolean;
  vendorSamples: VendorSample[];
  sourceConfig?: SourceConfig;
  tables: Array<{
    sentinelTable: string;
    criblStream: string;
    logType?: string;        // Log type name (e.g., "HTTP", "WAF", "DNS") for per-logtype pipelines
    sourcetypeFilter?: string; // Sourcetype filter for routing (e.g., "sourcetype == 'cloudflare:json'")
    fields: FieldMapping[];
  }>;
  fieldMappingOverrides?: Record<string, Array<{
    source: string; dest: string; sourceType: string; destType: string;
    confidence: string; action: string; needsCoercion: boolean;
    description: string; sampleValue?: string;
  }>>;
}

interface DcrSchemaColumn {
  name: string;
  type: string;
}

function getPacksDir(): string {
  return appPacksDir();
}


// Load DCR template schema from bundled templates in app data.
// Falls back to linked repo if templates haven't been bundled yet.
function loadDcrTemplateSchema(tableName: string): DcrSchemaColumn[] {
  const templateDir = appDcrTemplatesDir();

  // Normalize table name: strip common prefixes used in Sentinel Content Hub
  // e.g., "Microsoft-CommonSecurityLog" -> "CommonSecurityLog"
  const normalizedNames = [tableName];
  if (tableName.startsWith('Microsoft-')) {
    normalizedNames.push(tableName.replace(/^Microsoft-/, ''));
  }
  // Also try with prefix if not present (reverse lookup)
  if (!tableName.startsWith('Microsoft-')) {
    normalizedNames.push(`Microsoft-${tableName}`);
  }

  // Search paths: app data first, then linked repo
  const searchBases: string[] = [templateDir];
  const linkedRepo = getRepoPath('Azure', 'CustomDeploymentTemplates', 'DCR-Templates', 'SentinelNativeTables');
  if (linkedRepo && fs.existsSync(linkedRepo)) searchBases.push(linkedRepo);

  // Build all candidate paths across all search bases, trying all name variants
  const candidatePaths: string[] = [];
  for (const base of searchBases) {
    for (const name of normalizedNames) {
      candidatePaths.push(path.join(base, 'DataCollectionRules(DCE)', `${name}.json`));
      candidatePaths.push(path.join(base, 'DataCollectionRules(NoDCE)', `${name}.json`));
    }
  }
  const customSchemaPaths: string[] = [];
  for (const name of normalizedNames) {
    customSchemaPaths.push(path.join(templateDir, 'custom-table-schemas', `${name}.json`));
    const linkedCustom = getRepoPath('Azure', 'CustomDeploymentTemplates', 'DCR-Automation', 'core', 'custom-table-schemas', `${name}.json`);
    if (linkedCustom) customSchemaPaths.push(linkedCustom);
  }

  // Try DCR templates first
  for (const templatePath of candidatePaths) {
    if (fs.existsSync(templatePath)) {
      try {
        const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
        const resources = template.resources;
        if (Array.isArray(resources)) {
          for (const resource of resources) {
            const props = resource.properties;
            if (props?.streamDeclarations) {
              const streamKey = Object.keys(props.streamDeclarations).find(
                (k) => normalizedNames.some((n) => k === `Custom-${n}`)
              );
              if (streamKey && props.streamDeclarations[streamKey].columns) {
                return props.streamDeclarations[streamKey].columns;
              }
            }
          }
        }
      } catch (err) {
        logger.warn('pack-builder', `Failed to parse DCR template at ${templatePath}`, err);
      }
    }
  }

  // Try custom table schemas
  for (const customSchemaPath of customSchemaPaths) {
    if (fs.existsSync(customSchemaPath)) {
      try {
        const schema = JSON.parse(fs.readFileSync(customSchemaPath, 'utf-8'));
        if (Array.isArray(schema.columns)) {
          return schema.columns.map((c: Record<string, string>) => ({
            name: c.name,
            type: c.type || 'string',
          }));
        }
      } catch (err) {
        logger.warn('pack-builder', `Failed to parse custom table schema at ${customSchemaPath}`, err);
      }
    }
  }

  // Try Sentinel repo CustomTables directories (for custom _CL tables defined in solutions).
  // These files use the format: { properties: { schema: { columns: [{name,type}] } } }
  try {
    const { getSolutionsDir } = sentinelRepo;
    const solDir = getSolutionsDir();
    if (fs.existsSync(solDir)) {
      const solutions = fs.readdirSync(solDir, { withFileTypes: true }).filter((e: any) => e.isDirectory());
      for (const sol of solutions) {
        // Search all directories recursively for CustomTables/<tableName>.json
        const connDirNames = ['Data Connectors', 'DataConnectors'];
        for (const connDirName of connDirNames) {
          const connDir = path.join(solDir, sol.name, connDirName);
          if (!fs.existsSync(connDir)) continue;
          // Recursively find CustomTables directories
          const findCustomTables = (dir: string): string[] => {
            const results: string[] = [];
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                  if (entry.name === 'CustomTables') {
                    // Check for the specific table file
                    const tableFile = path.join(fullPath, `${tableName}.json`);
                    if (fs.existsSync(tableFile)) results.push(tableFile);
                  } else {
                    results.push(...findCustomTables(fullPath));
                  }
                }
              }
            } catch (err) { logger.warn('pack-builder', `Failed to read directory ${dir} while searching for CustomTables`, err); }
            return results;
          };
          const tableFiles = findCustomTables(connDir);
          for (const tableFile of tableFiles) {
            try {
              const schema = JSON.parse(fs.readFileSync(tableFile, 'utf-8'));
              // Format: { properties: { schema: { columns: [{name, type, description}] } } }
              const columns = schema?.properties?.schema?.columns;
              if (Array.isArray(columns) && columns.length > 0) {
                return columns.map((c: Record<string, string>) => ({
                  name: c.name,
                  type: c.type || 'string',
                }));
              }
            } catch (err) { logger.warn('pack-builder', `Failed to parse CustomTables file ${tableFile}`, err); }
          }
        }
      }
    }
  } catch (err) { logger.warn('pack-builder', `Sentinel repo not available for schema lookup of table '${tableName}'`, err); }

  return [];
}

// Public accessor for field-matcher to load DCR schemas
export function loadDcrTemplateSchemaPublic(tableName: string): DcrSchemaColumn[] {
  const columns = loadDcrTemplateSchema(tableName);
  const systemCols = new Set([
    'TenantId', 'SourceSystem', 'MG', 'ManagementGroupName',
    '_ResourceId', '_SubscriptionId', '_ItemId', '_IsBillable', '_BilledSize',
    'Type', 'PartitionKey', 'RowKey', 'StorageAccount',
    'AzureDeploymentID', 'AzureTableName', 'TimeCollected',
    'SourceComputerId', 'EventOriginId',
  ]);
  return columns.filter((c) => !systemCols.has(c.name));
}

// System columns that should be filtered from DCR schemas (auto-populated by Azure)
const SYSTEM_COLUMNS = new Set([
  'TenantId', 'SourceSystem', 'MG', 'ManagementGroupName',
  '_ResourceId', '_SubscriptionId', '_ItemId', '_IsBillable', '_BilledSize',
  'Type', 'PartitionKey', 'RowKey', 'StorageAccount',
  'AzureDeploymentID', 'AzureTableName', 'TimeCollected',
  'SourceComputerId', 'EventOriginId',
]);

// Build a type coercion expression for Cribl Eval function
function buildCoercionExpr(fieldName: string, sourceType: string, targetType: string): string | null {
  if (sourceType === targetType) return null;
  const t = targetType.toLowerCase();
  const escaped = fieldName.replace(/'/g, "\\'");
  if (t === 'int' || t === 'long') return `Number(${escaped}) || 0`;
  if (t === 'real') return `parseFloat(${escaped}) || 0.0`;
  if (t === 'boolean') return `Boolean(${escaped})`;
  if (t === 'datetime') return `${escaped}`;
  if (t === 'string') return `String(${escaped} || '')`;
  if (t === 'dynamic') return `typeof ${escaped} === 'string' ? JSON.parse(${escaped}) : ${escaped}`;
  return null;
}

// Detect the most likely timestamp field from the field list
function detectTimestampField(fields: FieldMapping[]): string {
  const candidates = [
    'EdgeStartTimestamp', 'Datetime', 'Timestamp', 'EventTime',
    'TimeGenerated', 'timestamp', 'time', 'eventTime', 'created_at',
    'CreatedDateTime', 'StartTime', 'GeneratedDateTime',
  ];
  for (const candidate of candidates) {
    if (fields.some((f) => f.source === candidate || f.target === candidate)) {
      return candidate;
    }
  }
  // Fall back to any field with "time" or "date" in the name
  const timeField = fields.find((f) => {
    const lower = (f.source || f.target).toLowerCase();
    return lower.includes('time') || lower.includes('date') || lower.includes('timestamp');
  });
  return timeField ? (timeField.source || timeField.target) : 'TimeGenerated';
}

// Generate pipeline conf.yml matching the reference pack structure:
// Groups: Field Extraction, Enrich & Classify, Sentinel Cleanup
// Functions: serde (JSON parse), auto_timestamp, eval (enrichments), eval (cleanup)
//
// When vendorMappings are provided (from vendor research), the pipeline generates
// proper source->destination transformations: rename source fields to dest names,
// coerce types where they differ, and add enrichment fields.
function generatePipelineConf(
  pipelineName: string,
  solutionName: string,
  tableName: string,
  fields: FieldMapping[],
  vendorMappings?: VendorFieldMapping[],
  sourceFormat?: string,
  overflowConfig?: OverflowConfig,
  reductionRules?: TableReductionRules | null,
): string {
  const functions: string[] = [];

  // Group IDs for pipeline function grouping
  const GID_EXTRACT = 'extract';
  const GID_REDUCE = 'reduce';
  const GID_ENRICH = 'enrich';
  const GID_OVERFLOW = 'overflow';
  const GID_CLEANUP = 'cleanup';

  // If vendor mappings exist, use them for authoritative source->dest transformation
  const hasVendorMappings = vendorMappings && vendorMappings.length > 0;

  const activeFields = fields.filter((f) => f.action !== 'drop');
  const renameFields = hasVendorMappings
    ? vendorMappings.filter((m) => m.action === 'map' && m.sourceName !== m.destName)
    : activeFields.filter((f) => f.action === 'rename' && f.source !== f.target);
  const coerceFields = hasVendorMappings
    ? vendorMappings.filter((m) => m.action === 'map' && m.sourceType !== m.destType)
    : activeFields.filter((f) => f.action === 'coerce');

  let timestampField = hasVendorMappings
    ? (vendorMappings.find((m) => m.destName === 'TimeGenerated')?.sourceName || detectTimestampField(fields))
    : detectTimestampField(fields);
  // If timestamp detection found a non-standard field but the solution name suggests
  // a known timestamp pattern, override it. FDR uses epoch ms in "timestamp" field.
  if (solutionName.toLowerCase().includes('crowdstrike') && timestampField !== 'timestamp') {
    timestampField = 'timestamp';
  }
  // CEF format uses 'rt' (ReceiptTime) as the standard timestamp field.
  // Fall back to 'start' if rt isn't available.
  if (sourceFormat === 'cef' && timestampField === 'TimeGenerated') {
    timestampField = 'rt';
  }

  // Step 1 (extract group): Parse fields from _raw
  if (sourceFormat === 'cef') {
    // CEF requires two-step extraction:
    //   1. Regex extract: parse pipe-delimited CEF header into standard fields
    //   2. KVP serde: parse extension key=value pairs
    // Raw CEF line format: [syslog_header] CEF:version|vendor|product|ver|id|name|severity|extensions...
    // CEF extraction: Use eval with JavaScript to parse the pipe-delimited header
    // and then serde kvp for the extension key=value pairs.
    // This avoids regex_extract conf format issues across Cribl versions.
    functions.push([
      '  - id: eval',
      '    filter: "true"',
      '    disabled: false',
      '    conf:',
      '      add:',
      "        - name: __cefParts",
      `          value: "(_raw || '').substring((_raw || '').indexOf('CEF:')).split('|')"`,
      "        - name: CEFVersion",
      "          value: \"(__cefParts && __cefParts.length > 0) ? __cefParts[0].replace('CEF:','') : undefined\"",
      "        - name: DeviceVendor",
      "          value: \"(__cefParts && __cefParts.length > 1) ? __cefParts[1] : undefined\"",
      "        - name: DeviceProduct",
      "          value: \"(__cefParts && __cefParts.length > 2) ? __cefParts[2] : undefined\"",
      "        - name: DeviceVersion",
      "          value: \"(__cefParts && __cefParts.length > 3) ? __cefParts[3] : undefined\"",
      "        - name: DeviceEventClassID",
      "          value: \"(__cefParts && __cefParts.length > 4) ? __cefParts[4] : undefined\"",
      "        - name: Activity",
      "          value: \"(__cefParts && __cefParts.length > 5) ? __cefParts[5] : undefined\"",
      "        - name: LogSeverity",
      "          value: \"(__cefParts && __cefParts.length > 6) ? __cefParts[6] : undefined\"",
      "        - name: __cefExtension",
      "          value: \"(__cefParts && __cefParts.length > 7) ? __cefParts.slice(7).join('|') : undefined\"",
      '      remove:',
      "        - __cefParts",
      '    description: Parse CEF header from _raw',
      '    groupId: extract',
    ].join('\n'));

    // Parse CEF extension key=value pairs
    functions.push([
      '  - id: serde',
      '    filter: "__cefExtension != undefined"',
      '    disabled: false',
      '    conf:',
      '      mode: extract',
      '      type: kvp',
      '      srcField: __cefExtension',
      '      delimChar: " "',
      '      pairDelim: "="',
      '    description: Parse CEF extension fields',
      '    groupId: extract',
    ].join('\n'));

    // Clean up temporary __cefExtension field
    functions.push([
      '  - id: eval',
      '    filter: "true"',
      '    disabled: false',
      '    conf:',
      '      add: []',
      '      remove:',
      "        - __cefExtension",
      '    description: Remove temporary parsing field',
      '    groupId: extract',
    ].join('\n'));
  } else if (sourceFormat === 'leef') {
    // LEEF: similar to CEF but with different delimiter
    functions.push([
      '  - id: serde',
      '    filter: "true"',
      '    disabled: false',
      '    conf:',
      '      mode: extract',
      '      type: kvp',
      '      srcField: _raw',
      '      delimChar: "\\t"',
      '      pairDelim: "="',
      '    description: Parse LEEF fields from _raw',
      '    groupId: extract',
    ].join('\n'));
  } else if (sourceFormat === 'csv') {
    // CSV: split on comma and assign positional field names.
    // For PAN-OS, use known column definitions per log type.
    // First strip syslog prefix, then split CSV.
    const isPanOS = solutionName.toLowerCase().includes('paloalto') || solutionName.toLowerCase().includes('pan_os') || solutionName.toLowerCase().includes('palo alto');

    // Step 1: Strip syslog prefix and split CSV
    functions.push([
      '  - id: eval',
      '    filter: "true"',
      '    disabled: false',
      '    conf:',
      '      add:',
      "        - name: __csvRaw",
      // Strip syslog prefix: find first digit-comma-4digit pattern (PAN-OS) or use as-is
      `          value: "(_raw || '').replace(/^.*?(\\\\d+,\\\\d{4}\\\\/)/, '$1')"`,
      "        - name: __csvParts",
      `          value: "(__csvRaw || '').split(',')"`,
      '      remove:',
      '        - __csvRaw',
      '    description: Strip syslog prefix and split CSV fields',
      '    groupId: extract',
    ].join('\n'));

    if (isPanOS) {
      // PAN-OS specific: assign named fields based on column position
      const trafficCols = [
        ['receive_time', 1], ['serial', 2], ['type', 3], ['subtype', 4],
        ['generated_time', 6], ['src', 7], ['dst', 8], ['natsrc', 9], ['natdst', 10],
        ['rule', 11], ['srcuser', 12], ['dstuser', 13], ['app', 14], ['vsys', 15],
        ['from', 16], ['to', 17], ['inbound_if', 18], ['outbound_if', 19],
        ['sessionid', 22], ['repeatcnt', 23], ['sport', 24], ['dport', 25],
        ['natsport', 26], ['natdport', 27], ['proto', 29], ['action', 30],
        ['bytes_sent', 32], ['bytes_received', 33], ['elapsed', 36], ['category', 37],
        ['device_name', 52],
      ] as const;

      const colAssignments = trafficCols.map(([name, idx]) =>
        `        - name: ${name}\n          value: "(__csvParts && __csvParts.length > ${idx}) ? __csvParts[${idx}] : undefined"`
      );

      functions.push([
        '  - id: eval',
        '    filter: "true"',
        '    disabled: false',
        '    conf:',
        '      add:',
        ...colAssignments,
        '      remove:',
        '        - __csvParts',
        '    description: Assign PAN-OS CSV columns to named fields',
        '    groupId: extract',
      ].join('\n'));
    } else {
      // Generic CSV: use serde which creates _0, _1, _2, etc.
      functions.push([
        '  - id: serde',
        '    filter: "true"',
        '    disabled: false',
        '    conf:',
        '      mode: extract',
        '      type: csv',
        '      srcField: _raw',
        '      delimChar: ","',
        '      hasHeaderRow: false',
        '    description: Parse CSV from _raw',
        '    groupId: extract',
      ].join('\n'));
    }
  } else {
    const serdeType = sourceFormat === 'kv' ? 'kvp' : 'json';
    const serdeDesc = serdeType === 'json' ? 'Parse JSON from _raw' :
                      'Parse key-value pairs from _raw';

    functions.push([
      '  - id: serde',
      '    filter: "true"',
      '    disabled: false',
      '    conf:',
      '      mode: extract',
      `      type: ${serdeType}`,
      '      srcField: _raw',
      ...(serdeType === 'csv' ? ['      delimChar: ","', '      quoteChar: "\\""', '      hasHeaderRow: false'] : []),
      ...(serdeType === 'kvp' ? ['      delimChar: " "', '      pairDelim: "="'] : []),
      `    description: ${serdeDesc}`,
      '    groupId: extract',
    ].join('\n'));
  }

  // Step 2 (extract group): Extract timestamp
  // CrowdStrike FDR events have "timestamp" as epoch milliseconds (string)
  // and "ContextTimeStamp" as epoch seconds with decimal.
  // These need direct eval conversion, not auto_timestamp (which can miss
  // timestamps deep in the event body).
  const isFdrTimestamp = timestampField === 'timestamp' &&
    solutionName.toLowerCase().includes('crowdstrike');

  if (isFdrTimestamp) {
    // Primary: eval-based timestamp extraction (position-independent)
    functions.push([
      '  - id: eval',
      '    filter: "true"',
      '    disabled: false',
      '    conf:',
      '      add:',
      '        - disabled: false',
      '          name: _time',
      '          value: "Number(timestamp) / 1000 || Number(ContextTimeStamp) || Date.now() / 1000"',
      '      remove: []',
      '    description: Extract _time from FDR timestamp with fallback to ContextTimeStamp',
      '    groupId: extract',
    ].join('\n'));

    // Backup: auto_timestamp catches anything the eval missed
    // (e.g., events where both timestamp and ContextTimeStamp are absent)
    // This also ensures Cribl Insights gets accurate _time values.
    functions.push([
      '  - id: auto_timestamp',
      '    filter: "!_time || _time <= 0"',
      '    disabled: false',
      '    conf:',
      '      srcField: _raw',
      '      dstField: _time',
      '      defaultTimezone: UTC',
      '      timeExpression: "time.getTime() / 1000"',
      '      offset: 0',
      '      maxLen: 15000',
      '      defaultTime: now',
      '      latestDateAllowed: +1week',
      '      earliestDateAllowed: -420weeks',
      '    description: Backup timestamp extraction when eval misses',
      '    groupId: extract',
    ].join('\n'));
  } else {
    functions.push([
      '  - id: auto_timestamp',
      '    filter: "true"',
      '    disabled: false',
      '    conf:',
      `      srcField: ${timestampField}`,
      '      dstField: _time',
      '      defaultTimezone: UTC',
      '      timeExpression: "time.getTime() / 1000"',
      '      offset: 0',
      '      maxLen: 150',
      '      defaultTime: now',
      '      latestDateAllowed: +1week',
      '      earliestDateAllowed: -420weeks',
      `    description: Extract _time from ${timestampField}`,
      '    groupId: extract',
    ].join('\n'));
  }

  // Step 2.5 (reduce group): Volume reduction -- keep/drop/suppress.
  // Runs BEFORE field rename so filters operate on raw vendor field names
  // (e.g., act, src, dpt for CEF; action, srcip, dstip for FortiGate).
  // Only present when reductionRules is provided.
  if (reductionRules) {
    // Keep: tag analytics-critical events
    if (reductionRules.keep.length > 0) {
      const keepConditions = reductionRules.keep.map((r) => `(${r.filter})`).join(' || ');
      functions.push([
        '  - id: eval',
        `    filter: "${escapeYamlFilter(keepConditions)}"`,
        '    disabled: false',
        '    conf:',
        '      add:',
        "        - name: __keep",
        "          value: \"true\"",
        '      remove: []',
        `    description: Tag analytics-critical events`,
        '    groupId: reduce',
      ].join('\n'));
    }

    // Drop: eliminate events with no analytics value
    for (const rule of reductionRules.drop) {
      functions.push([
        '  - id: drop',
        `    filter: "!__keep && (${escapeYamlFilter(rule.filter)})"`,
        '    disabled: false',
        '    conf: {}',
        `    description: DROP ${rule.description || 'low-value events'}`,
        '    groupId: reduce',
      ].join('\n'));
    }

    // Suppress: aggregate noisy events
    for (const rule of reductionRules.suppress) {
      functions.push([
        '  - id: suppress',
        `    filter: "!__keep && (${escapeYamlFilter(rule.filter)})"`,
        '    disabled: false',
        '    conf:',
        `      allow: ${rule.allow || 1}`,
        `      suppressPeriodSec: ${rule.windowSec || 300}`,
        `      keyExpr: "${escapeYamlFilter(rule.groupKey || 'SourceIP')}"`,
        '      dropEventsMode: true',
        `    description: SUPPRESS ${rule.description || 'noisy events'}`,
        '    groupId: reduce',
      ].join('\n'));
    }

    // Clean up __keep tag
    functions.push([
      '  - id: eval',
      '    filter: "__keep"',
      '    disabled: false',
      '    conf:',
      '      add: []',
      '      remove:',
      "        - __keep",
      '    description: Remove internal __keep tag before enrichment',
      '    groupId: reduce',
    ].join('\n'));
  }

  // Step 3 (enrich group): Rename source fields to destination names
  if (renameFields.length > 0) {
    let entries: string[];
    if (hasVendorMappings) {
      // Use vendor mappings: sourceName -> destName
      entries = (renameFields as VendorFieldMapping[]).map(
        (m) => `        - currentName: ${m.sourceName}\n          newName: ${m.destName}`
      );
    } else {
      entries = (renameFields as FieldMapping[]).map(
        (f) => `        - currentName: ${f.source}\n          newName: ${f.target}`
      );
    }
    functions.push([
      '  - id: rename',
      '    filter: "true"',
      '    disabled: false',
      `    description: Rename source fields to DCR schema`,
      '    groupId: enrich',
      '    conf:',
      '      rename:',
      ...entries,
    ].join('\n'));
  }

  // Step 3b (enrich group): Enrichment fields (derived from source data)
  if (hasVendorMappings) {
    const enrichFields = vendorMappings!.filter((m) => m.action === 'enrich');
    if (enrichFields.length > 0) {
      const enrichExprs = enrichFields.map((m) => {
        // Generate enrichment expressions based on the mapping description
        return `        - disabled: false\n          name: ${m.destName}\n          value: "'${m.description}'"`;
      });
      functions.push([
        '  - id: eval',
        '    filter: "true"',
        '    disabled: false',
        '    conf:',
        '      add:',
        ...enrichExprs,
        '      remove: []',
        `    description: Add enrichment fields`,
        '    groupId: enrich',
      ].join('\n'));
    }
  }

  // Step 4 (enrich group): Type coercion for fields where source type != dest type
  const coercionExprs: string[] = [];
  if (hasVendorMappings) {
    for (const m of coerceFields as VendorFieldMapping[]) {
      if (m.sourceType === m.destType) continue;
      const fieldName = m.destName; // Coerce after rename
      const expr = buildCoercionExpr(fieldName, m.sourceType, m.destType);
      if (expr) {
        coercionExprs.push(
          `        - name: ${fieldName}\n          value: "${expr}"`
        );
      }
    }
  } else {
    for (const f of coerceFields as FieldMapping[]) {
      const expr = buildCoercionExpr(f.target || f.source, 'string', f.type);
      if (expr) {
        coercionExprs.push(
          `        - name: ${f.target || f.source}\n          value: "${expr}"`
        );
      }
    }
  }

  // Step 4b: Value normalization (from ASIM/Chronicle pattern)
  // NOTE: Value normalization generates lookup expressions with curly braces
  // that some Cribl YAML parsers can't handle. Disabled for now -- will be
  // re-implemented as a separate Lookup function or C.Lookup() call.
  const valueNormExprs: string[] = [];

  // Build the enrich eval: combine Type classification + coercions + value normalizations
  const enrichAdd: string[] = [
    `        - disabled: false`,
    `          name: Type`,
    `          value: "'${tableName}'"`,
    ...coercionExprs,
    ...valueNormExprs,
  ];

  functions.push([
    '  - id: eval',
    '    filter: "true"',
    '    disabled: false',
    '    conf:',
    '      add:',
    ...enrichAdd,
    '      remove: []',
    `    description: Set Type and classify for ${tableName}`,
    '    groupId: enrich',
  ].join('\n'));

  // Step 5 (overflow group): Collect unmatched source fields into the overflow field.
  // Uses Cribl's native Serialize function with exclusion patterns (!field) + wildcard (*).
  // This says "serialize everything EXCEPT the schema fields" -- compact and native.
  const hasOverflow = overflowConfig?.enabled && overflowConfig.sourceFields.length > 0;

  if (hasOverflow) {
    const ofc = overflowConfig!;
    // Build exclusion list -- fields that should NOT be serialized into overflow.
    const excludeFields = new Set<string>();
    // Cribl envelope
    for (const f of ['_raw', '_time', 'source', 'sourcetype', 'host', 'index', 'cribl_breaker']) excludeFields.add(f);
    // Schema fields (renamed dest names + kept source names)
    for (const f of activeFields) {
      if (f.action !== 'drop') excludeFields.add(f.target || f.source);
      if (f.action === 'keep') excludeFields.add(f.source);
    }
    if (hasVendorMappings) {
      for (const m of vendorMappings!) {
        if (m.action === 'map') excludeFields.add(m.destName);
      }
    }
    // Standard pipeline fields + the overflow field itself
    for (const f of ['Type', 'TimeGenerated', ofc.fieldName]) excludeFields.add(f);

    // Always use JSON serialization for overflow -- produces a structured JSON object
    // that preserves field names and values. KV format loses structure with nested values.
    functions.push([
      '  - id: serialize',
      '    filter: "true"',
      '    disabled: false',
      '    conf:',
      '      type: json',
      `      dstField: ${ofc.fieldName}`,
      '      fields:',
      // Exclude Cribl internal fields (__ prefix), schema fields, then include everything else (*)
      '        - "!__*"',
      ...[...excludeFields].map((f) => `        - "!${f}"`),
      '        - "*"',
      `    description: Serialize unmapped fields into ${ofc.fieldName} as JSON`,
      '    groupId: overflow',
    ].join('\n'));
  }

  // Step 6 (cleanup group): Remove Cribl internal fields and transport metadata.
  // Only list Cribl metadata here -- overflow fields are already removed by the
  // overflow eval batches above (no need to list 170+ fields again).
  const vendorDropFields = hasVendorMappings
    ? vendorMappings!.filter((m) => m.action === 'drop').map((m) => m.sourceName)
    : [];
  const dropEntries = [
    '_raw',
    '_time',
    'cribl_*',
    '__header*',
    '__inputId',
    '__criblMetrics',
    '__final',
    '__channel',
    '__dest*',
    '__span*',
    'source',
    'host',
    'port',
    'index',
    'cribl_breaker',
    'sourcetype',
    ...vendorDropFields,
  ];

  functions.push([
    '  - id: eval',
    '    filter: "true"',
    '    disabled: false',
    '    conf:',
    '      add: []',
    '      remove:',
    ...dropEntries.map((f) => `        - ${f}`),
    '    description: Remove internal fields',
    '    groupId: cleanup',
  ].join('\n'));

  const mapCount = hasVendorMappings ? vendorMappings!.filter((m) => m.action === 'map').length : 0;
  const srcFmt = sourceFormat || 'json';

  return [
    'output: default',
    'streamtags: []',
    'groups:',
    '  extract:',
    '    name: Field Extraction',
    '    disabled: false',
    ...(reductionRules ? [
    '  reduce:',
    '    name: Volume Reduction',
    '    disabled: false',
    ] : []),
    '  enrich:',
    '    name: Enrich & Classify',
    '    disabled: false',
    ...(hasOverflow ? [
    '  overflow:',
    '    name: Overflow Collection',
    '    disabled: false',
    ] : []),
    '  cleanup:',
    '    name: Sentinel Cleanup',
    '    disabled: false',
    'asyncFuncTimeout: 1000',
    'functions:',
    ...functions,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Reduction Pipeline Generation
// ---------------------------------------------------------------------------

// Generate a Reduction pipeline conf.yml that drops, suppresses, or aggregates
// events based on the reduction knowledge base. This pipeline runs BEFORE
// the transformation pipelines to minimize data before schema mapping.
function generateReductionPipelineConf(
  solutionName: string,
  tableName: string,
  rules: TableReductionRules,
  sourceFormat?: string,
): string {
  const functions: string[] = [];

  // Phase 1 (triage group): Parse raw event so filters can inspect fields
  const serdeType = sourceFormat === 'csv' ? 'csv' :
                    sourceFormat === 'kv' || sourceFormat === 'cef' || sourceFormat === 'leef' ? 'kvp' : 'json';
  functions.push([
    '  - id: serde',
    '    filter: "true"',
    '    disabled: false',
    '    conf:',
    '      mode: extract',
    `      type: ${serdeType}`,
    '      srcField: _raw',
    ...(serdeType === 'kvp' ? ['      delimChar: " "', '      pairDelim: "="'] : []),
    `    description: Parse ${sourceFormat || 'JSON'} from _raw so reduction filters can inspect fields.`,
    '    groupId: triage',
  ].join('\n'));

  // Reduction filters now use raw vendor field names directly (act, src, dpt for CEF;
  // action, srcip, dstip for FortiGate; etc.) so no rename step is needed here.

  // Phase 2 (keep group): Tag events that MUST be kept (analytics-critical)
  // We set __keep=true on these; later drop logic skips tagged events.
  if (rules.keep.length > 0) {
    const keepConditions = rules.keep.map((r) => `(${r.filter})`).join(' || ');
    functions.push([
      '  - id: eval',
      `    filter: "${escapeYamlFilter(keepConditions)}"`,
      '    disabled: false',
      '    conf:',
      '      add:',
      "        - name: __keep",
      "          value: \"true\"",
      '      remove: []',
      `    description: Tag analytics-critical events`,
      '    groupId: keep',
    ].join('\n'));
  }

  // Phase 3 (drop group): Drop entire events that are safe to eliminate
  for (const rule of rules.drop) {
    functions.push([
      '  - id: drop',
      `    filter: "!__keep && (${escapeYamlFilter(rule.filter)})"`,
      '    disabled: false',
      '    conf: {}',
      `    description: DROP ${rule.description || 'low-value events'}`,
      '    groupId: drop',
    ].join('\n'));
  }

  // Phase 4 (suppress group): Suppress/aggregate noisy events
  // Uses Cribl's Suppress function to deduplicate events within a time window.
  for (const rule of rules.suppress) {
    functions.push([
      '  - id: suppress',
      `    filter: "!__keep && (${escapeYamlFilter(rule.filter)})"`,
      '    disabled: false',
      '    conf:',
      `      allow: ${rule.maxEvents ?? 1}`,
      `      suppressPeriodSec: ${rule.windowSec}`,
      `      keyExpr: "${escapeYamlFilter(rule.groupKey)}"`,
      '      dropEventsMode: true',
      `    description: SUPPRESS ${rule.description || 'noisy events'}`,
      '    groupId: suppress',
    ].join('\n'));
  }

  // Phase 5 (finalize group): Clean up the __keep tag before passing to transformation pipeline
  functions.push([
    '  - id: eval',
    '    filter: "__keep"',
    '    disabled: false',
    '    conf:',
    '      add: []',
    '      remove:',
    "        - __keep",
    '    description: Remove internal __keep tag before passing events downstream.',
    '    groupId: finalize',
  ].join('\n'));

  // Build the full pipeline YAML
  const dropCount = rules.drop.length;
  const suppressCount = rules.suppress.length;
  const keepCount = rules.keep.length;

  return [
    `# Reduction Pipeline: ${solutionName} - ${tableName}`,
    '#',
    '# Reduces ingestion volume by eliminating or suppressing events that are',
    '# not required by any built-in Sentinel analytics rule.',
    '#',
    `# ${keepCount} keep rules protect analytics-critical events`,
    `# ${dropCount} drop rules eliminate entire events`,
    `# ${suppressCount} suppress rules aggregate noisy events`,
    '#',
    '# IMPORTANT: Disable individual rules by setting disabled: true on the',
    '# specific function. Never disable the entire pipeline without understanding',
    '# the cost impact -- this pipeline can reduce ingestion by 40-80%.',
    '#',
    '# Generated by Cribl SOC Optimization Toolkit',
    '',
    'output: default',
    'streamtags: []',
    'groups:',
    '  triage:',
    '    name: Event Triage',
    '    description: Parse events so reduction filters can inspect field values',
    '    disabled: false',
    '  keep:',
    '    name: Analytics Protection',
    '    description: Tag events required by Sentinel analytics rules (never dropped)',
    '    disabled: false',
    '  drop:',
    '    name: Event Elimination',
    '    description: Drop entire events with no analytics value',
    '    disabled: false',
    '  suppress:',
    '    name: Event Suppression',
    '    description: Aggregate noisy events by key fields within time windows',
    '    disabled: false',
    '  finalize:',
    '    name: Finalize',
    '    description: Clean up internal tags before downstream processing',
    '    disabled: false',
    'asyncFuncTimeout: 1000',
    'functions:',
    ...functions,
    '',
  ].join('\n');
}

// Escape double quotes in filter expressions for YAML string embedding
function escapeYamlFilter(expr: string | undefined | null): string {
  if (!expr) return 'true';
  return expr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Generate a no-op reduction pipeline when no rules match the table/vendor
function generateFallbackReductionConf(solutionName: string, tableName: string, sourceFormat?: string): string {
  const serdeType = sourceFormat === 'csv' ? 'csv' :
                    sourceFormat === 'kv' || sourceFormat === 'cef' || sourceFormat === 'leef' ? 'kvp' : 'json';
  return [
    `# Reduction Pipeline: ${solutionName} - ${tableName}`,
    '#',
    '# No pre-built reduction rules found for this table/vendor.',
    '# Add custom drop/suppress functions below to reduce ingestion volume.',
    '#',
    '# Recommended approach:',
    '#   1. Analyze which events your Sentinel analytics rules actually query',
    '#   2. Add drop functions for event types not referenced by any rule',
    '#   3. Add suppress functions for noisy events that can be sampled',
    '#',
    '# Generated by Cribl SOC Optimization Toolkit',
    '',
    'output: default',
    'streamtags: []',
    'groups:',
    '  triage:',
    '    name: Event Triage',
    '    disabled: false',
    '  drop:',
    '    name: Event Elimination',
    '    disabled: false',
    '  suppress:',
    '    name: Event Suppression',
    '    disabled: false',
    'asyncFuncTimeout: 1000',
    'functions:',
    '  - id: serde',
    '    filter: "true"',
    '    disabled: false',
    '    conf:',
    '      mode: extract',
    `      type: ${serdeType}`,
    '      srcField: _raw',
    ...(serdeType === 'kvp' ? ['      delimChar: " "', '      pairDelim: "="'] : []),
    `    description: Parse ${sourceFormat || 'JSON'} from _raw so reduction filters can inspect fields.`,
    '    groupId: triage',
    '  - id: comment',
    '    filter: "true"',
    '    disabled: true',
    '    conf:',
    '      comment: >',
    '        No built-in reduction rules for this table. Add custom drop and',
    '        suppress functions here based on your Sentinel analytics rules.',
    '    groupId: drop',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Sample Data Generation
// ---------------------------------------------------------------------------

// Generate a realistic value for a field based on its name and type.
// Uses heuristics on the field name to produce contextually appropriate data.
function generateFieldValue(name: string, type: string): unknown {
  const lower = name.toLowerCase();
  const t = type.toLowerCase();

  // Datetime fields
  if (t === 'datetime' || lower.includes('time') || lower.includes('date') || lower === 'timestamp') {
    const base = new Date('2025-06-15T14:30:00Z');
    const offset = Math.floor(Math.random() * 3600000);
    return new Date(base.getTime() + offset).toISOString();
  }

  // Boolean fields
  if (t === 'boolean' || t === 'bool') {
    return Math.random() > 0.5;
  }

  // Numeric fields - use name heuristics for realistic ranges
  if (t === 'int' || t === 'long' || t === 'real') {
    if (lower.includes('port')) return 1024 + Math.floor(Math.random() * 64000);
    if (lower.includes('pid') || lower.includes('processid')) return 1000 + Math.floor(Math.random() * 50000);
    if (lower.includes('severity') || lower.includes('level')) return Math.floor(Math.random() * 8);
    if (lower.includes('size') || lower.includes('bytes') || lower.includes('length')) return Math.floor(Math.random() * 100000);
    if (lower.includes('count') || lower.includes('total')) return Math.floor(Math.random() * 500);
    if (lower.includes('duration') || lower.includes('elapsed')) return Math.floor(Math.random() * 30000);
    if (lower.includes('code') || lower.includes('status')) return [200, 201, 301, 400, 403, 404, 500][Math.floor(Math.random() * 7)];
    if (lower.includes('id') && !lower.includes('guid')) return Math.floor(Math.random() * 100000);
    if (t === 'real') return Math.round(Math.random() * 100 * 100) / 100;
    return Math.floor(Math.random() * 10000);
  }

  // Dynamic/object fields
  if (t === 'dynamic' || t === 'object') {
    if (lower.includes('event') && lower.includes('data')) {
      return { param1: 'value1', param2: 42 };
    }
    return {};
  }

  // String fields - extensive name-based heuristics
  if ((lower.includes('ip') || lower.includes('address')) && !lower.includes('mac') && !lower.includes('email') && !lower.includes('descript')) {
    const octets = [10, Math.floor(Math.random() * 255), Math.floor(Math.random() * 255), 1 + Math.floor(Math.random() * 254)];
    if (lower.includes('dest') || lower.includes('dst') || lower.includes('target') || lower.includes('remote')) {
      octets[0] = [172, 192, 10][Math.floor(Math.random() * 3)];
    }
    if (lower.includes('source') || lower.includes('src') || lower.includes('client') || lower.includes('local')) {
      octets[0] = 10;
    }
    if (lower.includes('public') || lower.includes('external')) {
      octets[0] = [52, 104, 20, 40][Math.floor(Math.random() * 4)];
    }
    return octets.join('.');
  }

  if (lower.includes('mac')) {
    return Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
  }

  if (lower.includes('host') || lower.includes('computer') || lower.includes('machine') || lower.includes('node')) {
    const prefixes = ['srv', 'web', 'app', 'db', 'dc', 'fw', 'proxy', 'mail'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    return `${prefix}-${String(Math.floor(Math.random() * 99) + 1).padStart(2, '0')}.contoso.com`;
  }

  if (lower.includes('user') || lower.includes('account') || lower.includes('identity')) {
    const users = ['admin', 'jsmith', 'svc-monitor', 'SYSTEM', 'jane.doe', 'backup-svc', 'apiuser01'];
    return users[Math.floor(Math.random() * users.length)];
  }

  if (lower.includes('domain') || lower.includes('dns')) {
    const domains = ['contoso.com', 'fabrikam.net', 'tailspintoys.org', 'internal.corp'];
    return domains[Math.floor(Math.random() * domains.length)];
  }

  if (lower.includes('url') || lower.includes('uri') || lower.includes('href')) {
    const paths = ['/api/v2/status', '/login', '/health', '/data/query', '/admin/settings'];
    return `https://app.contoso.com${paths[Math.floor(Math.random() * paths.length)]}`;
  }

  if (lower.includes('path') || lower.includes('file')) {
    if (lower.includes('file') && !lower.includes('path')) {
      return ['audit.log', 'system.evtx', 'access.log', 'error.log', 'sysmon.xml'][Math.floor(Math.random() * 5)];
    }
    return ['C:\\Windows\\System32\\svchost.exe', '/var/log/syslog', 'C:\\Program Files\\app\\service.exe',
      '/usr/bin/python3', '/etc/config.yaml'][Math.floor(Math.random() * 5)];
  }

  if (lower.includes('process') || lower.includes('program') || lower.includes('application')) {
    return ['svchost.exe', 'python3', 'java', 'nginx', 'powershell.exe', 'cmd.exe', 'sshd'][Math.floor(Math.random() * 7)];
  }

  if (lower.includes('protocol')) {
    return ['TCP', 'UDP', 'HTTPS', 'DNS', 'ICMP', 'SSH', 'TLS'][Math.floor(Math.random() * 7)];
  }

  if (lower.includes('action') || lower.includes('operation') || lower.includes('activity')) {
    return ['Allow', 'Deny', 'Create', 'Delete', 'Modify', 'Read', 'Execute', 'Login'][Math.floor(Math.random() * 8)];
  }

  if (lower.includes('severity') || lower.includes('priority') || lower.includes('level')) {
    return ['Informational', 'Low', 'Medium', 'High', 'Critical'][Math.floor(Math.random() * 5)];
  }

  if (lower.includes('category') || lower.includes('type') || lower.includes('class')) {
    return ['Security', 'Audit', 'Network', 'Application', 'System', 'Authentication'][Math.floor(Math.random() * 6)];
  }

  if (lower.includes('facility')) {
    return ['auth', 'authpriv', 'local0', 'kern', 'daemon', 'syslog', 'user'][Math.floor(Math.random() * 7)];
  }

  if (lower.includes('message') || lower.includes('description') || lower.includes('detail') || lower === 'syslogmessage') {
    const msgs = [
      'User authentication successful for admin from 10.1.2.3',
      'Connection established to remote host 172.16.0.10:443',
      'Firewall rule applied: Allow TCP from 10.0.0.0/8 to any:443',
      'Process svchost.exe (PID 4528) started by SYSTEM',
      'File access audit: C:\\Sensitive\\data.xlsx read by jsmith',
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  if (lower.includes('guid') || lower.includes('uuid') || lower.includes('correlationid') || lower.includes('requestid')) {
    return [
      crypto.randomBytes(4).toString('hex'),
      crypto.randomBytes(2).toString('hex'),
      crypto.randomBytes(2).toString('hex'),
      crypto.randomBytes(2).toString('hex'),
      crypto.randomBytes(6).toString('hex'),
    ].join('-');
  }

  if (lower.includes('hash') || lower.includes('checksum')) {
    return crypto.randomBytes(16).toString('hex');
  }

  if (lower.includes('vendor') || lower.includes('product')) {
    return lower.includes('vendor')
      ? ['Microsoft', 'Palo Alto', 'CrowdStrike', 'Fortinet', 'Cisco'][Math.floor(Math.random() * 5)]
      : ['Defender', 'Cortex', 'Falcon', 'FortiGate', 'ASA'][Math.floor(Math.random() * 5)];
  }

  if (lower.includes('version')) {
    return `${1 + Math.floor(Math.random() * 5)}.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 100)}`;
  }

  if (lower.includes('country') || lower.includes('region') || lower.includes('location')) {
    return ['US', 'GB', 'DE', 'JP', 'AU', 'CA', 'FR'][Math.floor(Math.random() * 7)];
  }

  // Generic string fallback
  return `sample_${name}_value`;
}

// Generate a raw vendor log event (what Cribl would receive before pipeline processing).
// Uses source fields (from the connector schema) with realistic values.
function generateRawVendorEvent(
  sourceFields: FieldMapping[],
  vendorSampleRaw: string | null,
): Record<string, unknown> {
  // If we have an actual vendor sample, use it as the base
  if (vendorSampleRaw) {
    try {
      return JSON.parse(vendorSampleRaw);
    } catch (err) {
      logger.warn('pack-builder', 'Failed to parse vendor sample as JSON, generating synthetic event', err);
    }
  }

  const event: Record<string, unknown> = {};
  // Use source field names to generate the raw vendor event
  const sourceNames = new Set<string>();
  for (const field of sourceFields) {
    const name = field.source || field.target;
    if (!name || sourceNames.has(name)) continue;
    sourceNames.add(name);
    event[name] = generateFieldValue(name, field.type);
  }

  // Ensure timestamp exists
  if (!event['TimeGenerated'] && !event['timestamp'] && !event['time'] && !event['EventTime']) {
    event['TimeGenerated'] = new Date('2025-06-15T14:32:17Z').toISOString();
  }

  return event;
}

// Generate Cribl-format sample data for a table.
// Each sample event wraps a raw vendor log in the Cribl event envelope.
// When real uploaded samples exist, ALL events are included (not limited to eventCount).
// Each JSON array element becomes a separate event with its own _raw field.
function generateSampleFile(
  solutionName: string,
  tableName: string,
  sourceFields: FieldMapping[],
  vendorSamples: VendorSample[],
  eventCount: number,
  logType?: string,
): { events: unknown[]; rawCount: number } {
  const events: unknown[] = [];

  // Find vendor samples for this table -- match by table name or source (which includes logType)
  const tableSamples = vendorSamples.filter((s) => {
    const tbl = s.tableName.toLowerCase();
    const tblTarget = tableName.toLowerCase().replace(/_cl$/i, '');
    if (tbl === tableName.toLowerCase()) return true;
    if (tbl.includes(tblTarget)) return true;
    // Also match by source if it contains the log type
    if (logType && s.source && s.source.toLowerCase().includes(logType.toLowerCase())) return true;
    return false;
  });

  // Collect all real raw events from uploaded samples
  const allRawEvents: string[] = [];
  for (const sample of tableSamples) {
    for (const rawStr of sample.rawEvents) {
      // Event-break JSON arrays: if the raw event string is a JSON array,
      // extract each element as a separate event
      const trimmed = rawStr.trim();
      if (trimmed.startsWith('[')) {
        try {
          const arr = JSON.parse(trimmed);
          if (Array.isArray(arr)) {
            for (const item of arr) {
              allRawEvents.push(typeof item === 'string' ? item : JSON.stringify(item));
            }
            continue;
          }
        } catch (err) { logger.warn('pack-builder', 'Raw event starts with [ but is not a valid JSON array, using as-is', err); }
      }
      allRawEvents.push(rawStr);
    }
  }

  if (allRawEvents.length > 0) {
    // Use ALL real uploaded events -- only _raw + Cribl envelope fields.
    // The pipeline's serde function extracts top-level fields from _raw,
    // so sample data should mirror what the Cribl source actually delivers.
    const baseTime = new Date('2025-06-15T14:30:00Z').getTime() / 1000;
    for (let i = 0; i < allRawEvents.length; i++) {
      let rawValue = allRawEvents[i];

      // If rawEvent is a JSON-parsed CEF object (from tagSample roundtrip),
      // reconstruct the raw CEF line so the pipeline's CEF parser can process it.
      // Format: CEF:version|vendor|product|version|id|name|severity|key=val key=val...
      if (rawValue.startsWith('{')) {
        try {
          const evt = JSON.parse(rawValue);
          if (evt.CEFVersion !== undefined && evt.DeviceVendor) {
            const header = [
              `CEF:${evt.CEFVersion || '0'}`,
              evt.DeviceVendor || '',
              evt.DeviceProduct || '',
              evt.DeviceVersion || '',
              evt.DeviceEventClassID || '',
              evt.Name || evt.Activity || '',
              evt.Severity || evt.LogSeverity || '',
            ].join('|');
            // Build extension key=value pairs from remaining fields
            const skipFields = new Set([
              'CEFVersion', 'DeviceVendor', 'DeviceProduct', 'DeviceVersion',
              'DeviceEventClassID', 'Name', 'Activity', 'Severity', 'LogSeverity',
              '_syslogHeader',  // Syslog header not needed in reconstructed CEF
            ]);
            const extParts: string[] = [];
            for (const [k, v] of Object.entries(evt)) {
              if (skipFields.has(k) || v === undefined || v === null || v === '') continue;
              extParts.push(`${k}=${String(v)}`);
            }
            rawValue = header + '|' + extParts.join(' ');
          }
        } catch (err) { logger.warn('pack-builder', 'Failed to parse raw event as JSON for CEF reconstruction, using as-is', err); }
      }

      events.push({
        _time: baseTime + i * 60,
        _raw: rawValue,
        source: `${solutionName}:${logType || tableName}`,
        sourcetype: `${solutionName}:${logType || tableName}`,
        host: 'cribl-worker-01.contoso.com',
        index: tableName,
      });
    }
  } else {
    // No real samples -- generate synthetic events
    for (let i = 0; i < eventCount; i++) {
      const rawEvent = generateRawVendorEvent(sourceFields, null);
      events.push({
        _time: new Date('2025-06-15T14:30:00Z').getTime() / 1000 + i * 60,
        _raw: JSON.stringify(rawEvent),
        source: `${solutionName}:${logType || tableName}`,
        sourcetype: `${solutionName}:${logType || tableName}`,
        host: 'cribl-worker-01.contoso.com',
        index: tableName,
      });
    }
  }

  return { events, rawCount: events.length };
}

// Generate a Cribl samples.yml registry entry
// Run DCR gap analysis as a standalone function to avoid deep nesting issues.
// Compares source data fields vs DCR input expectations per table.
async function runDcrGapAnalysis(
  solutionName: string,
  tables: PackScaffoldOptions['tables'],
  vendorSamples: VendorSample[],
  tableRouting: import('./kql-parser').TableRoutingInfo[],
  packDir: string,
): Promise<Map<string, import('./kql-parser').DcrGapAnalysis>> {
  const result = new Map<string, import('./kql-parser').DcrGapAnalysis>();
  if (tableRouting.length === 0) return result;

  try {
    if (!sentinelRepo.isRepoReady()) return result;

    const solutions = sentinelRepo.listSolutions();
    const lower = solutionName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const solMatch = solutions.find((s) => {
      const k = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return k === lower || k.includes(lower) || lower.includes(k);
    });
    if (!solMatch) return result;

    const connectors = sentinelRepo.listConnectorFiles(solMatch.name);
    const dcrFiles = connectors.filter((f) => f.name.toLowerCase().includes('dcr') && f.name.toLowerCase().endsWith('.json'));

    for (const dcrFile of dcrFiles) {
      const content = sentinelRepo.readRepoFile(dcrFile.path);
      if (!content) continue;

      let parsed: ReturnType<typeof kqlParser.parseDcrJson> | null = null;
      try {
        parsed = kqlParser.parseDcrJson(content);
      } catch (parseErr) {
        logger.warn('pack-builder', `Failed to parse DCR JSON from ${dcrFile.name}`, parseErr);
        continue;
      }
      if (!parsed) continue;

      for (const flow of parsed.flows) {
        const tableEntry = tables.find((t) =>
          t.sentinelTable.toLowerCase() === flow.tableName.toLowerCase()
        );
        if (!tableEntry) continue;

        // Collect source fields from table.fields or samples
        let sourceFields: Array<{ name: string; type: string }> = [];
        if (tableEntry.fields.length > 0) {
          sourceFields = tableEntry.fields.map((f) => ({ name: f.source || f.target, type: f.type }));
        } else {
          // Extract fields from vendor samples
          const matchingSamples = vendorSamples.filter((s) =>
            s.source.toLowerCase().includes((tableEntry.logType || '').toLowerCase())
          );
          const fieldMap = new Map<string, string>();
          for (const sample of matchingSamples) {
            for (const raw of sample.rawEvents.slice(0, 5)) {
              try {
                const evt = JSON.parse(raw);
                for (const [k, v] of Object.entries(evt)) {
                  if (!fieldMap.has(k)) {
                    const t = typeof v === 'number' ? (Number.isInteger(v) ? 'long' : 'real') :
                      typeof v === 'boolean' ? 'boolean' :
                      typeof v === 'object' ? 'dynamic' : 'string';
                    fieldMap.set(k, t);
                  }
                }
              } catch (jsonErr) { logger.warn('pack-builder', 'Failed to parse sample event JSON during gap analysis field extraction', jsonErr); }
            }
          }
          sourceFields = Array.from(fieldMap.entries()).map(([name, type]) => ({ name, type }));
        }

        const destSchema = loadDcrTemplateSchemaPublic(flow.tableName);
        if (sourceFields.length > 0 && destSchema.length > 0) {
          const gap = kqlParser.analyzeDcrGap(sourceFields, destSchema, flow);
          result.set(flow.tableName, gap);

          // Write gap analysis report
          const lines: string[] = [];
          lines.push('# DCR Gap Analysis: ' + flow.tableName);
          lines.push('# Source fields: ' + gap.totalSourceFields);
          lines.push('# Destination columns: ' + gap.totalDestFields);
          lines.push('# Passthrough (no Cribl action): ' + gap.passthroughCount);
          lines.push('# DCR handles (renames/coercions): ' + gap.dcrHandledCount);
          lines.push('# Cribl must handle: ' + gap.criblHandledCount);
          lines.push('# Overflow (not in dest schema): ' + gap.overflowCount);
          lines.push('#');
          lines.push('# === DCR Handles (DO NOT duplicate) ===');
          lines.push('# Renames: ' + gap.dcrHandles.renames.length);
          for (const r of gap.dcrHandles.renames) lines.push('#   ' + r.source + ' -> ' + r.dest);
          lines.push('# Coercions: ' + gap.dcrHandles.coercions.length);
          for (const c of gap.dcrHandles.coercions) lines.push('#   ' + c.field + ' -> ' + c.toType);
          lines.push('#');
          lines.push('# === Cribl Must Handle ===');
          lines.push('# Renames: ' + gap.criblMustHandle.renames.length);
          for (const r of gap.criblMustHandle.renames) lines.push('#   ' + r.source + ' -> ' + r.dest);
          lines.push('# Coercions: ' + gap.criblMustHandle.coercions.length);
          for (const c of gap.criblMustHandle.coercions) lines.push('#   ' + c.field + ': ' + c.fromType + ' -> ' + c.toType);
          lines.push('# Overflow: ' + gap.criblMustHandle.overflow.length);
          for (const o of gap.criblMustHandle.overflow.slice(0, 20)) lines.push('#   ' + o.field + ' (' + o.type + ')');
          lines.push('# Enrichments: ' + gap.criblMustHandle.enrichments.length);
          for (const en of gap.criblMustHandle.enrichments) lines.push('#   ' + en.field + ' = ' + en.value);
          fs.writeFileSync(path.join(packDir, 'DCR_GAP_ANALYSIS_' + flow.tableName + '.txt'), lines.join('\n'));
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message + '\n' + err.stack : String(err);
    fs.writeFileSync(path.join(packDir, 'GAP_ANALYSIS_ERROR.txt'), msg);
  }

  return result;
}

function generateSampleId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Collect all files in a directory recursively, returning paths relative to the dir.
interface TarEntry { abs: string; rel: string; isDir: boolean }

function collectFiles(dir: string, base?: string): TarEntry[] {
  base = base ?? dir;
  const results: TarEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      results.push({ abs, rel, isDir: true });
      results.push(...collectFiles(abs, base));
    } else {
      results.push({ abs, rel, isDir: false });
    }
  }
  return results;
}

// Build a POSIX tar header block (512 bytes).
function tarHeader(relPath: string, size: number, isDir: boolean = false): Buffer {
  const header = Buffer.alloc(512, 0);
  // name (100 bytes) -- directories need trailing /
  const name = isDir ? (relPath.endsWith('/') ? relPath : relPath + '/') : relPath;
  header.write(name.substring(0, 99), 0, 'utf-8');
  // mode (8 bytes)
  header.write(isDir ? '0000755\0' : '0000644\0', 100, 'utf-8');
  // uid (8 bytes)
  header.write('0000000\0', 108, 'utf-8');
  // gid (8 bytes)
  header.write('0000000\0', 116, 'utf-8');
  // size (12 bytes) - octal
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf-8');
  // mtime (12 bytes)
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 'utf-8');
  // typeflag: '0' for regular file, '5' for directory
  header.write(isDir ? '5' : '0', 156, 'utf-8');
  // magic
  header.write('ustar\0', 257, 'utf-8');
  // version
  header.write('00', 263, 'utf-8');

  // Compute checksum: sum of all bytes with checksum field treated as spaces
  header.write('        ', 148, 'utf-8'); // 8 spaces for checksum field
  let chk = 0;
  for (let i = 0; i < 512; i++) chk += header[i];
  header.write(chk.toString(8).padStart(6, '0') + '\0 ', 148, 'utf-8');

  return header;
}

// Package a pack directory into a .crbl file (tar.gz) using pure Node.js.
// Returns the path to the created .crbl file.
// Fallback Node.js tar builder (used when system tar.exe is unavailable)
function buildNodeTar(packFiles: TarEntry[], crblPath: string): void {
  const chunks: Buffer[] = [];
  for (const file of packFiles) {
    if (file.isDir) {
      chunks.push(tarHeader(file.rel, 0, true));
    } else {
      const content = fs.readFileSync(file.abs);
      chunks.push(tarHeader(file.rel, content.length, false));
      chunks.push(content);
      const remainder = content.length % 512;
      if (remainder > 0) chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  const tarData = Buffer.concat(chunks);
  const gzipped = zlib.gzipSync(tarData, { level: 9 });
  fs.writeFileSync(crblPath, gzipped);
}

function packagePack(packDir: string, sender: Electron.WebContents): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString('hex');

    if (!sender.isDestroyed()) {
      sender.send('ps:output', { id, stream: 'stdout', data: `Packaging .crbl from ${packDir}\n` });
    }

    try {
      // Read package.json to get name and version for the .crbl filename
      const pkgPath = path.join(packDir, 'package.json');
      let crblName = path.basename(packDir);
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (pkg.name && pkg.version) {
            crblName = `${pkg.name}_${pkg.version}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
          }
        } catch (err) { logger.warn('pack-builder', `Failed to parse package.json at ${pkgPath}, using directory name`, err); }
      }

      const crblPath = path.join(path.dirname(packDir), `${crblName}.crbl`);
      const files = collectFiles(packDir);
      // Sort: directories first, then files alphabetically, package.json LAST
      // (matches Cribl's expected .crbl structure)
      files.sort((a, b) => {
        // Directories before files at the same level
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        // package.json goes last (Cribl convention)
        if (a.rel === 'package.json') return 1;
        if (b.rel === 'package.json') return -1;
        // Alphabetical
        return a.rel.localeCompare(b.rel);
      });

      // Exclude non-pack files (mapping reports, vendor research)
      const packFiles = files.filter((f) =>
        !f.rel.startsWith('FIELD_MAPPING_') && !f.rel.startsWith('VENDOR_RESEARCH')
      );

      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stdout', data: `Found ${packFiles.length} entries to package\n` });
      }

      // Use system tar.exe on Windows (produces .crbl that Cribl accepts)
      // Fall back to Node.js tar builder on other platforms
      const sysTar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
      const hasSysTar = process.platform === 'win32' ? fs.existsSync(sysTar) : true;

      if (hasSysTar) {
        // Use system tar -- produces correct format for Cribl
        const { execFileSync } = require('child_process');
        try {
          execFileSync(sysTar, [
            '-czf', crblPath,
            '--exclude=FIELD_MAPPING_*',
            '--exclude=VENDOR_RESEARCH*',
            '--exclude=inputs.yml',
            '*',
          ], { cwd: packDir, windowsHide: true, timeout: 30000 });
        } catch (tarErr) {
          // Fall back to Node.js tar if system tar fails
          if (!sender.isDestroyed()) {
            sender.send('ps:output', { id, stream: 'stderr', data: `System tar failed, using built-in: ${tarErr}\n` });
          }
          buildNodeTar(packFiles, crblPath);
        }
      } else {
        buildNodeTar(packFiles, crblPath);
      }

      const sizeKB = (fs.statSync(crblPath).size / 1024).toFixed(1);
      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stdout', data: `Created ${path.basename(crblPath)} (${sizeKB} KB)\n` });
        sender.send('ps:exit', { id, code: 0 });
      }

      resolve(crblPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stderr', data: `Packaging error: ${msg}\n` });
        sender.send('ps:exit', { id, code: -1 });
      }
      reject(err);
    }
  });
}

export function registerPackBuilderHandlers(ipcMain: IpcMain) {
  // Load DCR schema for a given table name from repo templates
  ipcMain.handle('pack:dcr-schema', async (_event, { tableName }: { tableName: string }) => {
    const columns = loadDcrTemplateSchema(tableName);
    return columns.filter((c) => !SYSTEM_COLUMNS.has(c.name));
  });

  // List all available DCR template table names from the repo
  ipcMain.handle('pack:available-tables', async () => {
    const tables = new Set<string>();
    // Check app data bundled templates
    const dceDir = path.join(appDcrTemplatesDir(), 'DataCollectionRules(DCE)');
    if (fs.existsSync(dceDir)) {
      for (const file of fs.readdirSync(dceDir).filter((f) => f.endsWith('.json'))) {
        tables.add(file.replace('.json', ''));
      }
    }
    // Also check linked repo if templates haven't been bundled yet
    const repoDir = getRepoPath('Azure', 'CustomDeploymentTemplates', 'DCR-Templates', 'SentinelNativeTables', 'DataCollectionRules(DCE)');
    if (repoDir && fs.existsSync(repoDir)) {
      for (const file of fs.readdirSync(repoDir).filter((f) => f.endsWith('.json'))) {
        tables.add(file.replace('.json', ''));
      }
    }
    return Array.from(tables).sort();
  });

  ipcMain.handle('pack:scaffold', async (event, options: PackScaffoldOptions) => {
    try { return await scaffoldPack(options); } catch (err) {
      console.error('pack:scaffold error:', err);
      throw err;
    }
  });

  async function scaffoldPack(options: PackScaffoldOptions) {
    const packsDir = getPacksDir();
    const packDir = path.join(packsDir, options.packName);

    // Remove existing pack to allow rebuilds
    if (fs.existsSync(packDir)) {
      fs.rmSync(packDir, { recursive: true, force: true });
    }
    // Also remove old .crbl file
    const oldCrbl = path.join(packsDir, `${options.packName}_${options.version || '1.0.0'}.crbl`);
    if (fs.existsSync(oldCrbl)) {
      fs.rmSync(oldCrbl, { force: true });
    }

    // Create pack directory structure
    fs.mkdirSync(path.join(packDir, 'default', 'pipelines'), { recursive: true });
    fs.mkdirSync(path.join(packDir, 'data', 'samples'), { recursive: true });

    // Build a short vendor prefix for pack naming, pipeline names, and sample filenames.
    // Strip common noise words, take first 2 words max, limit to 20 chars.
    const vendorPrefix = (() => {
      let name = options.solutionName
        .replace(/\b(connector|for|microsoft|sentinel|cloud|solution|integration|next-generation|firewall)\b/gi, '')
        .trim()
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
      const parts = name.split('_').filter(Boolean).slice(0, 2);
      return parts.join('_').slice(0, 20) || 'vendor';
    })();

    // package.json - matches Cribl pack format from reference .crbl
    const streamtags = [
      options.solutionName.toLowerCase().replace(/\s+/g, '-'),
      'sentinel',
    ];
    const packageJson: Record<string, unknown> = {
      name: options.packName,
      version: options.version,
      author: 'Cribl SOC Toolkit',
      description: `Transforms ${vendorPrefix.replace(/_/g, ' ')} logs for ingestion into ${[...new Set(options.tables.map((t) => t.sentinelTable))].join(', ')} via DCR`,
      displayName: vendorPrefix.replace(/_/g, ' ') + ' Sentinel',
      tags: { streamtags },
      exports: ['*'],
      minLogStreamVersion: '4.14.0',
    };
    fs.writeFileSync(path.join(packDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');

    // default/pack.yml - matches reference pack structure
    fs.writeFileSync(path.join(packDir, 'default', 'pack.yml'), 'allowGlobalAccess: true\n');

    // default/breakers.yml - JSON event breaker
    // CrowdStrike FDR needs special handling:
    //   - 768KB max event size (ScriptContent/ScriptContentBytes can be huge)
    //   - Timestamp anchor targets "timestamp" field directly (epoch ms)
    //     because the field position varies wildly across event types
    //   - Fallback anchor for ContextTimeStamp (epoch seconds with decimal)
    const isCrowdStrike = options.solutionName.toLowerCase().includes('crowdstrike');
    const maxEventBytes = isCrowdStrike ? 786432 : 51200; // 768KB for CS, 50KB default
    const timestampAnchor = isCrowdStrike
      ? '/\"timestamp\"\\s*:\\s*\"/' // Anchor directly on the "timestamp" field
      : '/^/';

    const breakersYml = [
      'id: default',
      'rules:',
      '  - id: json_array',
      '    name: JSON Array Breaker',
      '    condition: /^\\[/',
      '    type: json_array',
      `    maxEventBytes: ${maxEventBytes}`,
      '    disabled: false',
      '  - id: json_newline',
      '    name: JSON Newline Delimited',
      '    condition: /^\\{/',
      '    type: regex',
      `    timestampAnchorRegex: ${timestampAnchor}`,
      '    eventBreakerRegex: /[\\n\\r]+(?=\\{)/',
      `    maxEventBytes: ${maxEventBytes}`,
      '    disabled: false',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(packDir, 'default', 'breakers.yml'), breakersYml);

    // Generate sample data files for each table
    const vendorSamples: VendorSample[] = options.vendorSamples || [];
    const samplesRegistry: string[] = [];
    const EVENTS_PER_SAMPLE = 5;

    for (const table of options.tables) {
      const sampleId = generateSampleId();
      // Build a short sample file name: {vendor}_{logtype}
      const sampleLogType = (table.logType || table.sentinelTable).replace(/_CL$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
      const sampleFileName = `${vendorPrefix}_${sampleLogType}`.slice(0, 50);
      const { events, rawCount } = generateSampleFile(
        options.solutionName,
        table.sentinelTable,
        table.fields,
        vendorSamples,
        EVENTS_PER_SAMPLE,
        table.logType,
      );

      // Write sample data file as JSON array
      // Cribl sample files must be valid JSON (array of objects)
      const sampleContent = JSON.stringify(events, null, 2);
      const sampleFilePath = path.join(packDir, 'data', 'samples', `${sampleId}.json`);
      fs.writeFileSync(sampleFilePath, sampleContent);

      // Register in samples.yml
      samplesRegistry.push([
        `${sampleId}:`,
        `  sampleName: "${sampleFileName}.json"`,
        `  ttl: 0`,
        `  created: ${Date.now()}`,
        `  size: ${Buffer.byteLength(sampleContent)}`,
        `  numEvents: ${rawCount}`,
      ].join('\n'));
    }

    // Write samples.yml
    const samplesYml = samplesRegistry.length > 0
      ? samplesRegistry.join('\n') + '\n'
      : '# No sample data generated\n';
    fs.writeFileSync(path.join(packDir, 'default', 'samples.yml'), samplesYml);

    // Track overflow config per table (populated by auto-matching)
    const tableOverflowConfigs = new Map<string, OverflowConfig>();

    // Vendor research: enrich tables with source field data from vendor schemas.
    // This auto-discovers source log fields so pipelines can generate accurate
    // field mappings between vendor source data and DCR destination schemas.
    let vendorData: VendorResearchResult | null = null;
    try {
      vendorData = await performVendorResearch(options.solutionName);
    } catch (err) {
      logger.warn('pack-builder', `Vendor research failed for '${options.solutionName}', falling back to user-provided fields`, err);
    }

    if (vendorData) {
      // Write vendor research summary into the pack for reference
      const researchSummary = [
        `# Vendor Research: ${vendorData.displayName}`,
        `# Fetched: ${new Date(vendorData.fetchedAt).toISOString()}`,
        `# Source: ${vendorData.fromCache ? 'cache' : 'live fetch'}`,
        `# Documentation: ${vendorData.documentationUrl}`,
        '#',
        `# Log types discovered: ${vendorData.logTypes.length}`,
        ...vendorData.logTypes.map((lt) =>
          `#   - ${lt.name}: ${lt.fields.length} fields${lt.sourcetypePattern ? ` (sourcetype: ${lt.sourcetypePattern})` : ''}`
        ),
        '#',
        '# This file is for reference only. The pipeline configurations were',
        '# generated using these field definitions.',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(packDir, 'VENDOR_RESEARCH.txt'), researchSummary);

      // Auto-match source fields to DCR destination schema for each table.
      // Uses the field matcher to produce a COMPLETE mapping for every field.
      const { matchFields: autoMatch } = await import('./field-matcher');

      for (const table of options.tables) {
        // Find matching vendor log type
        const tableLower = table.sentinelTable.toLowerCase().replace(/_cl$/i, '');

        // First: find a log type whose destTable matches this table (most reliable)
        // Then: find by name/id match
        // Prefer log types that have actual fields over empty ones
        let matchedLogType = vendorData.logTypes.find((lt) =>
          lt.destTable && lt.destTable.toLowerCase() === table.sentinelTable.toLowerCase() && lt.fields.length > 0
        );
        if (!matchedLogType) {
          matchedLogType = vendorData.logTypes.find((lt) => {
            const ltLower = lt.id.toLowerCase();
            const ltName = lt.name.toLowerCase().replace(/\s+/g, '_');
            return (ltLower === tableLower || ltName === tableLower ||
                    tableLower.includes(ltLower) || ltLower.includes(tableLower)) &&
                   lt.fields.length > 0;
          });
        }
        if (!matchedLogType) {
          matchedLogType = vendorData.logTypes.find((lt) => lt.fields.length > 0) || vendorData.logTypes[0];
        }

        if (!matchedLogType) continue;

        // Get source fields from vendor research
        const sourceFields = matchedLogType.fields.map((f) => ({
          name: f.name, type: f.type, sampleValue: f.example,
        }));

        // Enrich source fields with fields discovered from uploaded samples.
        // User-uploaded samples contain the REAL vendor field names and types,
        // which may be more complete than the static vendor registry.
        // IMPORTANT: Sample data field names take priority over vendor research
        // names when they differ only in casing, because Cribl rename rules are
        // case-sensitive and must match the actual field names in the data.
        const sampleFieldNames = new Set(sourceFields.map((f) => f.name));
        const sampleFieldNamesLower = new Map(sourceFields.map((f) => [f.name.toLowerCase(), f.name]));
        const tableSamples = vendorSamples.filter((s) => {
          const tbl = s.tableName.toLowerCase().replace(/_cl$/i, '');
          const target = table.sentinelTable.toLowerCase().replace(/_cl$/i, '');
          return tbl === target || tbl.includes(target) || target.includes(tbl) ||
                 (table.logType && s.source.toLowerCase().includes(table.logType.toLowerCase()));
        });

        for (const sample of tableSamples) {
          for (const rawStr of sample.rawEvents) {
            try {
              const evt = JSON.parse(rawStr);
              for (const [key, value] of Object.entries(evt)) {
                const keyLower = key.toLowerCase();
                if (sampleFieldNames.has(key)) continue;

                // If vendor research has the same field with different casing,
                // replace the vendor name with the real name from sample data.
                // This ensures pipeline rename rules use the actual field casing.
                const existingName = sampleFieldNamesLower.get(keyLower);
                if (existingName && existingName !== key) {
                  const idx = sourceFields.findIndex((f) => f.name === existingName);
                  if (idx >= 0) {
                    sourceFields[idx].name = key; // Use real casing from sample
                    sampleFieldNames.delete(existingName);
                    sampleFieldNames.add(key);
                    sampleFieldNamesLower.set(keyLower, key);
                  }
                  continue;
                }

                sampleFieldNamesLower.set(keyLower, key);
                sampleFieldNames.add(key);
                let inferredType = 'string';
                if (typeof value === 'number') inferredType = Number.isInteger(value) ? 'int' : 'real';
                else if (typeof value === 'boolean') inferredType = 'boolean';
                else if (typeof value === 'object' && value !== null) inferredType = 'dynamic';
                else if (typeof value === 'string') {
                  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) inferredType = 'datetime';
                  else if (/^\d+$/.test(value) && value.length < 16) inferredType = 'long';
                }
                sourceFields.push({
                  name: key,
                  type: inferredType,
                  sampleValue: typeof value === 'object' ? JSON.stringify(value) : String(value),
                });
              }
            } catch (err) { logger.warn('pack-builder', `Failed to parse sample event for source field enrichment on table '${table.sentinelTable}'`, err); }
          }
        }

        // Get destination fields from DCR schema
        const destSchema = loadDcrTemplateSchemaPublic(table.sentinelTable);

        if (sourceFields.length > 0 && destSchema.length > 0) {
          // Detect if source data is CEF by checking sample events for CEF header fields.
          // CEF data has different field names (cs1, spt, act) than vendor research (rule, sport, action).
          // When CEF is detected, skip vendor field mappings and let the alias table handle it.
          let isSampleCef = false;
          for (const sample of tableSamples) {
            if (sample.rawEvents?.[0]) {
              try {
                const testEvt = JSON.parse(sample.rawEvents[0]);
                if (testEvt.CEFVersion !== undefined && testEvt.DeviceVendor) { isSampleCef = true; break; }
              } catch (err) {
                logger.warn('pack-builder', 'Failed to JSON-parse sample event during CEF detection, checking raw string', err);
                if (sample.rawEvents[0].includes('CEF:')) { isSampleCef = true; break; }
              }
            }
            if (sample.format === 'cef' || sample.format === 'leef') { isSampleCef = true; break; }
          }

          // Run auto-matching -- skip vendor mappings for CEF (they use wrong field names)
          const vendorMaps = isSampleCef ? undefined : matchedLogType.fieldMappings?.map((m) => ({
            sourceName: m.sourceName, destName: m.destName,
            sourceType: m.sourceType, destType: m.destType,
            action: m.action,
          }));
          const matchResult = autoMatch(sourceFields, destSchema, vendorMaps, table.sentinelTable);

          // Convert match result to field mappings for pipeline generation
          table.fields = [
            // Matched fields: rename/keep/coerce
            ...matchResult.matched.map((m) => ({
              source: m.sourceName,
              target: m.destName,
              type: m.destType,
              action: (m.action === 'keep' && !m.needsCoercion ? 'keep' :
                       m.action === 'keep' && m.needsCoercion ? 'coerce' :
                       m.needsCoercion ? 'rename' : m.action) as 'rename' | 'keep' | 'coerce' | 'drop',
            })),
            // Overflow fields: mark with overflow action
            ...matchResult.overflow.map((o) => ({
              source: o.sourceName, target: o.destName, type: o.destType,
              action: 'drop' as const, // The overflow eval handles these; mark as drop so cleanup removes the individual fields
            })),
            // Unmatched source fields (Cribl internals): drop
            ...matchResult.unmatchedSource.map((s) => ({
              source: s.name, target: s.name, type: s.type, action: 'drop' as const,
            })),
          ];

          // Store overflow config for pipeline generation
          tableOverflowConfigs.set(table.sentinelTable, matchResult.overflowConfig);

          // Write match report into pack for reference
          const matchReport = [
            `# Field Mapping Report: ${table.sentinelTable}`,
            `# Source: ${matchedLogType.name} (${sourceFields.length} fields)`,
            `# Destination: ${table.sentinelTable} DCR (${destSchema.length} fields)`,
            `# Match rate: ${Math.round(matchResult.matchRate * 100)}%`,
            '#',
            `# Matched (1:1): ${matchResult.matched.length}`,
            ...matchResult.matched.map((m) =>
              `#   [${m.confidence}] ${m.sourceName} (${m.sourceType}) -> ${m.destName} (${m.destType})${m.needsCoercion ? ' [COERCE]' : ''} -- ${m.description}`
            ),
            '#',
            `# Overflow (into ${matchResult.overflowConfig.fieldName}): ${matchResult.overflow.length}`,
            ...matchResult.overflow.map((o) =>
              `#   ${o.sourceName} (${o.sourceType}) -> ${matchResult.overflowConfig.fieldName} (${matchResult.overflowConfig.fieldType})`
            ),
            '#',
            `# Dropped (Cribl internals): ${matchResult.unmatchedSource.length}`,
            ...matchResult.unmatchedSource.map((s) => `#   ${s.name} (${s.type})`),
            '#',
            `# Unmapped dest fields (not in source): ${matchResult.unmatchedDest.length}`,
            ...matchResult.unmatchedDest.map((d) => `#   ${d.name} (${d.type})`),
            '',
          ].join('\n');
          fs.writeFileSync(
            path.join(packDir, `FIELD_MAPPING_${table.sentinelTable}.txt`),
            matchReport,
          );
        } else if (table.fields.length === 0 && sourceFields.length > 0) {
          // No DCR schema available -- use source fields as-is (passthrough)
          table.fields = sourceFields.map((f) => ({
            source: f.name, target: f.name, type: f.type, action: 'keep' as const,
          }));
        }
      }
    }

    // Fallback: if no vendor research, but user uploaded samples, extract source
    // fields from samples and run auto-matching against the DCR destination schema.
    // This is the key path for vendors without static registry entries.
    if (!vendorData && vendorSamples.length > 0) {
      const { matchFields: autoMatch } = await import('./field-matcher');

      for (const table of options.tables) {
        if (table.fields.length > 0) continue; // Already has mappings

        // Extract fields from uploaded samples for this table
        const sourceFields: Array<{ name: string; type: string; sampleValue?: string }> = [];
        const fieldNames = new Set<string>();

        const tableSamples = vendorSamples.filter((s) => {
          const tbl = s.tableName.toLowerCase().replace(/_cl$/i, '');
          const target = table.sentinelTable.toLowerCase().replace(/_cl$/i, '');
          return tbl === target || tbl.includes(target) || target.includes(tbl) ||
                 (table.logType && s.source.toLowerCase().includes(table.logType.toLowerCase()));
        });

        for (const sample of tableSamples) {
          for (const rawStr of sample.rawEvents) {
            try {
              const evt = JSON.parse(rawStr);
              for (const [key, value] of Object.entries(evt)) {
                if (fieldNames.has(key)) continue;
                fieldNames.add(key);
                let inferredType = 'string';
                if (typeof value === 'number') inferredType = Number.isInteger(value) ? 'int' : 'real';
                else if (typeof value === 'boolean') inferredType = 'boolean';
                else if (typeof value === 'object' && value !== null) inferredType = 'dynamic';
                else if (typeof value === 'string') {
                  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) inferredType = 'datetime';
                  else if (/^\d+$/.test(value) && value.length < 16) inferredType = 'long';
                }
                sourceFields.push({
                  name: key, type: inferredType,
                  sampleValue: typeof value === 'object' ? JSON.stringify(value) : String(value),
                });
              }
            } catch (err) { logger.warn('pack-builder', `Failed to parse sample event for field extraction on table '${table.sentinelTable}'`, err); }
          }
        }

        if (sourceFields.length === 0) continue;

        // Get destination schema from DCR templates
        const destSchema = loadDcrTemplateSchemaPublic(table.sentinelTable);

        if (destSchema.length > 0) {
          const matchResult = autoMatch(sourceFields, destSchema, undefined, table.sentinelTable);

          table.fields = [
            ...matchResult.matched.map((m) => ({
              source: m.sourceName, target: m.destName, type: m.destType,
              action: (m.action === 'keep' && !m.needsCoercion ? 'keep' :
                       m.action === 'keep' && m.needsCoercion ? 'coerce' :
                       m.needsCoercion ? 'rename' : m.action) as 'rename' | 'keep' | 'coerce' | 'drop',
            })),
            ...matchResult.overflow.map((o) => ({
              source: o.sourceName, target: o.destName, type: o.destType,
              action: 'drop' as const,
            })),
            ...matchResult.unmatchedSource.map((s) => ({
              source: s.name, target: s.name, type: s.type, action: 'drop' as const,
            })),
          ];

          tableOverflowConfigs.set(table.sentinelTable, matchResult.overflowConfig);

          // Write match report
          const matchReport = [
            `# Field Mapping Report (from samples): ${table.sentinelTable}`,
            `# Source fields (from uploaded samples): ${sourceFields.length}`,
            `# Destination fields (DCR schema): ${destSchema.length}`,
            `# Match rate: ${Math.round(matchResult.matchRate * 100)}%`,
            '#',
            `# Matched: ${matchResult.matched.length}`,
            ...matchResult.matched.map((m) =>
              `#   [${m.confidence}] ${m.sourceName} -> ${m.destName}${m.needsCoercion ? ' [COERCE]' : ''}`
            ),
            `# Overflow: ${matchResult.overflow.length}`,
            `# Unmatched source: ${matchResult.unmatchedSource.length}`,
            `# Unmatched dest: ${matchResult.unmatchedDest.length}`,
            '',
          ].join('\n');
          fs.writeFileSync(path.join(packDir, `FIELD_MAPPING_${table.sentinelTable}.txt`), matchReport);
        } else {
          // No DCR schema -- pass through all sample fields
          table.fields = sourceFields.map((f) => ({
            source: f.name, target: f.name, type: f.type, action: 'keep' as const,
          }));
        }
      }
    }

    // Resolve route conditions from DCR transformKql (event_simpleName groups)
    // This replaces the generic "true" condition with precise event routing.
    let tableRouting: import('./kql-parser').TableRoutingInfo[] = [];
    try {
      const { getTableRoutingForSolution } = kqlParser;
      tableRouting = await getTableRoutingForSolution(options.solutionName);
    } catch (err) { logger.warn('pack-builder', `Failed to resolve table routing for solution '${options.solutionName}'`, err); }

    // Apply route conditions to tables
    if (tableRouting.length > 0) {
      for (const table of options.tables) {
        const routing = tableRouting.find((r) =>
          r.tableName.toLowerCase() === table.sentinelTable.toLowerCase() ||
          r.tableName.toLowerCase().replace(/_cl$/i, '') === table.sentinelTable.toLowerCase().replace(/_cl$/i, '')
        );
        if (routing && routing.routeCondition !== 'true') {
          table.sourcetypeFilter = routing.routeCondition;
        }
      }
    }

    // DCR gap analysis: determine what Cribl must transform vs what the DCR handles.
    const gapAnalyses = await runDcrGapAnalysis(
      options.solutionName, options.tables, vendorSamples, tableRouting, packDir,
    );

    // Create a pipeline for each table mapping with intelligent field transformation
    // Naming convention: {Vendor}_{LogType} e.g., PaloAlto_Traffic
    const tableFormatMap = new Map<string, string>(); // per-table format for reduction pipelines
    for (const table of options.tables) {
      // Determine logtype name -- use short log type, strip _CL suffix
      let logTypeSuffix = (table.logType || table.sentinelTable)
        .replace(/_CL$/i, '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 25);
      const pipelineName = `${vendorPrefix}_${logTypeSuffix}`;
      const pipelineDir = path.join(packDir, 'default', 'pipelines', pipelineName);
      fs.mkdirSync(pipelineDir, { recursive: true });

      // Check if we have a DCR gap analysis for this table
      const gap = gapAnalyses.get(table.sentinelTable);

      // If gap analysis exists AND the DCR has real transforms (renames or coercions),
      // use gap results to avoid duplicating DCR work. But for native tables with
      // empty/synthetic DCR flows (no renames, no coercions), use the field matcher
      // instead -- it has the alias table (cs1->DeviceCustomString1, src->SourceIP, etc.)
      // that the gap analysis lacks.
      const dcrHasTransforms = gap &&
        (gap.dcrHandles.renames.length > 0 || gap.dcrHandles.coercions.length > 0);

      if (gap && dcrHasTransforms) {
        table.fields = [
          // Cribl-only renames (DCR doesn't handle these)
          ...gap.criblMustHandle.renames.map((r) => ({
            source: r.source, target: r.dest, type: 'string', action: 'rename' as const,
          })),
          // Cribl-only coercions (DCR doesn't handle these)
          ...gap.criblMustHandle.coercions.map((c) => ({
            source: c.field, target: c.field, type: c.toType, action: 'coerce' as const,
          })),
          // Overflow fields to drop (handled by overflow eval)
          ...gap.criblMustHandle.overflow.map((o) => ({
            source: o.field, target: o.field, type: o.type, action: 'drop' as const,
          })),
        ];
      } else if (gap) {
        // Native table with empty DCR flow -- use field matcher for alias-based renames.
        // Extract source fields from vendor samples for this table.
        const sampleMatch = vendorSamples.find((vs) =>
          vs.tableName.toLowerCase() === table.sentinelTable.toLowerCase()
        ) || vendorSamples[0];
        if (sampleMatch?.rawEvents?.length > 0) {
          const { matchFields, getOverflowConfig } = await import('./field-matcher');
          const { parseSampleContent } = await import('./sample-parser');
          const parsed = parseSampleContent(sampleMatch.rawEvents.join('\n'), 'sample');
          const sourceFields = parsed.fields.map((f: any) => ({ name: f.name, type: f.type, sampleValue: f.sampleValues?.[0] }));
          const destColumns = loadDcrTemplateSchemaPublic(table.sentinelTable);
          if (sourceFields.length > 0 && destColumns.length > 0) {
            const destFields = destColumns.map((c: any) => ({ name: c.name, type: c.type }));
            const matchResult = matchFields(sourceFields, destFields, undefined, table.sentinelTable);
            table.fields = [
              ...matchResult.matched.filter((m: any) => m.action === 'rename').map((m: any) => ({
                source: m.sourceName, target: m.destName, type: m.destType, action: 'rename' as const,
              })),
              ...matchResult.matched.filter((m: any) => m.action === 'coerce').map((m: any) => ({
                source: m.sourceName, target: m.destName, type: m.destType, action: 'coerce' as const,
              })),
            ];
            // Update overflow config with field matcher results
            tableOverflowConfigs.set(table.sentinelTable, matchResult.overflowConfig);
          }
        }
      }

      // Look up source format from vendor research
      let sourceFormat: string | undefined;
      if (vendorData) {
        const tableLower = table.sentinelTable.toLowerCase().replace(/_cl$/i, '');
        const matchedLogType = vendorData.logTypes.find((lt) => {
          const ltLower = (lt.id || '').toLowerCase();
          const ltName = (lt.name || '').toLowerCase().replace(/\s+/g, '_');
          if (!ltLower && !ltName) return false;
          return ltLower === tableLower || ltName === tableLower ||
                 (ltLower.length > 2 && tableLower.includes(ltLower)) ||
                 (tableLower.length > 2 && ltLower.includes(tableLower));
        }) || vendorData.logTypes[0];

        if (matchedLogType?.sourceFormat) {
          sourceFormat = matchedLogType.sourceFormat;
        }
      }

      // Detect source format from actual sample event content. This overrides vendor
      // research because tagSample re-parses events into JSON -- the raw events in
      // state are always JSON strings even if the original vendor format was KV or CSV.
      if (vendorSamples.length > 0) {
        // Try to match by log type name first (most specific)
        const logTypeKey = (table as any).logType?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
        const sampleMatch = vendorSamples.find((vs) => {
          const vsKey = vs.source?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
          return vsKey.includes(logTypeKey) || logTypeKey.includes(vsKey);
        }) || vendorSamples.find((vs) =>
          vs.tableName.toLowerCase() === table.sentinelTable.toLowerCase()
        ) || vendorSamples[0];

        // Detect format from actual event content (more reliable than declared format,
        // which may be stale after Filebeat unwrapping or format conversion).
        const firstRaw = sampleMatch?.rawEvents?.[0] || '';
        if (firstRaw.includes('CEF:')) {
          sourceFormat = 'cef';
        } else if (firstRaw.includes('LEEF:')) {
          sourceFormat = 'leef';
        } else if (firstRaw.startsWith('{')) {
          // JSON event -- check for CEF/LEEF header fields, otherwise it's plain JSON
          try {
            const evt = JSON.parse(firstRaw);
            if (evt.CEFVersion !== undefined && evt.DeviceVendor) sourceFormat = 'cef';
            else if (evt.LEEFVersion !== undefined) sourceFormat = 'leef';
            else sourceFormat = 'json';
          } catch (err) { logger.warn('pack-builder', 'Sample event starts with { but failed JSON parse during format detection', err); }
        } else if (/^\w+=/.test(firstRaw)) {
          // Key-value pairs (e.g., Fortinet: date=2019-05-10 type="traffic")
          sourceFormat = 'kv';
        }
      }

      // Store per-table format for reduction pipelines
      tableFormatMap.set(table.sentinelTable + ':' + ((table as any).logType || ''), sourceFormat || 'json');

      // For CEF/LEEF/KV sources, use the field matcher with alias table instead of
      // vendor research mappings. Vendor research provides PAN-OS syslog names (sport,
      // dport, rule) while actual CEF data has CEF extension names (spt, dpt, cs1).
      // The field matcher's alias table handles the CEF->Sentinel name mapping correctly.
      const isCefLike = sourceFormat === 'cef' || sourceFormat === 'leef' || sourceFormat === 'kv';
      if (isCefLike && table.fields.length === 0 && vendorSamples.length > 0) {
        const logTypeKey = (table as any).logType?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
        const sampleForMatcher = vendorSamples.find((vs) => {
          const vsKey = vs.source?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
          return vsKey.includes(logTypeKey) || logTypeKey.includes(vsKey);
        }) || vendorSamples.find((vs) =>
          vs.tableName.toLowerCase() === table.sentinelTable.toLowerCase()
        ) || vendorSamples[0];
        if (sampleForMatcher?.rawEvents?.length > 0) {
          try {
            const { matchFields: mf } = await import('./field-matcher');
            const { parseSampleContent: psc } = await import('./sample-parser');
            const parsedSample = psc(sampleForMatcher.rawEvents.join('\n'), 'sample');
            const srcFields = parsedSample.fields.map((f: any) => ({ name: f.name, type: f.type, sampleValue: f.sampleValues?.[0] }));
            const dstCols = loadDcrTemplateSchemaPublic(table.sentinelTable);
            if (srcFields.length > 0 && dstCols.length > 0) {
              const dstFields = dstCols.map((c: any) => ({ name: c.name, type: c.type }));
              const mr = mf(srcFields, dstFields, undefined, table.sentinelTable);
              table.fields = [
                ...mr.matched.filter((m: any) => m.action === 'rename').map((m: any) => ({
                  source: m.sourceName, target: m.destName, type: m.destType, action: 'rename' as const,
                })),
                ...mr.matched.filter((m: any) => m.action === 'coerce').map((m: any) => ({
                  source: m.sourceName, target: m.destName, type: m.destType, action: 'coerce' as const,
                })),
              ];
              tableOverflowConfigs.set(table.sentinelTable, mr.overflowConfig);
            }
          } catch (err) { logger.warn('pack-builder', `CEF/LEEF/KV field matcher failed for table '${table.sentinelTable}'`, err); }
        }
      }

      // Only use vendor research field mappings for JSON sources where field names
      // match. CEF/LEEF sources have different field naming and use the alias table above.
      let vendorMappings: VendorFieldMapping[] | undefined;
      if (!isCefLike && vendorData && table.fields.length === 0) {
        const tableLower = table.sentinelTable.toLowerCase().replace(/_cl$/i, '');
        const matchedLogType = vendorData.logTypes.find((lt) => {
          const ltLower = (lt.id || '').toLowerCase();
          const ltName = (lt.name || '').toLowerCase().replace(/\s+/g, '_');
          if (!ltLower && !ltName) return false;
          return ltLower === tableLower || ltName === tableLower ||
                 (ltLower.length > 2 && tableLower.includes(ltLower)) ||
                 (tableLower.length > 2 && ltLower.includes(tableLower));
        }) || vendorData.logTypes[0];
        if (matchedLogType?.fieldMappings && matchedLogType.fieldMappings.length > 0) {
          vendorMappings = matchedLogType.fieldMappings;
        }
      }

      // Apply user mapping overrides if provided
      if (options.fieldMappingOverrides) {
        const overrides = options.fieldMappingOverrides[table.sentinelTable];
        if (overrides && overrides.length > 0) {
          table.fields = overrides.map((o) => ({
            source: o.source,
            target: o.dest,
            type: o.destType,
            action: (o.action === 'overflow' ? 'drop' : o.action) as 'rename' | 'keep' | 'coerce' | 'drop',
          }));
        }
      }

      const confYml = generatePipelineConf(
        pipelineName,
        options.solutionName,
        table.sentinelTable,
        table.fields,
        vendorMappings,
        sourceFormat,
        tableOverflowConfigs.get(table.sentinelTable),
      );
      fs.writeFileSync(path.join(pipelineDir, 'conf.yml'), confYml);
    }

    // Generate CSV lookup files with full field mapping details per log type.
    // Each log type gets its own lookup file so users can see per-pipeline mappings.
    const lookupsDir = path.join(packDir, 'data', 'lookups');
    fs.mkdirSync(lookupsDir, { recursive: true });
    const { matchFields: lookupMatch } = await import('./field-matcher');
    const { parseSampleContent: lookupParse } = await import('./sample-parser');
    for (const table of options.tables) {
      const logTypeSuffix = (table.logType || table.sentinelTable).replace(/[^a-zA-Z0-9_-]/g, '_');
      const lookupFileName = `${logTypeSuffix}_field_mapping.csv`;

      // If user provided mapping overrides for this log type, use those directly
      const overrideKey = table.logType || table.sentinelTable;
      if (options.fieldMappingOverrides?.[overrideKey]) {
        const overrides = options.fieldMappingOverrides[overrideKey];
        const csvHeader = 'source_field,source_type,dest_field,dest_type,confidence,action,needs_coercion,description';
        const csvRows = overrides.map((o) => {
          return [o.source, o.sourceType, o.dest, o.destType, o.confidence, o.action, String(o.needsCoercion), o.description]
            .map((v) => (v || '').includes(',') || (v || '').includes('"') ? '"' + (v || '').replace(/"/g, '""') + '"' : (v || ''))
            .join(',');
        });
        fs.writeFileSync(path.join(lookupsDir, lookupFileName), [csvHeader, ...csvRows].join('\n') + '\n');
        continue;
      }

      // Match vendor samples by log type first, then by table name
      const sampleMatch = vendorSamples.find((vs) =>
        vs.logType?.toLowerCase() === (table.logType || '').toLowerCase()
      ) || vendorSamples.find((vs) =>
        vs.tableName.toLowerCase() === table.sentinelTable.toLowerCase()
      ) || vendorSamples[0];
      if (!sampleMatch?.rawEvents?.length) continue;

      try {
        const parsed = lookupParse(sampleMatch.rawEvents.join('\n'), 'sample');
        const sourceFields = parsed.fields.map((f: any) => ({ name: f.name, type: f.type, sampleValue: f.sampleValues?.[0] }));
        const destColumns = loadDcrTemplateSchemaPublic(table.sentinelTable);
        if (sourceFields.length === 0 || destColumns.length === 0) continue;

        const destFields = destColumns.map((c: any) => ({ name: c.name, type: c.type }));
        const mr = lookupMatch(sourceFields, destFields, undefined, table.sentinelTable);

        const csvHeader = 'source_field,source_type,dest_field,dest_type,confidence,action,needs_coercion,description';
        const allMappings = [
          ...mr.matched.map((m: any) => [m.sourceName, m.sourceType, m.destName, m.destType, m.confidence, m.action, String(m.needsCoercion), m.description]),
          ...mr.overflow.map((o: any) => [o.sourceName, o.sourceType, o.destName, o.destType, 'unmatched', 'overflow', 'false', 'Collected into overflow field']),
        ];
        const csvRows = allMappings.map((row: string[]) =>
          row.map((v) => v.includes(',') || v.includes('"') ? '"' + v.replace(/"/g, '""') + '"' : v).join(',')
        );
        if (csvRows.length > 0) {
          fs.writeFileSync(path.join(lookupsDir, lookupFileName), [csvHeader, ...csvRows].join('\n') + '\n');
        }
      } catch (err) { logger.warn('pack-builder', `Failed to generate lookup CSV for table '${table.sentinelTable}'`, err); }
    }

    // Generate default/lookups.yml registry for the lookup CSV files.
    const lookupFiles = fs.existsSync(lookupsDir)
      ? fs.readdirSync(lookupsDir).filter((f) => f.endsWith('.csv'))
      : [];
    if (lookupFiles.length > 0) {
      const lookupsYml = lookupFiles.map((f) => {
        const id = f.replace('.csv', '');
        const logType = id.replace('_field_mapping', '').replace(/_/g, ' ');
        return [
          `${id}:`,
          `  id: ${id}`,
          `  filename: ${f}`,
          `  description: "Field mapping lookup for ${logType}"`,
        ].join('\n');
      }).join('\n');
      fs.writeFileSync(path.join(packDir, 'default', 'lookups.yml'), lookupsYml + '\n');
    }

    // Create Reduction pipeline for each table -- same full transformation pipeline
    // but with reduction steps (keep/drop/suppress) inserted between rename and enrich.
    // This makes each reduction pipeline self-contained: it extracts, renames, reduces,
    // enriches, overflows, and cleans up. Users can disable the "reduce" group to get
    // the same behavior as the non-reduction pipeline.
    const reductionPipelines: Array<{ tableName: string; logType: string; pipelineId: string; hasRules: boolean }> = [];
    for (const table of options.tables) {
      const rules = findReductionRules(table.sentinelTable, options.solutionName);
      const logTypeSuffix = (table.logType || table.sentinelTable).replace(/[^a-zA-Z0-9_-]/g, '_');
      const reductionId = `Reduction_${vendorPrefix}_${logTypeSuffix}`;
      const reductionDir = path.join(packDir, 'default', 'pipelines', reductionId);
      fs.mkdirSync(reductionDir, { recursive: true });

      const reductionFormat = tableFormatMap.get(table.sentinelTable + ':' + ((table as any).logType || ''))
        || tableFormatMap.values().next().value
        || undefined;

      // Re-lookup vendor mappings for this table (same logic as transformation pipeline)
      const isCefLike = reductionFormat === 'cef' || reductionFormat === 'leef' || reductionFormat === 'kv';
      let redVendorMappings: VendorFieldMapping[] | undefined;
      if (!isCefLike && vendorData && table.fields.length === 0) {
        const tableLower = table.sentinelTable.toLowerCase().replace(/_cl$/i, '');
        const matchedLt = vendorData.logTypes.find((lt) => {
          const ltLower = (lt.id || '').toLowerCase();
          const ltName = (lt.name || '').toLowerCase().replace(/\s+/g, '_');
          if (!ltLower && !ltName) return false;
          return ltLower === tableLower || ltName === tableLower ||
                 (ltLower.length > 2 && tableLower.includes(ltLower)) ||
                 (tableLower.length > 2 && ltLower.includes(tableLower));
        }) || vendorData.logTypes[0];
        if (matchedLt?.fieldMappings && matchedLt.fieldMappings.length > 0) {
          redVendorMappings = matchedLt.fieldMappings;
        }
      }

      const reductionConf = rules
        ? generatePipelineConf(
            reductionId, options.solutionName, table.sentinelTable,
            table.fields, redVendorMappings, reductionFormat,
            tableOverflowConfigs.get(table.sentinelTable), rules,
          )
        : generateFallbackReductionConf(options.solutionName, table.sentinelTable, reductionFormat);

      fs.writeFileSync(path.join(reductionDir, 'conf.yml'), reductionConf);
      reductionPipelines.push({
        tableName: table.sentinelTable,
        logType: table.logType || table.sentinelTable,
        pipelineId: reductionId,
        hasRules: rules !== null,
      });
    }

    // Create route.yml: Two routes per log type --
    //   1. Reduction route (enabled, final:true): full pipeline with reduction + transformation
    //   2. Passthrough route (disabled): same transformation without reduction (enable as fallback)
    // To disable reduction: disable the reduction route and enable the passthrough route.
    const allRouteEntries: string[] = [];

    for (let idx = 0; idx < options.tables.length; idx++) {
      const table = options.tables[idx];
      const logTypeSuffix = (table.logType || table.sentinelTable).replace(/[^a-zA-Z0-9_-]/g, '_');
      const tableName = table.sentinelTable.replace(/_CL$/i, '');
      const destId = `MS-Sentinel-${tableName}-dest`;
      const routeCondition = table.sourcetypeFilter || 'true';
      const isLast = idx === options.tables.length - 1;
      const rp = reductionPipelines.find((r) =>
        (r.logType || r.tableName).replace(/[^a-zA-Z0-9_-]/g, '_') === logTypeSuffix
      );

      // Route filter: use sourcetypeFilter if set, otherwise match all events.
      // YAML `filter: true` (unquoted) means match all; `filter: "true"` (quoted string) is wrong.
      const filterLine = routeCondition === 'true'
        ? '    filter: "true"'
        : `    filter: "${routeCondition.replace(/"/g, '\\"')}"`;

      // Reduction route: full pipeline with volume reduction enabled
      if (rp?.hasRules) {
        allRouteEntries.push([
          `  - id: reduction_${vendorPrefix}_${logTypeSuffix}`,
          `    name: "Reduction + Transform: ${logTypeSuffix}"`,
          `    pipeline: ${rp.pipelineId}`,
          filterLine,
          `    output: ${destId}`,
          '    final: true',
          '    disabled: false',
          `    description: Reduction + Transform for ${logTypeSuffix} events`,
        ].join('\n'));
      }

      // Passthrough route: transformation only (no reduction)
      // Disabled by default when reduction route exists; enabled when it doesn't
      const pipelineName = `${vendorPrefix}_${logTypeSuffix}`;
      allRouteEntries.push([
        `  - id: route_${vendorPrefix}_${logTypeSuffix}`,
        `    name: "Transform: ${logTypeSuffix}"`,
        `    pipeline: ${pipelineName}`,
        filterLine,
        `    output: ${destId}`,
        '    final: true',
        `    disabled: ${rp?.hasRules ? 'true' : 'false'}`,
        `    description: Transform only for ${logTypeSuffix} events`,
      ].join('\n'));
    }

    const routeYml = [
      `# Routes for ${options.solutionName}`,
      '# Generated by Cribl SOC Optimization Toolkit',
      '#',
      '# Each log type has two routes:',
      '#   1. Reduction + Transform (enabled): full pipeline with volume reduction',
      '#   2. Transform only (disabled): same pipeline without reduction',
      '# To skip reduction: disable the reduction route and enable the passthrough route.',
      '',
      'id: default',
      'groups: {}',
      'routes:',
      ...allRouteEntries,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(packDir, 'default', 'pipelines', 'route.yml'), routeYml);

    // default/outputs.yml - Sentinel destination config
    // Try to embed real deployed destinations first (only secret left as placeholder).
    // Falls back to placeholder template if no deployed DCRs exist.
    const deployedDests: DeployedDestination[] = [];
    for (const table of options.tables) {
      const dest = findDestinationForTable(table.sentinelTable);
      if (dest && !deployedDests.some((d) => d.id === dest.id)) {
        deployedDests.push(dest);
      }
    }

    let outputsYml: string;
    // Always generate destinations for ALL tables.
    // Use real deployed values when available, skeleton placeholders when not.
    {
      const azureParams = readAzureParameters();

      // If we have some real destinations, start with those
      if (deployedDests.length > 0 && deployedDests.length >= options.tables.length) {
        outputsYml = generateOutputsYmlFromDestinations(deployedDests, azureParams);
      } else {
        // Mix of real + skeleton destinations
        const destLines: string[] = ['outputs:'];

        for (const table of options.tables) {
          const deployed = deployedDests.find((d) => {
            const dTable = d.tableName.replace(/_CL$/i, '').toLowerCase();
            const tTable = table.sentinelTable.replace(/_CL$/i, '').toLowerCase();
            return dTable === tTable || dTable.includes(tTable) || tTable.includes(dTable);
          });

          const tableName = table.sentinelTable.replace(/_CL$/i, '');
          const destId = 'MS-Sentinel-' + tableName + '-dest';
          const streamName = 'Custom-' + tableName;
          const clientId = deployed?.client_id || (azureParams?.clientId ? "'" + azureParams.clientId + "'" : "''");
          const tenantId = azureParams?.tenantId || '';
          const dceEndpoint = deployed?.dceEndpoint || 'https://UPDATE-DCE-ENDPOINT.logs.z1.ingest.monitor.azure.com';
          const dcrID = deployed?.dcrID || 'dcr-00000000000000000000000000000000';
          const loginUrl = deployed?.loginUrl || 'https://login.microsoftonline.com/' + tenantId + '/oauth2/v2.0/token';
          const url = deployed?.url || dceEndpoint + '/dataCollectionRules/' + dcrID + '/streams/' + streamName + '?api-version=2021-11-01-preview';

          destLines.push(
            '  ' + destId + ':',
            '    systemFields: []',
            '    streamtags: []',
            '    keepAlive: true',
            '    concurrency: 5',
            '    maxPayloadSizeKB: 1000',
            '    maxPayloadEvents: 0',
            '    compress: true',
            '    rejectUnauthorized: true',
            '    timeoutSec: 30',
            '    flushPeriodSec: 1',
            '    useRoundRobinDns: false',
            '    failedRequestLoggingMode: none',
            '    safeHeaders: []',
            '    responseRetrySettings: []',
            '    timeoutRetrySettings:',
            '      timeoutRetry: false',
            '    responseHonorRetryAfterHeader: false',
            '    onBackpressure: drop',
            '    scope: https://monitor.azure.com/.default',
            '    endpointURLConfiguration: ID',
            '    type: sentinel',
            '    dceEndpoint: ' + dceEndpoint,
            '    dcrID: ' + dcrID,
            '    streamName: ' + streamName,
            '    client_id: ' + clientId,
            '    secret: "!{sentinel_client_secret}"',
            '    loginUrl: "' + loginUrl + '"',
            '    url: "' + url + '"',
            '',
          );
        }
        outputsYml = destLines.join('\n') + '\n';
      }
    }
    // Old skeleton code removed -- all tables handled in unified block above
    fs.writeFileSync(path.join(packDir, 'default', 'outputs.yml'), outputsYml);

    // default/inputs.yml - Source/input configuration
    // If user provided sourceConfig, use it; otherwise auto-detect from vendor name
    const sourceConf = options.sourceConfig ?? (() => {
      const hint = suggestSourceType(options.solutionName, options.tables[0]?.sentinelTable || '');
      if (hint) {
        return { sourceType: hint.sourceType, vendorPreset: hint.preset, fields: {} } as SourceConfig;
      }
      return null;
    })();

    if (sourceConf) {
      const inputId = `${options.packName.replace(/[^a-zA-Z0-9_-]/g, '_')}_input`;
      const inputsYml = generateInputsYml(inputId, sourceConf);
      fs.writeFileSync(path.join(packDir, 'default', 'inputs.yml'), inputsYml);
    }

    // Capture a build snapshot for change detection.
    // Records connector file SHAs and schema fingerprints so we can detect
    // upstream changes next time the app loads.
    try {
      const logTypesForSnapshot = options.tables.map((t) => ({
        id: t.sentinelTable.replace(/[^a-zA-Z0-9_]/g, '_'),
        name: t.sentinelTable,
        fields: t.fields.map((f) => ({ name: f.target || f.source, type: f.type })),
      }));
      await captureSnapshot(options.packName, options.solutionName, logTypesForSnapshot);
    } catch (err) {
      logger.warn('pack-builder', `Build snapshot capture failed for pack '${options.packName}'`, err);
    }

    // Always package the .crbl file after scaffold creation
    let crblPath = '';
    try {
      crblPath = await packagePack(packDir, event.sender);
    } catch (err) {
      logger.warn('pack-builder', `Packaging .crbl failed for pack '${options.packName}', pack directory was still created`, err);
    }

    return { packDir, crblPath };
  }

  ipcMain.handle('pack:package', async (event, { packDir }: { packDir: string }) => {
    const crblPath = await packagePack(packDir, event.sender);
    return { packDir, crblPath };
  });

  // Export all deployment artifacts to a directory for air-gapped mode.
  // Produces: .crbl pack, ARM templates per table, Cribl destination configs, deployment README.
  ipcMain.handle('pack:export-artifacts', async (_event, {
    packDir, crblPath, exportDir, tables, solutionName, packName,
  }: {
    packDir: string; crblPath?: string; exportDir?: string; tables: string[];
    solutionName: string; packName: string;
  }) => {
    // Resolve export directory -- 'downloads' maps to user's Downloads folder
    let resolvedDir = exportDir;
    if (!resolvedDir || resolvedDir === 'downloads') {
      const userHome = process.env.USERPROFILE || process.env.HOME || '';
      resolvedDir = path.join(userHome, 'Downloads', `${packName}-artifacts`);
    }
    const exportPath = resolvedDir;
    // Clean previous export to avoid stale files
    if (fs.existsSync(exportPath)) {
      fs.rmSync(exportPath, { recursive: true, force: true });
    }
    fs.mkdirSync(exportPath, { recursive: true });

    const artifacts: string[] = [];

    // 1. Copy the .crbl file that was just built
    if (crblPath && fs.existsSync(crblPath)) {
      const crblName = path.basename(crblPath);
      fs.copyFileSync(crblPath, path.join(exportPath, crblName));
      artifacts.push(crblName);
    }

    // 2. Copy/generate ARM templates (only for this solution's tables)
    const templatesDir = path.join(exportPath, 'arm-templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    const cwd = dcrAutomationCwd();
    for (const table of tables) {
      const searchPaths = cwd ? [
        path.join(cwd, 'core', 'generated-templates', `${table}-latest.json`),
        path.join(cwd, '..', 'DCR-Templates', 'SentinelNativeTables', 'DataCollectionRules(NoDCE)', `${table}.json`),
        path.join(cwd, '..', 'DCR-Templates', 'SentinelNativeTables', 'DataCollectionRules(DCE)', `${table}.json`),
      ] : [];
      for (const tplPath of searchPaths) {
        if (fs.existsSync(tplPath)) {
          fs.copyFileSync(tplPath, path.join(templatesDir, `${table}.json`));
          artifacts.push(`arm-templates/${table}.json`);
          break;
        }
      }
      // Custom table schemas
      if (table.endsWith('_CL') && cwd) {
        const schemaPath = path.join(cwd, 'core', 'custom-table-schemas', `${table}.json`);
        if (fs.existsSync(schemaPath)) {
          fs.copyFileSync(schemaPath, path.join(templatesDir, `${table}-schema.json`));
          artifacts.push(`arm-templates/${table}-schema.json`);
        }
      }
    }

    // 3. Copy Cribl destination configs (only for this solution's tables)
    if (cwd) {
      const destDir = path.join(cwd, 'core', 'cribl-dcr-configs', 'destinations');
      if (fs.existsSync(destDir)) {
        const criblDir = path.join(exportPath, 'cribl-destinations');
        fs.mkdirSync(criblDir, { recursive: true });
        // Build a set of table name fragments to match against destination filenames
        const tableFragments = tables.map((t) => t.replace(/_CL$/, '').replace(/([A-Z])/g, '-$1').replace(/^-/, ''));
        for (const f of fs.readdirSync(destDir).filter((ff) => ff.endsWith('.json'))) {
          const matchesTable = tables.some((t) => f.toLowerCase().includes(t.toLowerCase())) ||
            tableFragments.some((frag) => f.toLowerCase().includes(frag.toLowerCase()));
          if (matchesTable) {
            fs.copyFileSync(path.join(destDir, f), path.join(criblDir, f));
            artifacts.push(`cribl-destinations/${f}`);
          }
        }
      }
    }

    // 4. Generate deployment README
    const readme = [
      `# ${solutionName} - Deployment Artifacts`,
      '',
      `Generated by Cribl SOC Optimization Toolkit`,
      '',
      '## Contents',
      '',
      ...artifacts.map((a) => `- \`${a}\``),
      '',
      '## Deployment Steps',
      '',
      '### 1. Azure Resources',
      '- Deploy ARM templates from `arm-templates/` to your Azure resource group',
      '- Use Azure Portal > Deploy a custom template, or `az deployment group create`',
      '- Custom table schemas in `*-schema.json` files define the table structure',
      '',
      '### 2. Cribl Pack',
      `- Import \`${packName}*.crbl\` into Cribl Stream via Packs > Add Pack > Import from File`,
      '- Configure the Sentinel destination with your DCR credentials',
      '- The destination configs in `cribl-destinations/` contain the DCR IDs and endpoints',
      '',
      '### 3. Route Configuration',
      '- Create a route in Cribl that directs your source to the pack pipeline',
      '- Filter: `__inputId==\'your_source_id\'`',
      `- Pipeline: \`pack:${packName}\``,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(exportPath, 'README-deployment.md'), readme);
    artifacts.push('README-deployment.md');

    return { exportPath, artifacts };
  });

  ipcMain.handle('pack:list', async () => {
    const packsDir = getPacksDir();

    if (!fs.existsSync(packsDir)) {
      return [];
    }

    const entries = fs.readdirSync(packsDir, { withFileTypes: true });
    const packs: Array<{
      name: string; version: string; path: string;
      displayName?: string; author?: string; description?: string;
      crblPath?: string; crblSize?: number; createdAt?: number;
      crblFiles?: Array<{ path: string; name: string; size: number; createdAt: number }>;
      tables?: string[];
    }> = [];

    // Collect .crbl files at the packs directory level
    const crblFiles = entries.filter((e) => !e.isDirectory() && e.name.endsWith('.crbl'));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const packageJsonPath = path.join(packsDir, entry.name, 'package.json');
      if (!fs.existsSync(packageJsonPath)) continue;

      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

        // Find all matching .crbl files for this pack
        const matchingCrbls = crblFiles
          .filter((f) => f.name.startsWith(entry.name))
          .map((f) => {
            const fp = path.join(packsDir, f.name);
            const stat = fs.statSync(fp);
            return { path: fp, name: f.name, size: stat.size, createdAt: stat.mtimeMs };
          })
          .sort((a, b) => b.createdAt - a.createdAt); // newest first

        // Latest .crbl for backwards compat
        const latestCrbl = matchingCrbls[0];
        let crblPath: string | undefined;
        let crblSize: number | undefined;
        let createdAt: number | undefined;
        if (latestCrbl) {
          crblPath = latestCrbl.path;
          crblSize = latestCrbl.size;
          createdAt = latestCrbl.createdAt;
        }

        // Extract table names from pipelines if available
        const tables: string[] = [];
        if (pkg.streamtags) {
          const tags = typeof pkg.streamtags === 'string' ? pkg.streamtags : '';
          if (tags) tables.push(...tags.split(',').map((t: string) => t.trim()));
        }

        packs.push({
          name: pkg.name || entry.name,
          version: pkg.version || '0.0.0',
          path: path.join(packsDir, entry.name),
          displayName: pkg.displayName || pkg.name || entry.name,
          author: pkg.author,
          description: pkg.description,
          crblPath,
          crblSize,
          createdAt,
          crblFiles: matchingCrbls,
          tables,
        });
      } catch (err) {
        logger.warn('pack-builder', `Failed to read package.json for pack '${entry.name}'`, err);
        packs.push({
          name: entry.name,
          version: '0.0.0',
          path: path.join(packsDir, entry.name),
        });
      }
    }

    return packs;
  });

  ipcMain.handle('pack:delete', async (_event, { packName }: { packName: string }) => {
    const packsDir = getPacksDir();
    const packDir = path.join(packsDir, packName);

    if (!packDir.startsWith(packsDir)) {
      throw new Error('Access denied: path outside packs directory');
    }

    // Remove pack directory
    if (fs.existsSync(packDir)) {
      fs.rmSync(packDir, { recursive: true, force: true });
    }
    // Remove all associated .crbl files
    if (fs.existsSync(packsDir)) {
      for (const f of fs.readdirSync(packsDir)) {
        if (f.endsWith('.crbl') && f.startsWith(packName)) {
          fs.unlinkSync(path.join(packsDir, f));
        }
      }
    }
  });

  // Delete a specific .crbl file by name
  ipcMain.handle('pack:delete-crbl', async (_event, { crblName }: { crblName: string }) => {
    const packsDir = getPacksDir();
    const crblPath = path.join(packsDir, crblName);
    if (!crblPath.startsWith(packsDir) || !crblName.endsWith('.crbl')) {
      throw new Error('Access denied');
    }
    if (fs.existsSync(crblPath)) {
      fs.unlinkSync(crblPath);
    }
  });

  // Clean up orphaned and old-version .crbl files
  ipcMain.handle('pack:clean', async () => {
    const packsDir = getPacksDir();
    if (!fs.existsSync(packsDir)) return { removed: [], freedBytes: 0 };

    const entries = fs.readdirSync(packsDir, { withFileTypes: true });
    const packDirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    const crblFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.crbl')).map((e) => e.name);

    // Group .crbl files by pack name prefix
    const crblsByPack = new Map<string, string[]>();
    for (const crbl of crblFiles) {
      // Extract pack name: everything before _version.crbl or .crbl
      const match = crbl.match(/^(.+?)(?:_\d|\.crbl$)/);
      const packPrefix = match ? match[1] : crbl.replace('.crbl', '');
      const group = crblsByPack.get(packPrefix) || [];
      group.push(crbl);
      crblsByPack.set(packPrefix, group);
    }

    const removed: string[] = [];
    let freedBytes = 0;

    for (const [packPrefix, files] of crblsByPack) {
      const isOrphaned = !packDirs.has(packPrefix);

      if (isOrphaned) {
        // Remove all .crbl files for packs with no directory
        for (const f of files) {
          const fullPath = path.join(packsDir, f);
          freedBytes += fs.statSync(fullPath).size;
          fs.unlinkSync(fullPath);
          removed.push(f);
        }
      } else if (files.length > 1) {
        // Keep only the newest .crbl, remove older versions
        const sorted = files.sort((a, b) => {
          const aStat = fs.statSync(path.join(packsDir, a));
          const bStat = fs.statSync(path.join(packsDir, b));
          return bStat.mtimeMs - aStat.mtimeMs;
        });
        for (const f of sorted.slice(1)) {
          const fullPath = path.join(packsDir, f);
          freedBytes += fs.statSync(fullPath).size;
          fs.unlinkSync(fullPath);
          removed.push(f);
        }
      }
    }

    return { removed, freedBytes };
  });

  // Get storage info for the packs directory
  ipcMain.handle('pack:storage-info', async () => {
    const pd = getPacksDir();
    if (!fs.existsSync(pd)) {
      return { packsDir: pd, totalSize: 0, packCount: 0, crblCount: 0, orphanedCrblCount: 0, oldVersionCount: 0 };
    }

    const entries = fs.readdirSync(pd, { withFileTypes: true });
    const packDirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    const crblFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.crbl')).map((e) => e.name);

    let totalSize = 0;
    let orphanedCrblCount = 0;
    let oldVersionCount = 0;

    // Calculate total size of all .crbl files
    const crblsByPack = new Map<string, string[]>();
    for (const crbl of crblFiles) {
      totalSize += fs.statSync(path.join(pd, crbl)).size;
      const match = crbl.match(/^(.+?)(?:_\d|\.crbl$)/);
      const packPrefix = match ? match[1] : crbl.replace('.crbl', '');
      if (!packDirs.has(packPrefix)) {
        orphanedCrblCount++;
      } else {
        const group = crblsByPack.get(packPrefix) || [];
        group.push(crbl);
        crblsByPack.set(packPrefix, group);
      }
    }

    // Count old versions (more than 1 .crbl per pack)
    for (const files of crblsByPack.values()) {
      if (files.length > 1) oldVersionCount += files.length - 1;
    }

    // Add directory sizes
    for (const dir of packDirs) {
      const dirPath = path.join(pd, dir);
      try {
        const walk = (d: string): number => {
          let size = 0;
          for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const fp = path.join(d, f.name);
            size += f.isDirectory() ? walk(fp) : fs.statSync(fp).size;
          }
          return size;
        };
        totalSize += walk(dirPath);
      } catch (err) { logger.warn('pack-builder', `Failed to calculate size of pack directory '${dir}'`, err); }
    }

    return { packsDir: pd, totalSize, packCount: packDirs.size, crblCount: crblFiles.length, orphanedCrblCount, oldVersionCount };
  });

  // List all available source types with their fields and vendor presets
  ipcMain.handle('pack:source-types', async () => {
    return Object.entries(SOURCE_TYPES).map(([id, def]) => ({
      id,
      name: def.name,
      description: def.description,
      category: def.category,
      criblType: def.criblType,
      fields: def.fields,
      hasDiscovery: !!def.discovery?.enabled,
      discoveryDescription: def.discovery?.description || '',
      discoveryFields: def.discovery?.fields || [],
      vendorPresets: def.vendorPresets
        ? Object.entries(def.vendorPresets).map(([key, preset]) => ({
            key,
            label: preset.label,
            description: preset.description,
          }))
        : [],
    }));
  });

  // Suggest a source type for a given vendor/solution name
  ipcMain.handle('pack:suggest-source', async (_event, { solutionName, tableName }: { solutionName: string; tableName: string }) => {
    return suggestSourceType(solutionName, tableName);
  });

  // Analyze sample data against DCR schemas -- returns gap analysis without building a pack.
  // Called by the UI after sample upload to show field mapping results.
  ipcMain.handle('pack:analyze-samples', async (_event, {
    solutionName,
    samples,
  }: {
    solutionName: string;
    samples: Array<{ logType: string; tableName: string; rawEvents: string[] }>;
  }) => {
    try {
      const routing = await kqlParser.getTableRoutingForSolution(solutionName);

      const { matchFields: autoMatch } = await import('./field-matcher');

      const results: Array<{
        tableName: string;
        logType: string;
        sourceFieldCount: number;
        destFieldCount: number;
        passthroughCount: number;
        dcrHandledCount: number;
        criblHandledCount: number;
        overflowCount: number;
        dcrRenames: Array<{ source: string; dest: string }>;
        dcrCoercions: Array<{ field: string; toType: string }>;
        criblRenames: Array<{ source: string; dest: string; reason: string }>;
        criblCoercions: Array<{ field: string; fromType: string; toType: string }>;
        routeCondition: string;
        fieldMappings: Array<{
          source: string; dest: string; sourceType: string; destType: string;
          confidence: string; action: string; needsCoercion: boolean;
          description: string; sampleValue?: string;
        }>;
        destSchema: Array<{ name: string; type: string }>;
      }> = [];

      const { parseSampleContent: analyzeParser } = await import('./sample-parser');

      for (const sample of samples) {
        // Extract source fields using the sample parser (handles CEF, CSV, JSON, KV, etc.)
        let sourceFields: Array<{ name: string; type: string }> = [];
        try {
          const parsed = analyzeParser(sample.rawEvents.join('\n'), 'sample');
          sourceFields = parsed.fields.map((f: any) => ({ name: f.name, type: f.type }));
        } catch (err) { logger.warn('pack-builder', `Sample parser failed for table '${sample.tableName}', falling back to JSON parse`, err); }

        // Fallback: try JSON.parse for pre-parsed events (e.g., Cribl captures)
        if (sourceFields.length === 0) {
          const fieldMap = new Map<string, string>();
          for (const raw of sample.rawEvents.slice(0, 10)) {
            try {
              const evt = JSON.parse(raw);
              for (const [k, v] of Object.entries(evt)) {
                if (!fieldMap.has(k)) {
                  const t = typeof v === 'number' ? (Number.isInteger(v) ? 'long' : 'real') :
                    typeof v === 'boolean' ? 'boolean' :
                    typeof v === 'object' ? 'dynamic' : 'string';
                  fieldMap.set(k, t);
                }
              }
            } catch (err) { logger.warn('pack-builder', `Failed to JSON-parse fallback sample event for table '${sample.tableName}'`, err); }
          }
          sourceFields = Array.from(fieldMap.entries()).map(([name, type]) => ({ name, type }));
        }

        // Get destination schema
        const destSchema = loadDcrTemplateSchemaPublic(sample.tableName);

        // Find DCR flow for this table (always attempt, regardless of routing results)
        const flow = await (async () => {
          try {
            if (!sentinelRepo.isRepoReady()) return null;
            const solutions = sentinelRepo.listSolutions();
            const lower = solutionName.toLowerCase().replace(/[^a-z0-9]/g, '');
            const solMatch = solutions.find((s: { name: string }) => {
              const k = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
              return k === lower || k.includes(lower) || lower.includes(k);
            });
            if (!solMatch) return null;
            const connectors = sentinelRepo.listConnectorFiles(solMatch.name);
            const dcrFiles = connectors.filter((f: { name: string }) => f.name.toLowerCase().includes('dcr') && f.name.toLowerCase().endsWith('.json'));
            for (const dcrFile of dcrFiles) {
              const content = sentinelRepo.readRepoFile(dcrFile.path);
              if (!content) continue;
              try {
                const parsed = kqlParser.parseDcrJson(content);
                const match = parsed.flows.find((fl) => fl.tableName.toLowerCase() === sample.tableName.toLowerCase());
                if (match) return match;
              } catch (parseErr) { logger.warn('pack-builder', `Failed to parse DCR JSON during analyze-samples for '${dcrFile.name}'`, parseErr); continue; }
            }
            return null;
          } catch (err) { logger.warn('pack-builder', `Sentinel repo lookup failed during analyze-samples for '${solutionName}'`, err); return null; }
        })();

        const routeInfo = routing.find((r) => r.tableName.toLowerCase() === sample.tableName.toLowerCase());

        // Run field matching to get full mapping details
        const matchSrc = sourceFields.map((f) => ({ name: f.name, type: f.type, sampleValue: '' }));
        const matchDest = destSchema.map((f) => ({ name: f.name, type: f.type }));
        let fieldMappings: Array<{
          source: string; dest: string; sourceType: string; destType: string;
          confidence: string; action: string; needsCoercion: boolean;
          description: string; sampleValue?: string;
        }> = [];

        if (matchSrc.length > 0 && matchDest.length > 0) {
          try {
            const matchResult = autoMatch(matchSrc, matchDest, undefined, sample.tableName);
            fieldMappings = [
              ...matchResult.matched.map((m) => ({
                source: m.sourceName, dest: m.destName,
                sourceType: m.sourceType, destType: m.destType,
                confidence: m.confidence, action: m.action,
                needsCoercion: m.needsCoercion, description: m.description,
                sampleValue: m.sampleValue,
              })),
              ...matchResult.overflow.map((o) => ({
                source: o.sourceName, dest: o.destName,
                sourceType: o.sourceType, destType: o.destType,
                confidence: 'unmatched' as const, action: 'overflow' as const,
                needsCoercion: false, description: 'Collected into overflow field',
                sampleValue: o.sampleValue,
              })),
            ];
          } catch (err) { logger.warn('pack-builder', `Field matching failed during analyze-samples for table '${sample.tableName}'`, err); }
        }

        // Derive summary counts from the field matcher results (fieldMappings)
        // which include alias/fuzzy matching, rather than from analyzeDcrGap
        // which only does exact name matching and misses aliases like src->SourceIP.
        const keepCount = fieldMappings.filter((m) => m.action === 'keep' && !m.needsCoercion).length;
        const renameCount = fieldMappings.filter((m) => m.action === 'rename').length;
        const coerceCount = fieldMappings.filter((m) => m.action === 'coerce' || (m.action === 'keep' && m.needsCoercion)).length;
        const overflowCount = fieldMappings.filter((m) => m.action === 'overflow').length;

        // Still run DCR gap analysis for DCR-specific rename/coercion details
        let dcrRenames: Array<{ source: string; dest: string }> = [];
        let dcrCoercions: Array<{ field: string; toType: string }> = [];
        let dcrHandledCount = 0;
        if (sourceFields.length > 0 && destSchema.length > 0) {
          try {
            const effectiveFlow = flow || {
              outputStream: `Custom-${sample.tableName}`,
              tableName: sample.tableName,
              eventSimpleNames: [],
              renames: [],
              typeConversions: [],
              columns: destSchema,
            };
            const gap = kqlParser.analyzeDcrGap(sourceFields, destSchema, effectiveFlow);
            dcrRenames = gap.dcrHandles.renames;
            dcrCoercions = gap.dcrHandles.coercions;
            dcrHandledCount = gap.dcrHandledCount;
          } catch (err) { logger.warn('pack-builder', `DCR gap analysis failed for table '${sample.tableName}'`, err); }
        }

        results.push({
          tableName: sample.tableName,
          logType: sample.logType,
          sourceFieldCount: sourceFields.length,
          destFieldCount: destSchema.length,
          passthroughCount: keepCount,
          dcrHandledCount,
          criblHandledCount: renameCount + coerceCount,
          overflowCount,
          dcrRenames,
          dcrCoercions,
          criblRenames: fieldMappings
            .filter((m) => m.action === 'rename')
            .map((m) => ({ source: m.source, dest: m.dest, reason: m.description })),
          criblCoercions: fieldMappings
            .filter((m) => m.needsCoercion)
            .map((m) => ({ field: m.dest, fromType: m.sourceType, toType: m.destType })),
          routeCondition: routeInfo?.routeCondition || 'true',
          fieldMappings,
          destSchema: destSchema.map((f) => ({ name: f.name, type: f.type })),
        });
      }

      return { success: true, analyses: results };
    } catch (err) {
      return { success: false, analyses: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Parse analytics rule YAML content and extract field references
  ipcMain.handle('pack:parse-rule-yaml', async (_event, {
    yamlContents,
  }: {
    yamlContents: Array<{ fileName: string; content: string }>;
  }) => {
    try {
      const rules: Array<{ name: string; severity: string; requiredFields: string[]; fileName: string }> = [];

      for (const { fileName, content } of yamlContents) {
        try {
          const name = content.match(/^name:\s*(.+)/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || fileName;
          const severity = content.match(/^severity:\s*(.+)/m)?.[1]?.trim() || 'Unknown';

          const queryMatch = content.match(/^query:\s*\|?\s*\n([\s\S]*?)(?=^[a-zA-Z]|\Z)/m);
          const query = queryMatch?.[1] || '';
          const kqlFields = sentinelRepo.extractKqlFields(query);

          const entityFields: string[] = [];
          const colMatches = content.matchAll(/columnName:\s*(\w+)/g);
          for (const cm of colMatches) {
            if (cm[1]) entityFields.push(cm[1]);
          }

          const allFields = [...new Set([...kqlFields, ...entityFields])].sort();
          if (allFields.length > 0) {
            rules.push({ name, severity, requiredFields: allFields, fileName });
          }
        } catch (err) { logger.warn('pack-builder', `Failed to parse analytics rule YAML from '${fileName}'`, err); }
      }

      return { success: true, rules };
    } catch (err) {
      return { success: false, rules: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Analyze analytics rule field coverage against source sample fields
  ipcMain.handle('pack:rule-coverage', async (_event, {
    solutionName, sourceFields, destFields, customRules, destTable, destTables,
  }: {
    solutionName: string;
    sourceFields: string[];
    destFields?: string[];
    customRules?: Array<{ name: string; severity: string; requiredFields: string[]; fileName: string }>;
    destTable?: string;
    destTables?: string[];
  }) => {
    try {

      // Load schemas from ALL destination tables and union their columns.
      // This handles multi-table solutions (e.g., CrowdStrike with 10 custom tables)
      // and cases where the rule's KQL references a different table than the dataConnector.
      const allTableNames = [...new Set([
        ...(destTables || []),
        ...(destTable ? [destTable] : []),
      ])];
      const tableSchemaColumns = new Set<string>();
      for (const tbl of allTableNames) {
        const schema = loadDcrTemplateSchemaPublic(tbl);
        for (const c of schema) tableSchemaColumns.add(c.name);
      }

      const repoRules = sentinelRepo.listAnalyticRules(
        solutionName,
        tableSchemaColumns.size > 0 ? tableSchemaColumns : undefined,
      );

      // Merge repo rules + custom uploaded rules (custom rules also filtered against schema)
      const schemaLower = tableSchemaColumns.size > 0 ? new Set([...tableSchemaColumns].map((c) => c.toLowerCase())) : null;
      const allRules = [
        ...repoRules.map((r) => ({ name: r.name, severity: r.severity, tactics: r.tactics, requiredFields: r.requiredFields, query: r.query, custom: false })),
        ...(customRules || []).map((r) => ({
          name: r.name, severity: r.severity, tactics: [] as string[],
          requiredFields: schemaLower ? r.requiredFields.filter((f) => schemaLower.has(f.toLowerCase())) : r.requiredFields,
          query: '', custom: true,
        })),
      ];

      if (allRules.length === 0) return { rules: [], summary: { totalRules: 0, fullyCovered: 0, partiallyCovered: 0, missingFieldsAcrossRules: [], ruleReferencedFields: [] } };

      // Combine source + dest field names for coverage check (case-insensitive)
      const allAvailable = new Set([...sourceFields, ...(destFields || [])].map((f) => f.toLowerCase()));

      const ruleResults = allRules.map((rule) => {
        const covered = rule.requiredFields.filter((f) => allAvailable.has(f.toLowerCase()));
        const missing = rule.requiredFields.filter((f) => !allAvailable.has(f.toLowerCase()));
        return {
          name: rule.name,
          severity: rule.severity,
          tactics: rule.tactics,
          totalFields: rule.requiredFields.length,
          coveredFields: covered,
          missingFields: missing,
          coverage: rule.requiredFields.length > 0 ? covered.length / rule.requiredFields.length : 1,
          custom: rule.custom,
          query: rule.query,
        };
      });

      const fullyCovered = ruleResults.filter((r) => r.coverage === 1).length;
      const partiallyCovered = ruleResults.filter((r) => r.coverage > 0 && r.coverage < 1).length;

      // Aggregate missing fields sorted by frequency (most-needed first)
      const missingFreq = new Map<string, number>();
      for (const r of ruleResults) {
        for (const f of r.missingFields) {
          missingFreq.set(f, (missingFreq.get(f) || 0) + 1);
        }
      }
      const missingFieldsAcrossRules = [...missingFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([f]) => f);

      // Collect all unique fields referenced by any analytics rule
      const ruleReferencedFields = [...new Set(allRules.flatMap((r) => r.requiredFields))].sort();

      return {
        rules: ruleResults,
        summary: {
          totalRules: allRules.length,
          fullyCovered,
          partiallyCovered,
          missingFieldsAcrossRules,
          ruleReferencedFields,
        },
      };
    } catch (err) {
      return { rules: [], summary: { totalRules: 0, fullyCovered: 0, partiallyCovered: 0, missingFieldsAcrossRules: [], ruleReferencedFields: [] }, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
