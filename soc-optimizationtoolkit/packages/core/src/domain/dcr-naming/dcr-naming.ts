/**
 * DCR/DCE name generation - COMPATIBILITY CONTRACT.
 *
 * This module is a faithful port of the legacy PowerShell naming logic in
 * Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1
 * (DCR name: lines 2548-2631, DCE endpoint name: lines 2667-2668).
 *
 * The output must match the legacy script byte-for-byte, including its
 * quirks and preserved defects. Do not "improve" the behavior here; the
 * generated names are deployed Azure resource names and any change breaks
 * idempotent re-deployment against existing environments. Every rule is
 * pinned by dcr-naming.characterization.test.ts (legacy-vectors.json).
 *
 * Pipeline (see the unit tests for a readable rule-by-rule walkthrough):
 *   STEP 0  strip one trailing "_CL" (case-insensitive) for custom tables
 *   STEP 1  compose: prefix + table + "-" + location [+ "-" + suffix]
 *           (prefix is concatenated verbatim; it carries its own hyphen)
 *   dce-endpoint mode returns the STEP 1 result as-is (no limit, ever)
 *   STEP 2  limit gate: 30 chars (direct) / 64 chars (dce); if within
 *           limit, no abbreviation of any kind happens
 *   STEP 3  dce over limit: truncate the table segment to the remaining
 *           budget and recompose (throws if the budget is negative)
 *   STEP 4  direct over limit: 6-entry dictionary lookup or first-6-chars
 *           fallback, recompose, then hard-cut to 30 + TrimEnd('-')
 *   STEP 5  always Trim('-') on both ends (direct and dce)
 *   STEP 6  final name must be at least 3 characters (throws otherwise)
 */

/** Deployment flavor the generated name is for. */
export type DcrNamingMode = "direct" | "dce" | "dce-endpoint";

export interface DcrNameInput {
  /** Table name as listed (custom tables usually carry a "_CL" suffix). */
  table: string;
  mode: DcrNamingMode;
  /**
   * Name prefix, concatenated VERBATIM (legacy defaults: "dcr-" for
   * direct/dce, "dce-" for dce-endpoint; the trailing hyphen belongs to
   * the prefix itself - no separator is inserted after it).
   */
  prefix: string;
  /**
   * Optional name suffix. A null/undefined/empty/whitespace-only suffix is
   * treated as absent (.NET string.IsNullOrWhiteSpace semantics). When
   * present it is appended verbatim after a "-" separator.
   */
  suffix?: string | null;
  /** Azure region, e.g. "eastus". Always preceded by a "-" separator. */
  location: string;
  /**
   * Whether the table came from the custom table list (legacy
   * CustomTableMode). Only custom tables get the trailing "_CL" stripped.
   * Defaults to false.
   */
  isCustomTable?: boolean;
}

export interface DcrNameResult {
  /** The generated resource name. */
  name: string;
  /**
   * True when the STEP 1 composed name exceeded the mode's limit (legacy
   * uses this purely for a UI warning; it is not part of the name).
   * Always false for dce-endpoint mode, which has no limit.
   */
  wasAbbreviated: boolean;
}

/** Direct (Kind:Direct) DCR names are capped at 30 characters. */
export const DIRECT_DCR_NAME_MAX_LENGTH = 30;

/** DCE-based DCR names are capped at 64 characters. */
export const DCE_DCR_NAME_MAX_LENGTH = 64;

/** Azure requires resource names of at least 3 characters. */
export const DCR_NAME_MIN_LENGTH = 3;

/**
 * The complete legacy abbreviation dictionary (all 6 entries). Lookup is
 * full-string and case-insensitive (PowerShell switch semantics); on a hit
 * the CANONICAL literal below is emitted regardless of input casing. Note
 * the Syslog identity mapping still canonicalizes casing ("SYSLOG" ->
 * "Syslog"). The dictionary is consulted ONLY when the composed direct
 * name exceeds 30 characters.
 */
export const DIRECT_DCR_TABLE_ABBREVIATIONS: Readonly<Record<string, string>> =
  Object.freeze({
    CommonSecurityLog: "CSL",
    SecurityEvent: "SecEvt",
    WindowsEvent: "WinEvt",
    Syslog: "Syslog",
    DeviceEvents: "DevEvt",
    BehaviorAnalytics: "BehAna",
  });

/** Lowercased lookup table implementing the case-insensitive match. */
const abbreviationLookup: ReadonlyMap<string, string> = new Map(
  Object.entries(DIRECT_DCR_TABLE_ABBREVIATIONS).map(([table, abbrev]) => [
    table.toLowerCase(),
    abbrev,
  ]),
);

/** Error thrown when the legacy logic would throw (both crash modes). */
export class DcrNamingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DcrNamingError";
  }
}

/**
 * STEP 0: remove ONE trailing "_CL", matched case-insensitively, only at
 * the end of the string (PowerShell: -replace '_CL$', '').
 * "MyApp_CL_CL" -> "MyApp_CL"; "MYTABLE_cl" -> "MYTABLE"; no-op otherwise.
 */
export function stripCustomTableSuffix(tableName: string): string {
  return tableName.replace(/_CL$/i, "");
}

/** .NET string.IsNullOrWhiteSpace. */
function isNullOrWhitespace(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

/** .NET TrimEnd('-'): strip ALL trailing hyphens. */
function trimEndHyphens(value: string): string {
  return value.replace(/-+$/, "");
}

/** .NET Trim('-'): strip ALL leading and trailing hyphens. */
function trimHyphens(value: string): string {
  return value.replace(/^-+/, "").replace(/-+$/, "");
}

/**
 * STEP 1 composition. The prefix is concatenated verbatim (no separator);
 * a hyphen is ALWAYS inserted before the location and before a present
 * suffix. `suffix === undefined` means "absent" (already normalized).
 */
function compose(
  prefix: string,
  table: string,
  location: string,
  suffix: string | undefined,
): string {
  let name = `${prefix}${table}-${location}`;
  if (suffix !== undefined) {
    name = `${name}-${suffix}`;
  }
  return name;
}

/**
 * Generate a DCR name ("direct"/"dce" modes) or a DCE endpoint name
 * ("dce-endpoint" mode) exactly as the legacy PowerShell automation does.
 *
 * Pure function: no IO, no config lookup. Callers supply the prefix,
 * suffix, and location from their own configuration (legacy defaults:
 * prefix "dcr-"/"dce-", suffix "", location "eastus").
 *
 * @throws DcrNamingError when the legacy script would throw:
 *   - dce mode where prefix + location + suffix alone exceed the 64-char
 *     budget (legacy: .NET Substring ArgumentOutOfRangeException), or
 *   - a final name shorter than 3 characters.
 */
export function generateDcrName(input: DcrNameInput): DcrNameResult {
  const { table, mode, prefix, location } = input;
  const isCustomTable = input.isCustomTable ?? false;

  // A whitespace-only suffix is treated as absent; a present suffix is
  // appended verbatim (untrimmed).
  const suffix =
    input.suffix != null && !isNullOrWhitespace(input.suffix)
      ? input.suffix
      : undefined;

  // STEP 0: effective table name.
  const dcrTableName = isCustomTable ? stripCustomTableSuffix(table) : table;

  // STEP 1: compose.
  let name = compose(prefix, dcrTableName, location, suffix);

  if (mode === "dce-endpoint") {
    // Legacy performs NO length check, NO truncation, NO hyphen trimming,
    // and NO minimum-length enforcement on DCE endpoint names.
    return { name, wasAbbreviated: false };
  }

  // STEP 2: limit gate. Within the limit the dictionary is never consulted.
  const maxLength =
    mode === "direct" ? DIRECT_DCR_NAME_MAX_LENGTH : DCE_DCR_NAME_MAX_LENGTH;
  const wasAbbreviated = name.length > maxLength;

  if (wasAbbreviated) {
    if (mode === "dce") {
      // STEP 3: truncate the table segment to the remaining budget.
      let tableBudget = maxLength - prefix.length - location.length - 1;
      if (suffix !== undefined) {
        tableBudget -= suffix.length + 1;
      }
      if (tableBudget < 0) {
        // DEFECT PRESERVED: legacy throws a .NET Substring
        // ArgumentOutOfRangeException here; a faithful port errors too.
        throw new DcrNamingError(
          `Cannot generate DCE-based DCR name for table '${table}': ` +
            `prefix '${prefix}', location '${location}', and suffix ` +
            `leave a negative table-name budget (${tableBudget}) within ` +
            `the ${maxLength}-character limit`,
        );
      }
      const truncatedTable = dcrTableName.substring(
        0,
        Math.min(dcrTableName.length, tableBudget),
      );
      name = compose(prefix, truncatedTable, location, suffix);
    } else {
      // STEP 4: direct-mode abbreviation. Dictionary hit emits the
      // canonical literal; otherwise take the first min(6, length) chars
      // of the table (the ONLY generic intelligence - no CamelCase logic).
      const abbrev =
        abbreviationLookup.get(dcrTableName.toLowerCase()) ??
        dcrTableName.substring(0, Math.min(dcrTableName.length, 6));
      name = compose(prefix, abbrev, location, suffix);

      // Still too long: hard-cut to 30 then strip trailing hyphens. The
      // cut can consume the suffix, the location, and even part of the
      // prefix.
      if (name.length > maxLength) {
        name = trimEndHyphens(name.substring(0, maxLength));
      }
    }
  }

  // STEP 5: ALWAYS strip leading/trailing hyphens (even when the name was
  // never over the limit).
  name = trimHyphens(name);

  // STEP 6: minimum length validation (legacy throws with this message).
  if (name.length < DCR_NAME_MIN_LENGTH) {
    throw new DcrNamingError(
      `DCR name '${name}' is too short (minimum 3 characters required)`,
    );
  }

  return { name, wasAbbreviated };
}
