/**
 * Rule + workbook coverage PURE state (porting-plan Unit 23, ENG-11, GUI-09,
 * plus net-new workbook coverage). The @soc/core coverage-analysis module owns
 * the TRUTH - the ONE shared content-reference analyzer over the generic
 * ContentItem, the three-way classification, the frequency ranking, and the
 * KEPT Unit 18 ruleReferencedFields contract. This module is only the BINDING
 * layer the panel adds, kept out of the component so every projection is
 * unit-testable without a DOM:
 *
 *   - the coverage-input derivation from the Gap Analysis reports (the
 *     availability set = mapped destinations, and the destination-table names
 *     whose schemas the caller unions);
 *   - the rule-acquisition surface constants (the three Analytic-Rules dir-name
 *     variants, the YAML file test) the component's IO loop consumes;
 *   - the custom-YAML upload projection (parse -> shared ContentItem, custom
 *     flagged) over the core parser;
 *   - the panel projection: partition the CoverageReport into a rule section and
 *     a workbook section (two sources, one analyzer), the THREE-WAY counts, the
 *     per-item view (severity tone, coverage %, covered/missing/unknown), the
 *     header count chips, the missing-fields-by-frequency chips, and the summary
 *     line - all in the VERBATIM legacy vocabulary where the legacy had it;
 *   - the RULE-badge field-set derivation (the kept Unit 18 contract): the
 *     schema-resolvable referenced fields, lowercased, that light the mapping
 *     table's RULE badges.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto, no Math.random.
 */

import {
  analyticRuleToContentItem,
  analyzeContentCoverage,
  parseRuleUploadFile,
  unionSchemaColumns,
} from "@soc/core";
import type {
  ContentItem,
  ContentItemType,
  CoverageReport,
  CoverageSummary,
  GapFieldMapping,
  GapReport,
  ItemCoverage,
  SchemaCatalog,
} from "@soc/core";

// ---------------------------------------------------------------------------
// Rule acquisition surface (consumed by the component's content-port IO loop)
// ---------------------------------------------------------------------------

/**
 * The Analytic-Rules directory variants and the rule-YAML predicate now come
 * from @soc/core's sentinel-content domain, and are re-exported here so this
 * module's public surface is unchanged for the component and its pins.
 *
 * They were DEFINED here until the 2026-08-17 audit, with byte-identical copies
 * in core's siem-migration use-case. Two definitions of where a Sentinel
 * solution keeps its analytic rules can disagree, and only this one was pinned:
 * a fourth variant added here would have left the other probing three, so
 * SIEM migration would find no rules for a solution this screen handles fine.
 * The knowledge is about the content repo, not about this screen, so it lives
 * in the domain and both consumers import it.
 */
export {
  ANALYTIC_RULE_DIR_VARIANTS,
  isRuleYamlFileName,
} from "@soc/core";

// ---------------------------------------------------------------------------
// Coverage-input derivation from the Gap Analysis reports
// ---------------------------------------------------------------------------

/**
 * The AVAILABILITY set fed to the analyzer: the destination fields the mapped
 * pipeline actually produces. What ONE log type produces follows the legacy
 * `mappedDest` rules (SentinelIntegration.tsx 2649-2655); how log types
 * combine does not - see PER LOG TYPE below:
 *   - a `drop` mapping contributes nothing (the field is discarded);
 *   - an `overflow` mapping contributes BOTH the destination catch-all column
 *     and the source field name (the source survives inside the catch-all);
 *   - every other mapping contributes its destination column.
 * De-duplicated and sorted (the analyzer matches case-insensitively, so order
 * is irrelevant; sorted for deterministic tests).
 *
 * PER LOG TYPE (DBT-223, backlog.md section 25). The set used to be a plain
 * union of every log type's fields, so a column filled from TRAFFIC counted as
 * available for every rule, its missing chip cleared, and a THREAT detection
 * reading it was reported covered while THREAT events never carry it. A field
 * is now available only when EVERY log type it applies to provides it - see
 * {@link fieldMissingLogTypes} for which log types it applies to.
 */
export function availableFieldsFromReports(
  reports: readonly GapReport[],
): string[] {
  const provided = reports.map(providedFields);
  const names = new Map<string, string>();
  for (const report of reports) {
    for (const name of fieldNames(report)) {
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
  }
  const available: string[] = [];
  for (const [lower, name] of names) {
    if (missingIn(lower, reports, provided).length === 0) available.push(name);
  }
  return available.sort();
}

/**
 * The log types a field is still missing from (DBT-223), in report order.
 *
 * The log types a field APPLIES to are those whose destination schema has a
 * column of that name: a log type routed to a table without the column cannot
 * fill it, so it does not count against it. A field that is no column of any
 * report's table (a source name carried in overflow, a parser synonym) applies
 * to every log type. Empty = available everywhere it applies.
 */
export function fieldMissingLogTypes(
  field: string,
  reports: readonly GapReport[],
): string[] {
  return missingIn(field.toLowerCase(), reports, reports.map(providedFields));
}

/** Close matches offered per log type still missing a field (DBT-223). */
export const CLOSE_MATCHES_PER_LOG_TYPE = 3;

/**
 * " - missing in THREAT" when SOME log types still lack a field, null when
 * none or all do: then the bare field name already says everything, and
 * listing every log type would only add noise to a chip.
 */
export function partialMissingNote(missing: readonly string[], logTypeCount: number): string | null {
  if (missing.length === 0 || missing.length >= logTypeCount) return null;
  return ` - missing in ${missing.join(", ")}`;
}

function missingIn(
  lower: string,
  reports: readonly GapReport[],
  provided: readonly ReadonlySet<string>[],
): string[] {
  const hasColumn = reports.map((r) => r.destSchema.some((c) => c.name.toLowerCase() === lower));
  const appliesTo = hasColumn.some(Boolean) ? hasColumn : reports.map(() => true);
  return reports
    .filter((_, i) => appliesTo[i] && !provided[i]!.has(lower))
    .map((r) => r.logType);
}

/** The fields one log type's pipeline produces (the rules in the docblock above). */
function fieldNames(report: GapReport): string[] {
  const out: string[] = [];
  for (const mapping of report.fieldMappings) {
    if (mapping.action === "drop") continue;
    out.push(mapping.dest);
    if (mapping.action === "overflow") out.push(mapping.source);
  }
  return out;
}

function providedFields(report: GapReport): Set<string> {
  return new Set(fieldNames(report).map((f) => f.toLowerCase()));
}

/**
 * The distinct destination-table names across the reports (legacy
 * `allDestTables`). The component resolves each table's schema through the
 * SchemaCatalog port and unions the columns (core unionSchemaColumns) to form
 * the analyzer's schemaUnion - so a rule referencing a sibling table's column
 * is classified missing-from-reduced-schema, not unknown.
 */
export function destinationTableNamesFromReports(
  reports: readonly GapReport[],
): string[] {
  return [...new Set(reports.map((report) => report.tableName))].sort();
}

/**
 * The reports as the reviewer has EDITED them (DBT-203): each report's
 * fieldMappings replaced by the mapping review's effective rows for its log
 * type. Coverage reads availability from these, so a field applied in the Gap
 * Analysis (or from a missing-field chip here) counts as available at once and
 * its chip clears. A log type with no entry keeps the analysis baseline, and
 * an absent map returns the reports unchanged.
 */
export function reportsWithEffectiveMappings(
  reports: readonly GapReport[],
  effective: Readonly<Record<string, readonly GapFieldMapping[]>> | undefined,
): GapReport[] {
  if (effective === undefined) return [...reports];
  return reports.map((report) => {
    const rows = effective[report.logType];
    return rows === undefined ? report : { ...report, fieldMappings: [...rows] };
  });
}

/**
 * Where a close match for a missing field would land in ITS log type's table
 * (DBT-203): the destination column of that report's schema the field names,
 * matched case-insensitively and returned in the schema's own spelling. Null
 * when the log type has no report or its table has no such column - a rule
 * can reference a sibling table's column, and offering to rename into a
 * column the table lacks would be a click that silently does nothing.
 */
export function closeMatchTargetColumn(
  field: string,
  logType: string,
  reports: readonly GapReport[],
): string | null {
  const report = reports.find((r) => r.logType === logType);
  if (report === undefined) return null;
  const wanted = field.toLowerCase();
  return (
    report.destSchema.find((c) => c.name.toLowerCase() === wanted)?.name ?? null
  );
}

/**
 * Union the destination schemas the analyzer classifies against: each
 * report's OWN destSchema first - the analysis's source of truth, and the
 * only place a DERIVED schema exists (an unresolvable _CL destination
 * defined by the sample + content references resolves NOWHERE else; live
 * regression 2026-07-14: Cloudflare_CL derived 81 columns in the gap
 * analysis while this section still said "No schema could be resolved") -
 * then each table through the SchemaCatalog for sibling-table completeness.
 */
export async function resolveSchemaUnion(
  catalog: SchemaCatalog,
  reports: readonly GapReport[],
): Promise<string[]> {
  const schemas: Array<Array<{ name: string }>> = [];
  for (const report of reports) {
    if (report.destSchema.length > 0) {
      schemas.push(report.destSchema.map((c) => ({ name: c.name })));
    }
  }
  for (const table of destinationTableNamesFromReports(reports)) {
    const columns = await catalog.resolveSchema(table);
    if (columns !== null) {
      schemas.push(columns.map((c) => ({ name: c.name })));
    }
  }
  return unionSchemaColumns(schemas);
}

// ---------------------------------------------------------------------------
// Custom-rule upload projection (YAML detections, ARM JSON exports, raw KQL)
// ---------------------------------------------------------------------------

/** One uploaded rule file (name + text) awaiting parse. */
export interface RuleYamlUpload {
  fileName: string;
  content: string;
}

/**
 * Parse uploaded custom rule files into shared ContentItems, each flagged
 * `custom` (drives the CUSTOM badge). The core dispatcher accepts the three
 * wrappings a rule's KQL arrives in - repo-style YAML detections, portal ARM
 * JSON exports (which may carry several rules per file), and raw .kql/.txt
 * queries. Query text is PRESERVED (the legacy custom path dropped it), so a
 * custom rule flows through the shared analyzer identically to a repo rule.
 * The component merges the result into its custom-rule list with core
 * mergeCustomContentItems (last-write-wins by name - the re-upload fix), then
 * re-runs coverage.
 */
export function parseCustomRuleUploads(
  uploads: readonly RuleYamlUpload[],
): ContentItem[] {
  return uploads.flatMap((upload) =>
    parseRuleUploadFile(upload.fileName, upload.content).map((rule) =>
      analyticRuleToContentItem(rule, true),
    ),
  );
}

/** The "N custom rule(s)" note count. */
export function customRuleCount(customItems: readonly ContentItem[]): number {
  return customItems.length;
}

// ---------------------------------------------------------------------------
// The RULE-badge field set (the kept Unit 18 contract)
// ---------------------------------------------------------------------------

/**
 * The LOWERCASED schema-resolvable referenced-field set that lights the mapping
 * table's RULE badges (the kept Unit 18 contract `ruleReferencedFields`). The
 * analyzer already restricts this to real destination columns (covered union
 * missing-from-reduced-schema, never unknowns), so a badge only ever appears on
 * a mappable row. Lowercased to match isRuleField's case-insensitive lookup.
 */
export function ruleFieldSet(summary: CoverageSummary): ReadonlySet<string> {
  return new Set(summary.ruleReferencedFields.map((f) => f.toLowerCase()));
}

/**
 * The RULE-badge set straight from the GAP ANALYSIS, with no coverage run
 * (DBT-121). The badges used to light only after the Rule Coverage section's
 * own Analyze button, so clicking Analyze on the DCR gap analysis tagged
 * nothing and the feature read as missing on an installed app. This derives
 * the same contract from the analytic rules already fetched at solution
 * selection and the destination columns the gap reports carry, through the
 * SAME analyzer - so it is recomputed every time a gap analysis completes.
 *
 * Alert rules only: workbook fields are not rules. Availability is irrelevant
 * to the badge (covered and missing both count), so none is passed. Returns
 * undefined while there is nothing to tag, matching ruleFieldSet's "not yet".
 */
export function ruleFieldsFromGapReports(
  items: readonly ContentItem[],
  reports: readonly GapReport[],
): ReadonlySet<string> | undefined {
  const rules = items.filter((item) => item.type === "alert-rule");
  if (rules.length === 0 || reports.length === 0) {
    return undefined;
  }
  const schemaUnion = reports.flatMap((r) => r.destSchema.map((c) => c.name));
  return ruleFieldSet(
    analyzeContentCoverage({ items: rules, availableFields: [], schemaUnion })
      .summary,
  );
}

/** Union of two optional RULE-badge sets; undefined only when both are. */
export function unionRuleFields(
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return new Set([...a, ...b]);
}

// ---------------------------------------------------------------------------
// The three-way counts (legacy vocabulary)
// ---------------------------------------------------------------------------

/** The three-way coverage tally over a set of analyzed items. */
export interface CoverageThreeWay {
  total: number;
  /** coverage === 1 (has every schema-resolvable field it references). */
  fullyCovered: number;
  /** 0 < coverage < 1 (has some but not all). */
  partiallyCovered: number;
  /** coverage === 0 (has none of the schema-resolvable fields it references). */
  noCoverage: number;
}

/**
 * Tally items three ways, matching the core summary's fully/partial split
 * (coverage === 1 fully; 0 < coverage < 1 partial; the rest no-coverage). Runs
 * over any ItemCoverage[] so a per-section (rules-only / workbooks-only) count
 * is a filtered call.
 */
export function deriveThreeWayCounts(
  items: readonly ItemCoverage[],
): CoverageThreeWay {
  let fullyCovered = 0;
  let partiallyCovered = 0;
  for (const item of items) {
    if (item.coverage === 1) fullyCovered += 1;
    else if (item.coverage > 0 && item.coverage < 1) partiallyCovered += 1;
  }
  const total = items.length;
  return {
    total,
    fullyCovered,
    partiallyCovered,
    noCoverage: total - fullyCovered - partiallyCovered,
  };
}

// ---------------------------------------------------------------------------
// Per-item and per-section view projection
// ---------------------------------------------------------------------------

/** Severity badge tone (legacy exact-string match on High/Medium/Low). */
export type SeverityTone = "high" | "medium" | "low" | "unknown";

/** Coverage-percent tone (legacy: 1 -> green, > 0.5 -> orange, else red). */
export type CoverageTone = "ok" | "warn" | "error";

/** Map a rule severity to its badge tone (exact match, else unknown). */
export function severityTone(severity: string): SeverityTone {
  switch (severity) {
    case "High":
      return "high";
    case "Medium":
      return "medium";
    case "Low":
      return "low";
    default:
      return "unknown";
  }
}

/** Coverage as a whole-number percent (legacy Math.round(coverage * 100)). */
export function coveragePercent(coverage: number): number {
  return Math.round(coverage * 100);
}

/** The coverage-percent tone (legacy thresholds). */
export function coverageTone(coverage: number): CoverageTone {
  if (coverage === 1) return "ok";
  if (coverage > 0.5) return "warn";
  return "error";
}

/** The projected view of one analyzed content item (rule or workbook). */
export interface CoverageItemView {
  key: string;
  type: ContentItemType;
  name: string;
  custom: boolean;
  severity: string;
  severityTone: SeverityTone;
  coverage: number;
  coveragePercent: number;
  coverageTone: CoverageTone;
  /** Referenced fields present in the availability set (rule casing preserved). */
  covered: string[];
  /** Real schema columns referenced but NOT available - the actionable gap. */
  missing: string[];
  /** Referenced names not in the schema union at all (computed vars / other tables). */
  unknown: string[];
  /** How many missing fields (the "N missing" summary marker). */
  missingCount: number;
  /** The item's KQL query text(s), for the "View KQL Query" expandable. */
  queries: string[];
  /** Workbook query blocks that could not be parsed (0 for rules). */
  unparseableQueryCount: number;
}

/** Project one core ItemCoverage into its view model. */
export function deriveCoverageItemView(item: ItemCoverage): CoverageItemView {
  return {
    key: item.id !== "" ? item.id : item.name,
    type: item.type,
    name: item.name,
    custom: item.custom,
    severity: item.severity,
    severityTone: severityTone(item.severity),
    coverage: item.coverage,
    coveragePercent: coveragePercent(item.coverage),
    coverageTone: coverageTone(item.coverage),
    covered: item.covered,
    missing: item.missingFromReducedSchema,
    unknown: item.unknown,
    missingCount: item.missingFromReducedSchema.length,
    queries: item.queries,
    unparseableQueryCount: item.unparseableQueryCount,
  };
}

/** One header count chip (verbatim legacy label + a render tone). */
export interface CoverageCountChip {
  tone: "ok" | "warn" | "error" | "muted";
  text: string;
}

/** The noun for a content type in the count labels ("rule" / "workbook"). */
export function contentTypeNoun(type: ContentItemType): string {
  return type === "workbook" ? "workbook" : "rule";
}

/**
 * The header count chips in legacy order and vocabulary: "N fully covered"
 * (always), "N partial" (only when > 0), "N no coverage" (only when > 0), and
 * "N total rule(s)"/"N total workbook(s)" (always). The partial / no-coverage
 * chips are omitted at zero, exactly as the legacy summary bar rendered them.
 */
export function coverageCountChips(
  type: ContentItemType,
  counts: CoverageThreeWay,
): CoverageCountChip[] {
  const noun = contentTypeNoun(type);
  const chips: CoverageCountChip[] = [
    { tone: "ok", text: `${counts.fullyCovered} fully covered` },
  ];
  if (counts.partiallyCovered > 0) {
    chips.push({ tone: "warn", text: `${counts.partiallyCovered} partial` });
  }
  if (counts.noCoverage > 0) {
    chips.push({ tone: "error", text: `${counts.noCoverage} no coverage` });
  }
  chips.push({
    tone: "muted",
    text: `${counts.total} total ${noun}${counts.total !== 1 ? "s" : ""}`,
  });
  return chips;
}

/**
 * The section summary line. The alert-rule branches are VERBATIM legacy
 * vocabulary (SentinelIntegration.tsx 2591-2595); the workbook branches are the
 * net-new parallel copy (the old app never analyzed workbooks).
 *
 * The empty-workbook branch names the SOLUTION REPO as the only source (DBT-54).
 * It used to add "and folds in any Sentinel workbooks already deployed in your
 * subscription", which the 2026-07-12 user direction had already reversed - see
 * rule-coverage-section.tsx, where deployed subscription workbooks are
 * deliberately NOT analyzed because a shared subscription carries unrelated
 * dashboards and local copies drift from the repo templates. The copy was
 * telling an operator staring at "no workbooks found" to go look for a
 * subscription read that never happens.
 */
export function coverageSummaryLine(
  type: ContentItemType,
  counts: CoverageThreeWay,
  missingFieldCount: number,
): string {
  const isRule = type !== "workbook";
  if (counts.total === 0) {
    return isRule
      ? "No analytics rules found in the Sentinel repository for this solution. You can upload custom rules below to validate field coverage."
      : "No workbooks found for this solution. Workbook coverage reads the solution's Workbooks directory from the Sentinel repository only - workbooks already deployed in your subscription are not analyzed.";
  }
  if (counts.fullyCovered === counts.total) {
    return isRule
      ? "All analytics rules have the fields they need from your sample data."
      : "All workbooks have the fields they need from your sample data.";
  }
  return isRule
    ? `${missingFieldCount} field(s) referenced by detection rules are not present in your sample data. Missing fields may prevent rules from firing.`
    : `${missingFieldCount} field(s) referenced by workbooks are not present in your sample data. Missing fields may leave workbook tiles empty.`;
}

/** A projected coverage section (one content type = one source into the panel). */
export interface CoverageSectionView {
  type: ContentItemType;
  counts: CoverageThreeWay;
  items: CoverageItemView[];
  /** The section summary line (legacy vocabulary for rules). */
  summaryLine: string;
  /** The header count chips (legacy order/labels). */
  countChips: CoverageCountChip[];
  /** Total workbook query blocks that could not be parsed (0 for the rule section). */
  unparseableQueryCount: number;
}

/**
 * Project the CoverageReport's items of ONE content type into a section view -
 * the panel renders a rule section and a workbook section from the SAME report
 * (two sources, one analyzer). `missingFieldCount` feeds the summary line and is
 * the section-level missing-fields count. CORRECTED 2026-07-12 (audit): the
 * count derives from THIS section's own items - the caller previously passed
 * summary.missingFieldsAcrossRules.length, which counts across ALL item
 * types, so the workbook section's "N field(s) referenced by workbooks"
 * line reported a rules+workbooks combined number.
 */
export function deriveCoverageSection(
  report: CoverageReport,
  type: ContentItemType,
): CoverageSectionView {
  const typeItems = report.items.filter((item) => item.type === type);
  const items = typeItems.map(deriveCoverageItemView);
  const counts = deriveThreeWayCounts(typeItems);
  const missingFieldCount = new Set(
    typeItems.flatMap((item) => item.missingFromReducedSchema),
  ).size;
  const unparseableQueryCount = items.reduce(
    (sum, item) => sum + item.unparseableQueryCount,
    0,
  );
  return {
    type,
    counts,
    items,
    summaryLine: coverageSummaryLine(type, counts, missingFieldCount),
    countChips: coverageCountChips(type, counts),
    unparseableQueryCount,
  };
}

// ---------------------------------------------------------------------------
// Missing-fields-by-frequency chips (aggregated across items)
// ---------------------------------------------------------------------------

/** The default cap on rendered missing-field chips (0 = uncapped). */
export const DEFAULT_MISSING_CHIP_LIMIT = 0;

/**
 * The aggregated missing-fields chips, already frequency-ranked by the analyzer
 * (most-needed first, casing preserved). Optionally capped; 0 (the default)
 * renders them all, matching the legacy uncapped chip row.
 */
export function missingFieldChips(
  summary: CoverageSummary,
  limit: number = DEFAULT_MISSING_CHIP_LIMIT,
): string[] {
  const all = summary.missingFieldsAcrossRules;
  return limit > 0 ? all.slice(0, limit) : [...all];
}

/** The verbatim legacy heading over the aggregated missing-field chips. */
export const MISSING_FIELDS_HEADING =
  "Fields missing across rules (prioritized by frequency):";

/** The verbatim legacy expandable label for a rule/workbook's KQL. */
export const VIEW_KQL_LABEL = "View KQL Query";

/** The CUSTOM badge label (uploaded rules). */
export const CUSTOM_BADGE_LABEL = "CUSTOM";

/** The empty-state note before any coverage analysis has run. */
export const RULE_COVERAGE_IDLE_NOTE =
  "Analyze rule and workbook coverage to see which fields your detection rules " +
  "and workbooks need from the mapped destination schema. Rule coverage is " +
  "informational and never blocks a deploy. The RULE badges above light from " +
  "the DCR Gap Analysis itself; custom rules uploaded here add to them.";

/** The reason coverage cannot run yet (no Gap Analysis reports to derive availability from). */
export const RULE_COVERAGE_NO_REPORTS_NOTE =
  "Run the DCR Gap Analysis above first - rule coverage checks the analytics " +
  "rules' fields against the destination columns your mappings produce.";

/**
 * Custom rules uploaded before any gap report exists (DBT-212): accepted and
 * QUEUED, so the count beside the upload is not mistaken for a result.
 */
export function ruleCoverageQueuedNote(customCount: number): string {
  return customCount === 1
    ? "1 custom rule is queued - its coverage runs as soon as the DCR Gap Analysis reports arrive."
    : `${customCount} custom rules are queued - their coverage runs as soon as the DCR Gap Analysis reports arrive.`;
}

/**
 * The last coverage run was resolved for other destination tables than the
 * current gap reports carry (DBT-212), so its result is withheld until the
 * operator re-runs it. Names the tables now in play so the cause is visible.
 */
export function ruleCoverageStaleNote(currentTables: readonly string[]): string {
  const now = currentTables.length > 0 ? currentTables.join(", ") : "none";
  return `The DCR Gap Analysis changed the destination tables (now ${now}) since this coverage ran - Re-analyze to refresh.`;
}
