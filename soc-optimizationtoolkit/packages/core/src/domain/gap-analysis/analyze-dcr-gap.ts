/**
 * DCR gap analysis - the DCR-SIDE partitioning engine (porting-plan Unit 18,
 * ENG-12). Ported from legacy kql-parser.ts analyzeDcrGap.
 *
 * DESIGN CONTRACT (preserved verbatim from the legacy header): CRIBL MUST NEVER
 * DUPLICATE DCR WORK. A DCR's transformKql defines:
 *   - project-rename: field renames the DCR does (Cribl should NOT duplicate)
 *   - extend tolong()/todouble(): type coercions the DCR does (Cribl should NOT
 *     duplicate)
 *   - where event_simpleName in (...): routing the DCR does (Cribl mirrors it
 *     for pack routing, not for transformation)
 * The Cribl pipeline should ONLY handle:
 *   - fields that need renaming but the DCR does NOT rename
 *   - type coercions the DCR does NOT handle
 *   - fields present in source but absent from the DCR schema (overflow/drop)
 *   - the vendor _time extraction (Cribl-specific, not in the DCR)
 *   - Cribl metadata cleanup (cribl_*, __header*, etc.)
 *
 * DUAL-ENGINE SPLIT (Unit 18): this module owns the DCR-side partitioning only.
 * The USER-FACING Passthrough / Cribl Handles / Overflow counts a reviewer sees
 * come from the field matcher (Unit 13), which does alias/fuzzy matching this
 * exact-name partitioner intentionally does not. See gap-report.ts for the
 * composition, and consistency.test.ts for the pinned agreement contract.
 *
 * DELETED DEAD CODE (task item 2): the legacy "case-mismatch" branch
 * (destColumns.find(d => d.name.toLowerCase() === srcLower) after an exact-map
 * miss) was UNREACHABLE - destMap is already keyed by lowercased name, so any
 * case-insensitive hit was already returned by the exact-map lookup above it.
 * It is NOT ported.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { DcrFlow, DcrGapAnalysis, FieldRef } from "./models";
import { generateRouteCondition } from "./kql-parser";
import type { VendorGapProfile } from "./vendor-profile";
import { DEFAULT_GAP_PROFILE } from "./vendor-profile";

/**
 * System/transport fields Cribl always removes. VERBATIM from legacy
 * kql-parser.ts (the criblInternalFields Set). NOTE the plain generic names
 * (source/host/port/sourcetype/index) at the tail: these are the DATA-LOSS
 * FOOTGUN - a real vendor field with one of those exact names is dropped as
 * "internal". See {@link COLLISION_PRONE_INTERNAL_FIELDS}.
 */
export const CRIBL_INTERNAL_FIELDS: ReadonlySet<string> = new Set([
  "cribl_breaker",
  "cribl_pipe",
  "cribl_host",
  "cribl_input",
  "cribl_output",
  "cribl_wp",
  "__inputId",
  "__criblMetrics",
  "__final",
  "__channel",
  "__destHost",
  "__destPort",
  "__spanId",
  "__traceId",
  "__header_content_type",
  "__header_content_length",
  "source",
  "host",
  "port",
  "sourcetype",
  "index",
]);

/**
 * The subset of the internal drop-set that is a PLAIN generic word a real
 * vendor feed can legitimately emit (a firewall's literal "source"/"host"/
 * "port", a Splunk-origin "sourcetype"/"index"). When a source field collides
 * with one of these, the field is still dropped (the emission contract is
 * unchanged) but a warning is surfaced - the Unit 13 AdditionalData_d precedent
 * of SURFACE, DO NOT SILENTLY DROP.
 */
export const COLLISION_PRONE_INTERNAL_FIELDS: ReadonlySet<string> = new Set([
  "source",
  "host",
  "port",
  "sourcetype",
  "index",
]);

/**
 * The data-loss-footgun warning for a vendor field whose name collides with
 * the internal drop-set. Built here (the only emitter) and exported so
 * buildGapReport can RECOGNIZE the exact warning and resolve it into an
 * informational note when the field matcher has already claimed the field -
 * a matcher rename runs in the enrich group, before the cleanup drop, so the
 * vendor value survives and the alarm would be false.
 */
export function internalCollisionWarning(fieldName: string): string {
  return (
    `Source field "${fieldName}" collides with a Cribl-internal field name ` +
    `and is DROPPED as internal metadata. If "${fieldName}" is real ` +
    `vendor data, rename it upstream (or in the pipeline before this ` +
    `drop) so it is not lost.`
  );
}

/**
 * Whether a source type is compatible with a destination type (the DCR can
 * accept the value without a Cribl coercion). VERBATIM from legacy
 * typesCompatible.
 */
export function typesCompatible(sourceType: string, destType: string): boolean {
  const s = sourceType.toLowerCase();
  const d = destType.toLowerCase();
  if (s === d) return true;
  if (s === "string") return true;
  if ((s === "long" || s === "int") && (d === "long" || d === "int")) return true;
  if ((s === "real" || s === "double") && (d === "real" || d === "double")) return true;
  return false;
}

/**
 * Partition `sourceFields` against `destColumns` and the DCR `dcrFlow` into
 * what the DCR handles vs what Cribl must handle. `profile` supplies the
 * vendor _time enrichment (default: none).
 */
export function analyzeDcrGap(
  sourceFields: readonly FieldRef[],
  destColumns: readonly FieldRef[],
  dcrFlow: DcrFlow,
  profile: VendorGapProfile = DEFAULT_GAP_PROFILE,
): DcrGapAnalysis {
  const destMap = new Map(destColumns.map((c) => [c.name.toLowerCase(), c]));
  const dcrRenameMap = new Map(
    dcrFlow.renames.map((r) => [r.source.toLowerCase(), r]),
  );
  const dcrCoercionMap = new Map(
    dcrFlow.typeConversions.map((tc) => [tc.field.toLowerCase(), tc]),
  );

  const enrichments: Array<{ field: string; value: string }> = [];
  if (profile.timeEnrichment) enrichments.push({ ...profile.timeEnrichment });
  // Type is table-generic (not vendor-specific) - always emitted.
  enrichments.push({ field: "Type", value: `'${dcrFlow.tableName}'` });

  const warnings: string[] = [];

  const analysis: DcrGapAnalysis = {
    tableName: dcrFlow.tableName,
    dcrHandles: {
      renames: dcrFlow.renames,
      coercions: dcrFlow.typeConversions,
      routing: generateRouteCondition(dcrFlow.eventSimpleNames),
      timeGenerated: true,
    },
    criblMustHandle: {
      renames: [],
      coercions: [],
      overflow: [],
      drops: [],
      enrichments,
    },
    totalSourceFields: sourceFields.length,
    totalDestFields: destColumns.length,
    passthroughCount: 0,
    dcrHandledCount: dcrFlow.renames.length + dcrFlow.typeConversions.length,
    criblHandledCount: 0,
    overflowCount: 0,
    warnings,
  };

  for (const src of sourceFields) {
    const srcLower = src.name.toLowerCase();

    // Cribl-internal fields - always drop.
    if (
      CRIBL_INTERNAL_FIELDS.has(src.name) ||
      src.name.startsWith("cribl_") ||
      src.name.startsWith("__")
    ) {
      analysis.criblMustHandle.drops.push({
        field: src.name,
        reason: "Cribl internal metadata",
      });
      // DATA-LOSS FOOTGUN: a real vendor field collided with the internal
      // drop-set. Surface it (do not silently drop) - Unit 13 precedent.
      if (COLLISION_PRONE_INTERNAL_FIELDS.has(src.name)) {
        warnings.push(internalCollisionWarning(src.name));
      }
      continue;
    }

    // DCR renames this field - Cribl passes the SOURCE name through untouched.
    if (dcrRenameMap.has(srcLower)) {
      analysis.dcrHandledCount++;
      analysis.passthroughCount++;
      continue;
    }

    const destField = destMap.get(srcLower);
    if (destField) {
      // DCR coerces the type - Cribl passes through.
      if (dcrCoercionMap.has(srcLower)) {
        analysis.passthroughCount++;
        continue;
      }
      if (typesCompatible(src.type, destField.type)) {
        analysis.passthroughCount++;
      } else {
        analysis.criblMustHandle.coercions.push({
          field: src.name,
          fromType: src.type,
          toType: destField.type,
          reason: `Type mismatch: source ${src.type} vs dest ${destField.type}, not handled by DCR`,
        });
        analysis.criblHandledCount++;
      }
      continue;
    }

    // Not in the destination schema at all - overflow.
    // (The legacy case-mismatch branch that sat here was dead code; see header.)
    analysis.criblMustHandle.overflow.push({ field: src.name, type: src.type });
    analysis.overflowCount++;
  }

  // Always clean Cribl metadata (verbatim legacy tail).
  analysis.criblMustHandle.drops.push(
    { field: "_raw", reason: "Raw event string, not needed after extraction" },
    { field: "cribl_*", reason: "Cribl pipeline metadata" },
    { field: "__*", reason: "Cribl transport metadata" },
  );

  analysis.criblHandledCount +=
    analysis.criblMustHandle.enrichments.length +
    analysis.criblMustHandle.drops.length;

  return analysis;
}
