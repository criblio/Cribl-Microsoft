// Field Matcher -- thin facade over the Field Mapping Engine plus the IPC handlers.
//
// The matching intelligence (alias tables, scoring, overflow routing, the matchFields
// algorithm) now lives in field-mapping-engine.ts. This module re-exports that public surface
// so existing importers (pack-builder, sample-resolver, tests) keep working unchanged, and
// hosts the matchSampleToSchema convenience wrapper plus the IPC handlers (which dynamically
// load the DCR schema from pack-builder -- the one place this module depends on pack-builder).

import { IpcMain } from 'electron';
import { matchFields, getOverflowConfig, REVERSE_ALIAS, VALUE_NORMALIZATIONS } from './field-mapping-engine';
import type {
  SourceField,
  DestField,
  FieldMatch,
  OverflowConfig,
  MatchResult,
  MatchConfidence,
  MatchAction,
} from './field-mapping-engine';

// Re-export the engine's public surface so './field-matcher' import paths stay stable.
export { matchFields, getOverflowConfig, REVERSE_ALIAS, VALUE_NORMALIZATIONS };
export type {
  SourceField,
  DestField,
  FieldMatch,
  OverflowConfig,
  MatchResult,
  MatchConfidence,
  MatchAction,
};

// Convenience: match source fields from a parsed sample against a DCR schema
export function matchSampleToSchema(
  sampleFields: Array<{ name: string; type: string; sampleValues?: string[] }>,
  schemaColumns: Array<{ name: string; type: string }>,
  vendorMappings?: Array<{ sourceName: string; destName: string; sourceType: string; destType: string; action: string }>,
  tableName?: string,
): MatchResult {
  const sourceFields: SourceField[] = sampleFields.map((f) => ({
    name: f.name,
    type: f.type,
    sampleValue: f.sampleValues?.[0],
  }));
  const destFields: DestField[] = schemaColumns.map((c) => ({
    name: c.name,
    type: c.type,
  }));
  return matchFields(sourceFields, destFields, vendorMappings, tableName);
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerFieldMatcherHandlers(ipcMain: IpcMain) {
  // Auto-match source fields to destination schema
  ipcMain.handle('fields:match', async (_event, {
    sourceFields, destFields, vendorMappings,
  }: {
    sourceFields: SourceField[];
    destFields: DestField[];
    vendorMappings?: Array<{ sourceName: string; destName: string; sourceType: string; destType: string; action: string }>;
  }) => {
    return matchFields(sourceFields, destFields, vendorMappings);
  });

  // Match a parsed sample against a DCR schema by table name
  ipcMain.handle('fields:match-to-schema', async (_event, {
    sampleFields, tableName, vendorMappings,
  }: {
    sampleFields: Array<{ name: string; type: string; sampleValues?: string[] }>;
    tableName: string;
    vendorMappings?: Array<{ sourceName: string; destName: string; sourceType: string; destType: string; action: string }>;
  }) => {
    // Load DCR schema for the table
    const { loadDcrTemplateSchemaPublic } = await import('./pack-builder');
    const schemaColumns = loadDcrTemplateSchemaPublic(tableName);
    if (schemaColumns.length === 0) {
      return {
        matched: [],
        overflow: [],
        unmatchedSource: sampleFields.map((f) => ({ name: f.name, type: f.type })),
        unmatchedDest: [],
        overflowConfig: { enabled: false, fieldName: '', fieldType: 'dynamic' as const, sourceFields: [] },
        totalSource: sampleFields.length, totalDest: 0, matchRate: 0,
      };
    }
    return matchSampleToSchema(sampleFields, schemaColumns, vendorMappings, tableName);
  });
}
