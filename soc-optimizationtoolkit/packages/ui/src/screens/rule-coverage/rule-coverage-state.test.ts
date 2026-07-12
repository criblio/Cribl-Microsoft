/**
 * Tests for the rule + workbook coverage PURE projection (porting-plan Unit
 * 23). The analyzer's truth (three-way classification, frequency ranking, the
 * ruleReferencedFields contract) is pinned in @soc/core's coverage-analysis
 * tests; these pin the BINDING layer the panel adds: the coverage-input
 * derivation from the Gap reports, the custom-YAML upload projection, the
 * two-source panel projection (rule section + workbook section from one
 * report), the three-way counts, the legacy count-chip / summary vocabulary,
 * and the RULE-badge field set. One end-to-end case runs the REAL analyzer so
 * the projection is exercised over an actual CoverageReport.
 */

import { describe, expect, it } from "vitest";
import { analyzeContentCoverage } from "@soc/core";
import type {
  ContentItem,
  CoverageSummary,
  GapFieldMapping,
  GapReport,
  ItemCoverage,
} from "@soc/core";
import {
  ANALYTIC_RULE_DIR_VARIANTS,
  availableFieldsFromReports,
  contentTypeNoun,
  coverageCountChips,
  coveragePercent,
  coverageSummaryLine,
  coverageTone,
  customRuleCount,
  deriveCoverageItemView,
  deriveCoverageSection,
  deriveThreeWayCounts,
  destinationTableNamesFromReports,
  isRuleYamlFileName,
  missingFieldChips,
  parseCustomRuleUploads,
  ruleFieldSet,
  severityTone,
} from "./rule-coverage-state";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function mapping(over: Partial<GapFieldMapping> & Pick<GapFieldMapping, "source" | "dest" | "action">): GapFieldMapping {
  return {
    source: over.source,
    dest: over.dest,
    action: over.action,
    sourceType: over.sourceType ?? "string",
    destType: over.destType ?? "string",
    confidence: over.confidence ?? "exact",
    needsCoercion: over.needsCoercion ?? false,
    description: over.description ?? "",
  };
}

function gapReport(over: Partial<GapReport> & Pick<GapReport, "tableName" | "fieldMappings">): GapReport {
  return {
    tableName: over.tableName,
    logType: over.logType ?? over.tableName,
    stats: over.stats ?? [],
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
    dcrHandlesSummary: "",
    criblHandlesSummary: "",
    routeCondition: "true",
    fieldMappings: over.fieldMappings,
    destSchema: over.destSchema ?? [],
    overflowLossy: false,
    warnings: [],
  };
}

function itemCoverage(over: Partial<ItemCoverage> & Pick<ItemCoverage, "id" | "name" | "coverage">): ItemCoverage {
  return {
    type: over.type ?? "alert-rule",
    id: over.id,
    name: over.name,
    custom: over.custom ?? false,
    severity: over.severity ?? "Unknown",
    tactics: over.tactics ?? [],
    referencedFields: over.referencedFields ?? [],
    covered: over.covered ?? [],
    missingFromReducedSchema: over.missingFromReducedSchema ?? [],
    unknown: over.unknown ?? [],
    coverage: over.coverage,
    queries: over.queries ?? [],
    unparseableQueryCount: over.unparseableQueryCount ?? 0,
  };
}

function summary(over: Partial<CoverageSummary> = {}): CoverageSummary {
  return {
    totalItems: over.totalItems ?? 0,
    fullyCovered: over.fullyCovered ?? 0,
    partiallyCovered: over.partiallyCovered ?? 0,
    missingFieldsAcrossRules: over.missingFieldsAcrossRules ?? [],
    ruleReferencedFields: over.ruleReferencedFields ?? [],
    unparseableQueryCount: over.unparseableQueryCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Rule acquisition surface
// ---------------------------------------------------------------------------

describe("rule-acquisition surface", () => {
  it("probes the three dir-name variants in the legacy order", () => {
    expect(ANALYTIC_RULE_DIR_VARIANTS).toEqual([
      "Analytic Rules",
      "Analytics Rules",
      "AnalyticRules",
    ]);
  });

  it("recognises .yaml and .yml (case-insensitively), rejects others", () => {
    expect(isRuleYamlFileName("Rule.yaml")).toBe(true);
    expect(isRuleYamlFileName("Rule.YML")).toBe(true);
    expect(isRuleYamlFileName("rule.yml")).toBe(true);
    expect(isRuleYamlFileName("Rule.json")).toBe(false);
    expect(isRuleYamlFileName("README.md")).toBe(false);
    expect(isRuleYamlFileName("yaml")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Coverage-input derivation from the Gap reports
// ---------------------------------------------------------------------------

describe("availableFieldsFromReports", () => {
  it("keeps destination columns, drops 'drop', and adds both dest+source for 'overflow'", () => {
    const reports = [
      gapReport({
        tableName: "CommonSecurityLog",
        fieldMappings: [
          mapping({ source: "src", dest: "SourceIP", action: "keep" }),
          mapping({ source: "user", dest: "UserName", action: "rename" }),
          mapping({ source: "junk", dest: "AdditionalExtensions", action: "overflow" }),
          mapping({ source: "secret", dest: "Ignored", action: "drop" }),
        ],
      }),
    ];
    expect(availableFieldsFromReports(reports)).toEqual([
      "AdditionalExtensions",
      "SourceIP",
      "UserName",
      "junk",
    ]);
  });

  it("de-duplicates across reports and is empty for no reports", () => {
    const reports = [
      gapReport({ tableName: "T1", fieldMappings: [mapping({ source: "a", dest: "X", action: "keep" })] }),
      gapReport({ tableName: "T2", fieldMappings: [mapping({ source: "b", dest: "X", action: "keep" })] }),
    ];
    expect(availableFieldsFromReports(reports)).toEqual(["X"]);
    expect(availableFieldsFromReports([])).toEqual([]);
  });
});

describe("destinationTableNamesFromReports", () => {
  it("returns the distinct table names, sorted", () => {
    const reports = [
      gapReport({ tableName: "Syslog", fieldMappings: [] }),
      gapReport({ tableName: "CommonSecurityLog", fieldMappings: [] }),
      gapReport({ tableName: "Syslog", fieldMappings: [] }),
    ];
    expect(destinationTableNamesFromReports(reports)).toEqual([
      "CommonSecurityLog",
      "Syslog",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Custom-YAML upload projection
// ---------------------------------------------------------------------------

describe("parseCustomRuleUploads", () => {
  it("parses YAML into custom-flagged ContentItems and PRESERVES the query", () => {
    const yaml = [
      "id: 1111",
      "name: My Custom Rule",
      "severity: High",
      "query: |",
      "  SecurityEvent",
      "  | where TargetUserName == 'x'",
      "moreKeys: stop",
    ].join("\n");
    const items = parseCustomRuleUploads([{ fileName: "custom.yaml", content: yaml }]);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.type).toBe("alert-rule");
    expect(item.name).toBe("My Custom Rule");
    expect(item.custom).toBe(true);
    expect(item.severity).toBe("High");
    // The query is preserved (the legacy custom path dropped it).
    expect(item.queries.length).toBe(1);
    expect(item.queries[0]).toContain("SecurityEvent");
    expect(item.queries[0]).toContain("TargetUserName");
  });

  it("customRuleCount reports the list length", () => {
    const items: ContentItem[] = [
      { type: "alert-rule", id: "a", name: "a", queries: [] },
      { type: "alert-rule", id: "b", name: "b", queries: [] },
    ];
    expect(customRuleCount(items)).toBe(2);
    expect(customRuleCount([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The RULE-badge field set
// ---------------------------------------------------------------------------

describe("ruleFieldSet", () => {
  it("lowercases the schema-resolvable referenced fields for the case-insensitive badge lookup", () => {
    const set = ruleFieldSet(summary({ ruleReferencedFields: ["SourceIP", "TargetUserName"] }));
    expect(set.has("sourceip")).toBe(true);
    expect(set.has("targetusername")).toBe(true);
    // original casing is NOT what the lookup uses
    expect(set.has("SourceIP")).toBe(false);
    expect(set.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Three-way counts
// ---------------------------------------------------------------------------

describe("deriveThreeWayCounts", () => {
  it("splits fully (===1) / partial (0<c<1) / no-coverage (===0)", () => {
    const items = [
      itemCoverage({ id: "1", name: "full", coverage: 1 }),
      itemCoverage({ id: "2", name: "part", coverage: 0.5 }),
      itemCoverage({ id: "3", name: "none", coverage: 0 }),
      itemCoverage({ id: "4", name: "full2", coverage: 1 }),
    ];
    expect(deriveThreeWayCounts(items)).toEqual({
      total: 4,
      fullyCovered: 2,
      partiallyCovered: 1,
      noCoverage: 1,
    });
  });

  it("is all-zero for an empty list", () => {
    expect(deriveThreeWayCounts([])).toEqual({
      total: 0,
      fullyCovered: 0,
      partiallyCovered: 0,
      noCoverage: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Tone / percent helpers
// ---------------------------------------------------------------------------

describe("severityTone / coveragePercent / coverageTone", () => {
  it("maps severities exactly, else unknown", () => {
    expect(severityTone("High")).toBe("high");
    expect(severityTone("Medium")).toBe("medium");
    expect(severityTone("Low")).toBe("low");
    expect(severityTone("Informational")).toBe("unknown");
    expect(severityTone("")).toBe("unknown");
  });

  it("rounds coverage to a whole percent", () => {
    expect(coveragePercent(1)).toBe(100);
    expect(coveragePercent(0)).toBe(0);
    expect(coveragePercent(0.666)).toBe(67);
  });

  it("tones coverage on the legacy thresholds", () => {
    expect(coverageTone(1)).toBe("ok");
    expect(coverageTone(0.75)).toBe("warn");
    expect(coverageTone(0.5)).toBe("error");
    expect(coverageTone(0)).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Count chips + summary line (legacy vocabulary)
// ---------------------------------------------------------------------------

describe("coverageCountChips", () => {
  it("emits fully + total always, partial/no-coverage only when > 0, in legacy order", () => {
    const chips = coverageCountChips("alert-rule", {
      total: 5,
      fullyCovered: 2,
      partiallyCovered: 2,
      noCoverage: 1,
    });
    expect(chips).toEqual([
      { tone: "ok", text: "2 fully covered" },
      { tone: "warn", text: "2 partial" },
      { tone: "error", text: "1 no coverage" },
      { tone: "muted", text: "5 total rules" },
    ]);
  });

  it("omits partial and no-coverage chips at zero and singularizes the total", () => {
    const chips = coverageCountChips("alert-rule", {
      total: 1,
      fullyCovered: 1,
      partiallyCovered: 0,
      noCoverage: 0,
    });
    expect(chips).toEqual([
      { tone: "ok", text: "1 fully covered" },
      { tone: "muted", text: "1 total rule" },
    ]);
  });

  it("uses the workbook noun for the workbook section", () => {
    const chips = coverageCountChips("workbook", {
      total: 3,
      fullyCovered: 3,
      partiallyCovered: 0,
      noCoverage: 0,
    });
    expect(chips[chips.length - 1]).toEqual({ tone: "muted", text: "3 total workbooks" });
    expect(contentTypeNoun("workbook")).toBe("workbook");
    expect(contentTypeNoun("alert-rule")).toBe("rule");
  });
});

describe("coverageSummaryLine", () => {
  it("uses the VERBATIM legacy rule vocabulary across its three branches", () => {
    expect(
      coverageSummaryLine("alert-rule", { total: 0, fullyCovered: 0, partiallyCovered: 0, noCoverage: 0 }, 0),
    ).toBe(
      "No analytics rules found in the Sentinel repository for this solution. You can upload custom rules below to validate field coverage.",
    );
    expect(
      coverageSummaryLine("alert-rule", { total: 3, fullyCovered: 3, partiallyCovered: 0, noCoverage: 0 }, 0),
    ).toBe("All analytics rules have the fields they need from your sample data.");
    expect(
      coverageSummaryLine("alert-rule", { total: 3, fullyCovered: 1, partiallyCovered: 1, noCoverage: 1 }, 4),
    ).toBe(
      "4 field(s) referenced by detection rules are not present in your sample data. Missing fields may prevent rules from firing.",
    );
  });

  it("uses distinct workbook copy for the workbook section", () => {
    expect(
      coverageSummaryLine("workbook", { total: 0, fullyCovered: 0, partiallyCovered: 0, noCoverage: 0 }, 0),
    ).toContain("No workbooks found");
    expect(
      coverageSummaryLine("workbook", { total: 2, fullyCovered: 1, partiallyCovered: 0, noCoverage: 1 }, 3),
    ).toContain("referenced by workbooks");
  });
});

// ---------------------------------------------------------------------------
// Missing-field chips
// ---------------------------------------------------------------------------

describe("missingFieldChips", () => {
  it("returns the analyzer's frequency-ranked list unchanged by default", () => {
    const s = summary({ missingFieldsAcrossRules: ["TargetUserName", "SourceIP", "DeviceName"] });
    expect(missingFieldChips(s)).toEqual(["TargetUserName", "SourceIP", "DeviceName"]);
  });

  it("caps to the limit when a positive one is given", () => {
    const s = summary({ missingFieldsAcrossRules: ["a", "b", "c", "d"] });
    expect(missingFieldChips(s, 2)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Per-item + per-section projection
// ---------------------------------------------------------------------------

describe("deriveCoverageItemView", () => {
  it("projects an item, falling back to name when id is empty", () => {
    const view = deriveCoverageItemView(
      itemCoverage({
        id: "",
        name: "Named Rule",
        coverage: 0.5,
        severity: "Medium",
        custom: true,
        covered: ["SourceIP"],
        missingFromReducedSchema: ["TargetUserName"],
        unknown: ["ComputedVar"],
        queries: ["SecurityEvent | where SourceIP == '1'"],
      }),
    );
    expect(view.key).toBe("Named Rule");
    expect(view.custom).toBe(true);
    expect(view.severityTone).toBe("medium");
    expect(view.coveragePercent).toBe(50);
    expect(view.coverageTone).toBe("error");
    expect(view.missing).toEqual(["TargetUserName"]);
    expect(view.missingCount).toBe(1);
    expect(view.unknown).toEqual(["ComputedVar"]);
  });
});

describe("deriveCoverageSection", () => {
  it("partitions the report by content type - two sources, one report", () => {
    const report = {
      items: [
        itemCoverage({ id: "r1", name: "Rule 1", type: "alert-rule", coverage: 1 }),
        itemCoverage({ id: "r2", name: "Rule 2", type: "alert-rule", coverage: 0 }),
        itemCoverage({ id: "w1", name: "Workbook 1", type: "workbook", coverage: 0.5, unparseableQueryCount: 2 }),
      ],
      summary: summary({ totalItems: 3 }),
    };

    const rules = deriveCoverageSection(report, "alert-rule");
    expect(rules.items.map((i) => i.name)).toEqual(["Rule 1", "Rule 2"]);
    expect(rules.counts).toEqual({ total: 2, fullyCovered: 1, partiallyCovered: 0, noCoverage: 1 });
    expect(rules.unparseableQueryCount).toBe(0);

    const workbooks = deriveCoverageSection(report, "workbook");
    expect(workbooks.items.map((i) => i.name)).toEqual(["Workbook 1"]);
    expect(workbooks.counts).toEqual({ total: 1, fullyCovered: 0, partiallyCovered: 1, noCoverage: 0 });
    expect(workbooks.unparseableQueryCount).toBe(2);
    expect(workbooks.summaryLine).toContain("referenced by workbooks");
  });
});

// ---------------------------------------------------------------------------
// End-to-end over the REAL analyzer (both sources through one engine)
// ---------------------------------------------------------------------------

describe("end-to-end over the real analyzer", () => {
  it("projects a rule + a workbook analyzed together into two sections and a badge set", () => {
    const items: ContentItem[] = [
      {
        type: "alert-rule",
        id: "rule-a",
        name: "Rule A",
        severity: "High",
        queries: ["SecurityEvent | where SourceIP == '1' | where TargetUserName == 'x'"],
      },
      {
        type: "workbook",
        id: "/subscriptions/s/workbooks/wb-1",
        name: "Workbook One",
        queries: ["CommonSecurityLog | where DeviceName == 'h'"],
        unparseableQueryCount: 1,
      },
    ];
    const report = analyzeContentCoverage({
      items,
      availableFields: ["SourceIP"],
      schemaUnion: ["SourceIP", "TargetUserName", "DeviceName"],
    });

    const rules = deriveCoverageSection(report, "alert-rule");
    const workbooks = deriveCoverageSection(report, "workbook");
    // AUDIT FIX 2026-07-12: each section counts ITS OWN missing fields; the
    // workbook line no longer reports the rules+workbooks combined number.
    // Rules miss TargetUserName (1); workbooks miss DeviceName (1) - each
    // line says 1, not the combined 2.
    expect(rules.summaryLine).toContain("1 field(s)");
    expect(workbooks.summaryLine).toContain("1 field(s)");

    expect(rules.counts.total).toBe(1);
    expect(workbooks.counts.total).toBe(1);
    expect(workbooks.unparseableQueryCount).toBe(1);

    // The badge set is lowercased and covers the schema-resolvable referenced
    // fields from BOTH sources (the kept Unit 18 contract).
    const badges = ruleFieldSet(report.summary);
    expect(badges.has("sourceip")).toBe(true);
    expect(badges.has("targetusername")).toBe(true);
    expect(badges.has("devicename")).toBe(true);

    // Missing chips are frequency-ranked real columns (never unknowns).
    for (const chip of missingFieldChips(report.summary)) {
      expect(["TargetUserName", "DeviceName"]).toContain(chip);
    }
  });
});
