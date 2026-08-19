/**
 * Resolving ONE picked table's live columns - extracted so the rule it encodes
 * can be pinned (2026-08-18 architecture audit).
 *
 * WHY THIS IS ITS OWN MODULE. This lived as an inline `useCallback` in
 * integrate-screen.tsx, where nothing could reach it, and it had grown a cache
 * guard: it returned null unless the table appeared in the listing the picker
 * had already loaded. That reads like a cheap pre-check and is really a SECOND
 * answer to a question ARM answers authoritatively.
 *
 * The guard was wrong in two reachable states. `workspaceTables` fills only
 * after the auto-load resolves, and never at all when that listing 403s (the
 * auto-load deliberately does not retry), while the destination selector offers
 * four hardcoded natives from the first render. So picking SecurityEvent early,
 * or after a failed listing, skipped the fetch and analysed against the DERIVED
 * schema - while the picker's own tip promised live columns from Azure. That is
 * the quiet substitution createLiveTableSchemaCatalog exists to prevent.
 *
 * It is also the rule the table picker states one component over and this
 * contradicted: our reading of what we think is there never pre-empts the
 * attempt. Azure's response is the gate.
 *
 * A table that genuinely does not exist yet - a solution candidate, or one the
 * pack will create - now 404s and this throws, which the caller catches and
 * leaves derived. Same outcome as the guard, reached by asking the authority.
 */

import { fetchWorkspaceTableSchema } from "@soc/core";
import type {
  AzureManagement,
  DestField,
  Logger,
  WorkspaceTablesTarget,
} from "@soc/core";

/** Resolve a table name to its live destination columns. */
export type TableSchemaResolver = (table: string) => Promise<DestField[] | null>;

/**
 * Build a resolver bound to one workspace.
 *
 * NO existence pre-check, deliberately - see the header. Every name reaches
 * ARM, including one the caller has never seen in a listing.
 *
 * Returns null only for the state the usecase defines as null: the table exists
 * but exposes no usable column source (provisioned, never materialized). A
 * failed READ throws, because the two are different facts and collapsing them
 * would let a 403 look like an empty table.
 */
export function createTableSchemaResolver(
  azure: AzureManagement,
  target: WorkspaceTablesTarget,
  logger?: Logger,
): TableSchemaResolver {
  return (table: string) =>
    fetchWorkspaceTableSchema(azure, target, table, logger);
}
