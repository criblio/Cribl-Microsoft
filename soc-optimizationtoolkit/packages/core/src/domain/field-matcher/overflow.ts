/**
 * field-matcher OVERFLOW CONFIG - porting-plan Unit 13 (ENG-03).
 *
 * The per-table overflow (catch-all) column map and the Cribl-internal skip
 * list, ported VERBATIM from legacy field-matcher.ts (lines 334-359, 751-754).
 *
 * The "enabled only when the overflow field exists in the schema" rule and the
 * SURFACED WARNING when it does not live in match-fields (that is where the
 * schema is in scope). Legacy set enabled=false and dropped the data SILENTLY;
 * Unit 13 keeps the enabled rule but adds the warning (fix + pin).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/**
 * Maps Sentinel table names to their overflow/catch-all field. Verbatim from
 * legacy TABLE_OVERFLOW_FIELDS.
 */
export const TABLE_OVERFLOW_FIELDS: Record<
  string,
  { fieldName: string; fieldType: "dynamic" | "string" }
> = {
  // CEF-based tables use AdditionalExtensions (string, key=value format)
  CommonSecurityLog: { fieldName: "AdditionalExtensions", fieldType: "string" },
  // Syslog uses a dynamic field or message field
  Syslog: { fieldName: "SyslogMessage", fieldType: "string" },
  // Windows events use EventData (dynamic/JSON)
  WindowsEvent: { fieldName: "EventData", fieldType: "dynamic" },
  SecurityEvent: { fieldName: "EventData", fieldType: "dynamic" },
  // Azure Activity uses Properties (dynamic)
  AzureActivity: { fieldName: "Properties", fieldType: "dynamic" },
  // Custom tables typically use a dynamic column for extras
  // Default for any _CL table:
  _default_custom: { fieldName: "AdditionalData_d", fieldType: "dynamic" },
  // Specific vendor tables
  CloudflareV2_CL: { fieldName: "AdditionalFields_d", fieldType: "dynamic" },
};

/**
 * Fields to skip from overflow (Cribl internals, transport metadata - cleaned
 * up separately by the pipeline). Verbatim from legacy `skipOverflow`.
 *
 * DESIGN NOTE preserved: "in" is a JS reserved word, so the CEF inbound-bytes
 * field cannot be an ALIAS_TABLE key (its counterpart "out" is). It therefore
 * never gets a dedicated match and flows to overflow by design - not dropped.
 * Preserving this list (and NOT adding "in") preserves that behavior.
 */
export const SKIP_OVERFLOW_FIELDS = new Set([
  "_raw",
  "_time",
  "source",
  "host",
  "port",
  "index",
  "sourcetype",
  "cribl_breaker",
  "cribl_pipe",
]);

/**
 * Get the overflow field config for a table. Verbatim from legacy
 * getOverflowConfig: exact match, then the _CL custom default, then the
 * CEF-style AdditionalExtensions fallback.
 */
export function getOverflowConfig(tableName: string): {
  fieldName: string;
  fieldType: "dynamic" | "string";
} {
  // Exact match
  if (TABLE_OVERFLOW_FIELDS[tableName]) return TABLE_OVERFLOW_FIELDS[tableName];
  // Custom table default
  if (tableName.endsWith("_CL")) return TABLE_OVERFLOW_FIELDS["_default_custom"];
  // Fallback
  return { fieldName: "AdditionalExtensions", fieldType: "string" };
}
