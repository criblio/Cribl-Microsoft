// KQL Parser for DCR transformKql
// Extracts routing rules, field mappings, and type conversions from
// Azure DCR dataFlow transformKql statements.
//
// Used by:
//   - Route condition generator (event_simpleName groups per table)
//   - Schema extractor (column names + types from extend/project-rename)
//   - Vendor research auto-resolver (enriches table definitions)

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DcrDataFlow {
  outputStream: string;           // e.g., "Custom-CrowdStrike_Process_Events_CL"
  tableName: string;              // e.g., "CrowdStrike_Process_Events_CL"
  eventSimpleNames: string[];     // event_simpleName values that route to this table
  renames: Array<{ dest: string; source: string }>;
  typeConversions: Array<{ field: string; toType: string }>;
  columns: Array<{ name: string; type: string }>;
}

export interface ParsedDcr {
  flows: DcrDataFlow[];
  totalEventNames: number;
  totalColumns: number;
}

// ---------------------------------------------------------------------------
// KQL Parsing
// ---------------------------------------------------------------------------

function parseTransformKql(kql: string): Omit<DcrDataFlow, 'outputStream' | 'tableName'> {
  const clean = kql.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Extract event_simpleName in (...) list
  const esnMatch = clean.match(/event_simpleName\s+in\s*\(([^)]+)\)/);
  const eventSimpleNames: string[] = [];
  if (esnMatch) {
    const raw = esnMatch[1];
    // Split on comma, strip quotes and whitespace
    for (const part of raw.split(',')) {
      const name = part.trim().replace(/^'|'$/g, '').trim();
      if (name) eventSimpleNames.push(name);
    }
  }

  // Extract project-rename: dest = ['source'] or dest = source
  const renames: Array<{ dest: string; source: string }> = [];
  const renameBlock = clean.match(/project-rename\s+([\s\S]*?)(?=\n\s*\||\n*$)/);
  if (renameBlock) {
    const renameRegex = /(\w+)\s*=\s*\[?'?(\w+)'?\]?/g;
    let m: RegExpExecArray | null;
    while ((m = renameRegex.exec(renameBlock[1])) !== null) {
      const dest = m[1];
      const source = m[2];
      // Skip KQL function calls
      if (['iff', 'isnotempty', 'now', 'todatetime', 'tolong', 'todouble', 'toint',
           'tobool', 'todynamic', 'datetime_add', 'source', 'extend'].includes(dest)) continue;
      if (dest !== source) {
        renames.push({ dest, source });
      }
    }
  }

  // Extract type conversions from extend: field = tolong(field), field = todouble(field)
  const typeConversions: Array<{ field: string; toType: string }> = [];
  const typeMap: Record<string, string> = {
    tolong: 'long', todouble: 'real', toint: 'int',
    tobool: 'boolean', todynamic: 'dynamic', tostring: 'string',
  };
  const extendBlocks = clean.match(/extend\s+([\s\S]*?)(?=\n\s*\||\n*$)/g) || [];
  for (const block of extendBlocks) {
    const convRegex = /(\w+)\s*=\s*(tolong|todouble|toint|tobool|todynamic|tostring)\((?:\[?'?)?(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = convRegex.exec(block)) !== null) {
      typeConversions.push({ field: m[1], toType: typeMap[m[2]] || 'string' });
    }
  }

  // Build column list from renames + type conversions
  const columnMap = new Map<string, string>();
  // Always include TimeGenerated
  columnMap.set('TimeGenerated', 'datetime');

  for (const r of renames) {
    columnMap.set(r.dest, 'string');
  }
  for (const tc of typeConversions) {
    columnMap.set(tc.field, tc.toType);
  }

  // Add event_simpleName and common FDR fields if this is an event_simpleName-based flow
  if (eventSimpleNames.length > 0) {
    if (!columnMap.has('event_simpleName')) columnMap.set('event_simpleName', 'string');
    if (!columnMap.has('timestamp')) columnMap.set('timestamp', 'long');
    if (!columnMap.has('aid')) columnMap.set('aid', 'string');
    if (!columnMap.has('aip')) columnMap.set('aip', 'string');
    if (!columnMap.has('cid')) columnMap.set('cid', 'string');
    if (!columnMap.has('event_platform')) columnMap.set('event_platform', 'string');
  }

  const columns = Array.from(columnMap.entries()).map(([name, type]) => ({ name, type }));

  return { eventSimpleNames, renames, typeConversions, columns };
}

// ---------------------------------------------------------------------------
// DCR JSON Parser
// ---------------------------------------------------------------------------

export function parseDcrJson(content: string): ParsedDcr {
  const raw = JSON.parse(content);

  // Handle multiple JSON structures found in the Sentinel repo:
  //   1. Direct DCR object:  { properties: { dataFlows: [...] } }
  //   2. ARM template:       { resources: [{ type: "...dataCollectionRules", properties: { dataFlows: [...] } }] }
  //   3. Array wrapper:      [ { properties: { dataFlows: [...] } } ]
  let dcrObj = Array.isArray(raw) ? raw[0] : raw;

  // ARM template -- find the DCR resource inside resources[]
  if (dcrObj?.resources && Array.isArray(dcrObj.resources)) {
    const dcrResource = dcrObj.resources.find((r: Record<string, unknown>) =>
      typeof r.type === 'string' && r.type.toLowerCase().includes('datacollectionrules')
    );
    if (dcrResource) dcrObj = dcrResource;
  }

  const dataFlows = dcrObj?.properties?.dataFlows || [];

  const flows: DcrDataFlow[] = [];
  let totalEventNames = 0;
  let totalColumns = 0;

  for (const flow of dataFlows) {
    const kql = flow.transformKql || '';
    const outputStream = flow.outputStream || flow.streams?.[0] || '';
    const tableName = outputStream.replace(/^Custom-/, '').replace(/^Microsoft-/, '');

    const parsed = parseTransformKql(kql);
    totalEventNames += parsed.eventSimpleNames.length;
    totalColumns += parsed.columns.length;

    flows.push({
      outputStream,
      tableName,
      ...parsed,
    });
  }

  return { flows, totalEventNames, totalColumns };
}

// ---------------------------------------------------------------------------
// Route Condition Generator
// ---------------------------------------------------------------------------

// Generate a Cribl route condition expression from event_simpleName lists.
// For tables with a small number of events: exact match list.
// For tables with many events: use a Set lookup for performance.
export function generateRouteCondition(eventNames: string[]): string {
  if (eventNames.length === 0) return 'true';
  if (eventNames.length === 1) return `event_simpleName == '${eventNames[0]}'`;
  if (eventNames.length <= 5) {
    return eventNames.map((n) => `event_simpleName == '${n}'`).join(' || ');
  }
  // For large lists, use a regex or in() expression
  // Cribl supports: /regex/.test(field) or field.match(/regex/)
  return `/${eventNames.join('|')}/.test(event_simpleName)`;
}

// ---------------------------------------------------------------------------
// Public API: Parse DCR from Sentinel repo and return route conditions + schemas
// ---------------------------------------------------------------------------

export interface TableRoutingInfo {
  tableName: string;
  outputStream: string;
  routeCondition: string;
  eventSimpleNames: string[];
  columns: Array<{ name: string; type: string }>;
  typeConversions: Array<{ field: string; toType: string }>;
}

export function extractTableRouting(dcrContent: string): TableRoutingInfo[] {
  const parsed = parseDcrJson(dcrContent);
  return parsed.flows.map((flow) => ({
    tableName: flow.tableName,
    outputStream: flow.outputStream,
    routeCondition: generateRouteCondition(flow.eventSimpleNames),
    eventSimpleNames: flow.eventSimpleNames,
    columns: flow.columns,
    typeConversions: flow.typeConversions,
  }));
}

// ---------------------------------------------------------------------------
// Sentinel Repo Integration: Find and parse DCR for a solution
// ---------------------------------------------------------------------------

export async function getTableRoutingForSolution(solutionName: string): Promise<TableRoutingInfo[]> {
  let sentinelRepo: typeof import('./sentinel-repo') | null = null;
  try { sentinelRepo = await import('./sentinel-repo'); } catch { return []; }
  if (!sentinelRepo.isRepoReady()) return [];

  const solutions = sentinelRepo.listSolutions();
  const lower = solutionName.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Find matching solution
  const match = solutions.find((s) => {
    const solKey = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return solKey === lower || solKey.includes(lower) || lower.includes(solKey);
  });
  if (!match) return [];

  // Find DCR.json files in the solution's Data Connectors
  const connectors = sentinelRepo.listConnectorFiles(match.name);
  const dcrFiles = connectors.filter((f) =>
    f.name.toLowerCase().includes('dcr') && f.name.toLowerCase().endsWith('.json')
  );

  const allRouting: TableRoutingInfo[] = [];
  for (const dcrFile of dcrFiles) {
    const content = sentinelRepo.readRepoFile(dcrFile.path);
    if (!content) continue;
    try {
      const routing = extractTableRouting(content);
      allRouting.push(...routing);
    } catch { /* skip unparseable DCRs */ }
  }

  return allRouting;
}

// ---------------------------------------------------------------------------
// DCR Gap Analysis
// ---------------------------------------------------------------------------
// Compares source sample data fields against what the DCR expects as INPUT,
// and determines exactly what Cribl needs to transform vs what the DCR handles.
//
// The DCR's transformKql defines:
//   - project-rename: field renames the DCR does (Cribl should NOT duplicate)
//   - extend tolong()/todouble(): type coercions the DCR does (Cribl should NOT duplicate)
//   - where event_simpleName in (...): routing the DCR does (Cribl mirrors for pack routing)
//
// The Cribl pipeline should ONLY handle:
//   - Fields that need renaming but the DCR does NOT rename
//   - Type coercions the DCR does NOT handle
//   - Fields present in source but absent from DCR schema (overflow/drop)
//   - _time extraction (Cribl-specific, not in DCR)
//   - Cribl metadata cleanup (cribl_*, __header*, etc.)

export interface GapAnalysisField {
  fieldName: string;
  sourceType: string;
  destType: string;
  action: 'passthrough' | 'cribl_rename' | 'cribl_coerce' | 'cribl_overflow' | 'cribl_drop' | 'cribl_enrich';
  reason: string;
}

export interface DcrGapAnalysis {
  tableName: string;
  // What the DCR handles -- Cribl should NOT touch these
  dcrHandles: {
    renames: Array<{ source: string; dest: string }>;     // DCR does project-rename
    coercions: Array<{ field: string; toType: string }>;   // DCR does extend toType()
    routing: string;                                       // DCR does event_simpleName filter
    timeGenerated: boolean;                                // DCR derives TimeGenerated
  };
  // What Cribl must handle -- gaps the DCR doesn't cover
  criblMustHandle: {
    renames: Array<{ source: string; dest: string; reason: string }>;
    coercions: Array<{ field: string; fromType: string; toType: string; reason: string }>;
    overflow: Array<{ field: string; type: string }>;       // Source fields not in dest schema
    drops: Array<{ field: string; reason: string }>;        // Cribl internal fields to remove
    enrichments: Array<{ field: string; value: string }>;   // Fields to add (Type, _time)
  };
  // Summary
  totalSourceFields: number;
  totalDestFields: number;
  passthroughCount: number;      // Fields that flow through untouched (source name = dest name, same type)
  dcrHandledCount: number;       // Fields the DCR transforms
  criblHandledCount: number;     // Fields Cribl must transform
  overflowCount: number;         // Source fields not in dest schema
}

export function analyzeDcrGap(
  sourceFields: Array<{ name: string; type: string }>,
  destColumns: Array<{ name: string; type: string }>,
  dcrFlow: DcrDataFlow,
): DcrGapAnalysis {
  const destMap = new Map(destColumns.map((c) => [c.name.toLowerCase(), c]));
  const dcrRenameMap = new Map(dcrFlow.renames.map((r) => [r.source.toLowerCase(), r]));
  const dcrCoercionMap = new Map(dcrFlow.typeConversions.map((tc) => [tc.field.toLowerCase(), tc]));

  // System fields Cribl should always remove
  const criblInternalFields = new Set([
    'cribl_breaker', 'cribl_pipe', 'cribl_host', 'cribl_input', 'cribl_output',
    'cribl_wp', '__inputId', '__criblMetrics', '__final', '__channel',
    '__destHost', '__destPort', '__spanId', '__traceId',
    '__header_content_type', '__header_content_length',
    'source', 'host', 'port', 'sourcetype', 'index',
  ]);

  const analysis: DcrGapAnalysis = {
    tableName: dcrFlow.tableName,
    dcrHandles: {
      renames: dcrFlow.renames,
      coercions: dcrFlow.typeConversions,
      routing: generateRouteCondition(dcrFlow.eventSimpleNames),
      timeGenerated: true, // DCR always derives TimeGenerated
    },
    criblMustHandle: {
      renames: [],
      coercions: [],
      overflow: [],
      drops: [],
      enrichments: [
        { field: '_time', value: 'Number(timestamp) / 1000 || Number(ContextTimeStamp) || Date.now() / 1000' },
        { field: 'Type', value: `'${dcrFlow.tableName}'` },
      ],
    },
    totalSourceFields: sourceFields.length,
    totalDestFields: destColumns.length,
    passthroughCount: 0,
    dcrHandledCount: dcrFlow.renames.length + dcrFlow.typeConversions.length,
    criblHandledCount: 0,
    overflowCount: 0,
  };

  for (const src of sourceFields) {
    const srcLower = src.name.toLowerCase();

    // Skip Cribl internal fields -- always drop
    if (criblInternalFields.has(src.name) || src.name.startsWith('cribl_') || src.name.startsWith('__')) {
      analysis.criblMustHandle.drops.push({ field: src.name, reason: 'Cribl internal metadata' });
      continue;
    }

    // Check if DCR renames this field
    const dcrRename = dcrRenameMap.get(srcLower);
    if (dcrRename) {
      // DCR handles the rename -- Cribl passes through the SOURCE field name
      analysis.dcrHandledCount++;
      analysis.passthroughCount++;
      continue;
    }

    // Check if field exists in destination (exact name match)
    const destField = destMap.get(srcLower);
    if (destField) {
      // Check if DCR coerces the type
      const dcrCoercion = dcrCoercionMap.get(srcLower);
      if (dcrCoercion) {
        // DCR handles type coercion -- Cribl passes through
        analysis.passthroughCount++;
        continue;
      }

      // Check if types match
      const typesMatch = typesCompatible(src.type, destField.type);
      if (typesMatch) {
        // Perfect passthrough -- same name, same type
        analysis.passthroughCount++;
      } else {
        // Name matches but type differs, and DCR doesn't coerce it
        // Cribl must coerce
        analysis.criblMustHandle.coercions.push({
          field: src.name,
          fromType: src.type,
          toType: destField.type,
          reason: `Type mismatch: source ${src.type} vs dest ${destField.type}, not handled by DCR`,
        });
        analysis.criblHandledCount++;
      }
      continue;
    }

    // Field not in destination schema by exact name -- check case-insensitive
    const destByCI = destColumns.find((d) => d.name.toLowerCase() === srcLower);
    if (destByCI) {
      // Case differs but names match -- check if DCR renames
      // If not, Cribl may need to rename (Azure tables are case-sensitive)
      analysis.criblMustHandle.renames.push({
        source: src.name,
        dest: destByCI.name,
        reason: `Case mismatch: source "${src.name}" vs dest "${destByCI.name}"`,
      });
      analysis.criblHandledCount++;
      continue;
    }

    // Field not in destination at all -- overflow
    analysis.criblMustHandle.overflow.push({ field: src.name, type: src.type });
    analysis.overflowCount++;
  }

  // Always need to clean Cribl metadata
  analysis.criblMustHandle.drops.push(
    { field: '_raw', reason: 'Raw event string, not needed after extraction' },
    { field: 'cribl_*', reason: 'Cribl pipeline metadata' },
    { field: '__*', reason: 'Cribl transport metadata' },
  );

  analysis.criblHandledCount += analysis.criblMustHandle.enrichments.length + analysis.criblMustHandle.drops.length;

  return analysis;
}

function typesCompatible(sourceType: string, destType: string): boolean {
  const s = sourceType.toLowerCase();
  const d = destType.toLowerCase();
  if (s === d) return true;
  // String is compatible with anything (DCR can coerce from string)
  if (s === 'string') return true;
  // long/int are interchangeable
  if ((s === 'long' || s === 'int') && (d === 'long' || d === 'int')) return true;
  // real/double are interchangeable
  if ((s === 'real' || s === 'double') && (d === 'real' || d === 'double')) return true;
  return false;
}
