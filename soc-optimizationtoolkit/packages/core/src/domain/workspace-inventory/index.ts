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
