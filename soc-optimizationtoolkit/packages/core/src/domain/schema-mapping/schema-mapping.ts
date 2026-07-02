/**
 * Log Analytics schema -> DCR column-set mapping - COMPATIBILITY CONTRACT.
 *
 * Faithful port of the legacy PowerShell schema handling in
 * Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1:
 *   - ConvertTo-DCRColumnType       (lines 396-432)   type mapping (DCR-08)
 *   - Get-TableColumns              (lines 1475-1617) column-source selection
 *                                    and system/guid filtering (DCR-09)
 *   - Get-CustomTableSchemaFromFile (lines 702-779)   custom schema-file path
 *   - New-LogAnalyticsCustomTable   (lines 452-462)   reserved creation columns
 * plus core/dcr-template-direct.json and core/dcr-template-with-dce.json for
 * the stream declaration and dataFlow shape.
 *
 * The generated column sets and stream names are deployed DCR content; the
 * output must match what the legacy script deploys, including its quirks
 * (e.g. guid-typed columns are DROPPED from DCR declarations, not converted,
 * while the custom-schema-file path CONVERTS them to string). Every rule is
 * pinned by schema-mapping.test.ts (unit, per rule) and
 * schema-mapping.characterization.test.ts (legacy-fixtures.json replay).
 *
 * Rules (numbering matches the extracted specification):
 *   RULE 1  input schema selection: which column array of the workspace
 *           tables API response feeds the mapping (selectSchemaColumns)
 *   RULE 2a system-name drop lists, case-insensitive (18 native / 6 custom)
 *   RULE 2b guid/uniqueidentifier/uuid columns dropped entirely
 *   RULE 2c TimeGenerated always passes through; only the schema-FILE path
 *           injects it (normalizeCustomSchemaColumns), never the Azure path
 *   RULE 2d zero surviving columns -> no DCR (buildStreamDeclaration throws)
 *   RULE 2e table-CREATION payload strips 13 reserved names
 *           (stripReservedTableCreationColumns) - separate from the DCR set
 *   RULE 3  type mapping to the 7-value DCR vocabulary; unknown -> string
 *   RULE 4  order preserved; no sort, no dedup, no rename; {name, type} only
 *   RULE 5  stream declaration: input stream "Custom-{table}", output stream
 *           "Microsoft-{table}" (native) / "Custom-{table}" (custom),
 *           transformKql always "source", destination "logAnalyticsWorkspace"
 *
 * DCR/DCE resource-name generation lives in ../dcr-naming; column names are
 * never abbreviated or altered here.
 */

/** A column as it arrives from the LA management API or a user schema file. */
export interface LogAnalyticsColumn {
  name: string;
  /**
   * Log Analytics type. The management API enum is string, int, long, real,
   * boolean, dateTime, guid, dynamic; user schema files may carry loose
   * aliases (int32, double, timestamp, json, uuid, ...). Matched
   * case-insensitively.
   */
  type: string;
}

/** The exact DCR stream-declaration type vocabulary the legacy script emits. */
export const DCR_COLUMN_TYPES = Object.freeze([
  "string",
  "int",
  "long",
  "real",
  "boolean",
  "datetime",
  "dynamic",
] as const);

/**
 * A DCR stream-declaration column type. "guid" never appears in generated
 * declarations: guid-typed columns are dropped before mapping (RULE 2b) and
 * the mapper converts the guid family to string everywhere else.
 */
export type DcrColumnType = (typeof DCR_COLUMN_TYPES)[number];

/** A column entry of a DCR stream declaration: {name, type} and nothing else. */
export interface DcrColumn {
  name: string;
  type: DcrColumnType;
}

/**
 * Which drop list applies (legacy $CustomTableMode). Native tables use the
 * 18-name list; custom (_CL) tables use the minimal 6-name list and KEEP
 * TenantId and SourceSystem in their DCR declaration.
 */
export type TableMode = "native" | "custom";

/** Why a column was removed from the DCR stream declaration. */
export type DropReason = "system-column" | "guid-type";

export interface DroppedColumn {
  name: string;
  reason: DropReason;
}

/** A column whose LA type was not recognized (legacy logs a warning). */
export interface UnknownTypeColumn {
  name: string;
  /** The unrecognized input type, verbatim. It was mapped to "string". */
  laType: string;
}

export interface DcrColumnSetResult {
  /** Surviving columns, mapped to DCR types, in original order. */
  columns: DcrColumn[];
  /** Removed columns in original order, interleaved as encountered. */
  dropped: DroppedColumn[];
  /**
   * Columns whose type fell through to the unknown->string fallback, one
   * entry per occurrence. Callers surface these as warnings (the legacy
   * script does Write-Warning); pure domain code never logs.
   */
  unknownTypes: UnknownTypeColumn[];
}

/**
 * RULE 2a, native mode: the 18 system column names removed from native-table
 * DCR declarations. Matching is CASE-INSENSITIVE (PowerShell -notin).
 */
export const NATIVE_SYSTEM_COLUMNS: readonly string[] = Object.freeze([
  "TenantId",
  "SourceSystem",
  "MG",
  "ManagementGroupName",
  "_ResourceId",
  "Type",
  "_SubscriptionId",
  "_ItemId",
  "_IsBillable",
  "_BilledSize",
  "PartitionKey",
  "RowKey",
  "StorageAccount",
  "AzureDeploymentID",
  "AzureTableName",
  "TimeCollected",
  "SourceComputerId",
  "EventOriginId",
]);

/**
 * RULE 2a, custom mode: the minimal 6-name list for custom (_CL) tables.
 * TenantId and SourceSystem are intentionally NOT listed - custom-table DCR
 * declarations keep them.
 */
export const CUSTOM_SYSTEM_COLUMNS: readonly string[] = Object.freeze([
  "_ResourceId",
  "_SubscriptionId",
  "_ItemId",
  "_IsBillable",
  "_BilledSize",
  "Type",
]);

/**
 * RULE 2b: LA types (lowercased) whose columns are removed ENTIRELY from the
 * DCR stream declaration - not converted to string - in both table modes.
 */
export const GUID_LIKE_TYPES: readonly string[] = Object.freeze([
  "guid",
  "uniqueidentifier",
  "uuid",
]);

/**
 * RULE 2e: the 13 reserved names stripped from the custom table CREATION
 * payload (the tables PUT), because Azure manages them automatically and
 * rejects them with 400 errors. TimeGenerated is explicitly allowed. This
 * list is unrelated to the DCR declaration filter above.
 */
export const RESERVED_TABLE_CREATION_COLUMNS: readonly string[] = Object.freeze(
  [
    "Type",
    "ItemCount",
    "SourceSystem",
    "ManagementGroupName",
    "Computer",
    "RawData",
    "TenantId",
    "_ResourceId",
    "_SubscriptionId",
    "_ItemId",
    "_IsBillable",
    "_BilledSize",
    "_TimeReceived",
  ],
);

/**
 * RULE 5: the only transform the legacy pipeline ever emits, identical for
 * Direct and DCE modes. No TimeGenerated = now() or other KQL is injected.
 */
export const DEFAULT_TRANSFORM_KQL = "source";

/** RULE 5: the single logAnalytics destination name used by every dataFlow. */
export const LOG_ANALYTICS_DESTINATION_NAME = "logAnalyticsWorkspace";

const nativeSystemColumnSet: ReadonlySet<string> = new Set(
  NATIVE_SYSTEM_COLUMNS.map((name) => name.toLowerCase()),
);

const customSystemColumnSet: ReadonlySet<string> = new Set(
  CUSTOM_SYSTEM_COLUMNS.map((name) => name.toLowerCase()),
);

const guidLikeTypeSet: ReadonlySet<string> = new Set(GUID_LIKE_TYPES);

const reservedCreationColumnSet: ReadonlySet<string> = new Set(
  RESERVED_TABLE_CREATION_COLUMNS.map((name) => name.toLowerCase()),
);

/**
 * RULE 3: the complete legacy type-mapping table (ConvertTo-DCRColumnType).
 * Keys are lowercased input types; the API casing "dateTime" therefore maps
 * to "datetime". The guid family maps to string here but is UNREACHABLE in
 * the DCR column-set path because RULE 2b drops those columns first; it is
 * reachable only via normalizeCustomSchemaColumns (schema-file path).
 */
const typeMap: ReadonlyMap<string, DcrColumnType> = new Map<
  string,
  DcrColumnType
>([
  ["string", "string"],
  ["int", "int"],
  ["int32", "int"],
  ["integer", "int"],
  ["long", "long"],
  ["int64", "long"],
  ["bigint", "long"],
  ["real", "real"],
  ["double", "real"],
  ["float", "real"],
  ["decimal", "real"],
  ["bool", "boolean"],
  ["boolean", "boolean"],
  ["datetime", "datetime"],
  ["timestamp", "datetime"],
  ["date", "datetime"],
  ["time", "datetime"],
  ["dynamic", "dynamic"],
  ["object", "dynamic"],
  ["json", "dynamic"],
  ["guid", "string"],
  ["uniqueidentifier", "string"],
  ["uuid", "string"],
]);

/** Error thrown where the legacy pipeline would fail table processing. */
export class SchemaMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaMappingError";
  }
}

/**
 * RULE 3: map a Log Analytics (or user schema file) column type to its DCR
 * stream-declaration type. Case-insensitive; any unrecognized type falls
 * back to "string" (use isKnownColumnType to detect the fallback and warn).
 */
export function mapColumnType(laType: string): DcrColumnType {
  return typeMap.get(laType.toLowerCase()) ?? "string";
}

/** Whether the type is in the legacy mapping table (case-insensitive). */
export function isKnownColumnType(laType: string): boolean {
  return typeMap.has(laType.toLowerCase());
}

/**
 * The API response fragment selectSchemaColumns operates on
 * (properties.schema of the workspace tables GET).
 */
export interface TableSchemaColumnSources {
  /** User/table columns (custom DCR-based tables; native fallback). */
  columns?: LogAnalyticsColumn[] | null;
  /** Standard columns (native tables; MMA-legacy custom fallback). */
  standardColumns?: LogAnalyticsColumn[] | null;
}

/**
 * RULE 1: choose which column array of the tables API response feeds the
 * mapping. Empty arrays count as absent (PowerShell truthiness).
 *
 * Native mode: prefer standardColumns, fall back to columns. Safety case:
 * when standardColumns contains exactly one column named TenantId
 * (case-insensitive) and columns is present, use columns instead - this
 * indicates a mis-hit custom table.
 *
 * Custom mode: prefer columns (DCR-based table), fall back to
 * standardColumns (MMA legacy table).
 *
 * Returns null when no usable column source exists (the legacy script fails
 * the table).
 */
export function selectSchemaColumns(
  schema: TableSchemaColumnSources,
  mode: TableMode = "native",
): LogAnalyticsColumn[] | null {
  const columns =
    schema.columns != null && schema.columns.length > 0 ? schema.columns : null;
  const standardColumns =
    schema.standardColumns != null && schema.standardColumns.length > 0
      ? schema.standardColumns
      : null;

  if (mode === "custom") {
    return columns ?? standardColumns;
  }

  if (standardColumns !== null) {
    const first = standardColumns[0];
    const looksLikeMisHitCustomTable =
      standardColumns.length === 1 &&
      first !== undefined &&
      first.name.toLowerCase() === "tenantid" &&
      columns !== null;
    return looksLikeMisHitCustomTable ? columns : standardColumns;
  }
  return columns;
}

/**
 * RULES 2a/2b/3/4: filter a Log Analytics column list and map the survivors
 * to DCR stream-declaration columns. Single pass, order-preserving; no
 * sorting, no deduplication, no renaming.
 *
 * Drop reasons: system-column (name in the mode's drop list,
 * case-insensitive) takes precedence over guid-type (LA type is
 * guid/uniqueidentifier/uuid, case-insensitive); a column matching both is
 * reported as system-column, mirroring the legacy diagnostics.
 *
 * TimeGenerated is never dropped and is never injected here (RULE 2c: only
 * the schema-file path injects it - see normalizeCustomSchemaColumns).
 *
 * A result with zero surviving columns means the table fails processing
 * (RULE 2d); buildStreamDeclaration enforces that.
 */
export function buildDcrColumnSet(
  columns: readonly LogAnalyticsColumn[],
  mode: TableMode = "native",
): DcrColumnSetResult {
  const systemColumnSet =
    mode === "custom" ? customSystemColumnSet : nativeSystemColumnSet;

  const surviving: DcrColumn[] = [];
  const dropped: DroppedColumn[] = [];
  const unknownTypes: UnknownTypeColumn[] = [];

  for (const column of columns) {
    if (systemColumnSet.has(column.name.toLowerCase())) {
      dropped.push({ name: column.name, reason: "system-column" });
      continue;
    }
    if (guidLikeTypeSet.has(column.type.toLowerCase())) {
      dropped.push({ name: column.name, reason: "guid-type" });
      continue;
    }
    if (!isKnownColumnType(column.type)) {
      unknownTypes.push({ name: column.name, laType: column.type });
    }
    surviving.push({ name: column.name, type: mapColumnType(column.type) });
  }

  return { columns: surviving, dropped, unknownTypes };
}

/**
 * Append "_CL" unless the table name already ends with it. The legacy check
 * is .NET EndsWith("_CL"), which is CASE-SENSITIVE: "table_cl" becomes
 * "table_cl_CL". Quirk preserved (compatibility contract).
 */
export function ensureCustomTableSuffix(tableName: string): string {
  return tableName.endsWith("_CL") ? tableName : `${tableName}_CL`;
}

/** A single dataFlow of a DCR payload. */
export interface DcrDataFlow {
  streams: string[];
  destinations: string[];
  transformKql: string;
  outputStream: string;
}

/**
 * The stream-declaration fragment of a DCR payload. Identical for Direct
 * and DCE deployment modes (mode only affects kind/dataCollectionEndpointId
 * on the surrounding resource, which is out of scope here).
 */
export interface DcrStreamDeclaration {
  /** Input stream name: always "Custom-{table}". */
  streamName: string;
  /**
   * Output stream: "Microsoft-{table}" for native tables, "Custom-{table}"
   * for custom (_CL) tables.
   */
  outputStreamName: string;
  /** properties.streamDeclarations: a single-key object. */
  streamDeclarations: Record<string, { columns: DcrColumn[] }>;
  /** properties.dataFlows: exactly one flow with transformKql "source". */
  dataFlows: DcrDataFlow[];
}

/**
 * RULE 5: shape the DCR streamDeclarations entry and its dataFlow for a
 * table. For custom mode the table name is forced to carry the _CL suffix
 * (case-sensitively, matching the legacy EndsWith check).
 *
 * @throws SchemaMappingError when columns is empty (RULE 2d: a table with
 *   no surviving columns fails processing; no DCR is generated).
 */
export function buildStreamDeclaration(
  table: string,
  columns: readonly DcrColumn[],
  mode: TableMode = "native",
): DcrStreamDeclaration {
  if (columns.length === 0) {
    throw new SchemaMappingError(
      `Table '${table}' has no columns remaining after filtering; ` +
        `no DCR stream declaration can be generated`,
    );
  }

  const tableName = mode === "custom" ? ensureCustomTableSuffix(table) : table;
  const streamName = `Custom-${tableName}`;
  const outputStreamName =
    mode === "custom" ? streamName : `Microsoft-${tableName}`;

  return {
    streamName,
    outputStreamName,
    streamDeclarations: {
      [streamName]: { columns: columns.map(({ name, type }) => ({ name, type })) },
    },
    dataFlows: [
      {
        streams: [streamName],
        destinations: [LOG_ANALYTICS_DESTINATION_NAME],
        transformKql: DEFAULT_TRANSFORM_KQL,
        outputStream: outputStreamName,
      },
    ],
  };
}

/** A column as written in a local custom-table schema JSON file. */
export interface CustomSchemaFileColumn {
  name: string;
  type: string;
  description?: string | null;
}

/** A column of the custom table CREATION payload (the tables PUT). */
export interface CustomTableColumn {
  name: string;
  type: DcrColumnType;
  description: string;
}

/**
 * RULE 2c (schema-FILE path): normalize the columns of a local custom-table
 * schema file for table creation (Get-CustomTableSchemaFromFile). Types are
 * mapped through the same table as the DCR path, so here the guid family IS
 * converted to string instead of dropped (legacy inconsistency preserved).
 * Missing descriptions become "". When TimeGenerated is absent
 * (case-insensitive), {TimeGenerated, datetime} is appended at the END.
 *
 * This feeds table creation only - the DCR declaration for the same table
 * still goes through buildDcrColumnSet against the created table's schema.
 *
 * @throws SchemaMappingError when a column is missing name or type (legacy
 *   throws "Each column must have 'name' and 'type' properties").
 */
export function normalizeCustomSchemaColumns(
  columns: readonly CustomSchemaFileColumn[],
): CustomTableColumn[] {
  const normalized: CustomTableColumn[] = columns.map((column) => {
    if (!column.name || !column.type) {
      throw new SchemaMappingError(
        "Each column must have 'name' and 'type' properties",
      );
    }
    return {
      name: column.name,
      type: mapColumnType(column.type),
      description: column.description ? column.description : "",
    };
  });

  const hasTimeGenerated = normalized.some(
    (column) => column.name.toLowerCase() === "timegenerated",
  );
  if (!hasTimeGenerated) {
    normalized.push({
      name: "TimeGenerated",
      type: "datetime",
      description: "Timestamp when the record was generated",
    });
  }

  return normalized;
}

/**
 * RULE 2e: strip the 13 Azure-managed reserved names (case-insensitive)
 * from a custom table CREATION payload, preserving order. TimeGenerated is
 * not reserved and passes through. Applies to the tables PUT only, never to
 * DCR stream declarations.
 */
export function stripReservedTableCreationColumns<T extends { name: string }>(
  columns: readonly T[],
): T[] {
  return columns.filter(
    (column) => !reservedCreationColumnSet.has(column.name.toLowerCase()),
  );
}
