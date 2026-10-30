/**
 * GEN-20, end to end: the CEF inbound-bytes key `in` reaches ReceivedBytes in
 * the GENERATED pipeline, not just in the matcher.
 *
 * The UAT (PAN-OS CEF capture, v1.12.6) showed `in` as an unmatched overflow
 * row beside `out -> SentBytes`, so Rule Coverage reported ReceivedBytes
 * missing while the Mapping Catalog claimed the mapping was covered. The
 * matcher pin alone cannot show that the conf a pack ships renames it, so this
 * runs the production chain the Pipeline Preview and the pack build share:
 * analyzeSamples -> reportToPlanInput -> buildPipelinePlan ->
 * generatePipelineConfForPlan, then holds the emitted YAML to checkCriblYaml.
 */

import {
  CEF_CATALOG_PACK,
  FakeSentinelContent,
  buildPipelinePlan,
  checkCriblYaml,
  collectGapReports,
  createBundledSchemaCatalog,
  generatePipelineConfForPlan,
} from "@soc/core";
import { describe, expect, it } from "vitest";
import { availableFieldsFromReports } from "../rule-coverage/rule-coverage-state";
import { reportToPlanInput } from "./pipeline-preview-state";

const SOLUTION = "Palo Alto Networks";

/** Two PAN-OS CEF TRAFFIC events carrying both CEF byte counters. */
const CEF_SAMPLE = [
  "CEF:0|Palo Alto Networks|PAN-OS|10.2|end|TRAFFIC|3|src=10.0.0.1 dst=10.0.0.2 spt=51000 dpt=443 proto=TCP in=1200 out=3400 act=allow",
  "CEF:0|Palo Alto Networks|PAN-OS|10.2|end|TRAFFIC|3|src=10.0.0.3 dst=10.0.0.4 spt=51001 dpt=80 proto=TCP in=98 out=12 act=allow",
].join("\n");

async function cefReport() {
  const [report] = await collectGapReports(
    { content: new FakeSentinelContent({ files: {} }), catalog: createBundledSchemaCatalog() },
    {
      solutionName: SOLUTION,
      samples: [{ logType: "TRAFFIC", tableName: "CommonSecurityLog", content: CEF_SAMPLE }],
    },
  );
  return report;
}

async function cefConf(): Promise<string> {
  const report = await cefReport();
  const plan = buildPipelinePlan({
    solutionName: SOLUTION,
    packName: "palo-alto-sentinel",
    version: "1.0.0",
    tables: [reportToPlanInput(report, undefined, { TRAFFIC: "cef" })],
  });
  return generatePipelineConfForPlan(plan.tables[0], SOLUTION);
}

/**
 * The `fields:` list of the overflow serialize step. It is an exclusion list
 * ending in "*": every field not excluded is folded into AdditionalExtensions.
 */
function serializeFields(conf: string): string[] {
  const lines = conf.split("\n");
  const step = lines.indexOf("  - id: serialize");
  if (step < 0) return [];
  const list = lines.indexOf("      fields:", step);
  const out: string[] = [];
  for (let i = list + 1; i < lines.length && lines[i].startsWith("        - "); i++) {
    out.push(lines[i].slice("        - ".length));
  }
  return out;
}

/** The cleanup Eval's `remove:` list (fields deleted after serialization). */
function cleanupRemoved(conf: string): string[] {
  const lines = conf.split("\n");
  const desc = lines.indexOf("    description: Remove internal fields");
  const list = lines.lastIndexOf("      remove:", desc);
  if (desc < 0 || list < 0) return [];
  return lines.slice(list + 1, desc).map((l) => l.trim().replace(/^- /, ""));
}

describe("CEF `in` -> ReceivedBytes, end to end (GEN-20)", () => {
  it("the gap report maps `in` to ReceivedBytes as a rename, not overflow", async () => {
    const report = await cefReport();
    const rows = report.fieldMappings.filter((m) => m.source === "in");
    expect(rows).toHaveLength(1);
    expect(rows[0].dest).toBe("ReceivedBytes");
    expect(rows[0].action).toBe("rename");
  });

  it("the conf renames `in` to ReceivedBytes, keeps it out of overflow, and passes checkCriblYaml", async () => {
    const conf = await cefConf();
    const lines = conf.split("\n");
    const at = lines.indexOf("        - currentName: in");
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe("          newName: ReceivedBytes");
    // `out` still goes the same way, so the pair is symmetric.
    const outAt = lines.indexOf("        - currentName: out");
    expect(lines[outAt + 1]).toBe("          newName: SentBytes");
    // The serialize step folds every field it does not exclude ("*" last).
    // `in` is renamed before it runs, so the step excludes ReceivedBytes and
    // never names `in`. Before GEN-20 `in` fell through "*" into
    // AdditionalExtensions and the cleanup Eval then deleted it.
    const fields = serializeFields(conf);
    expect(fields[fields.length - 1]).toBe('"*"');
    expect(fields).toContain('"!ReceivedBytes"');
    expect(fields).toContain('"!SentBytes"');
    expect(fields.filter((f) => /^"?!?in"?$/.test(f))).toEqual([]);
    const removed = cleanupRemoved(conf);
    expect(removed).toContain("CEFVersion");
    expect(removed).not.toContain("in");
    expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
  });

  it("agrees with the Mapping Catalog's CEF claim", async () => {
    // Read the claim AND what the gap analysis did, and hold them to each
    // other: reading the catalog alone passes whether or not the matcher
    // makes the mapping, which is exactly the disagreement GEN-20 was.
    const claim = CEF_CATALOG_PACK.mappings.filter((m) => m.sourceName === "in");
    expect(claim.map((m) => m.destName)).toEqual(["ReceivedBytes"]);
    const report = await cefReport();
    const made = report.fieldMappings
      .filter((m) => m.source === "in" && m.action !== "overflow")
      .map((m) => m.dest);
    expect(made).toEqual(claim.map((m) => m.destName));
  });

  it("Rule Coverage counts ReceivedBytes as produced, not `in` as an overflow survivor", async () => {
    // The UAT symptom: Rule Coverage reported ReceivedBytes missing. Its
    // availability set is derived from these same report rows.
    const available = availableFieldsFromReports([await cefReport()]);
    expect(available).toContain("ReceivedBytes");
    expect(available).toContain("SentBytes");
    expect(available).not.toContain("in");
  });
});
