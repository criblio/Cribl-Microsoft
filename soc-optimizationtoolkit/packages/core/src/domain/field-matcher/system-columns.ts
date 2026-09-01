/**
 * THE DESTINATION-COLUMN CONTRACT - the Azure-managed column names that every
 * SchemaCatalog tier strips, and the ONE filter all of them run.
 *
 * WHAT A SchemaCatalog RETURNS. `resolveSchema` does not answer "what columns
 * does this table have"; it answers "what columns may a DCR DECLARE for this
 * table". Azure populates the 18 names below itself - a generated DCR that
 * declares them is at best redundant and at worst rejected - so every tier
 * removes them before returning. TimeGenerated is deliberately NOT one of them:
 * it is a real, mappable column.
 *
 * WHY THIS IS ITS OWN MODULE (DBT-50, 2026-08-31). The list was already single
 * (it lived beside the bundled catalog), but the FILTER was not: three tiers
 * each built their own `new Set(DCR_SCHEMA_SYSTEM_COLUMNS)` and wrote their own
 * predicate, and the fourth - the live-ARM tier - had neither and so honoured
 * none of the contract. That went unnoticed while the live tier was composed
 * innermost, because the repo tiers answered first for nearly every table and
 * its columns were never returned. Promoting it to the top of the ladder made
 * the omission reachable: ARM reports a native table's managed columns in
 * `standardColumns`, so the promoted tier returns them where its siblings do not.
 *
 * The consequence is NOT that those columns reach a generated DCR - that was
 * claimed during the fix and is FALSE, corrected here rather than quietly
 * dropped because the wrong version is what makes the fix sound impressive.
 * `buildDcrColumnSet` re-strips the managed names for a native table, and the
 * only route by which a catalog schema reaches a DCR is `customSchema`, which
 * onboard-batch and onboard-table both ignore for a table that already exists -
 * and a table in this tier's map is by construction one the operator picked
 * from the workspace listing, so it exists.
 *
 * THE REAL HARM, which is subtler and worth stating precisely: the managed
 * names enter `GapReport.destSchema`, `destFieldCount`, the mapping table's
 * dest-column dropdown, overflow triage and the rule-coverage union. So an
 * operator can map a source field onto a column Azure owns - Type,
 * SourceSystem, RowKey - the pack emits it, and the DCR then drops it
 * SILENTLY. The data loss is real; it just happens one step further on than
 * the first telling said.
 *
 * The fix is one mechanism, not a fourth copy of the predicate. A duplicated
 * column list that can drift is the failure this codebase keeps filing cards
 * about, and a duplicated FILTER over a shared list drifts the same way - it
 * just takes an extra tier to notice. Both shapes below read the same set:
 * {@link isDcrSystemColumn} for tiers that filter while walking raw ARM/JSON
 * entries, {@link stripDcrSystemColumns} for tiers that hold a column array.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/**
 * The 18 Azure-managed system column names filtered out of every resolved
 * schema (verbatim from legacy pack-builder.ts loadDcrTemplateSchemaPublic /
 * SYSTEM_COLUMNS, which defined the same list twice, byte-identically).
 * Matching is CASE-SENSITIVE and exact, as the legacy `Set.has(c.name)` was.
 *
 * As a SET this equals schema-mapping's NATIVE_SYSTEM_COLUMNS (different order,
 * same names); `schema-catalog.test.ts` pins that equality so the two contracts
 * cannot drift apart.
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

/** The one set. Every tier's filter reads THIS, never its own copy. */
const systemColumnSet: ReadonlySet<string> = new Set(DCR_SCHEMA_SYSTEM_COLUMNS);

/**
 * Is `name` a column Azure manages, and therefore one a DCR must not declare?
 *
 * For tiers that decide column by column while walking a raw document (the
 * KQL-validation files, the solution's ARM resources) and never hold a
 * `DcrSchemaColumn[]` to filter.
 */
export function isDcrSystemColumn(name: string): boolean {
  return systemColumnSet.has(name);
}

/**
 * Drop every Azure-managed column from a resolved column array.
 *
 * For tiers that already hold their columns (the bundled snapshot, the live-ARM
 * tier). Copies each surviving entry, so a caller cannot mutate a tier's cached
 * columns through the result - the same defensive copy the tiers made when they
 * each owned their own filter.
 *
 * An input that is ENTIRELY system columns yields an empty array, not null. For
 * the live tier that is the honest answer and a meaningful one: a table whose
 * only columns are Azure-managed has nothing a DCR may declare, and the tier
 * treats an empty override as an override rather than a miss.
 */
export function stripDcrSystemColumns<T extends { name: string }>(
  columns: readonly T[],
): T[] {
  return columns.filter((column) => !isDcrSystemColumn(column.name)).map((column) => ({ ...column }));
}
