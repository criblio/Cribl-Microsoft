/**
 * content-install domain barrel (user feature 2026-07-14): pure transforms
 * for enabling a Sentinel solution's content in the workspace - solution
 * install, analytics-rule and workbook ARM bodies, upload parsing,
 * installed-state partitioning, and the per-item install-outcome vocabulary.
 * The IO half is usecases/content-install. All pure.
 */

export type {
  AlertRuleResource,
  ContentInstallOutcome,
  ParsedWorkbookUpload,
  ParserResource,
  WorkbookResourceInput,
} from "./content-install";
export {
  alertRuleResourceFromParsed,
  parserResourceBody,
  parserResourceFromYaml,
  partitionByInstalled,
  parseWorkbookUpload,
  summarizeInstallOutcomes,
  toArmSeverity,
  toArmTriggerOperator,
  toIsoDuration,
  workbookResourceBody,
} from "./content-install";
