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

import { EMPTY_OVERFLOW_TRIAGE } from "@soc/core";
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
    overflowTriage: EMPTY_OVERFLOW_TRIAGE,
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
  it("keeps overflow and drop DISTINCT (2026-07-13 live fix)", () => {
    // overflow folds into the catch-all; drop is removed outright by the
    // emitted pipeline. Collapsing them shipped reviewer-dropped fields
    // inside AdditionalExtensions.
    expect(gapMappingToPreset(mapping({ action: "overflow" })).action).toBe(
      "overflow",
    );
    expect(gapMappingToPreset(mapping({ action: "drop" })).action).toBe("drop");
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

/**
 * Sample VALUES must reach the planner THROUGH the preview.
 *
 * The derivation has its own pins in @soc/core. What those cannot catch is the
 * wiring being inert: a prop that type-checks, threads through three files and
 * never arrives still leaves every route match-all, and the only symptom is
 * detections that never fire. This is how the 1.11.0 identity advisory shipped
 * doing nothing, so it is pinned on the REAL derivePipelinePreview rather than
 * on a stub of it.
 */
describe("derivePipelinePreview - route discrimination by field value", () => {
  /** Two log types, one schema - separable only by the `action` VALUE. */
  const reports = [
    report({ logType: "ALLOWED", routeCondition: "true" }),
    report({ logType: "BLOCKED", routeCondition: "true" }),
  ];

  const values = {
    ALLOWED: {
      eventCount: 3,
      values: { action: ["Allowed", "Allowed", "Allowed"], src: ["a", "b", "c"] },
    },
    BLOCKED: {
      eventCount: 3,
      values: { action: ["Blocked", "Blocked", "Blocked"], src: ["d", "e", "f"] },
    },
  };

  function conditions(withValues: boolean): string[] {
    const view = derivePipelinePreview({
      solutionName: "Vendor",
      packName: "vendor-sentinel",
      reports,
      sampleFormats: { ALLOWED: "cef", BLOCKED: "cef" },
      ...(withValues ? { sampleFieldValues: values } : {}),
      approved: true,
    });
    return (view.plan?.tables ?? []).map((t) => t.routeCondition);
  }

  it("leaves both routes on a PLACEHOLDER when no values are supplied", () => {
    // RE-PINNED 2026-08-13. The baseline used to be two match-alls, one of
    // which was dead. Undiscriminable log types now get an inert placeholder
    // instead, so neither route steals the other's events and both are
    // reported as outstanding work.
    for (const cond of conditions(false)) {
      expect(cond).toContain("__UNSET__");
    }
  });

  it("gives each log type its own filter once values arrive", () => {
    const got = conditions(true);
    expect(got).not.toContain("true");
    expect(new Set(got).size).toBe(2);
  });

  it("filters on the discriminating field, never on per-event data", () => {
    const got = conditions(true).join(" ");
    expect(got).toContain("action");
    expect(got).not.toContain("src ===");
  });

  it("reports nothing unreachable once the routes are separated", () => {
    const view = derivePipelinePreview({
      solutionName: "Vendor",
      packName: "vendor-sentinel",
      reports,
      sampleFormats: { ALLOWED: "cef", BLOCKED: "cef" },
      sampleFieldValues: values,
      approved: true,
    });
    expect(view.unreachableLogTypes).toEqual([]);
  });
});

/**
 * Placeholder filters must reach the preview, or the operator never learns
 * there is work outstanding and ships a pack with silent inert routes.
 */
describe("derivePipelinePreview - placeholder route filters", () => {
  const reports = [
    report({ logType: "firewall", routeCondition: "true" }),
    report({ logType: "dns", routeCondition: "true" }),
  ];

  function view(withValues: boolean) {
    return derivePipelinePreview({
      solutionName: "Vendor",
      packName: "vendor-sentinel",
      reports,
      sampleFormats: { firewall: "cef", dns: "cef" },
      ...(withValues
        ? {
            sampleFieldValues: {
              // Three events each: below MIN_EVENTS_FOR_VALUE_FILTER the core
              // refuses to infer a filter at all, so a thinner fixture would
              // pin the evidence threshold instead of the wiring.
              firewall: { eventCount: 3, values: { act: ["Allow", "Allow", "Allow"] } },
              dns: { eventCount: 3, values: { act: ["Query", "Query", "Query"] } },
            },
          }
        : {}),
      approved: true,
    });
  }

  it("names the log types awaiting a filter", () => {
    expect(view(false).placeholderLogTypes.sort()).toEqual(["dns", "firewall"]);
  });

  it("reports NOTHING unreachable - a placeholder is inert, not shadowed", () => {
    // The distinction the operator acts on: unfinished, not broken.
    expect(view(false).unreachableLogTypes).toEqual([]);
  });

  it("still emits both routes and pipelines, so a filter edit is all that remains", () => {
    const v = view(false);
    expect(v.tables).toHaveLength(2);
    expect(v.routeYml).toContain("Reduction + Transform: firewall");
    expect(v.routeYml).toContain("Reduction + Transform: dns");
  });

  it("says nothing once the samples DO separate the log types", () => {
    // A warning that fires on a healthy pack is the noise that hides the real one.
    const v = view(true);
    expect(v.placeholderLogTypes).toEqual([]);
    expect(v.unreachableLogTypes).toEqual([]);
  });
})

/**
 * Suggested filters must reach the operator, or the derivation's work is done
 * and then thrown away - which is the failure "suggest instead of apply" was
 * chosen to avoid.
 */
describe("derivePipelinePreview - suggested route filters", () => {
  function view(eventsPerType: number) {
    const vals = (v: string) => ({
      eventCount: eventsPerType,
      values: { act: Array.from({ length: eventsPerType }, () => v) },
    });
    return derivePipelinePreview({
      solutionName: "Vendor",
      packName: "vendor-sentinel",
      reports: [
        report({ logType: "firewall", routeCondition: "true" }),
        report({ logType: "dns", routeCondition: "true" }),
      ],
      sampleFormats: { firewall: "cef", dns: "cef" },
      sampleFieldValues: { firewall: vals("Allow"), dns: vals("Query") },
      approved: true,
    });
  }

  it("offers the filter it declined to apply on a thin corpus", () => {
    const v = view(2);
    expect(v.placeholderLogTypes.sort()).toEqual(["dns", "firewall"]);
    const firewall = v.routeFilterSuggestions.find((s) => s.logType === "firewall");
    expect(firewall?.filter).toContain("act === 'Allow'");
  });

  it("offers NOTHING once the filters are actually applied", () => {
    // Suggesting a filter that is already in force would read as outstanding
    // work that does not exist.
    const v = view(3);
    expect(v.placeholderLogTypes).toEqual([]);
    expect(v.routeFilterSuggestions).toEqual([]);
  });

  it("suggests per log type, each with its OWN value", () => {
    const v = view(2);
    const byType = Object.fromEntries(
      v.routeFilterSuggestions.map((s) => [s.logType, s.filter]),
    );
    expect(byType.firewall).toContain("Allow");
    expect(byType.firewall).not.toContain("Query");
    expect(byType.dns).toContain("Query");
  });
})

/**
 * Accepting a suggestion is the operator supplying the judgement the sample
 * corpus could not. The threshold stays where it is - the app still never
 * applies thin evidence on its own - so acceptance is the ONLY path from a
 * suggested filter to a shipped one, and every step of that path is pinned
 * here. The failure this guards is silent: a filter shown, accepted, and then
 * dropped somewhere between the preview and route.yml would look exactly like
 * a filter that was never accepted.
 */
describe("derivePipelinePreview - accepted route filters", () => {
  const vals = (v: string) => ({
    eventCount: 2,
    values: { act: Array.from({ length: 2 }, () => v) },
  });
  function view(routeFilterOverrides?: Readonly<Record<string, string>>) {
    return derivePipelinePreview({
      solutionName: "Vendor",
      packName: "vendor-sentinel",
      reports: [
        report({ logType: "firewall", routeCondition: "true" }),
        report({ logType: "dns", routeCondition: "true" }),
      ],
      sampleFormats: { firewall: "cef", dns: "cef" },
      sampleFieldValues: { firewall: vals("Allow"), dns: vals("Query") },
      ...(routeFilterOverrides !== undefined ? { routeFilterOverrides } : {}),
      approved: true,
    });
  }

  it("writes the accepted filter into the emitted route.yml", () => {
    // The whole point. Without this the Accept button is decoration - the
    // operator would see it applied on screen and get __UNSET__ in the pack.
    const accepted = "act === 'Allow'";
    const v = view({ firewall: accepted });
    expect(v.routeYml).toContain(`filter: "${accepted}"`);
    expect(v.routeYml).not.toContain("__UNSET__ === \"firewall\"");
  });

  it("takes the accepted log type out of the placeholder and suggestion lists", () => {
    // Both lists are calls to ACTION. Leaving a log type in either after its
    // filter is in force reads as work still outstanding.
    const v = view({ firewall: "act === 'Allow'" });
    expect(v.placeholderLogTypes).toEqual(["dns"]);
    expect(v.routeFilterSuggestions.map((s) => s.logType)).toEqual(["dns"]);
  });

  it("leaves every OTHER log type exactly as it was", () => {
    // Accepting one filter silently rerouting a sibling is the failure that
    // would be hardest to see - the pack builds, the YAML validates, and the
    // wrong events land in the wrong table.
    const before = view();
    const after = view({ firewall: "act === 'Allow'" });
    const dnsBefore = before.tables.find((t) => t.logType === "dns");
    const dnsAfter = after.tables.find((t) => t.logType === "dns");
    expect(dnsAfter?.routeCondition).toBe(dnsBefore?.routeCondition);
    expect(dnsAfter?.routeCondition).toContain("__UNSET__");
  });

  it("applies the operator's filter verbatim, not a re-derived one", () => {
    // The operator may accept a suggestion and then hand-correct it. Whatever
    // reaches this input is what ships; the planner must not "improve" it.
    const handWritten = "act.startsWith('Allo') && src != null";
    const v = view({ firewall: handWritten });
    const firewall = v.tables.find((t) => t.logType === "firewall");
    expect(firewall?.routeCondition).toBe(handWritten);
  });

  it("keeps the pack valid, so an accepted filter can actually be built", () => {
    // A filter that breaks route.yml validation would block the build entirely,
    // which is a worse outcome than the placeholder it replaced.
    const v = view({ firewall: "act === 'Allow'" });
    expect(v.valid).toBe(true);
    expect(v.routeYmlIssues).toEqual([]);
  });

  it("ignores an override for a log type that is not in the plan", () => {
    // Overrides outlive solution changes. One naming a log type this plan does
    // not have must not invent a route or throw.
    const v = view({ nonexistent: "act === 'Nope'" });
    expect(v.routeYml).not.toContain("Nope");
    expect(v.placeholderLogTypes.sort()).toEqual(["dns", "firewall"]);
  });
})
