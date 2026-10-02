/**
 * GEN-5 - the DECODE fate of checkPlanFieldAccessors (audit follow-up,
 * 2026-10-02).
 *
 * The keep / self-rename / unexpressed-coerce pins live in
 * sample-parsing/accessor-names.test.ts, beside the whole-chain measurements
 * they came from. This file pins the fate the first cut of the check missed:
 * a `decode` field is read as `C.Decode.base64(<source>)` inside a VALUE
 * expression and otherwise appears only as a `remove:` bullet, so no
 * name:/currentName:/newName: line ever presents its source to checkCriblYaml.
 * Measured before the fix through the same chain as below: `b64.url` and
 * `b64-url` both gave 0 YAML issues and 0 plan issues, and the conf read
 * `value: "C.Decode.base64(b64.url)"` - a nested-path read that addresses
 * nothing, or for the hyphen a subtraction.
 *
 * Every assertion goes through generatePipelineConfForPlan, so a drift
 * between the check's idea of a decode field and the emitter's decodeFields
 * filter shows up as a count here.
 */

import { describe, expect, it } from "vitest";
import { checkCriblYaml } from "./cribl-yaml-validator";
import type { PipelineFieldMapping, TablePlan } from "./models";
import { generatePipelineConfForPlan } from "./pipeline-conf";
import { buildPipelinePlan } from "./plan";
import { checkPlanFieldAccessors } from "./plan-accessor-check";

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

function decodeOf(source: string, target = "RequestURL"): TablePlan {
  return tableWith([{ source, target, type: "string", action: "decode" }]);
}

describe("checkPlanFieldAccessors - decode (GEN-5)", () => {
  it("REFUSES a dotted decode source no conf line presents", () => {
    const table = decodeOf("b64.url");
    const conf = generatePipelineConfForPlan(table, "Test Solution");
    // The emitter really does read it, by its own spelling, in a value.
    expect(conf).toContain('value: "C.Decode.base64(b64.url)"');
    // ...and the YAML rule never sees it: the only name: line it reads is the
    // addressable target.
    expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
    expect(checkPlanFieldAccessors(table)).toEqual([
      'TestTable_CL: field name "b64.url" (decode) is not a valid Cribl ' +
        "property accessor - Cribl will fail to build an accessor for it at " +
        "runtime (or, for a dotted name, silently address a nested field " +
        "that does not exist). It is read as the input of the base64 decode " +
        "into RequestURL, and no conf line names it; rename it upstream to an " +
        "addressable name instead.",
    ]);
  });

  it("REFUSES a hyphenated decode source, which would read as subtraction", () => {
    const table = decodeOf("b64-url");
    const conf = generatePipelineConfForPlan(table, "Test Solution");
    expect(conf).toContain('value: "C.Decode.base64(b64-url)"');
    expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
    const issues = checkPlanFieldAccessors(table);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('field name "b64-url" (decode)');
  });

  it("does not refuse an addressable decode source", () => {
    const table = decodeOf("b64url");
    const conf = generatePipelineConfForPlan(table, "Test Solution");
    expect(conf).toContain('value: "C.Decode.base64(b64url)"');
    expect(checkPlanFieldAccessors(table)).toEqual([]);
  });

  it("matches the emitter: a decode with no target is never read, so never refused", () => {
    // The emitter's decodeFields filter skips `target === ""` - no eval reads
    // the source - so the check must skip it too or it would refuse a field
    // the pack never touches.
    const table = decodeOf("b64.url", "");
    const conf = generatePipelineConfForPlan(table, "Test Solution");
    expect(conf).not.toContain("C.Decode.base64");
    expect(checkPlanFieldAccessors(table)).toEqual([]);
  });

  it("keeps the keep wording for a kept field", () => {
    // The decode wording is its own branch; the kept one must not change.
    const table = tableWith([
      { source: "a.b", target: "a.b", type: "string", action: "keep" },
    ]);
    expect(checkPlanFieldAccessors(table)).toEqual([
      'TestTable_CL: field name "a.b" (keep) is not a valid Cribl property ' +
        "accessor - Cribl will fail to build an accessor for it at runtime " +
        "(or, for a dotted name, silently address a nested field that does " +
        "not exist). It is kept under its own spelling, so no conf line names " +
        "it; map it to a column with an addressable name instead.",
    ]);
  });
});
