export {
  buildTablePutRequest,
  CustomTableError,
  CUSTOM_TABLE_PLAN,
  DEFAULT_CUSTOM_TABLE_RETENTION_DAYS,
  DEFAULT_CUSTOM_TABLE_TOTAL_RETENTION_DAYS,
  isCustomTableName,
  LOG_ANALYTICS_TABLES_API_VERSION,
  parseTableSchemaFile,
  validateCustomTableSchema,
} from "./custom-table";
export type {
  CustomTableSchemaValidation,
  ParsedTableSchemaFile,
  TablePutRequest,
  TablePutRequestBody,
  TablePutRequestInput,
  TableSchemaFileVariant,
} from "./custom-table";
