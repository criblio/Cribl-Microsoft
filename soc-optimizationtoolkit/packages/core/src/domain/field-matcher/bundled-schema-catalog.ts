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
 * SYSTEM_COLUMNS filter: extracted VERBATIM from legacy pack-builder.ts, which
 * defined the SAME 18-name list TWICE - once inline in loadDcrTemplateSchemaPublic
 * (lines 201-207) and once as the module-level SYSTEM_COLUMNS (lines 212-218).
 * The two are byte-identical; reconciled here into ONE set. As a set it equals
 * schema-mapping's NATIVE_SYSTEM_COLUMNS (different order, same 18 Azure-managed
 * names); a test pins that set-equality so the two contracts cannot drift apart.
 *
 * GitHub CustomTables fallback (post-Unit-14) is a SEAM: a future adapter can
 * wrap this one and consult the content port for _CL tables defined only in
 * Sentinel solutions. No network is wired now.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { DcrSchemaColumn, SchemaCatalog } from "../../ports/schema-catalog";
import dcrTemplateSchemas from "../../assets/dcr-template-schemas.json";

const CATALOG: Readonly<Record<string, DcrSchemaColumn[]>> =
  dcrTemplateSchemas as Record<string, DcrSchemaColumn[]>;

/**
 * The 18 Azure-managed system column names filtered out of every resolved
 * schema (verbatim from pack-builder.ts loadDcrTemplateSchemaPublic /
 * SYSTEM_COLUMNS). Matching is CASE-SENSITIVE and exact, as the legacy
 * `Set.has(c.name)` filter was.
 */
export const DCR_SCHEMA_SYSTEM_COLUMNS: readonly string[] = Object.freeze([
  "TenantId",
  "SourceSystem",
  "MG",
  "ManagementGroupName",
  "_ResourceId",
  "_SubscriptionId",
  "_ItemId",
  "_IsBillable",
  "_BilledSize",
  "Type",
  "PartitionKey",
  "RowKey",
  "StorageAccount",
  "AzureDeploymentID",
  "AzureTableName",
  "TimeCollected",
  "SourceComputerId",
  "EventOriginId",
]);

const systemColumnSet: ReadonlySet<string> = new Set(DCR_SCHEMA_SYSTEM_COLUMNS);

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
      return columns
        .filter((column) => !systemColumnSet.has(column.name))
        .map((column) => ({ name: column.name, type: column.type }));
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
