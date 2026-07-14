/**
 * Idempotent skip rules - porting-plan Unit 20 task item 1 (the skip rules
 * "ported as tests"). The legacy e2e orchestrator (e2e-orchestrator.ts 219-280)
 * and handleDeploy decided per step whether to do work or skip it; those
 * decisions are extracted here as PURE functions so each rule is characterized
 * in one place and cannot drift between shells.
 *
 * 'skipped' is a FIRST-CLASS status (porting-plan "DECISIONS RESOLVED
 * 2026-07-03" item 1): a skip did no work and is terminal, distinct from a
 * success.
 *
 * ONE conscious FIX over the legacy: destination-existence matching uses
 * NORMALIZED-EXACT table keys (strip one trailing _CL, lowercase), not the
 * legacy fuzzy substring match (findDestinationForTable, azure-deploy.ts
 * 154-163) that cross-matched shared-prefix tables like Cloudflare vs
 * CloudflareAudit (porting-plan contract 1 - route table matching through
 * normalized names, never fuzzy substrings). Pinned by test.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/** Normalized table key for destination-existence matching (strip _CL, lower). */
export function normalizeTableKey(table: string): string {
  return table.replace(/_CL$/i, "").toLowerCase();
}

/** Whether any of the given tables is a custom (_CL) table. */
export function hasCustomTables(tables: readonly string[]): boolean {
  return tables.some((table) => /_CL$/i.test(table));
}

/**
 * Whether a destination already exists for `table` among `existingTables`,
 * by NORMALIZED-EXACT key (never fuzzy substring). `existingTables` are the
 * table names that already have a deployed destination.
 */
export function destinationExistsForTable(
  table: string,
  existingTables: readonly string[],
): boolean {
  const key = normalizeTableKey(table);
  return existingTables.some((existing) => normalizeTableKey(existing) === key);
}

/** A run-or-skip decision; 'skip' maps to JobStatus 'skipped'. */
export type RunOrSkip =
  | { kind: "run"; detail: string }
  | { kind: "skip"; detail: string };

/**
 * azure-tables step: create custom (_CL) tables. Skips when Azure is skipped
 * (offline mode) or when there are NO custom tables (native tables only,
 * e2e-orchestrator.ts 220-228).
 */
export function decideCustomTablesStep(
  tables: readonly string[],
  opts: { skipAzure: boolean },
): RunOrSkip {
  if (opts.skipAzure) {
    return { kind: "skip", detail: "Skipping Azure custom tables (offline mode)" };
  }
  if (!hasCustomTables(tables)) {
    return {
      kind: "skip",
      detail: "No custom tables needed (native tables only)",
    };
  }
  return { kind: "run", detail: "Creating custom tables..." };
}

/** azure-dcrs decision, with the subset of tables that still need deploying. */
export type DcrsDecision =
  | { kind: "run"; detail: string; tablesToDeploy: string[] }
  | { kind: "skip"; detail: string };

/**
 * azure-dcrs step: deploy DCRs. Skips when Azure is skipped, or when EVERY table
 * already has a deployed destination (e2e-orchestrator.ts 231-240). Otherwise
 * runs, reporting the tables that still need a DCR.
 */
export function decideDcrsStep(
  tables: readonly string[],
  existingDestinationTables: readonly string[],
  opts: { skipAzure: boolean },
): DcrsDecision {
  if (opts.skipAzure) {
    return { kind: "skip", detail: "Skipping Azure DCR deployment (offline mode)" };
  }
  const tablesToDeploy = tables.filter(
    (table) => !destinationExistsForTable(table, existingDestinationTables),
  );
  if (tables.length > 0 && tablesToDeploy.length === 0) {
    return { kind: "skip", detail: "DCRs already deployed" };
  }
  return {
    kind: "run",
    detail: `Deploying DCRs for ${tablesToDeploy.length} table(s)`,
    tablesToDeploy,
  };
}

/** build-pack decision: reuse an existing pack, or build a new one. */
export type BuildPackDecision =
  | { kind: "reuse"; detail: string }
  | { kind: "build"; detail: string };

/**
 * build-pack step: SHORT-CIRCUIT when a pack of this name already exists (reuse
 * it, e2e-orchestrator.ts 244-253); otherwise build.
 */
export function decideBuildPackStep(packExists: boolean): BuildPackDecision {
  if (packExists) {
    return { kind: "reuse", detail: "Pack already exists - reusing" };
  }
  return { kind: "build", detail: "Building Cribl pack..." };
}

/** embed-destinations decision: embed, skip, or error. */
export type EmbedDecision =
  | { kind: "embed"; detail: string }
  | { kind: "skip"; detail: string }
  | { kind: "error"; detail: string };

/**
 * embed-destinations step semantics (e2e-orchestrator.ts 256-280):
 *   - matched destinations AND the pack exists -> EMBED them,
 *   - NO matched destinations -> ERROR (nothing to embed - DCRs not deployed),
 *   - matched destinations but the pack is not yet created -> SKIP.
 */
export function decideEmbedStep(args: {
  matchedCount: number;
  packCreated: boolean;
}): EmbedDecision {
  if (args.matchedCount === 0) {
    return { kind: "error", detail: "No deployed destinations found" };
  }
  if (!args.packCreated) {
    return { kind: "skip", detail: "Pack not yet created" };
  }
  return {
    kind: "embed",
    detail: `${args.matchedCount} destination(s) embedded`,
  };
}
