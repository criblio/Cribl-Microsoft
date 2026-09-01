/**
 * THE SCHEMA LADDER - one named place for which authority wins when more than
 * one of them defines the same destination table.
 *
 * WHY THIS IS A MODULE (DBT-50). The order used to be an inline expression in
 * the mapping review's `catalogWith` callback, where nothing could reach it and
 * no test could pin it - the same shape of problem `table-schema-resolver.ts`
 * records one screen over. It drifted exactly as an unpinned order does: the
 * live tier was composed as the INNERMOST fallback, under both repo tiers, so
 * for any table the Sentinel repo defines the ARM read fired, was awaited, was
 * stored in `liveSchemas` - and was never reached by resolution.
 *
 * THE ORDER (outermost wins):
 *
 *   1. LIVE workspace columns, for the tables the operator explicitly pointed a
 *      log type at (createLiveTableSchemaCatalog).
 *   2. The Azure-Sentinel repo's CI-VALIDATED table schemas, under
 *      KqlvalidationsTests/CustomTables (createKqlValidationSchemaCatalog).
 *   3. The selected solution's own connector-ARM table definitions
 *      (createSolutionSchemaCatalog).
 *   4. `base` - the bundled snapshot, or whatever catalog the caller injected.
 *
 * Sample-DERIVED schemas are not a tier here: they remain the analyzeSamples
 * fallback for tables none of the four define.
 *
 * EVERY TIER ANSWERS THE SAME QUESTION - "what columns may a DCR DECLARE for
 * this table", not "what columns does this table have". So all four strip the
 * Azure-managed names through the single predicate in `system-columns.ts`.
 * Reordering tiers is only safe because of that: a tier that answered the other
 * question would change the RESULT when promoted, not just its source. The live
 * tier was exactly that tier - it is fed raw ARM, which reports managed columns
 * in `standardColumns` - so promoting it without the strip changes the answer.
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
 * WHY LIVE SITS ON TOP, and not tier 3 as it did (the DBT-50 judgement,
 * 2026-08-31). Two orders were defensible and they are not equivalent - either
 * the code was wrong or four documents were - so the argument is recorded here
 * rather than left to be re-derived:
 *
 * - The decision the live tier encodes already named the loser side of the
 *   comparison. `live-table-schema-catalog.ts` says blending would leave "some
 *   columns as the SOLUTION DECLARES THEM, some as the workspace actually has
 *   them", which is a statement about live-versus-solution-declared, not merely
 *   live-versus-sample-derived. Same in `workspace-tables.ts` and in
 *   backlog item 2: "once a real table is named, ARM is the better authority".
 * - The KQL tier's "resolves FIRST" is not the counter-claim it looks like. It
 *   enumerates what it beats - the solution's connector-ARM tables, the bundled
 *   snapshot, sample-derived schemas - and the live tier is absent from that
 *   list because it did not exist on 2026-07-14. There was never a decision
 *   that the repo outranks live; there was an order nobody composed.
 * - The later direction is also the narrower one. The repo schema answers "what
 *   were this solution's rules written against"; the live tier only ever holds
 *   a table the operator PICKED from their own workspace, which answers "what
 *   will actually accept this data". A DCR built from the repo's columns for a
 *   table whose live schema differs fails or drops columns on ingest, and the
 *   operator was told otherwise: release notes 1.11.12 promise that picking a
 *   real table "replaces the derived schema with the live columns from Azure".
 * - It is the same defect class the 2026-08-18 audit already ruled on when it
 *   deleted the picker's existence pre-check: analysing against the derived
 *   schema while the UI reports the live one is a quiet substitution, and this
 *   tier exists to prevent it. Reaching that outcome by ordering rather than by
 *   skipping the fetch does not make it a different bug.
 *
 * REPLACEMENT STAYS SCOPED TO THE PICKED TABLES. Promoting the tier changes
 * nothing for any table absent from `live`: those still fall through the repo
 * tiers exactly as before, because pointing one log type at a real table says
 * nothing about the others.
 *
 * Pure composition: no IO of its own, no React. Every tier's fetching lives
 * behind the SentinelContent port it is handed.
 */

import type { DcrSchemaColumn, SchemaCatalog } from "../../ports/schema-catalog";
import type { SentinelContent } from "../../ports/sentinel-content";
import { createKqlValidationSchemaCatalog } from "./kql-validation-schema-catalog";
import { createLiveTableSchemaCatalog } from "./live-table-schema-catalog";
import { createSolutionSchemaCatalog } from "./solution-schema-catalog";

/** What the ladder is built from. */
export interface SchemaLadderOptions {
  /** The seam both repo tiers read through. */
  content: SentinelContent;
  /** Selected solution, for the connector-ARM tier (blank disables that tier). */
  solutionName: string;
  /** Last resort: the bundled snapshot, or an injected catalog. */
  base: SchemaCatalog;
  /**
   * Live ARM columns keyed by TABLE, for the tables an operator pointed a log
   * type at. Absent or empty means no table was picked yet, in which case the
   * tier overrides nothing and the ladder behaves as the three lower tiers.
   */
  live?: Readonly<Record<string, readonly DcrSchemaColumn[]>>;
}

/**
 * Compose the four tiers in the order the header states.
 *
 * The live tier wraps UNCONDITIONALLY, including for an empty map. That is not
 * an oversight: an empty map overrides nothing, so the two are identical, and a
 * branch here would be a second place the order is decided.
 */
export function createSchemaLadder({
  content,
  solutionName,
  base,
  live,
}: SchemaLadderOptions): SchemaCatalog {
  return createLiveTableSchemaCatalog(
    live ?? {},
    createKqlValidationSchemaCatalog(
      content,
      createSolutionSchemaCatalog(content, solutionName, base),
    ),
  );
}
