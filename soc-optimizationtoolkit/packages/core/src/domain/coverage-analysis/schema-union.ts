/**
 * Destination-schema UNION helper (porting-plan Unit 23 task item 4). The
 * coverage math needs the union of EVERY destination table's columns - a rule's
 * KQL routinely references a different table than its dataConnector (a
 * multi-table solution like CrowdStrike has ~10 custom tables), so restricting
 * to one table's schema would mis-classify cross-table fields as unknown.
 *
 * This mirrors the legacy pack:rule-coverage union loop
 * (`for (const tbl of allTableNames) { schema = loadDcrTemplateSchemaPublic(tbl);
 * for (const c of schema) tableSchemaColumns.add(c.name); }`) but as a pure
 * function over already-resolved column lists - the SchemaCatalog resolution
 * (Unit 13) and the gap-analysis mapped destinations are the caller's job, so
 * this stays zero-IO.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/** A minimal column shape (only the name is needed for the union). */
export interface NamedColumn {
  name: string;
}

/**
 * Union the column NAMES of many destination tables into one de-duplicated,
 * sorted list, CASING PRESERVED (the availability check downstream is
 * case-insensitive, but the reported field casing is the rule's, not this set's,
 * so we keep the first-seen casing here for provenance). De-duplication is
 * EXACT-STRING (matching the legacy Set<string> of column names); a column
 * appearing under two casings across tables is preserved as two entries, which
 * the case-insensitive availability match then folds together.
 */
export function unionSchemaColumns(
  tableSchemas: ReadonlyArray<ReadonlyArray<NamedColumn>>,
): string[] {
  const names = new Set<string>();
  for (const schema of tableSchemas) {
    for (const column of schema) names.add(column.name);
  }
  return [...names].sort();
}
