/**
 * Pure decision logic for the OnboardTableScreen's custom (_CL) table
 * section (porting-plan Unit 5). Kept out of the screen component so the
 * schema-source precedence, parse/preview derivation, and retention
 * default/override rules are unit-testable without a DOM.
 *
 * All schema knowledge comes from @soc/core: parseTableSchemaFile accepts
 * the three wild schema-file shapes, validateCustomTableSchema enforces the
 * legacy creation rules, mapColumnType is the characterized type-mapping
 * contract, and stripReservedTableCreationColumns / the TimeGenerated
 * injection rule shape the honest creation-payload preview. Nothing is
 * re-implemented here - this module only DERIVES screen state from those
 * contracts.
 */

import {
  CustomTableError,
  isKnownColumnType,
  mapColumnType,
  parseTableSchemaFile,
  stripReservedTableCreationColumns,
  validateCustomTableSchema,
  findVendorSchema,
  VENDOR_SCHEMAS,
} from "@soc/core";
import type {
  CustomSchemaFileColumn,
  CustomTableRetentionDays,
  DcrColumnType,
  TableSchemaFileVariant,
} from "@soc/core";

/**
 * Where the custom table's schema comes from. Exactly ONE source is active
 * at a time (the picker is exclusive); inputs belonging to the other
 * sources are IGNORED by {@link deriveCustomSchemaPreview} - the pinned
 * source-precedence rule.
 *
 *   - "vendor":   a bundled VENDOR_SCHEMAS entry (air-gap capable).
 *   - "file":     an uploaded or pasted schema JSON file (any of the three
 *                 wild shapes parseTableSchemaFile accepts).
 *   - "existing": no schema is sent; the run requires the table to already
 *                 exist in the workspace (its live Azure schema wins - the
 *                 legacy Process-CustomTable contract).
 */
export type CustomSchemaSource = "vendor" | "file" | "existing";

/** Picker entries for the schema-source control, in render order. */
export const CUSTOM_SCHEMA_SOURCE_OPTIONS: readonly {
  value: CustomSchemaSource;
  label: string;
}[] = Object.freeze([
  { value: "vendor", label: "Bundled vendor schema" },
  { value: "file", label: "Upload or paste a schema JSON file" },
  { value: "existing", label: "Use the existing workspace table" },
]);

/**
 * Choices for the per-run retention select, mirroring the Unit 4
 * customTableRetentionDays option (30|90 contract).
 */
export const RETENTION_CHOICES: readonly { value: string; label: string }[] =
  Object.freeze([
    { value: "30", label: "30 days" },
    { value: "90", label: "90 days" },
  ]);

/**
 * Resolve the interactive retention for THIS run: an explicit per-run
 * override ("30"/"90" from the select) wins; anything else (including the
 * "" no-override sentinel) falls back to the PERSISTED Unit 4 default so an
 * options blob loaded after mount still takes effect until the user touches
 * the control.
 */
export function resolveRetentionDays(
  override: string,
  persistedDefault: CustomTableRetentionDays,
): CustomTableRetentionDays {
  if (override === "30") {
    return 30;
  }
  if (override === "90") {
    return 90;
  }
  return persistedDefault;
}

/**
 * The bundled vendor schema whose target table matches the typed name
 * (case-insensitive), or "" when none does - used to preselect the vendor
 * dropdown when the user types a table the library already covers.
 */
export function defaultVendorIdForTable(table: string): string {
  const wanted = table.trim().toLowerCase();
  if (wanted === "") {
    return "";
  }
  const match = VENDOR_SCHEMAS.find(
    (entry) => entry.table.toLowerCase() === wanted,
  );
  return match?.id ?? "";
}

/** One row of the column preview table. */
export interface SchemaPreviewRow {
  name: string;
  /** The type as written in the schema file (missing types read "string"). */
  declaredType: string;
  /** The DCR/creation type via the characterized mapColumnType contract. */
  mappedType: DcrColumnType;
  /** Declared type is outside the legacy mapping table (falls to string). */
  unknownType: boolean;
  /** TimeGenerated row the creation payload injects (not in the file). */
  injected: boolean;
  /** Azure-managed reserved name - stripped from the creation payload. */
  reserved: boolean;
}

/** Everything the custom section renders, derived from the raw inputs. */
export interface CustomSchemaPreview {
  /** Column preview rows; empty when nothing parsed yet. */
  rows: SchemaPreviewRow[];
  /** Columns to pass as onboardTable's customSchema (raw parsed shape). */
  columns: CustomSchemaFileColumn[];
  /** Which wild schema-file shape parsed, or null when nothing parsed. */
  variant: TableSchemaFileVariant | null;
  /** Table name the schema itself claims to target, or null. */
  schemaTableName: string | null;
  /** Blocking problems (parse failures, validation rule violations). */
  errors: string[];
  /** Non-blocking notices (name mismatch, unknown types). */
  warnings: string[];
  /**
   * Neutral guidance when the source simply needs more input (no vendor
   * schema picked yet, no file content yet); null once content exists.
   */
  notReadyHint: string | null;
  /** True when the run may proceed with this source selection. */
  ready: boolean;
  /** True when the run should carry `columns` as its customSchema. */
  providesSchema: boolean;
}

/** Raw control values {@link deriveCustomSchemaPreview} decides over. */
export interface CustomSchemaInputs {
  /** The typed table name (validated against the exact _CL rule). */
  table: string;
  source: CustomSchemaSource;
  /** Selected VENDOR_SCHEMAS id ("" = none picked). Vendor source only. */
  vendorId: string;
  /** Uploaded/pasted schema JSON text ("" = none yet). File source only. */
  fileText: string;
}

function emptyPreview(): CustomSchemaPreview {
  return {
    rows: [],
    columns: [],
    variant: null,
    schemaTableName: null,
    errors: [],
    warnings: [],
    notReadyHint: null,
    ready: false,
    providesSchema: false,
  };
}

/** Build preview rows mirroring what buildTablePutRequest will send. */
function previewRows(columns: readonly CustomSchemaFileColumn[]): SchemaPreviewRow[] {
  // Reserved detection reuses the REAL strip function (never a second list):
  // whatever it filters out is exactly what creation will drop.
  const kept = new Set(stripReservedTableCreationColumns(columns));
  const rows: SchemaPreviewRow[] = columns.map((column) => ({
    name: column.name,
    declaredType: column.type,
    mappedType: mapColumnType(column.type),
    unknownType: !isKnownColumnType(column.type),
    injected: false,
    reserved: !kept.has(column),
  }));
  const hasTimeGenerated = columns.some(
    (column) => column.name.toLowerCase() === "timegenerated",
  );
  if (!hasTimeGenerated) {
    // The normalizeCustomSchemaColumns injection rule, previewed honestly.
    rows.push({
      name: "TimeGenerated",
      declaredType: "datetime",
      mappedType: "datetime",
      unknownType: false,
      injected: true,
      reserved: false,
    });
  }
  return rows;
}

/**
 * Derive the whole custom-schema section state from its raw inputs.
 *
 * Source precedence (pinned by test): only the ACTIVE source's input is
 * consulted - junk in the file textarea cannot block a vendor-sourced run,
 * a stale vendor pick cannot leak into a file-sourced run, and the
 * "existing" source ignores both and never sends a schema.
 */
export function deriveCustomSchemaPreview(
  inputs: CustomSchemaInputs,
): CustomSchemaPreview {
  const preview = emptyPreview();
  const table = inputs.table.trim();

  if (inputs.source === "existing") {
    // No schema travels with the run: the workspace table's live schema
    // wins (and the run fails honestly at create-custom-table when the
    // table does not exist).
    preview.ready = true;
    return preview;
  }

  let raw: string;
  let schemaTableFallback: string | null = null;
  if (inputs.source === "vendor") {
    if (inputs.vendorId === "") {
      preview.notReadyHint =
        "Select a vendor schema to preview its columns.";
      return preview;
    }
    const entry = findVendorSchema(inputs.vendorId);
    if (entry === undefined) {
      preview.errors.push(`Unknown vendor schema '${inputs.vendorId}'.`);
      return preview;
    }
    raw = entry.raw;
    schemaTableFallback = entry.table;
  } else {
    if (inputs.fileText.trim() === "") {
      preview.notReadyHint =
        "Upload or paste a schema JSON file to preview its columns.";
      return preview;
    }
    raw = inputs.fileText;
  }

  try {
    const parsed = parseTableSchemaFile(raw);
    preview.columns = parsed.columns;
    preview.variant = parsed.variant;
    preview.schemaTableName = parsed.tableName ?? schemaTableFallback;
    preview.rows = previewRows(parsed.columns);
  } catch (error) {
    preview.errors.push(
      error instanceof CustomTableError ? error.message : String(error),
    );
    return preview;
  }

  const validation = validateCustomTableSchema(table, preview.columns);
  preview.errors.push(...validation.errors);

  if (
    preview.schemaTableName !== null &&
    preview.schemaTableName.toLowerCase() !== table.toLowerCase()
  ) {
    preview.warnings.push(
      `The schema targets table '${preview.schemaTableName}', but this run ` +
        `creates '${table}'.`,
    );
  }
  const unknown = preview.rows.filter((row) => row.unknownType);
  if (unknown.length > 0) {
    preview.warnings.push(
      "Unknown column type(s) default to string: " +
        unknown.map((row) => `${row.name} ('${row.declaredType}')`).join(", ") +
        ".",
    );
  }

  preview.ready = preview.errors.length === 0;
  preview.providesSchema = preview.ready;
  return preview;
}

/** Header line of the monospace column preview table. */
const PREVIEW_NAME_HEADER = "Column";
const PREVIEW_TYPE_HEADER = "Schema type";
const PREVIEW_MAPPED_HEADER = "Creates as";

/**
 * Render the column preview as aligned monospace lines (header first),
 * matching the screen's step-list visual language. Row notes explain the
 * two creation-payload adjustments and the unknown-type fallback.
 */
export function formatSchemaPreview(rows: readonly SchemaPreviewRow[]): string {
  const nameWidth = Math.max(
    PREVIEW_NAME_HEADER.length,
    ...rows.map((row) => row.name.length),
  );
  const typeWidth = Math.max(
    PREVIEW_TYPE_HEADER.length,
    ...rows.map((row) => row.declaredType.length),
  );
  const lines = [
    `${PREVIEW_NAME_HEADER.padEnd(nameWidth)}  ` +
      `${PREVIEW_TYPE_HEADER.padEnd(typeWidth)}  ${PREVIEW_MAPPED_HEADER}`,
  ];
  for (const row of rows) {
    const notes: string[] = [];
    if (row.injected) {
      notes.push("injected automatically");
    }
    if (row.reserved) {
      notes.push("Azure-managed - removed from the creation payload");
    }
    if (row.unknownType) {
      notes.push("unknown type - defaults to string");
    }
    const note = notes.length > 0 ? `  (${notes.join("; ")})` : "";
    lines.push(
      `${row.name.padEnd(nameWidth)}  ` +
        `${row.declaredType.padEnd(typeWidth)}  ${row.mappedType}${note}`,
    );
  }
  return lines.join("\n");
}
