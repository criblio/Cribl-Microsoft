/**
 * Workspace inventory (MIG-2): the KQL, the query-response parser and the fold
 * behind "what does this Sentinel workspace already ingest".
 */
export {
  answeredOutcome,
  BYTES_PER_MB,
  chunk,
  INVENTORY_TIMESPAN,
  INVENTORY_WINDOW_DAYS,
  inventoryTotals,
  kqlTableRef,
  parseQueryResult,
  parseSourceRows,
  parseUsageRows,
  sourceBreakdownQuery,
  sourcesFor,
  SOURCES_PER_TABLE,
  toInventoryTable,
  USAGE_QUERY,
} from "./workspace-inventory";
export type {
  InventorySource,
  InventoryTable,
  InventoryTotals,
  QueryResult,
  SourceAttribution,
  SourceReadOutcome,
  TableSources,
  UsageRow,
} from "./workspace-inventory";
export {
  identityKql,
  SOURCE_IDENTITY_AS_OF,
  SOURCE_IDENTITY_RULES,
} from "./source-identity";
export type { SourceIdentityRule } from "./source-identity";
export { billableTableMeasuredFree, bySource } from "./by-source";
export type { SourceViewReconciliation, SourceViewRow } from "./by-source";
