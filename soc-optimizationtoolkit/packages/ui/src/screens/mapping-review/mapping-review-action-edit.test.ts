/**
 * DBT-209, through the pipeline conf: an Action edit on an overflow row cannot
 * point a Rename at the catch-all.
 *
 * The Action select used to change only `action`. An overflow row (dest
 * AdditionalExtensions) set to rename then became `Rename qqvendorfield ->
 * AdditionalExtensions` in the pack, overwriting the serialized catch-all; set
 * to keep, it reached the DCR under its raw name and was discarded there. GEN-19
 * fixed the Dest path only. The reducer now asks core actionEditRefusal - the
 * same rule the screen uses to disable those options - and refuses the edit.
 *
 * This runs the production chain the Pipeline Preview and the pack build share
 * (collectGapReports -> reportToPlanInput -> buildPipelinePlan ->
 * generatePipelineConfForPlan) over the reviewer's effective rows.
 */

import {
  FakeSentinelContent,
  buildPipelinePlan,
  checkCriblYaml,
  collectGapReports,
  createBundledSchemaCatalog,
  generatePipelineConfForPlan,
  getOverflowConfig,
} from "@soc/core";
import type { GapReport, MatchAction } from "@soc/core";
import { describe, expect, it } from "vitest";
import { reportToPlanInput } from "../pipeline-preview/pipeline-preview-state";
import {
  INITIAL_MAPPING_REVIEW_STATE,
  effectiveMappings,
  isModified,
  mappingReviewReducer,
} from "./mapping-review-state";
import type { MappingReviewState } from "./mapping-review-state";

const SAMPLE = JSON.stringify({
  TimeGenerated: "2026-10-29T12:00:00Z",
  qqvendorfield: "00:11:22:33:44:55",
});

async function cslReport(): Promise<GapReport> {
  const [report] = await collectGapReports(
    { content: new FakeSentinelContent({ files: {} }), catalog: createBundledSchemaCatalog() },
    {
      solutionName: "",
      samples: [{ logType: "Vendor", tableName: "CommonSecurityLog", content: SAMPLE }],
    },
  );
  return report;
}

function editAction(
  state: MappingReviewState,
  report: GapReport,
  value: MatchAction,
): MappingReviewState {
  return mappingReviewReducer(state, {
    type: "edit-mapping",
    logType: report.logType,
    sourceField: "qqvendorfield",
    field: "action",
    value,
    baseline: report.fieldMappings,
    catchAllColumn: getOverflowConfig(report.tableName).fieldName,
  });
}

function confFor(report: GapReport, state: MappingReviewState): string {
  const plan = buildPipelinePlan({
    solutionName: "",
    packName: "vendor-sentinel",
    version: "1.0.0",
    tables: [
      reportToPlanInput(
        report,
        { [report.logType]: effectiveMappings(state, report) },
        { [report.logType]: "json" },
      ),
    ],
  });
  return generatePipelineConfForPlan(plan.tables[0], "");
}

/** Every `newName:` a Rename step in the conf writes. */
function renameTargets(conf: string): string[] {
  return conf
    .split("\n")
    .filter((l) => /^\s+newName: /.test(l))
    .map((l) => l.trim().slice("newName: ".length));
}

describe("an Action edit on an overflow row (DBT-209)", () => {
  it("the precondition: the vendor field is an overflow row in the catch-all", async () => {
    const report = await cslReport();
    const row = report.fieldMappings.find((m) => m.source === "qqvendorfield");
    expect(row?.action).toBe("overflow");
    expect(row?.dest).toBe(getOverflowConfig("CommonSecurityLog").fieldName);
  });

  it("refuses rename, keep, coerce and decode: no edit is stored and nothing reads as modified", async () => {
    const report = await cslReport();
    for (const value of ["rename", "keep", "coerce", "decode"] as const) {
      const next = editAction(INITIAL_MAPPING_REVIEW_STATE, report, value);
      expect(next).toBe(INITIAL_MAPPING_REVIEW_STATE);
      expect(isModified(next, report)).toBe(false);
    }
  });

  it("still takes drop, the action that needs no column", async () => {
    const report = await cslReport();
    const next = editAction(INITIAL_MAPPING_REVIEW_STATE, report, "drop");
    expect(
      effectiveMappings(next, report).find((m) => m.source === "qqvendorfield")?.action,
    ).toBe("drop");
  });

  // Each attempt on its own: rename is the Rename onto the catch-all, keep is
  // the field leaving overflow (no serialize step at all with one overflow row).
  for (const value of ["rename", "keep"] as const) {
    it(`the conf a ${value} attempt builds has no Rename onto the catch-all and still serializes the field`, async () => {
      const report = await cslReport();
      const catchAll = getOverflowConfig(report.tableName).fieldName;
      const conf = confFor(report, editAction(INITIAL_MAPPING_REVIEW_STATE, report, value));
      expect(renameTargets(conf)).not.toContain(catchAll);
      expect(conf).not.toContain("currentName: qqvendorfield");
      expect(conf.split("\n")).toContain("  - id: serialize");
      expect(checkCriblYaml(conf, "conf.yml")).toEqual([]);
    });
  }
});
