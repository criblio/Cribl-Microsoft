/**
 * SchemaCatalog port - resolve a Sentinel/DCR table name to its destination
 * column set (porting-plan Unit 13, ENG-05). This is the GAP-ANALYSIS
 * FOUNDATION: the field matcher matches a parsed sample against whatever this
 * port returns.
 *
 * The API is ASYNC on purpose. The legacy field matcher resolved schemas
 * through a synchronous `await import('./pack-builder')` dynamic-import
 * contortion so the renderer could reach filesystem state; an async port kills
 * that entirely - the resolution seam is honest about being pluggable.
 *
 * Adapters:
 * - BUNDLED (ships in-tree, default): pure resolution over the pre-extracted
 *   src/assets/dcr-template-schemas.json asset - fetch-free, air-gap-capable,
 *   zero IO. See domain/field-matcher/bundled-schema-catalog.
 * - GitHub CustomTables FALLBACK (post-Unit-14 SEAM): a future adapter can
 *   chain a network lookup for _CL tables defined only in Sentinel solutions.
 *   The port method is the seam; no network is wired now.
 *
 * Error semantics: `resolveSchema` resolves null for an unknown/unresolvable
 * table and NEVER throws for a miss (the matcher turns null into an
 * all-unmatched MatchResult). It rejects only on a genuine backend failure
 * (which the bundled adapter never has).
 */

/** A single destination column: {name, type} and nothing else. */
export interface DcrSchemaColumn {
  name: string;
  /**
   * The column's declared type, verbatim from the source (DCR stream
   * declaration or custom-table schema file): one of the DCR vocabulary
   * string/int/long/real/boolean/datetime/dynamic/guid. Not remapped here -
   * DCR-emission-time type reconciliation is owned by
   * domain/schema-mapping.mapColumnType (Unit 5).
   */
  type: string;
}

/** Resolves table names to destination column sets. */
export interface SchemaCatalog {
  /**
   * Resolve `tableName` to its destination columns, or null when the table is
   * not in the catalog. Name normalization (the "Microsoft-" prefix, both
   * directions) is the adapter's responsibility. System columns Azure
   * auto-populates are already filtered out of the returned set.
   */
  resolveSchema(tableName: string): Promise<DcrSchemaColumn[] | null>;
}
