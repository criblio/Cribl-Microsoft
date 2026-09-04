/**
 * route.yml emission - porting-plan Unit 17, task item (d) (ENG-02 routing).
 *
 * Ported from legacy IS/pack-builder.ts 2436-2503. Each log type gets a PAIR of
 * routes:
 *   1. a REDUCTION route (final:true, enabled) whose pipeline is the
 *      self-contained reduction pipeline (extract + reduce + transform); emitted
 *      only when the table has reduction rules;
 *   2. a PASSTHROUGH route (final:true) whose pipeline is the transform-only
 *      pipeline; disabled when a reduction route exists, enabled otherwise.
 * The disable-swap is the documented operational lever: to skip reduction,
 * disable the reduction route and enable the passthrough route (comment preserved
 * verbatim).
 *
 * FILTER KEY CONTRACT (section 3 item 7): routes use `filter:`, NEVER
 * `condition:`. The regression that once asserted this against a string literal
 * is re-pointed at THIS emitter (route-yml.test.ts), and the emitted route.yml
 * passes checkCriblYaml.
 *
 * NAMING: every id here is derived from the SINGLE {@link TablePlan.suffix} via
 * the naming helpers, so a route's `pipeline:` target can never diverge from the
 * pipeline dir (the legacy suffix-mismatch defect, fixed + pinned).
 *
 * OVERFLOW/PER-LOGTYPE COLLISION (conscious resolution): the legacy scaffold
 * keyed overflow config (and format, and fields) by `table.sentinelTable` in a
 * shared Map. For a multi-logType single table (Cloudflare HTTP/WAF/DNS all
 * targeting CloudflareV2_CL) the last logType overwrote the others. The plan
 * model resolves this by making each TablePlan a per-logType entry that carries
 * its OWN overflow/format/fields; route.yml therefore emits one route pair PER
 * logType, all pointing at the SAME destination for the shared table. Pinned by
 * plan.test.ts / route-yml.test.ts.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { PipelinePlan, TablePlan } from "./models";
import {
  passthroughRouteId,
  reductionRouteId,
} from "./naming";
import { isPlaceholderFilter } from "./route-placeholder";

/**
 * The match-all sentinel, and the ONE place that recognises it.
 *
 * Architecture audit 2026-08-12: this predicate was written out six times
 * across plan.ts and this file. Two of those sites have to agree or the
 * product lies - {@link unreachableLogTypes} names the dead log types and
 * {@link emissionOrder} decides which one survives - and until now they agreed
 * only because both happened to spell the same literal.
 *
 * Audit 2026-08-14: the literal is now a shared constant, because the coupling
 * crosses a module boundary. plan.ts decides WHEN to replace a match-all (with
 * a discriminator or a placeholder); this file decides WHAT IS one. If those
 * ever spelled the sentinel differently, the planner would leave a route this
 * file does not recognise - reported as reachable while receiving nothing.
 */
export const MATCH_ALL_FILTER = "true";

function isMatchAll(table: TablePlan): boolean {
  return table.routeCondition === MATCH_ALL_FILTER;
}

/**
 * Tables in the order their routes are EMITTED: match-alls last.
 *
 * A final match-all emitted first makes every later route unreachable (live
 * flaw 2026-07-13). Sorting is stable, so discriminated pairs keep their
 * relative order and so do the match-alls among themselves - which is what
 * makes "the first match-all" a well-defined thing for both callers.
 *
 * Shared rather than duplicated: {@link unreachableLogTypes} used to derive
 * its answer from plan order and agree with the emitter only by the accident
 * of that stability. Now both read the same sequence, so they cannot drift.
 */
function emissionOrder(plan: PipelinePlan): TablePlan[] {
  return [...plan.tables].sort(
    (a, b) => Number(isMatchAll(a)) - Number(isMatchAll(b)),
  );
}

/** Build the route filter line: unquoted-match-all vs an escaped condition. */
function filterLine(routeCondition: string): string {
  // YAML `filter: true` (unquoted) means match all; we always quote the value.
  return routeCondition === "true"
    ? '    filter: "true"'
    : `    filter: "${routeCondition.replace(/"/g, '\\"')}"`;
}

/** Emit the route entry pair for one resolved {@link TablePlan}. */
export function buildRouteEntries(
  plan: PipelinePlan,
  table: TablePlan,
): string[] {
  const entries: string[] = [];
  const hasRules = table.reductionRules !== null;
  const line = filterLine(table.routeCondition);
  // The COMPANION to dropping outputs.yml, not the thing that earns the
  // dropdown entry - and the first version of this comment had that backwards.
  //
  // Measured live 2026-09-04: setting a pack route's destination to Cribl's own
  // "Send to Worker Group Routes" (the UI form of `output: default`) did NOT
  // make the pack selectable; deleting the pack's destination did. So the gate
  // is the destination OBJECT, handled in scaffold.ts. This line exists so a
  // routable pack's routes do not name a destination it no longer ships.
  const output =
    plan.packShape === "routable" ? "default" : table.destinationId;

  // Reduction route: full pipeline with volume reduction enabled
  if (hasRules) {
    entries.push(
      [
        `  - id: ${reductionRouteId(plan.vendorPrefix, table.suffix)}`,
        `    name: "Reduction + Transform: ${table.suffix}"`,
        `    pipeline: ${table.reductionPipelineId}`,
        line,
        `    output: ${output}`,
        "    final: true",
        "    disabled: false",
        `    description: Reduction + Transform for ${table.suffix} events`,
      ].join("\n"),
    );
  }

  // Passthrough route: transformation only. Disabled when a reduction route
  // exists, enabled when it does not.
  entries.push(
    [
      `  - id: ${passthroughRouteId(plan.vendorPrefix, table.suffix)}`,
      `    name: "Transform: ${table.suffix}"`,
      `    pipeline: ${table.pipelineName}`,
      line,
      `    output: ${output}`,
      "    final: true",
      `    disabled: ${hasRules ? "true" : "false"}`,
      `    description: Transform only for ${table.suffix} events`,
    ].join("\n"),
  );

  return entries;
}

/**
 * The log types whose routes CANNOT receive events, in route order.
 *
 * Every route is `final: true`, so the first match-all route consumes each
 * event and terminates routing - any match-all after it is dead. Read from
 * {@link emissionOrder}, the same sequence generateRouteYml emits, so "the
 * first match-all" means the same thing here and in the file: the surviving
 * catch-all. This reports the rest.
 *
 * NOW AN INVARIANT ASSERTION, NOT A REPORT (architecture audit 2026-08-17).
 * For any plan from buildPipelinePlan this is ALWAYS empty, and that is by
 * construction rather than by luck: the planner placeholders EVERY match-all
 * once a plan has more than one table, and a lone table's match-all is correct
 * and is the only one, so "all match-alls except the first" has nothing left to
 * name. Verified against the planner, not reasoned about: 1 table -> [], 3
 * indistinguishable tables -> [] with all three placeholdered.
 *
 * So the failure this was written for - a silent one, where the pack builds,
 * the YAML validates, and the affected log types are quietly run through the
 * first match-all's pipeline with the wrong renames - can no longer happen.
 * The placeholder ladder superseded it: an unseparable log type now gets a
 * filter that matches NOTHING instead of a filter that matches EVERYTHING,
 * which turns silent mis-shaped data into a visible unfinished task
 * ({@link placeholderLogTypes}).
 *
 * Kept, because a non-empty result now means the PLANNER has regressed - the
 * ladder let a match-all through where it should have placeholdered it - and
 * that is worth catching. Callers should treat it as an assertion that fires
 * only on a generator bug, not as a routine warning to render; the tests that
 * exercise it build plans by hand, which is the only way to reach it.
 */
export function unreachableLogTypes(plan: PipelinePlan): string[] {
  const matchAll = emissionOrder(plan).filter(isMatchAll).map((t) => t.suffix);
  // The first match-all is the catch-all and is reachable; the rest are not.
  return matchAll.slice(1);
}

/**
 * The log types whose route filter is a placeholder awaiting a human.
 *
 * These are NOT unreachable and NOT lost - they have a full route, pipeline,
 * lookup and sample, and start receiving events the moment someone writes a
 * filter that identifies them. That is the whole point of emitting a
 * placeholder instead of a match-all (which would have hijacked its siblings'
 * events) or nothing at all (which would have dropped the log type silently).
 *
 * Reported separately from {@link unreachableLogTypes} because the two ask for
 * different things: unreachable is a defect to fix in the generator,
 * placeholder is a task for the operator. Collapsing them would either nag
 * about a healthy pack or bury a real routing bug.
 */
export function placeholderLogTypes(plan: PipelinePlan): string[] {
  return emissionOrder(plan)
    .filter((t) => isPlaceholderFilter(t.routeCondition))
    .map((t) => t.suffix);
}

/** Emit the full route.yml for a resolved {@link PipelinePlan}. */
export function generateRouteYml(plan: PipelinePlan): string {
  const ordered = emissionOrder(plan);
  const catchAlls = ordered.filter(isMatchAll).length;
  const placeholders = placeholderLogTypes(plan);
  const allRouteEntries: string[] = [];
  for (const table of ordered) {
    allRouteEntries.push(...buildRouteEntries(plan, table));
  }

  return [
    `# Routes for ${plan.solutionName}`,
    "# Generated by Cribl SOC Optimization Toolkit",
    "#",
    "# Each log type has two routes:",
    "#   1. Reduction + Transform (enabled): full pipeline with volume reduction",
    "#   2. Transform only (disabled): same pipeline without reduction",
    "# To skip reduction: disable the reduction route and enable the passthrough route.",
    // Unreachable in any planner-built pack - see unreachableLogTypes: the
    // ladder placeholders every match-all once there is more than one table,
    // so catchAlls can only be 0 or 1 here. Emitted anyway because a plan that
    // DOES arrive with overlapping catch-alls is a generator regression, and
    // the person holding that pack should be told in the file itself.
    ...(catchAlls > 1
      ? [
          "#",
          `# GENERATOR BUG: ${catchAlls} log types kept overlapping match-all`,
          "# routes. Every route is final, so only the first receives events and",
          "# the rest are handled by ITS pipeline, with the wrong field mapping.",
          "# This should be impossible - the generator gives an unseparable log",
          "# type a placeholder filter instead. Please report this pack.",
        ]
      : []),
    ...(placeholders.length > 0
      ? [
          "#",
          `# ACTION REQUIRED: ${placeholders.length} log type(s) have a PLACEHOLDER`,
          `# filter: ${placeholders.join(", ")}.`,
          "# Nothing in the samples told them apart from the other log types, so",
          "# their filters compare against __UNSET__ and match no event. Their",
          "# pipelines, lookups and samples are all present - replace each filter",
          "# with an expression that identifies that log type and the route starts",
          "# working. Left as-is they receive nothing; they are not dropping data",
          "# into another log type's pipeline, which is what a match-all would do.",
        ]
      : []),
    "",
    "id: default",
    "groups: {}",
    "routes:",
    ...allRouteEntries,
    "",
  ].join("\n");
}
