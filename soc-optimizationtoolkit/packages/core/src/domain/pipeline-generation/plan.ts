/**
 * buildPipelinePlan - the ONE pure planner - porting-plan Unit 17, task item (a).
 *
 * THE CENTRAL REDESIGN. The legacy scaffold (pack-builder.ts 1770-2510) resolved
 * each table's field mappings by MUTATING `options.tables[i].fields` through a
 * sequence of competing branches, each overwriting the last:
 *   - the vendor-research match (1897) or its no-schema passthrough (1976);
 *   - the samples-fallback match (2034) or its no-schema passthrough (2072);
 *   - the DCR-gap branch (2132: dcrHasTransforms -> criblMustHandle) or its
 *     no-transform matcher (2147);
 *   - the CEF/LEEF/KV matcher (2236) and the vendor-mappings assignment (2271),
 *     both gated on `table.fields.length === 0`;
 *   - the user field-mapping overrides (2287), applied LAST.
 * Overflow config was stashed in a table-name-keyed side Map (1771) that later
 * branches overwrote. This is the "five competing options.tables mutation paths"
 * the digest flags for unification.
 *
 * Here they are reified into ONE explicit priority resolution per table, with the
 * result surfaced as a typed {@link TablePlan} (no mutation, no side Map). The
 * priority, highest first, preserves the INTENT of the legacy precedence:
 *   1. user overrides            (legacy step applied last -> wins)
 *   2. DCR gap w/ real transforms(avoid duplicating DCR work)
 *   3. field MatchResult         (the alias/fuzzy matcher paths)
 *   4. preset fields             (a caller that already decided)
 *   5. passthrough source fields (no schema/match available)
 *   6. empty
 * `provenance` records which branch won (the Unit 15 "never resolve silently"
 * precedent).
 *
 * BOUNDARY: this is pure over TYPED INPUTS. The MatchResult (Unit 13), the
 * DcrGapAnalysis + TableRoutingInfo (Unit 18), and vendor mappings (Unit 15,
 * deferred/empty for MVP) are inputs - the planner never calls those subsystems.
 * The only lookups it performs are into THIS unit's own pure data (reduction KB)
 * and Unit 13's pure getOverflowConfig helper for a sensible default overflow
 * field name.
 *
 * PER-LOGTYPE OVERFLOW COLLISION resolved consciously: each TablePlanInput is one
 * logType, so each TablePlan carries its OWN overflowConfig/format/fields. A
 * multi-logType single table (Cloudflare) yields several plans that share a
 * destination but never clobber each other's overflow - unlike the legacy
 * table-keyed Map. Pinned by plan.test.ts.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { FieldMatch, OverflowConfig } from "../field-matcher";
import { getOverflowConfig } from "../field-matcher";
import type {
  BuildPipelinePlanInput,
  PipelineFieldMapping,
  PlanProvenance,
  TablePlan,
  TablePlanInput,
} from "./models";
import { findReductionRules, type TableReductionRules } from "./reduction-rules";
import { deriveRouteDiscriminator } from "./route-discriminator";
import {
  deriveValueDiscriminator,
  type LogTypeFieldValues,
} from "./route-value-discriminator";
import { placeholderRouteFilter } from "./route-placeholder";
import { MATCH_ALL_FILTER } from "./route-yml";
import {
  destinationId,
  pipelineName,
  pipelineSuffix,
  reductionPipelineId,
  streamName,
  vendorPrefixFromSolution,
} from "./naming";

/** Map a field matcher action to the pipeline's 4-value action (verbatim). */
function mapMatchedAction(m: FieldMatch): PipelineFieldMapping["action"] {
  // Legacy remap (pack-builder.ts 1930-1932). The matcher already yields
  // keep/coerce/rename for `matched`, so this collapses to identity there.
  if (m.action === "keep" && !m.needsCoercion) return "keep";
  if (m.action === "keep" && m.needsCoercion) return "coerce";
  if (m.needsCoercion) return "rename";
  if (m.action === "overflow") return "overflow";
  return m.action;
}

/** A disabled overflow config carrying the table's default overflow field name. */
function disabledOverflow(sentinelTable: string): OverflowConfig {
  const def = getOverflowConfig(sentinelTable);
  return {
    enabled: false,
    fieldName: def.fieldName,
    fieldType: def.fieldType,
    sourceFields: [],
  };
}

/**
 * The overflow config for a resolved field set.
 *
 * THE FIELDS THEMSELVES CAN TURN OVERFLOW ON (user report 2026-08-12, Zscaler).
 * Every rung below that did not come from the field matcher used to hardcode a
 * DISABLED config, so a field the gap analysis marked `overflow` fell through
 * the emitter entirely: excluded from the renames (correct - it is not renamed),
 * skipped by the serialize step (which only runs when overflow is enabled), and
 * missed by the cleanup drops (which only remove `drop`). It reached the DCR
 * under its raw vendor name and was discarded there, silently.
 *
 * For Zscaler that was 133 of 170 fields on one log type: the analysis promised
 * them in AdditionalExtensions and the pipeline did nothing with them at all.
 *
 * The matcher's own config still wins when present - it carries decisions this
 * cannot reconstruct. Otherwise overflow is enabled exactly when some field asks
 * for it, and the table's own catch-all column supplies the name and type.
 */
function overflowFor(
  sentinelTable: string,
  fields: readonly PipelineFieldMapping[],
  matchResult: TablePlanInput["matchResult"],
): OverflowConfig {
  if (matchResult?.overflowConfig !== undefined) {
    return matchResult.overflowConfig;
  }
  const sourceFields = fields
    .filter((f) => f.action === "overflow")
    .map((f) => f.source);
  if (sourceFields.length === 0) {
    return disabledOverflow(sentinelTable);
  }
  const def = getOverflowConfig(sentinelTable);
  return {
    enabled: true,
    fieldName: def.fieldName,
    fieldType: def.fieldType,
    sourceFields,
  };
}

/** Resolve one table's fields + overflow via the priority ladder. */
function resolveFields(input: TablePlanInput): {
  fields: PipelineFieldMapping[];
  overflowConfig: OverflowConfig;
  provenance: PlanProvenance;
} {
  const { sentinelTable } = input;

  // 1. User overrides win outright (legacy applied them last).
  if (input.fieldOverrides && input.fieldOverrides.length > 0) {
    const fields: PipelineFieldMapping[] = input.fieldOverrides.map((o) => ({
      source: o.source,
      target: o.dest,
      type: o.destType,
      action: o.action as PipelineFieldMapping["action"],
    }));
    return {
      fields,
      overflowConfig: overflowFor(sentinelTable, fields, input.matchResult),
      provenance: "user-override",
    };
  }

  // 2. DCR gap with REAL transforms: use criblMustHandle, never duplicate DCR
  //    work (legacy 2132-2146).
  const gap = input.gap;
  const dcrHasTransforms =
    gap != null &&
    (gap.dcrHandles.renames.length > 0 || gap.dcrHandles.coercions.length > 0);
  if (gap && dcrHasTransforms) {
    const fields: PipelineFieldMapping[] = [
      ...gap.criblMustHandle.renames.map((r) => ({
        source: r.source,
        target: r.dest,
        type: "string",
        action: "rename" as const,
      })),
      ...gap.criblMustHandle.coercions.map((c) => ({
        source: c.field,
        target: c.field,
        type: c.toType,
        action: "coerce" as const,
      })),
      ...gap.criblMustHandle.overflow.map((o) => ({
        source: o.field,
        target: o.field,
        type: o.type,
        action: "drop" as const,
      })),
    ];
    return {
      fields,
      overflowConfig: overflowFor(sentinelTable, fields, input.matchResult),
      provenance: "dcr-gap",
    };
  }

  // 3. Field MatchResult: matched (rename/keep/coerce) + overflow (drop) +
  //    unmatchedSource (drop). Overflow config is the matcher's own.
  const mr = input.matchResult;
  if (mr) {
    const fields: PipelineFieldMapping[] = [
      ...mr.matched.map((m) => ({
        source: m.sourceName,
        target: m.destName,
        type: m.destType,
        action: mapMatchedAction(m),
      })),
      ...mr.overflow.map((o) => ({
        source: o.sourceName,
        target: o.destName,
        type: o.destType,
        // The overflow serialize handles these; mark drop so cleanup removes the
        // individual fields (legacy 1937).
        action: "drop" as const,
      })),
      ...mr.unmatchedSource.map((s) => ({
        source: s.name,
        target: s.name,
        type: s.type,
        action: "drop" as const,
      })),
    ];
    return {
      fields,
      overflowConfig: mr.overflowConfig,
      provenance: "field-match",
    };
  }

  // 4. Preset fields: a caller that already decided.
  if (input.presetFields && input.presetFields.length > 0) {
    return {
      fields: input.presetFields,
      overflowConfig: overflowFor(
        sentinelTable,
        input.presetFields,
        input.matchResult,
      ),
      provenance: "preset-fields",
    };
  }

  // 5. Passthrough: keep every source field as-is (legacy 1976/2072).
  if (input.passthroughFields && input.passthroughFields.length > 0) {
    const fields: PipelineFieldMapping[] = input.passthroughFields.map((f) => ({
      source: f.name,
      target: f.name,
      type: f.type,
      action: "keep" as const,
    }));
    return {
      fields,
      overflowConfig: disabledOverflow(sentinelTable),
      provenance: "passthrough",
    };
  }

  // 6. Nothing to resolve from.
  return {
    fields: [],
    overflowConfig: disabledOverflow(sentinelTable),
    provenance: "empty",
  };
}

/** Resolve the reduction rules for a table (explicit input, else KB lookup). */
function resolveReductionRules(
  input: TablePlanInput,
  solutionName: string,
): TableReductionRules | null {
  if (input.reductionRules !== undefined) return input.reductionRules;
  return findReductionRules(input.sentinelTable, solutionName);
}

/** Compute the route filter for a table (routing.routeCondition, else match-all). */
function resolveRouteCondition(input: TablePlanInput): string {
  const cond = input.routing?.routeCondition;
  return cond && cond !== MATCH_ALL_FILTER ? cond : MATCH_ALL_FILTER;
}

/**
 * Build the explicit, typed pipeline plan from already-computed typed inputs.
 * The single source of truth the conf/route emitters read.
 */
export function buildPipelinePlan(
  input: BuildPipelinePlanInput,
): import("./models").PipelinePlan {
  const version = input.version || "1.0.0";
  const vendorPrefix = vendorPrefixFromSolution(input.solutionName);

  const tables: TablePlan[] = input.tables.map((t) => {
    const logType = t.logType || t.sentinelTable;
    const suffix = pipelineSuffix(t.logType, t.sentinelTable);
    const { fields, overflowConfig, provenance } = resolveFields(t);
    return {
      sentinelTable: t.sentinelTable,
      logType,
      suffix,
      pipelineName: pipelineName(vendorPrefix, suffix),
      reductionPipelineId: reductionPipelineId(vendorPrefix, suffix),
      destinationId: destinationId(t.sentinelTable),
      streamName: streamName(t.sentinelTable),
      fields,
      overflowConfig,
      sourceFormat: t.sourceFormat || "json",
      routeCondition: resolveRouteCondition(t),
      vendorMappings: t.vendorMappings,
      identityOverride: t.identityOverride,
      reductionRules: resolveReductionRules(t, input.solutionName),
      provenance,
    };
  });

  // Multi-log-type plans need DISCRIMINATING route filters (live flaw
  // 2026-07-13: two match-all final routes left the second unreachable).
  // Each match-all table gets a filter built from source fields unique to
  // its log type; a table whose evidence cannot separate it keeps "true"
  // and route.yml orders it last as the catch-all.
  if (tables.length > 1) {
    const sourceSets = tables.map(
      (table) =>
        new Set(
          table.fields
            .map((f) => f.source.toLowerCase())
            .filter((s) => s !== ""),
        ),
    );
    // VALUES are tried FIRST, because presence cannot separate log types that
    // share one schema - the common case for CEF vendors, and the reason the
    // Zscaler pack shipped with 7 of 10 routes unreachable. Presence stays the
    // fallback: it needs no sample values, so it still works for callers that
    // supply none, and for log types whose shapes genuinely differ.
    const sampleValues = input.tables.map((t) => t.sampleFieldValues);
    tables.forEach((table, i) => {
      if (table.routeCondition !== MATCH_ALL_FILTER) return;

      const ownValues = sampleValues[i];
      if (ownValues !== undefined) {
        const siblingValues = sampleValues.filter(
          (v, j) => j !== i && v !== undefined,
        ) as LogTypeFieldValues[];
        const byValue = deriveValueDiscriminator(
          ownValues,
          siblingValues,
          table.sourceFormat,
        );
        if (byValue !== null) {
          table.routeCondition = byValue;
          return;
        }
      }

      const discriminator = deriveRouteDiscriminator(
        table.fields.map((f) => f.source),
        sourceSets.filter((_, j) => j !== i),
        table.sourceFormat,
      );
      if (discriminator !== null) {
        table.routeCondition = discriminator;
        return;
      }

      // Nothing separates this log type. Emit its route and pipeline anyway,
      // behind a filter that cannot match until a human writes one.
      //
      // Keeping `true` here is what made routes unreachable: every route is
      // final, so the first match-all consumed everything and ran it through
      // the wrong pipeline. Dropping the log type instead would be honest but
      // costly - firewall and DNS are exactly what a SOC needs a path for.
      // The placeholder keeps the path and makes the missing filter visible
      // (see route-placeholder), which is work the operator can finish; the
      // other two options are losses they cannot see.
      //
      // Only when there are siblings to be confused with. A single-log-type
      // pack has nothing to shadow, so match-all is correct there and stays -
      // placeholdering it would leave that pack routing nothing at all.
      table.routeCondition = placeholderRouteFilter(table.logType);
    });
  }

  return {
    solutionName: input.solutionName,
    packName: input.packName,
    version,
    vendorPrefix,
    tables,
  };
}
