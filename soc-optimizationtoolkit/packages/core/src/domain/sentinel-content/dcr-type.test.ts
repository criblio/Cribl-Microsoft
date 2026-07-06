/**
 * normalizeDcrType SUPERSET reconciliation - porting-plan Unit 14.
 *
 * The map was TRIPLICATED with COVERAGE drift (never value drift) across:
 *   G = github.ts             normalizeDcrType   (228-256)
 *   R = registry-sync.ts      normalizeType      (101-111)
 *   V = vendor-research.ts    normalizeType      (372-384)
 *
 * Each row cites which copies handled the input. The "expected" is the union
 * value; the point of the reconciliation is that no two copies DISAGREED where
 * they overlapped - the only bug was silent fall-through to 'string' for keys a
 * copy omitted. This suite pins the union so no key is ever lost again.
 */
import { describe, expect, it } from "vitest";
import { DCR_TYPE_MAP, isKnownDcrType, normalizeDcrType } from "./dcr-type";

interface Row {
  input: string;
  g: string | null; // github.ts value; null = not handled (fell through to string)
  r: string | null; // registry-sync.ts value
  v: string | null; // vendor-research.ts value
  expected: string;
}

// null means the source's map lacked the key and its `|| 'string'` default fired.
const RECONCILIATION: Row[] = [
  // agreed by all three
  { input: "string", g: "string", r: "string", v: "string", expected: "string" },
  { input: "int", g: "int", r: "int", v: "int", expected: "int" },
  { input: "int32", g: "int", r: "int", v: "int", expected: "int" },
  { input: "integer", g: "int", r: "int", v: "int", expected: "int" },
  { input: "long", g: "long", r: "long", v: "long", expected: "long" },
  { input: "int64", g: "long", r: "long", v: "long", expected: "long" },
  { input: "real", g: "real", r: "real", v: "real", expected: "real" },
  { input: "double", g: "real", r: "real", v: "real", expected: "real" },
  { input: "float", g: "real", r: "real", v: "real", expected: "real" },
  { input: "decimal", g: "real", r: "real", v: "real", expected: "real" },
  { input: "bool", g: "boolean", r: "boolean", v: "boolean", expected: "boolean" },
  { input: "boolean", g: "boolean", r: "boolean", v: "boolean", expected: "boolean" },
  { input: "datetime", g: "datetime", r: "datetime", v: "datetime", expected: "datetime" },
  { input: "timestamp", g: "datetime", r: "datetime", v: "datetime", expected: "datetime" },
  { input: "date", g: "datetime", r: "datetime", v: "datetime", expected: "datetime" },
  { input: "dynamic", g: "dynamic", r: "dynamic", v: "dynamic", expected: "dynamic" },
  { input: "object", g: "dynamic", r: "dynamic", v: "dynamic", expected: "dynamic" },
  { input: "json", g: "dynamic", r: "dynamic", v: "dynamic", expected: "dynamic" },
  { input: "guid", g: "string", r: "string", v: "string", expected: "string" },
  { input: "uuid", g: "string", r: "string", v: "string", expected: "string" },

  // COVERAGE drift - a key one/two copies omitted (default 'string' would corrupt)
  { input: "bigint", g: "long", r: null, v: "long", expected: "long" }, // not R
  { input: "number", g: null, r: "real", v: "real", expected: "real" }, // not G
  { input: "array", g: null, r: "dynamic", v: "dynamic", expected: "dynamic" }, // not G
  { input: "date-time", g: null, r: null, v: "datetime", expected: "datetime" }, // V only
  { input: "time", g: "datetime", r: null, v: null, expected: "datetime" }, // G only
  { input: "uniqueidentifier", g: "string", r: null, v: null, expected: "string" }, // G only
  { input: "str", g: null, r: null, v: "string", expected: "string" }, // V only
];

describe("normalizeDcrType superset (G/R/V reconciled)", () => {
  for (const row of RECONCILIATION) {
    const cite = `G:${row.g ?? "-"} R:${row.r ?? "-"} V:${row.v ?? "-"}`;
    it(`'${row.input}' -> '${row.expected}' (${cite})`, () => {
      // No source that HANDLED the key disagreed with the union value.
      for (const src of [row.g, row.r, row.v]) {
        if (src !== null) expect(src).toBe(row.expected);
      }
      expect(normalizeDcrType(row.input)).toBe(row.expected);
      expect(isKnownDcrType(row.input)).toBe(true);
    });
  }

  it("matches case-insensitively", () => {
    expect(normalizeDcrType("DateTime")).toBe("datetime");
    expect(normalizeDcrType("Int32")).toBe("int");
    expect(normalizeDcrType("GUID")).toBe("string");
    expect(normalizeDcrType("Date-Time")).toBe("datetime");
  });

  it("unknown / empty / nullish default to string and are not 'known'", () => {
    expect(normalizeDcrType("sbyte")).toBe("string");
    expect(normalizeDcrType("")).toBe("string");
    expect(normalizeDcrType(null)).toBe("string");
    expect(normalizeDcrType(undefined)).toBe("string");
    expect(isKnownDcrType("sbyte")).toBe(false);
    expect(isKnownDcrType("")).toBe(false);
    expect(isKnownDcrType(null)).toBe(false);
  });

  it("every map value is a DCR vocabulary type", () => {
    const vocab = new Set(["string", "int", "long", "real", "boolean", "datetime", "dynamic"]);
    for (const value of Object.values(DCR_TYPE_MAP)) {
      expect(vocab.has(value)).toBe(true);
    }
  });

  it("the map is the union - it covers every input any source handled", () => {
    for (const row of RECONCILIATION) {
      expect(Object.prototype.hasOwnProperty.call(DCR_TYPE_MAP, row.input)).toBe(true);
    }
  });
});
