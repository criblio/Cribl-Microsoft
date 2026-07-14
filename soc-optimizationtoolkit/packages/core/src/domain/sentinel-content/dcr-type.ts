/**
 * normalizeDcrType - the ONE superset DCR-vocabulary type map (porting-plan
 * Unit 14; ENG-23; compatibility contract section 3 item 8).
 *
 * The legacy had this map TRIPLICATED across three modules, drifted only in
 * COVERAGE (which source types each handled) - never in VALUES. Wherever two
 * copies handled the same input they agreed; each copy merely omitted keys the
 * others had, so an input one copy normalized correctly would silently fall
 * through another copy's `|| 'string'` default and corrupt the schema. This
 * module reconciles them to the UNION: every key any source handled, all values
 * pinned by dcr-type.test.ts with the source(s) cited per row.
 *
 * Cited sources (verbatim from the legacy tree):
 *   G = github.ts             normalizeDcrType   (lines 228-256)
 *   R = registry-sync.ts      normalizeType      (lines 101-111)
 *   V = vendor-research.ts    normalizeType      (lines 372-384)
 *
 * This is DISTINCT from schema-mapping.mapColumnType (Unit 5): that map is the
 * custom-table CREATION contract (ARM tables API, incl. datetimeoffset); this
 * map is the connector-DECODE projection applied when reading a connector's
 * declared column types into the DCR vocabulary
 * (string|int|long|real|boolean|datetime|dynamic). Unknown inputs default to
 * "string", matching all three legacy copies.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** The 7 DCR-vocabulary output types normalizeDcrType can produce. */
export type DcrVocabularyType =
  | "string"
  | "int"
  | "long"
  | "real"
  | "boolean"
  | "datetime"
  | "dynamic";

/**
 * The reconciled UNION map (lowercase input -> DCR vocabulary type). The
 * source-attribution comment on each group names which legacy copies carried
 * that key (G/R/V above); a bare key with no note is in all three.
 */
export const DCR_TYPE_MAP: Readonly<Record<string, DcrVocabularyType>> =
  Object.freeze({
    // -> string
    string: "string",
    str: "string", //            V only
    guid: "string", //           G, R, V  (GUIDs are not a DCR type; coerced)
    uniqueidentifier: "string", // G only
    uuid: "string",

    // -> int
    int: "int",
    int32: "int",
    integer: "int",

    // -> long
    long: "long",
    int64: "long",
    bigint: "long", //           G, V  (not R)

    // -> real
    real: "real",
    double: "real",
    float: "real",
    decimal: "real",
    number: "real", //           R, V  (not G)

    // -> boolean
    bool: "boolean",
    boolean: "boolean",

    // -> datetime
    datetime: "datetime",
    timestamp: "datetime",
    date: "datetime",
    "date-time": "datetime", //  V only
    time: "datetime", //         G only

    // -> dynamic
    dynamic: "dynamic",
    object: "dynamic",
    json: "dynamic",
    array: "dynamic", //         R, V  (not G)
  });

/**
 * Normalize a connector-declared column type to the DCR vocabulary. Matches
 * case-insensitively; unknown inputs (and empty/nullish) default to "string",
 * exactly as all three legacy copies did.
 */
export function normalizeDcrType(type: string | null | undefined): DcrVocabularyType {
  const lower = (type || "string").toLowerCase();
  return DCR_TYPE_MAP[lower] ?? "string";
}

/** True when `type` is an explicitly mapped input (not the string fallback). */
export function isKnownDcrType(type: string | null | undefined): boolean {
  if (!type) return false;
  return Object.prototype.hasOwnProperty.call(DCR_TYPE_MAP, type.toLowerCase());
}
