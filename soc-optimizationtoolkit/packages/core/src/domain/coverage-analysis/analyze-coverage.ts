/**
 * THE SHARED CONTENT-REFERENCE ANALYZER (porting-plan Unit 23 task items 1 & 4)
 * - the FIRST SLICE of the native-onboarding flagship's analyzer. ONE engine
 * over the generic {@link ContentItem}: alert rules and workbooks are two
 * sources in, one {@link CoverageReport} out. It never branches on item type -
 * the type is provenance carried through to the report for the UI.
 *
 * COVERAGE MATH (Unit 23 task item 4):
 *  - Referenced fields per item = extractKqlFields(each query) UNION extraFields
 *    (rule entity columns), sorted, casing PRESERVED.
 *  - The AVAILABILITY set and the SCHEMA UNION are matched case-INSENSITIVELY.
 *  - THREE-WAY per field (the surface-not-drop upgrade over legacy two-way):
 *      covered                       -> field is in the availability set
 *      missing-from-reduced-schema   -> field is a real schema column but not
 *                                       available (the actionable gap)
 *      unknown                       -> field is not in the schema union at all
 *                                       (a computed KQL var or other-table
 *                                       column) - SURFACED, not silently dropped
 *  - coverage = covered / (covered + missing-from-reduced-schema); unknowns are
 *    excluded from the denominator, so the number equals the legacy ratio
 *    (whose requiredFields were pre-filtered to schema columns). 1 when the
 *    denominator is 0.
 *  - missingFieldsAcrossRules = missing-from-reduced-schema fields ranked by
 *    reference FREQUENCY (most-needed first; insertion order breaks ties).
 *  - ruleReferencedFields = every unique SCHEMA-RESOLVABLE referenced field
 *    (covered union missing), sorted, casing preserved. This is the KEPT Unit
 *    18 contract that lights the mapping-table RULE badges: only real
 *    destination columns, never unknowns.
 *
 * NO STALE-SKIP (Unit 23 task item 5): the legacy UI skipped re-running
 * coverage whenever the mapped-destination set was empty, leaving stale results
 * after a custom-rule upload. This engine has NO such guard - it runs over
 * whatever items and availability it is given, INCLUDING an empty availability
 * set (every schema field then reads missing, every non-schema field unknown).
 * {@link shouldRerunCoverage} pins that always-run rule for the caller.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { extractKqlFields } from "./extract-kql-fields";
import type {
  ContentItem,
  CoverageInput,
  CoverageReport,
  CoverageSummary,
  ItemCoverage,
} from "./models";

/** Extract the full referenced-field set for one item (queries + extraFields). */
function referencedFieldsFor(item: ContentItem): string[] {
  const set = new Set<string>();
  for (const query of item.queries) {
    for (const field of extractKqlFields(query)) set.add(field);
  }
  for (const field of item.extraFields ?? []) set.add(field);
  return [...set].sort();
}

/** Classify one item's fields three ways against the availability + schema sets. */
function classifyItem(
  item: ContentItem,
  availableLower: ReadonlySet<string>,
  schemaLower: ReadonlySet<string>,
): ItemCoverage {
  const referencedFields = referencedFieldsFor(item);
  const covered: string[] = [];
  const missingFromReducedSchema: string[] = [];
  const unknown: string[] = [];

  for (const field of referencedFields) {
    const lower = field.toLowerCase();
    if (availableLower.has(lower)) covered.push(field);
    else if (schemaLower.has(lower)) missingFromReducedSchema.push(field);
    else unknown.push(field);
  }

  const denominator = covered.length + missingFromReducedSchema.length;
  const coverage = denominator > 0 ? covered.length / denominator : 1;

  return {
    type: item.type,
    id: item.id,
    name: item.name,
    custom: item.custom ?? false,
    severity: item.severity ?? "Unknown",
    tactics: item.tactics ?? [],
    referencedFields,
    covered,
    missingFromReducedSchema,
    unknown,
    coverage,
    queries: [...item.queries],
    unparseableQueryCount: item.unparseableQueryCount ?? 0,
  };
}

/**
 * Run the shared coverage engine over a set of content items. See the module
 * header for the exact math. Deterministic and total - never throws, never
 * skips, safe on an empty availability set.
 */
export function analyzeContentCoverage(input: CoverageInput): CoverageReport {
  const availableLower = new Set(
    input.availableFields.map((f) => f.toLowerCase()),
  );
  const schemaLower = new Set(input.schemaUnion.map((f) => f.toLowerCase()));

  const items = input.items.map((item) =>
    classifyItem(item, availableLower, schemaLower),
  );

  const fullyCovered = items.filter((r) => r.coverage === 1).length;
  const partiallyCovered = items.filter(
    (r) => r.coverage > 0 && r.coverage < 1,
  ).length;

  // Frequency-rank the missing-from-reduced-schema fields (most-needed first).
  // A Map preserves insertion order, and Array.sort is stable, so ties keep
  // first-seen order - the legacy behavior.
  const missingFreq = new Map<string, number>();
  for (const r of items) {
    for (const f of r.missingFromReducedSchema) {
      missingFreq.set(f, (missingFreq.get(f) ?? 0) + 1);
    }
  }
  const missingFieldsAcrossRules = [...missingFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);

  // The KEPT Unit 18 contract: only SCHEMA-RESOLVABLE fields (covered union
  // missing) light RULE badges - never unknowns.
  const ruleReferencedFields = [
    ...new Set(
      items.flatMap((r) => [...r.covered, ...r.missingFromReducedSchema]),
    ),
  ].sort();

  const unparseableQueryCount = items.reduce(
    (sum, r) => sum + r.unparseableQueryCount,
    0,
  );

  const summary: CoverageSummary = {
    totalItems: items.length,
    fullyCovered,
    partiallyCovered,
    missingFieldsAcrossRules,
    ruleReferencedFields,
    unparseableQueryCount,
  };

  return { items, summary };
}

/**
 * PIN of the no-stale-skip fix (Unit 23 task item 5). The legacy UI gated the
 * coverage re-run on `mappedDest.length > 0`, so after a custom-rule
 * upload/clear with no mapped destinations the panel showed STALE coverage.
 * This predicate is unconditionally `true`: coverage should ALWAYS re-run when
 * the rule set or availability changes, because {@link analyzeContentCoverage}
 * is well-defined on an empty availability set. Kept as a named function so the
 * contract is testable and the shells cannot reintroduce the guard.
 */
export function shouldRerunCoverage(): boolean {
  return true;
}
