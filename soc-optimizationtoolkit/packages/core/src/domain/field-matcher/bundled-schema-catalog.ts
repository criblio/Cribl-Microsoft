/**
 * BUNDLED SchemaCatalog adapter - porting-plan Unit 13 (ENG-05), deliverable (a).
 *
 * Pure resolution over the pre-extracted src/assets/dcr-template-schemas.json
 * asset (50 native DCR template column sets + 13 custom _CL schemas). The asset
 * is a STATIC IMPORT (resolveJsonModule, like dcr-naming's legacy-vectors), so
 * this adapter performs ZERO IO and ZERO fetch at runtime - the air-gap-capable
 * path stays fetch-free. Regenerate the asset with
 * `node scripts/extract-dcr-template-schemas.mjs` (see that script's header).
 *
 * Name normalization: the "Microsoft-" content-hub prefix is handled BOTH
 * directions (strip and add), verbatim from legacy loadDcrTemplateSchema
 * (pack-builder.ts lines 70-79).
 *
 * SYSTEM_COLUMNS filter: this module used to own the 18-name list, its set and
 * its predicate. All three now live in `system-columns.ts`, which every tier of
 * the ladder reads - this one, the two repo tiers, and the live-ARM tier that
 * honoured none of the contract until DBT-50. The barrel re-exports the list
 * from there, so `DCR_SCHEMA_SYSTEM_COLUMNS` still resolves for callers.
 *
 * GitHub CustomTables fallback (post-Unit-14) is a SEAM: a future adapter can
 * wrap this one and consult the content port for _CL tables defined only in
 * Sentinel solutions. No network is wired now.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { DcrSchemaColumn, SchemaCatalog } from "../../ports/schema-catalog";
import dcrTemplateSchemas from "../../assets/dcr-template-schemas.json";
import { stripDcrSystemColumns } from "./system-columns";

const CATALOG: Readonly<Record<string, DcrSchemaColumn[]>> =
  dcrTemplateSchemas as Record<string, DcrSchemaColumn[]>;

/**
 * Candidate table-name variants tried in order, mirroring legacy
 * loadDcrTemplateSchema: the name as given, then the "Microsoft-"-stripped form
 * (if prefixed) OR the "Microsoft-"-prefixed form (if not).
 */
export function normalizeTableNames(tableName: string): string[] {
  const names = [tableName];
  if (tableName.startsWith("Microsoft-")) {
    names.push(tableName.replace(/^Microsoft-/, ""));
  } else {
    names.push(`Microsoft-${tableName}`);
  }
  return names;
}

/**
 * Resolve `tableName` to its destination columns from the bundled asset, with
 * system columns filtered out, or null when no name variant is in the catalog.
 * Pure and synchronous - the async SchemaCatalog port wraps it.
 */
export function resolveSchemaFromCatalog(
  tableName: string,
): DcrSchemaColumn[] | null {
  for (const name of normalizeTableNames(tableName)) {
    const columns = CATALOG[name];
    if (columns && columns.length > 0) {
      return stripDcrSystemColumns(columns);
    }
  }
  return null;
}

/** The table names the bundled catalog can resolve (asset keys), for browse UIs. */
export function bundledCatalogTableNames(): string[] {
  return Object.keys(CATALOG);
}

/**
 * Build the bundled SchemaCatalog. Fetch-free, air-gap-capable; `resolveSchema`
 * never throws for a miss - it resolves null (the matcher turns that into an
 * all-unmatched MatchResult).
 */
export function createBundledSchemaCatalog(): SchemaCatalog {
  return {
    async resolveSchema(tableName: string): Promise<DcrSchemaColumn[] | null> {
      return resolveSchemaFromCatalog(tableName);
    },
  };
}
