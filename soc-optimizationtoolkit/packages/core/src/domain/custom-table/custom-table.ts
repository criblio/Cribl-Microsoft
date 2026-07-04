/**
 * Custom (_CL) Log Analytics table creation - porting-plan Unit 5 (ENG-34,
 * custom-table path of ENG-33).
 *
 * Mined from THREE legacy sources:
 *
 *   - Create-TableDCRs.ps1 New-LogAnalyticsCustomTable (lines 435-565):
 *     the tables ARM PUT contract - body
 *     {properties: {plan: "Analytics", retentionInDays, totalRetentionInDays,
 *     schema: {name, columns}}}, api-version 2022-10-01, reserved-column
 *     stripping (via schema-mapping stripReservedTableCreationColumns), and
 *     the case-sensitive "_CL" suffix enforcement (ensureCustomTableSuffix).
 *   - Create-TableDCRs.ps1 Get-CustomTableSchemaFromFile (lines 702-779):
 *     the BARE schema-file shape {description?, retentionInDays?,
 *     totalRetentionInDays?, columns: [{name, type, description?}]} used by
 *     Azure/CustomDeploymentTemplates/DCR-Automation/core/custom-table-schemas/
 *     (some files also carry a top-level "name"), the per-column name/type
 *     requirement, and the 30/90 retention defaults.
 *   - Cribl-Microsoft_IntegrationSolution/src/main/ipc/azure-deploy.ts
 *     generateCustomTableSchemas (lines 333-392): the two WILD Sentinel
 *     table-definition shapes - properties.schema.columns OR
 *     properties.schema.tableDefinition.columns - and the missing-type ->
 *     "string" default (`col.type || 'string'`).
 *
 * RETENTION COMPATIBILITY CONTRACT (porting-plan section 3, item 8): newly
 * created custom tables default to 30 days interactive retention and 90 days
 * total retention. Unit 4's OperationOptions.customTableRetentionDays (30|90)
 * feeds the interactive value.
 *
 * Column NORMALIZATION (type mapping, TimeGenerated injection) and the
 * reserved-column strip are NOT re-implemented here - they come from
 * ../schema-mapping (normalizeCustomSchemaColumns,
 * stripReservedTableCreationColumns), the characterized compatibility
 * contract.
 *
 * Pure: no IO, no fetch, no React, no Date/Math.random/crypto.
 */

import {
  ensureCustomTableSuffix,
  mapColumnType,
  normalizeCustomSchemaColumns,
  stripReservedTableCreationColumns,
} from "../schema-mapping";
import type {
  CustomSchemaFileColumn,
  CustomTableColumn,
} from "../schema-mapping";

/**
 * ARM api-version for Microsoft.OperationalInsights workspaces/tables. The
 * legacy engine pins 2022-10-01 for the tables GET (Get-LogAnalyticsTableSchema)
 * AND the tables PUT (New-LogAnalyticsCustomTable line 501); the onboardTable
 * use-case re-exports this value as LOG_ANALYTICS_API_VERSION.
 */
export const LOG_ANALYTICS_TABLES_API_VERSION = "2022-10-01";

/** Interactive-retention default for new custom tables (contract: 30). */
export const DEFAULT_CUSTOM_TABLE_RETENTION_DAYS = 30;

/** Total-retention default for new custom tables (contract: 90). */
export const DEFAULT_CUSTOM_TABLE_TOTAL_RETENTION_DAYS = 90;

/** The only table plan the legacy engine ever creates (PUT body verbatim). */
export const CUSTOM_TABLE_PLAN = "Analytics";

/** Error thrown where the legacy custom-table path would fail the table. */
export class CustomTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomTableError";
  }
}

/**
 * Whether a table name routes to the CUSTOM (_CL) path. CASE-INSENSITIVE,
 * matching the walking skeleton's native-mode guard (/_CL$/i): "foo_cl" is
 * treated as an ATTEMPTED custom table (and then rejected by
 * validateCustomTableSchema, which demands the exact "_CL" casing) rather
 * than silently processed as native.
 */
export function isCustomTableName(table: string): boolean {
  return /_CL$/i.test(table);
}

/** Which schema-file shape {@link parseTableSchemaFile} recognized. */
export type TableSchemaFileVariant =
  /** properties.schema.columns (Sentinel table definition). */
  | "schema-columns"
  /** properties.schema.tableDefinition.columns (Sentinel table definition). */
  | "table-definition"
  /** Bare {columns: [...]} (the PS custom-table-schemas file format). */
  | "bare";

/** The normalized result of parsing a custom-table schema file. */
export interface ParsedTableSchemaFile {
  /**
   * Table name carried by the file ("name" top-level, properties.schema.name,
   * or properties.schema.tableDefinition.name), or null when the file names
   * no table (e.g. the original CloudFlare_CL.json carries none - the file
   * NAME was the table name in the legacy layout).
   */
  tableName: string | null;
  /** File description, or "" (PS: description falls back to ""). */
  description: string;
  /** retentionInDays when the file carries a positive integer, else null. */
  retentionInDays: number | null;
  /** totalRetentionInDays when a positive integer, else null. */
  totalRetentionInDays: number | null;
  /**
   * Raw columns: name verbatim, type verbatim (missing/empty type defaults
   * to "string" - the legacy-TS `col.type || 'string'` rule), description
   * or "". Types are NOT mapped here; normalizeCustomSchemaColumns /
   * buildTablePutRequest map them.
   */
  columns: CustomSchemaFileColumn[];
  variant: TableSchemaFileVariant;
}

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Narrow to a non-empty string, else null. */
function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Narrow to a positive integer, else null (junk retention is ignored). */
function asPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/**
 * Parse a custom-table schema file, accepting ALL THREE shapes found in the
 * wild (precedence mirrors the legacy-TS lookup
 * `parsed.properties?.schema?.columns || parsed.properties?.schema?.tableDefinition?.columns`,
 * with the PS bare {columns} shape as the final fallback):
 *
 *   1. properties.schema.columns                    ("schema-columns")
 *   2. properties.schema.tableDefinition.columns    ("table-definition")
 *   3. columns                                      ("bare")
 *
 * Column rules (sources cited in the module doc):
 *   - every column must be an object with a non-empty string "name"
 *     (PS: "Each column must have 'name' and 'type' properties")
 *   - a missing/empty "type" defaults to "string" (legacy-TS rule; Sentinel
 *     table definitions omit types occasionally)
 *   - "description" falls back to "" (PS rule)
 *
 * @throws CustomTableError when the raw text is not valid JSON, when no
 *   variant yields a non-empty columns array, or when a column lacks a name.
 */
export function parseTableSchemaFile(raw: string): ParsedTableSchemaFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CustomTableError(`Schema file is not valid JSON: ${detail}`);
  }

  const schema = prop(prop(parsed, "properties"), "schema");
  const tableDefinition = prop(schema, "tableDefinition");

  let variant: TableSchemaFileVariant;
  let rawColumns: unknown;
  const schemaColumns = prop(schema, "columns");
  const tableDefinitionColumns = prop(tableDefinition, "columns");
  const bareColumns = prop(parsed, "columns");
  if (Array.isArray(schemaColumns) && schemaColumns.length > 0) {
    variant = "schema-columns";
    rawColumns = schemaColumns;
  } else if (
    Array.isArray(tableDefinitionColumns) &&
    tableDefinitionColumns.length > 0
  ) {
    variant = "table-definition";
    rawColumns = tableDefinitionColumns;
  } else if (Array.isArray(bareColumns) && bareColumns.length > 0) {
    variant = "bare";
    rawColumns = bareColumns;
  } else {
    // PS throws "Schema file must contain 'columns' array"; the wild-shape
    // scan (legacy TS) silently skipped such files. A parser must be loud.
    throw new CustomTableError(
      "Schema file must contain a non-empty 'columns' array " +
        "(at properties.schema.columns, " +
        "properties.schema.tableDefinition.columns, or top level)",
    );
  }

  const columns: CustomSchemaFileColumn[] = (rawColumns as unknown[]).map(
    (entry, index) => {
      const name = asNonEmptyString(prop(entry, "name"));
      if (name === null) {
        throw new CustomTableError(
          `Schema file column at index ${index} has no 'name' ` +
            "(each column must have 'name' and 'type' properties)",
        );
      }
      const type = asNonEmptyString(prop(entry, "type")) ?? "string";
      const description = asNonEmptyString(prop(entry, "description")) ?? "";
      return { name, type, description };
    },
  );

  // Table-name sources, most specific first. The bare shape's top-level
  // "name" (CrowdStrike files) and the Sentinel shapes' schema names all
  // land here; files without one return null.
  const tableName =
    asNonEmptyString(prop(schema, "name")) ??
    asNonEmptyString(prop(tableDefinition, "name")) ??
    asNonEmptyString(prop(parsed, "name"));

  return {
    tableName,
    description: asNonEmptyString(prop(parsed, "description")) ?? "",
    retentionInDays: asPositiveInteger(prop(parsed, "retentionInDays")),
    totalRetentionInDays: asPositiveInteger(
      prop(parsed, "totalRetentionInDays"),
    ),
    columns,
    variant,
  };
}

/** Result of {@link validateCustomTableSchema}. */
export interface CustomTableSchemaValidation {
  valid: boolean;
  /** Human-readable rule violations; empty when valid. */
  errors: string[];
}

/**
 * Validate a custom table name + schema columns against the legacy creation
 * rules BEFORE building the tables PUT:
 *
 *   - the table name must end with "_CL" EXACTLY (case-sensitive). The legacy
 *     EndsWith("_CL") check is case-sensitive, so a "foo_cl" name would have
 *     been silently double-suffixed to "foo_cl_CL"; rejecting it here is the
 *     conscious fix (the quirk itself stays preserved in
 *     ensureCustomTableSuffix for characterization).
 *   - columns must be non-empty and each must carry a name and a type
 *     (the PS "Each column must have 'name' and 'type' properties" rule,
 *     surfaced as named errors instead of a throw).
 *   - TimeGenerated must be a datetime on the CREATION payload. Absence is
 *     auto-satisfied: normalizeCustomSchemaColumns injects
 *     {TimeGenerated, datetime} (the PS injection rule), so this rule only
 *     rejects a schema that DECLARES TimeGenerated with a type that does not
 *     map to datetime - the case the legacy engine shipped straight into an
 *     Azure 400.
 */
export function validateCustomTableSchema(
  tableName: string,
  columns: readonly CustomSchemaFileColumn[],
): CustomTableSchemaValidation {
  const errors: string[] = [];

  if (!tableName.endsWith("_CL")) {
    errors.push(
      `table name '${tableName}' must end with '_CL' (exact casing; ` +
        "Azure custom tables require the suffix)",
    );
  }

  if (columns.length === 0) {
    errors.push("schema must contain at least one column");
  }

  for (const column of columns) {
    if (!column.name || !column.type) {
      errors.push(
        "Each column must have 'name' and 'type' properties " +
          `(offending column: ${JSON.stringify(column)})`,
      );
    }
  }

  const timeGenerated = columns.find(
    (column) => column.name.toLowerCase() === "timegenerated",
  );
  if (
    timeGenerated !== undefined &&
    mapColumnType(timeGenerated.type) !== "datetime"
  ) {
    errors.push(
      `TimeGenerated must be a datetime column (got type '${timeGenerated.type}')`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/** Input for {@link buildTablePutRequest}. */
export interface TablePutRequestInput {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  /** Table name; "_CL" is appended when absent (ensureCustomTableSuffix). */
  table: string;
  /**
   * Schema-file columns (raw types). They are normalized here exactly like
   * the legacy pipeline: types mapped via mapColumnType, TimeGenerated
   * injected when absent, then the 13 Azure-managed reserved names stripped.
   */
  columns: readonly CustomSchemaFileColumn[];
  /** Interactive retention; defaults to 30 (compatibility contract). */
  retentionDays?: number;
  /** Total retention; defaults to 90 (compatibility contract). */
  totalRetentionDays?: number;
}

/** The exact PUT body New-LogAnalyticsCustomTable sends (verbatim shape). */
export interface TablePutRequestBody {
  properties: {
    plan: typeof CUSTOM_TABLE_PLAN;
    retentionInDays: number;
    totalRetentionInDays: number;
    schema: {
      name: string;
      columns: CustomTableColumn[];
    };
  };
}

/** The complete ARM request for creating a custom Log Analytics table. */
export interface TablePutRequest {
  method: "PUT";
  /**
   * ARM path (no host, no api-version):
   * /subscriptions/{sub}/resourceGroups/{rg}/providers/
   * Microsoft.OperationalInsights/workspaces/{ws}/tables/{table}
   */
  path: string;
  /** {@link LOG_ANALYTICS_TABLES_API_VERSION}. */
  apiVersion: string;
  body: TablePutRequestBody;
  /** The final "_CL"-suffixed table name used in path and schema.name. */
  tableName: string;
  /**
   * Names of reserved columns removed from the creation payload
   * (diagnostics; the legacy script warns with the removed count).
   */
  strippedReservedColumns: string[];
}

/**
 * Build the ARM PUT that creates a custom (_CL) Log Analytics table -
 * New-LogAnalyticsCustomTable as data. The body shape, plan value, retention
 * defaults (30/90), reserved-column strip, and api-version 2022-10-01 are the
 * characterized legacy contract.
 *
 * @throws CustomTableError when a scope input is blank.
 * @throws SchemaMappingError (from normalizeCustomSchemaColumns) when a
 *   column lacks name or type - run validateCustomTableSchema first for
 *   named errors instead of a throw.
 */
export function buildTablePutRequest(
  input: TablePutRequestInput,
): TablePutRequest {
  const { subscriptionId, resourceGroup, workspaceName, table } = input;
  if (subscriptionId.trim() === "") {
    throw new CustomTableError("subscriptionId must be a non-empty string");
  }
  if (resourceGroup.trim() === "") {
    throw new CustomTableError("resourceGroup must be a non-empty string");
  }
  if (workspaceName.trim() === "") {
    throw new CustomTableError("workspaceName must be a non-empty string");
  }
  if (table.trim() === "") {
    throw new CustomTableError("table must be a non-empty string");
  }

  const tableName = ensureCustomTableSuffix(table);

  // Legacy order preserved: the schema-file loader normalizes (type mapping
  // + TimeGenerated injection), then the creation call strips reserved
  // names. TimeGenerated is never reserved, so the payload is never empty.
  const normalized = normalizeCustomSchemaColumns(input.columns);
  const creationColumns = stripReservedTableCreationColumns(normalized);
  // stripReservedTableCreationColumns filters (keeps object identity), so a
  // by-identity diff recovers exactly the removed entries in order.
  const kept = new Set<CustomTableColumn>(creationColumns);
  const strippedReservedColumns = normalized
    .filter((column) => !kept.has(column))
    .map((column) => column.name);

  const path =
    `/subscriptions/${subscriptionId}` +
    `/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${workspaceName}` +
    `/tables/${tableName}`;

  return {
    method: "PUT",
    path,
    apiVersion: LOG_ANALYTICS_TABLES_API_VERSION,
    body: {
      properties: {
        plan: CUSTOM_TABLE_PLAN,
        retentionInDays:
          input.retentionDays ?? DEFAULT_CUSTOM_TABLE_RETENTION_DAYS,
        totalRetentionInDays:
          input.totalRetentionDays ?? DEFAULT_CUSTOM_TABLE_TOTAL_RETENTION_DAYS,
        schema: {
          name: tableName,
          columns: creationColumns,
        },
      },
    },
    tableName,
    strippedReservedColumns,
  };
}
