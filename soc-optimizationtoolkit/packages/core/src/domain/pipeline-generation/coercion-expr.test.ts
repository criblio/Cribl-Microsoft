/**
 * GEN-23 - what each coercion expression DOES to a value, not what it looks
 * like.
 *
 * THE DEFECT. buildCoercionExpr shipped `Boolean(x)` for a boolean column (so
 * '0', 'no' and 'false' all arrived true - every non-empty string is truthy),
 * `Number(x) || 0` for int/long and `parseFloat(x) || 0.0` for real (a value
 * that does not convert arrived as a real 0, indistinguishable from a measured
 * zero), and an unguarded `JSON.parse(x)` for dynamic (any non-JSON string
 * threw). GEN-19 then routed the matcher's cross-type renames through the same
 * function, so the field-match rung reached it too.
 *
 * Every pin below goes through generatePipelineConfForPlan on a real planned
 * table, reads the emitted `value:` back out of the enrich eval, and EVALUATES
 * it as JavaScript against the sample values the card names - so a regression
 * fails on a value, not on a string shape. The same conf is held to
 * checkCriblYaml and checkPlanFieldAccessors, so a fix that broke the YAML or
 * the accessor rule would fail here as well.
 *
 * "Empty" is `undefined`: Cribl's Eval leaves a field unset when the value
 * expression yields undefined, the convention the VPC Flow stamp already uses
 * for an epoch it cannot read (pipeline-conf.ts, Step 3a1). NOT VERIFIED
 * AGAINST A LIVE CRIBL INSTANCE in this change - Live Preview is the check.
 */

import { describe, expect, it } from "vitest";
import { checkCriblYaml } from "./cribl-yaml-validator";
import type { PipelineFieldMapping, TablePlan } from "./models";
import { generatePipelineConfForPlan } from "./pipeline-conf";
import { buildPipelinePlan } from "./plan";
import { checkPlanFieldAccessors } from "./plan-accessor-check";
import { readYamlDoubleQuoted } from "./yaml-double-quoted.test-util";

/** A real planned table, its fields replaced by `fields`. */
function tableWith(fields: PipelineFieldMapping[]): TablePlan {
  const plan = buildPipelinePlan({
    solutionName: "Test Solution",
    packName: "cribl-test",
    tables: [{ sentinelTable: "TestTable_CL", sourceFormat: "json" }],
  });
  const table = plan.tables[0];
  if (table === undefined) throw new Error("planner produced no table");
  return { ...table, fields };
}

/**
 * The emitted conf for one coerce field of `type`, its value expression (the
 * ONE `- name: <field>` add), and the expression compiled as a function of
 * that field - YAML-unescaped first, as Cribl would read it.
 */
function coercionOf(
  field: string,
  type: string,
  action: "coerce" | "rename" = "coerce",
): { conf: string; table: TablePlan; expr: string; run: (v: unknown) => unknown } {
  const table = tableWith([
    action === "coerce"
      ? { source: field, target: field, type, action: "coerce" }
      : { source: `src_${field}`, target: field, type, action: "rename", needsCoercion: true },
  ]);
  const conf = generatePipelineConfForPlan(table, "Test Solution");
  const hits = [
    ...conf.matchAll(new RegExp(`- name: ${field}\\n +value: "(.*)"$`, "gm")),
  ];
  expect(hits, `value lines for ${field}`).toHaveLength(1);
  const expr = (hits[0]?.[1] ?? "").replace(/\\\\/g, "\\");
  const fn = new Function(field, `return (${expr});`) as (v: unknown) => unknown;
  return { conf, table, expr, run: fn };
}

/** The card's sample values, plus the already-typed and absent inputs. */
const SAMPLES = ["0", "1", "true", "no", "abc", "12", "", '{"a":1}', "not json"];

describe("buildCoercionExpr - boolean is value-aware (GEN-23)", () => {
  const { conf, table, run } = coercionOf("Allowed", "boolean");

  it("reads the card's samples by meaning, not by truthiness", () => {
    expect(SAMPLES.map(run)).toEqual([
      false, // '0'
      true, // '1'
      true, // 'true'
      false, // 'no'
      undefined, // 'abc'
      undefined, // '12'
      undefined, // ''
      undefined, // '{"a":1}'
      undefined, // 'not json'
    ]);
  });

  it("is case-insensitive, trims, and keeps values that are already typed", () => {
    expect(["TRUE", " Yes ", "False", "NO", "false"].map(run)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect([true, false, 1, 0, null, undefined].map(run)).toEqual([
      true,
      false,
      true,
      false,
      undefined,
      undefined,
    ]);
  });

  // Review of GEN-23: the card's samples hold every token alone, so an
  // unanchored match passed them all. A word only CONTAINING a token is not
  // that token - '10' is not false and 'notrue' is not true.
  it("matches a whole token only, not one inside a longer value", () => {
    expect(["10", "01", "notrue", "nayes", "casino", "yes no"].map(run)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("stays clean under both checks", () => {
    expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
    expect(checkPlanFieldAccessors(table)).toEqual([]);
  });
});

describe("buildCoercionExpr - a number that does not convert arrives empty (GEN-23)", () => {
  for (const type of ["int", "long"]) {
    it(`${type}: converts what converts, empties what does not`, () => {
      const { conf, table, run } = coercionOf("SentBytes", type);
      expect(SAMPLES.map(run)).toEqual([
        0, // '0' - a measured zero is still a zero
        1,
        undefined, // 'true'
        undefined, // 'no'
        undefined, // 'abc'
        12,
        undefined, // ''
        undefined, // '{"a":1}'
        undefined, // 'not json'
      ]);
      expect([12, 0, " 7 ", "   ", null, undefined].map(run)).toEqual([
        12,
        0,
        7,
        undefined,
        undefined,
        undefined,
      ]);
      expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
      expect(checkPlanFieldAccessors(table)).toEqual([]);
    });
  }

  it("real: same rule, and no partial parse of trailing text", () => {
    const { conf, table, run } = coercionOf("Latency", "real");
    expect(SAMPLES.map(run)).toEqual([
      0,
      1,
      undefined,
      undefined,
      undefined,
      12,
      undefined,
      undefined,
      undefined,
    ]);
    // parseFloat would have read '12.5ms' as 12.5; a value with a unit is not
    // a number the column can trust, so it arrives empty with everything else.
    expect(["12.5", 3.25, "12.5ms"].map(run)).toEqual([12.5, 3.25, undefined]);
    expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
    expect(checkPlanFieldAccessors(table)).toEqual([]);
  });

  it("the matcher's cross-type rename gets the same conversion (GEN-19 path)", () => {
    const { run } = coercionOf("ReceivedBytes", "long", "rename");
    expect(["12", "abc", ""].map(run)).toEqual([12, undefined, undefined]);
  });
});

describe("buildCoercionExpr - dynamic never throws on text (GEN-23)", () => {
  const { conf, table, run } = coercionOf("Details", "dynamic");

  it("parses JSON text and keeps any other string as it arrived", () => {
    expect(SAMPLES.map(run)).toEqual([
      0,
      1,
      true,
      "no",
      "abc",
      12,
      "",
      { a: 1 },
      "not json",
    ]);
    expect(["[1,2]", "{abc}"].map(run)).toEqual([[1, 2], "{abc}"]);
  });

  it("passes a value that is already structured through untouched", () => {
    const obj = { a: 1 };
    expect(run(obj)).toBe(obj);
    expect(run(null)).toBe(null);
    expect(run(undefined)).toBe(undefined);
    // Review of GEN-23: only a STRING is parsed. JSON.parse stringifies what it
    // is given, so without the typeof guard ['5'] would collapse to 5 and
    // [true] to true - the catch alone does not protect a structured value.
    const arr = ["5"];
    expect(run(arr)).toBe(arr);
    expect(run([true])).toEqual([true]);
  });

  it("stays clean under both checks", () => {
    expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
    expect(checkPlanFieldAccessors(table)).toEqual([]);
  });
});

/**
 * The emitted conf for a vendor-research mapping of `field` from `sourceType`
 * to `destType`, and the `value:` body of its ONE `- name: <field>` add, still
 * YAML-escaped. The string branch is reached only through this channel: the
 * preset path (coerce, and the matcher's cross-type rename) passes "string" as
 * the source type, so a string column there is never a coercion at all.
 */
function vendorValueOf(
  field: string,
  sourceType: string,
  destType: string,
): { conf: string; table: TablePlan; body: string } {
  const table: TablePlan = {
    ...tableWith([{ source: field, target: field, type: destType, action: "keep" }]),
    vendorMappings: [{ sourceName: field, destName: field, sourceType, destType, action: "map" }],
  };
  const conf = generatePipelineConfForPlan(table, "Test Solution");
  const lines = conf.split("\n");
  const nameLine = `        - name: ${field}`;
  expect(lines.filter((l) => l === nameLine), `name lines for ${field}`).toHaveLength(1);
  const m = /^ {10}value: "(.*)"$/.exec(lines[lines.indexOf(nameLine) + 1] ?? "");
  expect(m, `value line for ${field}`).not.toBeNull();
  return { conf, table, body: m?.[1] ?? "" };
}

/**
 * GEN-29 - the string branch. buildCoercionExpr shipped `String(x || '')`, so
 * every falsy value - an int 0, a boolean false - arrived in a string column
 * as '' instead of '0' / 'false'. The same rule as GEN-23's: absent stays
 * absent (null and undefined pass through), everything else is String(value).
 */
describe("buildCoercionExpr - string keeps 0 and false (GEN-29)", () => {
  for (const sourceType of ["int", "boolean"]) {
    it(`${sourceType} -> string: every present value is stringified, absent stays absent`, () => {
      const { conf, table, body } = vendorValueOf("DstPort", sourceType, "string");
      const run = new Function("DstPort", `return (${readYamlDoubleQuoted(body)});`) as (
        v: unknown,
      ) => unknown;
      expect([0, false, true, 12, "", null, "abc"].map(run)).toEqual([
        "0",
        "false",
        "true",
        "12",
        "", // already a string, and an empty one
        null,
        "abc",
      ]);
      expect(run(undefined)).toBe(undefined);
      expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
      expect(checkPlanFieldAccessors(table)).toEqual([]);
    });
  }
});

/**
 * GEN-29's second point - a field name holding a quote. buildCoercionExpr
 * escaped a single quote as `\'`, which is not a YAML double-quoted escape (so
 * the `value:` scalar did not parse) and did not make the name a valid JS
 * identifier either: the name is read as a bare identifier, never inside a
 * string literal, so there is no quote to escape. The emitter now writes the
 * name verbatim and YAML-escapes the whole expression, so the scalar reads
 * back to exactly the expression for ANY name. Whether Cribl can address that
 * name is the accessor rule's question, and these pins hold that it still
 * refuses the build.
 */
describe("a coercion value line is valid YAML for any field name (GEN-29)", () => {
  for (const field of ["O'Brien", 'Say"Hi', "back\\slash"]) {
    it(`${JSON.stringify(field)}: the value reads back verbatim, and the build is refused`, () => {
      const { conf, body } = vendorValueOf(field, "int", "string");
      expect(readYamlDoubleQuoted(body)).toBe(`${field} == null ? ${field} : String(${field})`);
      const issues = checkCriblYaml(conf, "conf.yml");
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain(`field name "${field}" is not a valid Cribl property accessor`);
    });

    it(`${JSON.stringify(field)}: the preset coerce line is escaped the same way`, () => {
      const table = tableWith([{ source: field, target: field, type: "int", action: "coerce" }]);
      const conf = generatePipelineConfForPlan(table, "Test Solution");
      const lines = conf.split("\n");
      const nameLine = `        - name: ${field}`;
      expect(lines.filter((l) => l === nameLine), `name lines for ${field}`).toHaveLength(1);
      const m = /^ {10}value: "(.*)"$/.exec(lines[lines.indexOf(nameLine) + 1] ?? "");
      expect(readYamlDoubleQuoted(m?.[1] ?? "")).toBe(
        `(${field} != null && String(${field}).trim() !== '' && isFinite(${field})) ? Number(${field}) : undefined`,
      );
      expect(checkCriblYaml(conf, "conf.yml")).toHaveLength(1);
    });
  }
});
