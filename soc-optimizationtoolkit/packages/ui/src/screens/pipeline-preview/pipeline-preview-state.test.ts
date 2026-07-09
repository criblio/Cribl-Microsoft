/**
 * Tests for the pipeline-preview PURE projection (porting-plan Unit 17 UI).
 *
 * The generation TRUTH (conf.yml emission, reduction KB, route.yml, the CEF
 * extraction, checkCriblYaml acceptance) is pinned in @soc/core's
 * pipeline-generation tests. These pin the BINDING layer this panel adds:
 *   - the empty-state ordering (samples -> mappings -> approval);
 *   - the GapReport -> TablePlanInput projection (presetFields, route condition,
 *     normalized format) and the reviewer-edit override;
 *   - the readable ordered function-line parse;
 *   - the reduction-rule display projection (keep/drop/suppress + reasons);
 *   - HONEST validator surfacing: a well-formed plan yields valid=true / zero
 *     issues, and the emitted YAML actually passes the core validator.
 * The end-to-end cases run the REAL core planner + emitters over constructed
 * gap reports, so the projection is exercised against actual generated YAML.
 */

import { describe, expect, it } from "vitest";
import type { GapFieldMapping, GapReport } from "@soc/core";
import {
  PIPELINE_PREVIEW_NO_REPORTS_REASON,
  PIPELINE_PREVIEW_NO_SAMPLES_REASON,
  PIPELINE_PREVIEW_NOT_APPROVED_REASON,
  derivePipelinePreview,
  effectiveReportMappings,
  gapMappingToPreset,
  normalizeSourceFormat,
  pipelineFunctionLines,
  pipelinePreviewEmptyReason,
  isValidEnrichmentFieldName,
  mergeEnrichments,
  reductionRuleViews,
  reportToPlanInput,
} from "./pipeline-preview-state";
import type { PipelinePreviewInputs } from "./pipeline-preview-state";

// --- Fixtures --------------------------------------------------------------

function mapping(over: Partial<GapFieldMapping>): GapFieldMapping {
  return {
    source: "src",
    dest: "SourceIP",
    sourceType: "string",
    destType: "string",
    confidence: "alias",
    action: "rename",
    needsCoercion: false,
    description: "",
    ...over,
  };
}

function report(over: Partial<GapReport>): GapReport {
  return {
    tableName: "CommonSecurityLog",
    logType: "CommonSecurityLog",
    stats: [],
    sourceFieldCount: 0,
    destFieldCount: 0,
    passthroughCount: 0,
    dcrHandledCount: 0,
    criblHandledCount: 0,
    overflowCount: 0,
    dcrRenames: [],
    dcrCoercions: [],
    criblRenames: [],
    criblCoercions: [],
    dcrHandlesSummary: "DCR handles: 0 rename(s), 0 coercion(s)",
    criblHandlesSummary: "Cribl handles: 1 rename(s), 0 coercion(s)",
    routeCondition: "true",
    fieldMappings: [mapping({})],
    destSchema: [{ name: "SourceIP", type: "string" }],
    overflowLossy: false,
    warnings: [],
    ...over,
  };
}

function approvedInputs(): PipelinePreviewInputs {
  return {
    solutionName: "Common Event Format",
    packName: "cef-pack",
    reports: [report({})],
    approved: true,
  };
}

// --- Empty-state ordering --------------------------------------------------

describe("pipelinePreviewEmptyReason", () => {
  it("asks for samples first when there are no reports", () => {
    expect(
      pipelinePreviewEmptyReason({
        solutionName: "s",
        packName: "p",
        reports: [],
        approved: false,
      }),
    ).toBe(PIPELINE_PREVIEW_NO_SAMPLES_REASON);
  });

  it("asks to run the gap analysis when reports carry no mappings", () => {
    expect(
      pipelinePreviewEmptyReason({
        solutionName: "s",
        packName: "p",
        reports: [report({ fieldMappings: [] })],
        approved: false,
      }),
    ).toBe(PIPELINE_PREVIEW_NO_REPORTS_REASON);
  });

  it("asks for approval when mappings exist but are not approved", () => {
    expect(
      pipelinePreviewEmptyReason({
        solutionName: "s",
        packName: "p",
        reports: [report({})],
        approved: false,
      }),
    ).toBe(PIPELINE_PREVIEW_NOT_APPROVED_REASON);
  });

  it("returns null once samples, mappings, and approval are all present", () => {
    expect(pipelinePreviewEmptyReason(approvedInputs())).toBeNull();
  });
});

describe("derivePipelinePreview empty view", () => {
  it("is unavailable with the reason and no plan when not approved", () => {
    const view = derivePipelinePreview({
      solutionName: "s",
      packName: "p",
      reports: [report({})],
      approved: false,
    });
    expect(view.available).toBe(false);
    expect(view.plan).toBeNull();
    expect(view.tables).toEqual([]);
    expect(view.routeYml).toBe("");
    expect(view.emptyReason).toBe(PIPELINE_PREVIEW_NOT_APPROVED_REASON);
    // Empty view is trivially valid (no YAML emitted, nothing to reject).
    expect(view.valid).toBe(true);
    expect(view.totalYamlIssues).toBe(0);
  });
});

// --- Projection helpers ----------------------------------------------------

describe("normalizeSourceFormat", () => {
  it("maps unknown/blank/undefined to json and passes real formats through", () => {
    expect(normalizeSourceFormat("unknown")).toBe("json");
    expect(normalizeSourceFormat("")).toBe("json");
    expect(normalizeSourceFormat(undefined)).toBe("json");
    expect(normalizeSourceFormat("cef")).toBe("cef");
    expect(normalizeSourceFormat("csv")).toBe("csv");
  });
});

describe("gapMappingToPreset", () => {
  it("collapses overflow to drop and preserves other actions", () => {
    expect(gapMappingToPreset(mapping({ action: "overflow" })).action).toBe(
      "drop",
    );
    expect(gapMappingToPreset(mapping({ action: "keep" })).action).toBe("keep");
    expect(gapMappingToPreset(mapping({ action: "coerce" })).action).toBe(
      "coerce",
    );
  });

  it("maps source/dest/destType onto the preset field shape", () => {
    const preset = gapMappingToPreset(
      mapping({ source: "spt", dest: "SourcePort", destType: "int" }),
    );
    expect(preset).toEqual({
      source: "spt",
      target: "SourcePort",
      type: "int",
      action: "rename",
    });
  });
});

describe("effectiveReportMappings", () => {
  const r = report({ logType: "HTTP", fieldMappings: [mapping({ source: "a" })] });

  it("uses the report baseline when there is no override", () => {
    expect(effectiveReportMappings(r)[0].source).toBe("a");
  });

  it("prefers the reviewer's edited mappings for the log type", () => {
    const edited = [mapping({ source: "edited" })];
    expect(effectiveReportMappings(r, { HTTP: edited })[0].source).toBe(
      "edited",
    );
  });
});

describe("reportToPlanInput", () => {
  it("carries the route condition, presets, and normalized format", () => {
    const input = reportToPlanInput(
      report({
        tableName: "CloudflareV2_CL",
        logType: "HTTP",
        routeCondition: "sourcetype == 'cloudflare:json'",
        fieldMappings: [mapping({ source: "x", dest: "y" })],
      }),
      undefined,
      { HTTP: "cef" },
    );
    expect(input.sentinelTable).toBe("CloudflareV2_CL");
    expect(input.logType).toBe("HTTP");
    expect(input.sourceFormat).toBe("cef");
    expect(input.routing?.routeCondition).toBe(
      "sourcetype == 'cloudflare:json'",
    );
    expect(input.presetFields).toEqual([
      { source: "x", target: "y", type: "string", action: "rename" },
    ]);
  });

  it("defaults an unmapped log-type format to json", () => {
    const input = reportToPlanInput(report({ logType: "L" }), undefined, {});
    expect(input.sourceFormat).toBe("json");
  });
});

describe("pipelineFunctionLines", () => {
  it("parses ids, groups, and descriptions in execution order", () => {
    const conf = [
      "functions:",
      "  - id: eval",
      '    filter: "true"',
      "    disabled: false",
      "    conf:",
      "      add:",
      "        - name: nested",
      "    description: First step",
      "    groupId: extract",
      "  - id: rename",
      "    disabled: false",
      "    description: Rename fields",
      "    groupId: rename",
      "",
    ].join("\n");
    const lines = pipelineFunctionLines(conf);
    expect(lines.map((l) => l.id)).toEqual(["eval", "rename"]);
    expect(lines.map((l) => l.index)).toEqual([1, 2]);
    expect(lines[0].groupId).toBe("extract");
    expect(lines[0].description).toBe("First step");
    // The nested `- name:` entry (six-space indent) is NOT a function.
    expect(lines).toHaveLength(2);
  });
});

// --- End-to-end over the real core planner + emitters ----------------------

describe("derivePipelinePreview (real generation)", () => {
  const view = derivePipelinePreview(approvedInputs());

  it("builds a plan and one table entry for the approved report", () => {
    expect(view.available).toBe(true);
    expect(view.plan).not.toBeNull();
    expect(view.tables).toHaveLength(1);
    expect(view.tables[0].tableName).toBe("CommonSecurityLog");
    expect(view.tables[0].provenance).toBe("preset-fields");
  });

  it("emits conf.yml with an ordered function list", () => {
    const table = view.tables[0];
    expect(table.transformConf).toContain("functions:");
    expect(table.functions.length).toBeGreaterThan(0);
    expect(table.functions[0].index).toBe(1);
  });

  it("projects the CommonSecurityLog reduction rules with reasons", () => {
    const table = view.tables[0];
    expect(table.hasReductionRules).toBe(true);
    const kinds = new Set(table.reductionRules.map((r) => r.kind));
    expect(kinds.has("keep")).toBe(true);
    expect(kinds.has("drop")).toBe(true);
    expect(kinds.has("suppress")).toBe(true);
    // Every rule carries a non-empty reason (the KB display content).
    expect(table.reductionRules.every((r) => r.reason.length > 0)).toBe(true);
    // keep rules sort before drop before suppress.
    const firstSuppress = table.reductionRules.findIndex(
      (r) => r.kind === "suppress",
    );
    const lastKeep = table.reductionRules.map((r) => r.kind).lastIndexOf("keep");
    expect(lastKeep).toBeLessThan(firstSuppress);
  });

  it("defaults suppress maxEvents to 1 when the KB omits it", () => {
    const table = view.tables[0];
    for (const rule of table.reductionRules) {
      if (rule.kind === "suppress") {
        expect(typeof rule.maxEvents).toBe("number");
        expect(rule.maxEvents).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("emits a route.yml that references the pipelines", () => {
    expect(view.routeYml).toContain("routes:");
    expect(view.routeYml).toContain(view.tables[0].pipelineName);
  });

  it("passes the Cribl YAML validator honestly (zero issues)", () => {
    expect(view.totalYamlIssues).toBe(0);
    expect(view.valid).toBe(true);
    expect(view.tables[0].yamlIssues).toEqual([]);
    expect(view.routeYmlIssues).toEqual([]);
  });
});

describe("derivePipelinePreview reflects reviewer edits", () => {
  it("uses the overridden mappings in the generated pipeline", () => {
    const base = report({
      logType: "CommonSecurityLog",
      fieldMappings: [mapping({ source: "src", dest: "SourceIP" })],
    });
    const view = derivePipelinePreview({
      solutionName: "CEF",
      packName: "p",
      reports: [base],
      mappingOverrides: {
        CommonSecurityLog: [
          mapping({ source: "src", dest: "DestinationIP", action: "rename" }),
        ],
      },
      approved: true,
    });
    // The edited destination appears in the emitted transform conf.
    expect(view.tables[0].transformConf).toContain("DestinationIP");
  });
});

describe("reductionRuleViews", () => {
  it("returns an empty list for a table with no matched rules", () => {
    const view = derivePipelinePreview({
      solutionName: "Acme Custom",
      packName: "p",
      reports: [
        report({
          tableName: "AcmeNoRules_CL",
          logType: "AcmeNoRules_CL",
          fieldMappings: [mapping({})],
        }),
      ],
      approved: true,
    });
    const table = view.tables[0];
    expect(table.hasReductionRules).toBe(false);
    expect(table.reductionRules).toEqual([]);
    // A no-rule table still validates cleanly.
    expect(table.yamlIssues).toEqual([]);
  });

  it("is a pure re-projection of the plan table's reductionRules", () => {
    const view = derivePipelinePreview(approvedInputs());
    const planTable = view.plan?.tables[0];
    expect(planTable).toBeDefined();
    if (planTable !== undefined) {
      expect(reductionRuleViews(planTable)).toEqual(
        view.tables[0].reductionRules,
      );
    }
  });
});

describe("enrichment fields (user-added constants)", () => {
  it("validates Eval-safe field names", () => {
    expect(isValidEnrichmentFieldName("DeviceVendor")).toBe(true);
    expect(isValidEnrichmentFieldName("_internal2")).toBe(true);
    expect(isValidEnrichmentFieldName("2bad")).toBe(false);
    expect(isValidEnrichmentFieldName("has space")).toBe(false);
    expect(isValidEnrichmentFieldName("")).toBe(false);
  });

  it("merges global + per-table with per-table winning on collision", () => {
    const merged = mergeEnrichments(
      [
        { field: "DeviceVendor", value: "Palo Alto Networks" },
        { field: "DeviceProduct", value: "PAN-OS" },
      ],
      [{ field: "DeviceProduct", value: "Prisma" }],
    );
    expect(merged).toEqual([
      { field: "DeviceVendor", value: "Palo Alto Networks" },
      { field: "DeviceProduct", value: "Prisma" },
    ]);
  });

  it("reportToPlanInput carries enrichments as enrich vendorMappings", () => {
    const input = reportToPlanInput(report({}), undefined, undefined, [
      { field: "DeviceVendor", value: "Palo Alto Networks" },
    ]);
    expect(input.vendorMappings).toEqual([
      {
        sourceName: "DeviceVendor",
        destName: "DeviceVendor",
        sourceType: "string",
        destType: "string",
        action: "enrich",
        description: "Palo Alto Networks",
      },
    ]);
  });

  it("the derived preview YAML adds the constant via an Eval enrich step", () => {
    const view = derivePipelinePreview({
      ...approvedInputs(),
      enrichments: {
        CommonSecurityLog: [
          { field: "DeviceVendor", value: "Palo Alto Networks" },
        ],
      },
    });
    expect(view.available).toBe(true);
    const conf = view.tables[0]?.transformConf ?? "";
    expect(conf).toContain("name: DeviceVendor");
    expect(conf).toContain("'Palo Alto Networks'");
    expect(conf).toContain("Add enrichment fields");
    // Validation still passes with the enrich step present.
    expect(view.valid).toBe(true);
  });
});
