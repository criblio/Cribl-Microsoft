/**
 * coverage-analysis domain module barrel - porting-plan Unit 23 (ENG-11,
 * GUI-09, plus net-new workbook coverage).
 *
 * THE ONE SHARED CONTENT-REFERENCE ANALYZER: alert rules and workbooks reduce
 * to the generic {@link ContentItem} and flow through {@link
 * analyzeContentCoverage} - the first slice of the native-onboarding flagship's
 * analyzer (hunting/parsers/playbooks join later as more sources into the same
 * engine). The KQL_BUILTINS set and extractKqlFields are relocated here (domain
 * logic that lived in the repo adapter); the AnalyticRule regex extraction is
 * PINNED (no impure YAML parser adopted); workbook serializedData is mined
 * DEFENSIVELY with an unparseable count. All pure.
 */

// The load-bearing abstraction + all result/parse shapes.
export type {
  ContentItemType,
  ContentItem,
  CoverageInput,
  FieldCoverageStatus,
  ItemCoverage,
  CoverageSummary,
  CoverageReport,
  ParsedAnalyticRule,
  WorkbookQueryExtraction,
} from "./models";

// KQL builtins (verbatim) + the relocated field extractor.
export { KQL_BUILTINS } from "./kql-builtins";
export { extractKqlFields } from "./extract-kql-fields";

// AnalyticRule parsing (pinned regex) + custom-rule merge (dedupe fix).
export {
  parseAnalyticRuleYaml,
  parseCustomAnalyticRuleYaml,
  analyticRuleToContentItem,
  mergeCustomContentItems,
} from "./parse-analytic-rule";

// Custom-rule uploads beyond YAML: portal ARM JSON exports + raw KQL.
export {
  RULE_UPLOAD_EXTENSIONS,
  isRuleUploadFileName,
  parseAnalyticRuleArmJson,
  parseRawKqlRule,
  parseRuleUploadFile,
} from "./parse-rule-uploads";

// Workbook query mining (net-new, defensive).
export { extractWorkbookQueries, workbookToContentItem } from "./parse-workbook";

// Destination schema union helper.
export type { NamedColumn } from "./schema-union";
export { unionSchemaColumns } from "./schema-union";

// The shared analyzer + the no-stale-skip pin.
export { analyzeContentCoverage, shouldRerunCoverage } from "./analyze-coverage";
