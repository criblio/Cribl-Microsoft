/**
 * A schema catalog tier for a table the operator PICKED from the live
 * workspace (backlog item 2).
 *
 * THE DECISION THIS ENCODES (user, 2026-08-10): once a real table is named,
 * ARM is the better authority, so its live columns REPLACE the derived schema
 * for that table rather than being reconciled with it. Blending the two would
 * produce a schema matching neither source - some columns as the solution
 * declares them, some as the workspace actually has them - and every mapping
 * verdict computed against it would be about a table that does not exist.
 *
 * REPLACEMENT IS SCOPED TO THE ONE TABLE. Everything else still resolves
 * through the fallback, because picking a table says nothing about the others;
 * the derived path remains correct for tables that do not materialize until a
 * connector is enabled.
 *
 * Layered like {@link createSolutionSchemaCatalog}: wrap a fallback, override
 * what this tier knows, delegate the rest. Same shape, so the tiers compose in
 * any order the caller needs.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto. The FETCHING lives in
 * usecases/workspace-tables (fetchWorkspaceTableSchema); this only decides what
 * wins once the columns are in hand.
 */

import type { DcrSchemaColumn, SchemaCatalog } from "../../ports/schema-catalog";

/**
 * Wrap `fallback` so `tableName` resolves to `columns`.
 *
 * Name matching is case-insensitive to match the rest of the catalog stack -
 * ARM reports `SecurityEvent` while a solution may say `securityevent`, and the
 * operator picked one table either way.
 *
 * An EMPTY `columns` array is still an override, deliberately. A table that
 * exists but exposes no columns yet is a real state (provisioned, never
 * materialized), and falling back there would silently analyse against the
 * derived schema while the UI says the live table is in use - the kind of quiet
 * substitution this tier exists to prevent.
 */
export function createLiveTableSchemaCatalog(
  tableName: string,
  columns: readonly DcrSchemaColumn[],
  fallback: SchemaCatalog,
): SchemaCatalog {
  const key = tableName.trim().toLowerCase();
  const frozen = [...columns];
  return {
    async resolveSchema(name: string): Promise<DcrSchemaColumn[] | null> {
      if (key !== "" && name.trim().toLowerCase() === key) {
        return [...frozen];
      }
      return fallback.resolveSchema(name);
    },
  };
}
