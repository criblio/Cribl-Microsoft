/**
 * mapColumnType RECONCILIATION TABLE - porting-plan Unit 5.
 *
 * Two legacy implementations existed:
 *   PS:  ConvertTo-DCRColumnType, Azure/CustomDeploymentTemplates/
 *        DCR-Automation/core/Create-TableDCRs.ps1 lines 396-432
 *        (the characterized compatibility contract, section 3 item 8)
 *   TS:  mapColumnType, Cribl-Microsoft_IntegrationSolution/src/main/ipc/
 *        azure-deploy.ts lines 395-405 (fed auto-generated schema files
 *        that the PS engine then re-mapped through ConvertTo-DCRColumnType)
 *
 * Reconciliation rules (this suite pins them verbatim):
 *   - Where both agree: unchanged.
 *   - Where they DISAGREE ('guid'): the PS contract WINS. The legacy TS
 *     returned 'guid', but the PS engine re-converted that to 'string' on
 *     load (its own comment: "GUIDs not allowed in DCR - must convert to
 *     string"), so end to end the deployed value was always 'string'.
 *   - Legacy-TS-ONLY inputs ('datetimeoffset', 'array') are ADDED: they
 *     appear in Sentinel table-definition JSONs, which the new toolkit now
 *     parses directly (parseTableSchemaFile), and default-to-string would
 *     corrupt those schemas.
 *   - PS-ONLY inputs (integer, bigint, decimal, timestamp, date, time,
 *     json, uniqueidentifier, uuid) are kept.
 */
import { describe, expect, it } from "vitest";
import { isKnownColumnType, mapColumnType } from "./schema-mapping";

interface ReconciliationRow {
  input: string;
  /** ConvertTo-DCRColumnType output; null = not handled (default string + warning). */
  ps: string | null;
  /** azure-deploy.ts mapColumnType output; null = not handled (default string). */
  legacyTs: string | null;
  /** The reconciled toolkit output. */
  expected: string;
}

const RECONCILIATION_TABLE: ReconciliationRow[] = [
  // Both sources agree - verbatim.
  { input: "string", ps: "string", legacyTs: null, expected: "string" },
  { input: "int", ps: "int", legacyTs: "int", expected: "int" },
  { input: "int32", ps: "int", legacyTs: "int", expected: "int" },
  { input: "long", ps: "long", legacyTs: "long", expected: "long" },
  { input: "int64", ps: "long", legacyTs: "long", expected: "long" },
  { input: "real", ps: "real", legacyTs: "real", expected: "real" },
  { input: "double", ps: "real", legacyTs: "real", expected: "real" },
  { input: "float", ps: "real", legacyTs: "real", expected: "real" },
  { input: "bool", ps: "boolean", legacyTs: "boolean", expected: "boolean" },
  { input: "boolean", ps: "boolean", legacyTs: "boolean", expected: "boolean" },
  { input: "datetime", ps: "datetime", legacyTs: "datetime", expected: "datetime" },
  { input: "dynamic", ps: "dynamic", legacyTs: "dynamic", expected: "dynamic" },
  { input: "object", ps: "dynamic", legacyTs: "dynamic", expected: "dynamic" },

  // PS-only inputs - the characterization contract keeps them.
  { input: "integer", ps: "int", legacyTs: null, expected: "int" },
  { input: "bigint", ps: "long", legacyTs: null, expected: "long" },
  { input: "decimal", ps: "real", legacyTs: null, expected: "real" },
  { input: "timestamp", ps: "datetime", legacyTs: null, expected: "datetime" },
  { input: "date", ps: "datetime", legacyTs: null, expected: "datetime" },
  { input: "time", ps: "datetime", legacyTs: null, expected: "datetime" },
  { input: "json", ps: "dynamic", legacyTs: null, expected: "dynamic" },
  { input: "uniqueidentifier", ps: "string", legacyTs: null, expected: "string" },
  { input: "uuid", ps: "string", legacyTs: null, expected: "string" },

  // CONFLICT: PS wins. Legacy TS said 'guid'; ConvertTo-DCRColumnType
  // (line 424) says 'string' - and re-mapped the TS output anyway.
  { input: "guid", ps: "string", legacyTs: "guid", expected: "string" },

  // LEGACY-TS-ONLY ADDITIONS (azure-deploy.ts lines 397 and 402): Sentinel
  // table definitions carry these; without the additions they would fall
  // through to the unknown->string default and corrupt parsed schemas.
  { input: "datetimeoffset", ps: null, legacyTs: "datetime", expected: "datetime" },
  { input: "array", ps: null, legacyTs: "dynamic", expected: "dynamic" },
];

describe("mapColumnType reconciliation (PS contract wins; legacy-TS-only cases added)", () => {
  for (const row of RECONCILIATION_TABLE) {
    it(`'${row.input}' -> '${row.expected}' (PS: ${row.ps ?? "n/a"}, legacy TS: ${row.legacyTs ?? "n/a"})`, () => {
      expect(mapColumnType(row.input)).toBe(row.expected);
      expect(isKnownColumnType(row.input)).toBe(true);
    });
  }

  it("the legacy-TS additions are matched case-insensitively like the rest", () => {
    expect(mapColumnType("DateTimeOffset")).toBe("datetime");
    expect(mapColumnType("Array")).toBe("dynamic");
  });

  it("inputs neither source handled still default to string and stay unknown", () => {
    expect(mapColumnType("sbyte")).toBe("string");
    expect(isKnownColumnType("sbyte")).toBe(false);
  });
});
