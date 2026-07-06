/**
 * field-matcher CATALOG DRIVER - porting-plan Unit 13.
 *
 * Bridges the Unit 11 ParsedSample to the matcher: map discovered fields to
 * SourceFields (first example value as the tie-break sampleValue), resolve the
 * destination schema through the SchemaCatalog port, and match. Replaces the
 * legacy `fields:match-to-schema` IPC handler and its `await import(...)`
 * schema-loading contortion with a clean async port call.
 *
 * An empty/unresolved schema flows GRACEFULLY to an all-unmatched MatchResult
 * (never throws), matching the shape the legacy handler returned when
 * loadDcrTemplateSchemaPublic came back empty - plus a surfaced warning.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto (the IO is the caller's
 * SchemaCatalog adapter).
 */

import type { ParsedSample } from "../sample-parsing/models";
import type { DcrSchemaColumn, SchemaCatalog } from "../../ports/schema-catalog";
import type { MatchResult, SourceField } from "./models";
import { matchFields, type VendorMapping } from "./match-fields";

/**
 * Map a ParsedSample's discovered fields to matcher SourceFields. The first
 * example value becomes the tie-break sampleValue (legacy used sampleValues[0]).
 */
export function parsedSampleToSourceFields(sample: ParsedSample): SourceField[] {
  return sample.fields.map((field) => {
    const sampleValue = field.examples.length > 0 ? field.examples[0] : undefined;
    return sampleValue !== undefined
      ? { name: field.name, type: field.type, sampleValue }
      : { name: field.name, type: field.type };
  });
}

/** Build the all-unmatched result for an empty/unresolved schema (never throws). */
function allUnmatched(
  sourceFields: SourceField[],
  tableName: string,
): MatchResult {
  return {
    matched: [],
    overflow: [],
    unmatchedSource: sourceFields,
    unmatchedDest: [],
    overflowConfig: {
      enabled: false,
      fieldName: "",
      fieldType: "dynamic",
      sourceFields: [],
    },
    totalSource: sourceFields.length,
    totalDest: 0,
    matchRate: 0,
    warnings: [
      `No destination schema resolved for table "${tableName}"; all ` +
        `${sourceFields.length} field(s) are unmatched.`,
    ],
  };
}

/**
 * Match a ParsedSample against an already-resolved column set (or null). Pure
 * and synchronous - useful for the match-preview UI when the schema is in hand.
 */
export function matchParsedSampleToColumns(
  sample: ParsedSample,
  columns: DcrSchemaColumn[] | null,
  tableName: string,
  vendorMappings?: VendorMapping[],
): MatchResult {
  const sourceFields = parsedSampleToSourceFields(sample);
  if (!columns || columns.length === 0) {
    return allUnmatched(sourceFields, tableName);
  }
  const destFields = columns.map((column) => ({
    name: column.name,
    type: column.type,
  }));
  return matchFields(sourceFields, destFields, vendorMappings, tableName);
}

/**
 * Resolve `tableName` through the SchemaCatalog and match `sample` against it.
 * The GAP-ANALYSIS entry point: a ParsedSample in, a MatchResult out.
 */
export async function matchSampleToTable(
  sample: ParsedSample,
  catalog: SchemaCatalog,
  tableName: string,
  vendorMappings?: VendorMapping[],
): Promise<MatchResult> {
  const columns = await catalog.resolveSchema(tableName);
  return matchParsedSampleToColumns(sample, columns, tableName, vendorMappings);
}
