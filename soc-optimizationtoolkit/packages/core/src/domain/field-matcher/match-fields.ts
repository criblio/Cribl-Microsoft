/**
 * field-matcher MATCHING ENGINE - porting-plan Unit 13 (ENG-04/03).
 *
 * matchFields and matchSampleToSchema, ported VERBATIM from legacy
 * field-matcher.ts (lines 620-820). The phase order, thresholds, and tie-break
 * boosts ARE the contract - characterization-pinned, not "improved".
 *
 * ONE behavior change vs legacy (Unit 13 decision, fix + pin): when a table's
 * overflow column is ABSENT from the resolved schema, legacy set
 * overflowConfig.enabled=false and SILENTLY dropped the overflow fields. We keep
 * enabled=false (the emission contract is unchanged) but SURFACE a warning on
 * MatchResult.warnings so the data loss is visible.
 *
 * The actual-sample-casing rule is preserved: matched output field names use the
 * REAL source-field casing (Cribl renames are case-sensitive), even when a
 * vendor mapping or schema column used different casing.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto. Type-coercion detection
 * compares the source type (sample-inference vocabulary) against the dest type
 * (DCR vocabulary) verbatim as legacy did; it does NOT fork schema-mapping's
 * mapColumnType (that map owns DCR-emission-time reconciliation, Unit 5).
 */

import type {
  DestField,
  FieldMatch,
  MatchConfidence,
  MatchResult,
  SourceField,
} from "./models";
import {
  COALESCE_PRIORITY,
  EVENT_TYPE_BOOSTS,
  classifyEventType,
} from "./knowledge-bases";
import { scoreMatch, typeValueBoost } from "./scoring";
import { SKIP_OVERFLOW_FIELDS, getOverflowConfig } from "./overflow";

/** A vendor-research field mapping override (Phase 0, highest priority). */
export interface VendorMapping {
  sourceName: string;
  destName: string;
  sourceType: string;
  destType: string;
  action: string;
}

/**
 * Match ALL source fields to dest fields. Verbatim port of legacy matchFields
 * with the added missing-overflow-field warning.
 */
export function matchFields(
  sourceFields: SourceField[],
  destFields: DestField[],
  vendorMappings?: VendorMapping[],
  destTableName?: string,
): MatchResult {
  const matched: FieldMatch[] = [];
  const usedDest = new Set<string>();
  const usedSource = new Set<string>();

  // Phase 0: Apply vendor-specific mappings first (highest priority)
  // Uses case-insensitive lookup for source fields because vendor research
  // field names may use different casing than the actual data (e.g.,
  // "LoginSessionId" in vendor docs vs "loginSessionId" in real FDR events).
  // The matched result always uses the ACTUAL source field name (src.name)
  // so that downstream rename rules reference the real field casing.
  if (vendorMappings) {
    for (const vm of vendorMappings) {
      if (vm.action === "drop") continue;
      const src =
        sourceFields.find((s) => s.name === vm.sourceName) ||
        sourceFields.find(
          (s) => s.name.toLowerCase() === vm.sourceName.toLowerCase(),
        );
      const dst =
        destFields.find((d) => d.name === vm.destName) ||
        destFields.find(
          (d) => d.name.toLowerCase() === vm.destName.toLowerCase(),
        );
      if (src) {
        // "decode": the vendor documents this source as the destination's
        // data base64-encoded - the pipeline decodes rather than renames.
        const isDecode = vm.action === "decode";
        matched.push({
          sourceName: src.name, // Use actual casing from source data
          sourceType: src.type || vm.sourceType,
          destName: dst?.name || vm.destName, // Use actual casing from schema
          destType: dst?.type || vm.destType,
          confidence: "exact",
          action: isDecode
            ? "decode"
            : src.name === (dst?.name || vm.destName)
              ? "keep"
              : "rename",
          needsCoercion: isDecode
            ? false
            : (src.type || vm.sourceType) !== (dst?.type || vm.destType),
          description: isDecode
            ? `Vendor mapping (base64 decode): ${src.name} -> ${dst?.name || vm.destName}`
            : `Vendor mapping: ${src.name} -> ${dst?.name || vm.destName}`,
          sampleValue: src.sampleValue,
        });
        usedSource.add(src.name);
        usedDest.add(dst?.name || vm.destName);
      }
    }
  }

  // Phase 0.5: Coalesce priority pre-assignment.
  // For key destination fields with multiple possible source mappings, prefer
  // the highest-priority source field that actually exists in the data.
  // This prevents lower-priority fields from claiming the destination first.
  const coalesceReserved = new Map<string, string>(); // destName -> reserved sourceName
  for (const [destName, priorities] of Object.entries(COALESCE_PRIORITY)) {
    if (usedDest.has(destName)) continue;
    for (const srcName of priorities) {
      const src = sourceFields.find(
        (s) =>
          s.name === srcName || s.name.toLowerCase() === srcName.toLowerCase(),
      );
      if (src && !usedSource.has(src.name)) {
        coalesceReserved.set(destName, src.name);
        break; // First match in priority order wins
      }
    }
  }

  // Classify event type for contextual score boosts
  const eventType = classifyEventType(sourceFields.map((s) => s.name));
  const eventBoosts = EVENT_TYPE_BOOSTS[eventType] || {};

  // Phase 1: Exact, alias, and fuzzy matches with type-aware + event-type
  // boosts.
  //
  // GLOBAL ASSIGNMENT (2026-07-09 improvement, pinned): the legacy loop
  // assigned per SOURCE field in DISCOVERY order, so an early field holding a
  // weak fuzzy score (50) could permanently steal a column from a later field
  // holding an alias score (90) - whether a mapping won depended on the JSON
  // key order of the sample. Now every (source, dest) pair above threshold is
  // scored first and assignment runs in DESCENDING score order (ties break by
  // source order then schema order, matching the legacy tie behavior), so the
  // strongest claim on a column always wins regardless of field order. A
  // source that loses its best column still competes for its next-best via
  // its remaining pairs.
  interface Candidate {
    srcIdx: number;
    destIdx: number;
    score: number;
    confidence: MatchConfidence;
    reason: string;
  }
  const candidates: Candidate[] = [];
  for (let s = 0; s < sourceFields.length; s++) {
    const src = sourceFields[s];
    if (usedSource.has(src.name)) continue;
    for (let d = 0; d < destFields.length; d++) {
      const dst = destFields[d];
      if (usedDest.has(dst.name)) continue;

      // If this dest has a coalesce reservation, only the reserved source can claim it
      const reserved = coalesceReserved.get(dst.name);
      if (reserved && reserved !== src.name) continue;

      const { score: nameScore, confidence, reason } = scoreMatch(
        src.name,
        dst.name,
      );
      if (nameScore === 0) continue;

      // Add type-aware sample value boost (tiebreaker for ambiguous matches)
      const valueBoost = typeValueBoost(src.sampleValue, dst.name, dst.type);

      // Add event-type contextual boost
      const eventBoost = eventBoosts[dst.name] || 0;

      const totalScore = nameScore + valueBoost + eventBoost;
      // Only accept matches above threshold (50 base, boosts can help borderline)
      if (totalScore < 50) continue;

      candidates.push({
        srcIdx: s,
        destIdx: d,
        score: totalScore,
        confidence,
        reason:
          reason +
          (valueBoost > 0 ? ` [+${valueBoost} value match]` : "") +
          (eventBoost > 0 ? ` [+${eventBoost} ${eventType} context]` : ""),
      });
    }
  }
  candidates.sort(
    (a, b) => b.score - a.score || a.srcIdx - b.srcIdx || a.destIdx - b.destIdx,
  );
  for (const candidate of candidates) {
    const src = sourceFields[candidate.srcIdx];
    const dst = destFields[candidate.destIdx];
    if (usedSource.has(src.name) || usedDest.has(dst.name)) continue;
    const needsCoercion =
      src.type !== dst.type && src.type !== "" && dst.type !== "";
    matched.push({
      sourceName: src.name,
      sourceType: src.type,
      destName: dst.name,
      destType: dst.type,
      confidence: candidate.confidence,
      action:
        src.name === dst.name ? (needsCoercion ? "coerce" : "keep") : "rename",
      needsCoercion,
      description: candidate.reason,
      sampleValue: src.sampleValue,
    });
    usedSource.add(src.name);
    usedDest.add(dst.name);
  }

  // Collect unmatched source fields
  const rawUnmatchedSource = sourceFields.filter((s) => !usedSource.has(s.name));
  const unmatchedDest = destFields.filter((d) => !usedDest.has(d.name));

  // Determine overflow configuration for the destination table.
  // Unmatched source fields go into the overflow field rather than being dropped,
  // so no vendor data is lost.
  const overflowDef = getOverflowConfig(destTableName || "");

  // Check if the overflow field exists in the destination schema
  const overflowFieldExists = destFields.some(
    (d) => d.name === overflowDef.fieldName,
  );

  const overflow: FieldMatch[] = [];
  const trueUnmatchedSource: SourceField[] = [];

  for (const src of rawUnmatchedSource) {
    // Skip Cribl internal / transport fields
    if (
      SKIP_OVERFLOW_FIELDS.has(src.name) ||
      src.name.startsWith("__") ||
      src.name.startsWith("cribl_")
    ) {
      trueUnmatchedSource.push(src);
      continue;
    }

    // Route to overflow
    overflow.push({
      sourceName: src.name,
      sourceType: src.type,
      destName: overflowDef.fieldName,
      destType: overflowDef.fieldType,
      confidence: "unmatched",
      action: "overflow",
      needsCoercion: false,
      description: `Collected into ${overflowDef.fieldName} (no dedicated destination column)`,
      sampleValue: src.sampleValue,
    });
  }

  // Sort matched by confidence (exact first, then alias, then fuzzy)
  const confOrder: Record<MatchConfidence, number> = {
    exact: 0,
    alias: 1,
    fuzzy: 2,
    unmatched: 3,
  };
  matched.sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence]);

  const totalHandled = matched.length + overflow.length;

  // Unit 13 fix + pin: surface the silent data loss legacy hid. When there are
  // fields destined for overflow but the overflow column is not in the schema,
  // those fields are dropped (enabled stays false, per the legacy contract).
  const warnings: string[] = [];
  if (overflow.length > 0 && !overflowFieldExists) {
    warnings.push(
      `${overflow.length} unmatched field(s) cannot be preserved: the overflow ` +
        `column "${overflowDef.fieldName}" is absent from the ` +
        `${destTableName || "destination"} schema, so these fields are dropped. ` +
        `Add a ${overflowDef.fieldName} (${overflowDef.fieldType}) column to the ` +
        `table to capture them.`,
    );
  }

  return {
    matched,
    overflow,
    unmatchedSource: trueUnmatchedSource,
    unmatchedDest,
    overflowConfig: {
      enabled: overflow.length > 0 && overflowFieldExists,
      fieldName: overflowDef.fieldName,
      fieldType: overflowDef.fieldType,
      sourceFields: overflow.map((o) => o.sourceName),
    },
    totalSource: sourceFields.length,
    totalDest: destFields.length,
    matchRate:
      sourceFields.length > 0 ? totalHandled / sourceFields.length : 0,
    warnings,
  };
}

/** A parsed-sample field as accepted by matchSampleToSchema. */
export interface SampleFieldInput {
  name: string;
  type: string;
  sampleValues?: string[];
}

/**
 * Match parsed-sample fields against a DCR schema column list. Verbatim from
 * legacy matchSampleToSchema (uses the first sample value as the tie-break
 * sampleValue).
 */
export function matchSampleToSchema(
  sampleFields: SampleFieldInput[],
  schemaColumns: Array<{ name: string; type: string }>,
  vendorMappings?: VendorMapping[],
  tableName?: string,
): MatchResult {
  const sourceFields: SourceField[] = sampleFields.map((f) => ({
    name: f.name,
    type: f.type,
    sampleValue: f.sampleValues?.[0],
  }));
  const destFields: DestField[] = schemaColumns.map((c) => ({
    name: c.name,
    type: c.type,
  }));
  return matchFields(sourceFields, destFields, vendorMappings, tableName);
}
