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
  parseCustomAnalyticRuleYaml,
} from "@soc/core";
import type {
  ContentItem,
  ContentItemType,
  CoverageReport,
  CoverageSummary,
  GapReport,
  ItemCoverage,
} from "@soc/core";

// ---------------------------------------------------------------------------
// Rule acquisition surface (consumed by the component's content-port IO loop)
// ---------------------------------------------------------------------------

/**
 * The three Analytic-Rules directory-name variants a solution may use, in the
 * legacy probe order (sentinel-repo.ts listAnalyticRules): the component lists
 * each under the selected solution through the Unit 14 SentinelContent port and
 * takes the first that yields files - exactly the legacy "first existing dir"
 * rule, expressed over the lazy port instead of a filesystem walk.
 */
export const ANALYTIC_RULE_DIR_VARIANTS: readonly string[] = [
  "Analytic Rules",
  "Analytics Rules",
  "AnalyticRules",
];

/** Whether a solution file is an analytic-rule YAML (legacy: .yaml or .yml). */
export function isRuleYamlFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

// ---------------------------------------------------------------------------
// Coverage-input derivation from the Gap Analysis reports
// ---------------------------------------------------------------------------

/**
 * The AVAILABILITY set fed to the analyzer: the destination fields the mapped
 * pipeline actually produces, derived from the Gap Analysis reports exactly as
 * the legacy `mappedDest` was (SentinelIntegration.tsx 2649-2655):
 *   - a `drop` mapping contributes nothing (the field is discarded);
 *   - an `overflow` mapping contributes BOTH the destination catch-all column
 *     and the source field name (the source survives inside the catch-all);
 *   - every other mapping contributes its destination column.
 * De-duplicated and sorted (the analyzer matches case-insensitively, so order
 * is irrelevant; sorted for deterministic tests).
 */
export function availableFieldsFromReports(
  reports: readonly GapReport[],
): string[] {
  const set = new Set<string>();
  for (const report of reports) {
    for (const mapping of report.fieldMappings) {
      if (mapping.action === "drop") continue;
      if (mapping.action === "overflow") {
        set.add(mapping.dest);
        set.add(mapping.source);
        continue;
      }
      set.add(mapping.dest);
    }
  }
  return [...set].sort();
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

// ---------------------------------------------------------------------------
// Custom-YAML upload projection
// ---------------------------------------------------------------------------

/** One uploaded rule YAML file (name + text) awaiting parse. */
export interface RuleYamlUpload {
  fileName: string;
  content: string;
}

/**
 * Parse uploaded custom rule YAML files into shared ContentItems, each flagged
 * `custom` (drives the CUSTOM badge). Uses the core PINNED regex parser; the
 * query text is PRESERVED (the legacy custom path dropped it), so a custom rule
 * flows through the shared analyzer identically to a repo rule. The component
 * merges the result into its custom-rule list with core mergeCustomContentItems
 * (last-write-wins by name - the re-upload fix), then re-runs coverage.
 */
export function parseCustomRuleUploads(
  uploads: readonly RuleYamlUpload[],
): ContentItem[] {
  return uploads.map((upload) =>
    analyticRuleToContentItem(
      parseCustomAnalyticRuleYaml(upload.content, upload.fileName),
      true,
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
      : "No workbooks found for this solution. Workbook coverage reads the solution's Workbooks directory from the Sentinel repository and folds in any Sentinel workbooks already deployed in your subscription.";
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
 * the panel-level missing-fields count (summary.missingFieldsAcrossRules.length,
 * matching the legacy sectionDesc which counted across all rules).
 */
export function deriveCoverageSection(
  report: CoverageReport,
  type: ContentItemType,
  missingFieldCount: number,
): CoverageSectionView {
  const items = report.items
    .filter((item) => item.type === type)
    .map(deriveCoverageItemView);
  const counts = deriveThreeWayCounts(
    report.items.filter((item) => item.type === type),
  );
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
  "informational - it lights the RULE badges above but never blocks a deploy.";

/** The reason coverage cannot run yet (no Gap Analysis reports to derive availability from). */
export const RULE_COVERAGE_NO_REPORTS_NOTE =
  "Run the DCR Gap Analysis above first - rule coverage checks the analytics " +
  "rules' fields against the destination columns your mappings produce.";
