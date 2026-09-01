/**
 * A schema catalog tier for tables the operator PICKED from the live
 * workspace (backlog item 2).
 *
 * PER LOG TYPE, NOT PER ANALYSIS (user, 2026-08-18). A solution rarely lands in
 * one table: CrowdStrike alone can map its log types across several, and each
 * destination is its own DCR with its own schema. So this tier holds a MAP -
 * every table any log type was pointed at - rather than a single override. An
 * earlier single-table version could only express "the whole analysis targets
 * one table", which is the wrong shape for the problem.
 *
 * THE DECISION THIS ENCODES (user, 2026-08-10): once a real table is named, ARM
 * is the better authority, so its live columns REPLACE the derived schema for
 * that table rather than being reconciled with it. Blending the two would
 * produce a schema matching neither source - some columns as the solution
 * declares them, some as the workspace actually has them - and every mapping
 * verdict computed against it would be about a table that does not exist.
 *
 * REPLACEMENT IS SCOPED TO THE TABLES IN THE MAP. Everything else still
 * resolves through the fallback, because pointing one log type at a real table
 * says nothing about the others; the derived path remains correct for tables
 * that do not materialize until a connector is enabled.
 *
 * Layered like {@link createSolutionSchemaCatalog}: wrap a fallback, override
 * what this tier knows, delegate the rest. Same shape, so the tiers compose in
 * any order the caller needs - and the order they are actually composed in is
 * `schema-ladder.ts`, which puts this tier OUTERMOST. It has to be: composed
 * anywhere else, the repo tiers answer first for every table they define and
 * the columns this tier holds are fetched, awaited, stored and dropped
 * (DBT-50, fixed 2026-08-31).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto. The FETCHING lives in
 * usecases/workspace-tables (fetchWorkspaceTableSchema); this only decides what
 * wins once the columns are in hand.
 */

import type { DcrSchemaColumn, SchemaCatalog } from "../../ports/schema-catalog";
import { stripDcrSystemColumns } from "./system-columns";

/**
 * Wrap `fallback` so every table in `byTable` resolves to its live columns.
 *
 * Name matching is case-insensitive to match the rest of the catalog stack -
 * ARM reports `SecurityEvent` while a solution may say `securityevent`, and the
 * operator picked one table either way.
 *
 * AZURE-MANAGED COLUMNS ARE STRIPPED, exactly as the three tiers below do it
 * and through the same predicate (DBT-50). This tier is fed raw ARM, which
 * reports a native table's managed columns in `standardColumns` -
 * TenantId, Type, _ResourceId and the rest - so without the strip the tier
 * answers a different question from its siblings: "what columns does this table
 * have" instead of "what columns may a DCR declare". The omission was
 * unreachable while this tier was composed innermost; promoting it to the top
 * of the ladder made it reachable.
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
 * An EMPTY column array is still an override, deliberately. A table that exists
 * but exposes no columns yet is a real state (provisioned, never materialized),
 * and falling back there would silently analyse against the derived schema
 * while the UI says the live table is in use - the kind of quiet substitution
 * this tier exists to prevent. A table whose columns are ALL Azure-managed
 * reduces to that same empty override, which is the honest answer: there is
 * nothing in it a DCR may declare.
 */
export function createLiveTableSchemaCatalog(
  byTable: Readonly<Record<string, readonly DcrSchemaColumn[]>>,
  fallback: SchemaCatalog,
): SchemaCatalog {
  const frozen = new Map<string, DcrSchemaColumn[]>();
  for (const [name, columns] of Object.entries(byTable)) {
    const key = name.trim().toLowerCase();
    // A blank name would match a trimmed lookup and override the world.
    if (key !== "") {
      frozen.set(key, stripDcrSystemColumns(columns));
    }
  }
  return {
    async resolveSchema(name: string): Promise<DcrSchemaColumn[] | null> {
      const hit = frozen.get(name.trim().toLowerCase());
      if (hit !== undefined) {
        return [...hit];
      }
      return fallback.resolveSchema(name);
    },
  };
}
