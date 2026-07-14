/**
 * Lookup CSV + lookups.yml generation - porting-plan Unit 19, task item 6, and
 * section 3 contract 6.
 *
 * Ported from legacy pack-builder.ts (2311-2382). Each log type gets a
 * per-pipeline field-mapping lookup CSV so operators can inspect the resolved
 * mappings. The CSV has a FIXED 8-column header and a quote-and-double escaping
 * rule (both pinned as contract). The registry `lookups.yml` lives at `default/`
 * - NEVER `data/lookups/` (MEMORY reference_cribl_pack_structure; the CSV data
 * files themselves live under `data/lookups/`).
 *
 * Rows come from the field MatchResult (Unit 13) or, when the caller supplied
 * user overrides, from those directly - the same two sources the legacy used.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { MatchResult } from "../field-matcher";
import type { FieldMappingOverride } from "../pipeline-generation";

/** The fixed 8-column lookup CSV header (contract). */
export const LOOKUP_CSV_HEADER =
  "source_field,source_type,dest_field,dest_type,confidence,action,needs_coercion,description";

/** Directory (within the pack) holding lookup CSV data files. */
export const LOOKUP_DATA_DIR = "data/lookups";

/** Quote-and-double-escape one CSV cell (legacy escaping rule, verbatim). */
export function escapeCsvCell(value: string | undefined | null): string {
  const v = value ?? "";
  return v.includes(",") || v.includes('"') ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** Build lookup rows from a field MatchResult (matched + overflow). */
export function lookupRowsFromMatch(match: MatchResult): string[][] {
  return [
    ...match.matched.map((m) => [
      m.sourceName,
      m.sourceType,
      m.destName,
      m.destType,
      m.confidence,
      m.action,
      String(m.needsCoercion),
      m.description,
    ]),
    ...match.overflow.map((o) => [
      o.sourceName,
      o.sourceType,
      o.destName,
      o.destType,
      "unmatched",
      "overflow",
      "false",
      "Collected into overflow field",
    ]),
  ];
}

/** Build lookup rows from user field-mapping overrides. */
export function lookupRowsFromOverrides(overrides: FieldMappingOverride[]): string[][] {
  return overrides.map((o) => [
    o.source,
    o.sourceType,
    o.dest,
    o.destType,
    o.confidence,
    o.action,
    String(o.needsCoercion),
    o.description,
  ]);
}

/** Render a lookup CSV (header + escaped rows). Returns null when empty. */
export function renderLookupCsv(rows: string[][]): string | null {
  if (rows.length === 0) return null;
  const lines = [LOOKUP_CSV_HEADER, ...rows.map((r) => r.map(escapeCsvCell).join(","))];
  return lines.join("\n") + "\n";
}

/** The lookup CSV filename for a pipeline suffix. */
export function lookupFileName(suffix: string): string {
  return `${suffix}_field_mapping.csv`;
}

/**
 * Render the pack's default/lookups.yml registry for the given CSV filenames
 * (legacy pack-builder.ts 2371-2381). Returns null when there are no lookups.
 */
export function generateLookupsYml(csvFileNames: string[]): string | null {
  if (csvFileNames.length === 0) return null;
  const blocks = csvFileNames.map((f) => {
    const id = f.replace(/\.csv$/, "");
    const logType = id.replace("_field_mapping", "").replace(/_/g, " ");
    return [
      `${id}:`,
      `  id: ${id}`,
      `  filename: ${f}`,
      `  description: "Field mapping lookup for ${logType}"`,
    ].join("\n");
  });
  return blocks.join("\n") + "\n";
}
