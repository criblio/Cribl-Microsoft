/**
 * Pins for the SIEM Migration domain (porting-plan Unit 26): the ported
 * parsers and plan assembly against the behaviors the legacy regression
 * suite characterized (RFC-4180 CSV, macro filtering, datamodel collapsing,
 * same-solution merging) plus the Unit-26 decisions (the ONE
 * normalizeSourceKey fix, the persisted rawSearch cap, pure fuzzy mapping,
 * injected report date).
 */

import { describe, expect, it } from "vitest";
import {
  MIGRATION_RAW_SEARCH_CAP,
  applyFuzzySolutionMap,
  assembleMigrationPlan,
  buildMitreCoverage,
  detectSiemPlatform,
  enrichPlanWithAnalyticRules,
  generateMigrationReport,
  identifyDataSources,
  migrationReportFileName,
  normalizeSourceKey,
  parseMigrationPlan,
  parseQRadarExport,
  parseRfc4180Csv,
  parseSplunkExport,
  serializeMigrationPlan,
} from "./index";
import type { ParsedRule } from "./index";

function splunkExport(rules: Array<Record<string, unknown>>): string {
  return JSON.stringify({ result: { alertrules: rules } });
}

describe("parseRfc4180Csv", () => {
  it("handles quoted multi-line fields, escaped quotes, and CRLF", () => {
    const csv = 'a,b\r\n"line1\nline2","say ""hi"""\r\nplain,row\n';
    expect(parseRfc4180Csv(csv)).toEqual([
      ["a", "b"],
      ['line1\nline2', 'say "hi"'],
      ["plain", "row"],
    ]);
  });
});

describe("parseSplunkExport", () => {
  it("extracts macros (skipping internal/filter macros) and severity", () => {
    const rules = parseSplunkExport(
      splunkExport([
        {
          title: "Suspicious PowerShell",
          search:
            "`powershell` `security_content_summariesonly` `something_filter` | stats count",
          "alert.severity": 3,
        },
      ]),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].macros).toEqual(["powershell"]);
    expect(rules[0].dataSources).toEqual(["powershell"]);
    expect(rules[0].severity).toBe("High");
  });

  it("collapses sub-datamodels and prefers macros over datamodels", () => {
    const [dmOnly] = parseSplunkExport(
      splunkExport([
        { title: "dm", search: "| tstats count from datamodel=Endpoint.Processes" },
      ]),
    );
    expect(dmOnly.dataModels).toEqual(["Endpoint.Processes"]);
    expect(dmOnly.dataSources).toEqual(["Endpoint"]);

    const [both] = parseSplunkExport(
      splunkExport([
        {
          title: "both",
          search: "`okta` | tstats count from datamodel=Endpoint.Processes",
        },
      ]),
    );
    // Macro wins; the abstract datamodel is redundant.
    expect(both.dataSources).toEqual(["okta"]);
  });

  it("extracts sourcetypes and accepts the three export shapes", () => {
    const [rule] = parseSplunkExport(
      splunkExport([{ title: "st", search: 'index=x sourcetype="cisco:asa"' }]),
    );
    expect(rule.sourcetypes).toEqual(["cisco:asa"]);
    expect(
      parseSplunkExport(JSON.stringify({ alertrules: [{ title: "a", search: "" }] })),
    ).toHaveLength(1);
    expect(
      parseSplunkExport(JSON.stringify([{ title: "b", search: "" }])),
    ).toHaveLength(1);
  });
});

const QRADAR_HEADER =
  "Rule name,Type,Rule enabled,Is rule,Notes,High-level.low-level category,Event name,Event description,Test definition,Tactic,Technique,Sub-technique,Content extension name,Content category";

describe("parseQRadarExport", () => {
  it("maps content extensions to solutions and flags building blocks", () => {
    const csv = [
      QRADAR_HEADER,
      'Endpoint rule,EVENT,TRUE,TRUE,,Audit.Login,,desc,"when the event",Defense Evasion,T1070,,IBM QRadar Endpoint Content Extension,Endpoint',
      "BB helper,EVENT,TRUE,FALSE,,,,,,,,,IBM QRadar Endpoint Content Extension,Endpoint",
      "Unknown ext,EVENT,TRUE,TRUE,,,,,,,,,Some Future Extension,Misc",
    ].join("\n");
    const rules = parseQRadarExport(csv);
    expect(rules).toHaveLength(3);
    expect(rules[0].dataSources).toEqual(["Windows Security Events"]);
    expect(rules[0].mitreTactics).toEqual(["Defense Evasion"]);
    expect(rules[0].isRule).toBe(true);
    expect(rules[1].isRule).toBe(false);
    expect(rules[2].dataSources).toEqual(["extension:Some Future Extension"]);
  });
});

describe("identifyDataSources", () => {
  it("merges sources resolving to the same solution into one entry", () => {
    const rules = parseSplunkExport(
      splunkExport([
        { title: "r1", search: "`kube_audit` | stats count" },
        { title: "r2", search: "`kube_container_falco` | stats count" },
      ]),
    );
    const sources = identifyDataSources(rules, "splunk");
    expect(sources).toHaveLength(1);
    expect(sources[0].sentinelSolution).toBe("Azure Kubernetes Service");
    expect(sources[0].sentinelTable).toBe("ContainerLog");
    expect(sources[0].platformIdentifiers.sort()).toEqual([
      "kube_audit",
      "kube_container_falco",
    ]);
    expect(sources[0].ruleCount).toBe(2);
    // kube_audit is a direct map (high); the merge keeps the highest.
    expect(sources[0].confidence).toBe("high");
  });

  it("recovers the QRadar table via reverse lookup (no fuzzy tier needed)", () => {
    const rules = parseQRadarExport(
      [
        QRADAR_HEADER,
        "R,EVENT,TRUE,TRUE,,,,,,,,,IBM QRadar DNS Analyzer,DNS",
      ].join("\n"),
    );
    const [source] = identifyDataSources(rules, "qradar");
    expect(source.sentinelSolution).toBe("DNS");
    expect(source.sentinelTable).toBe("DnsEvents");
    expect(source.confidence).toBe("high");
  });
});

describe("applyFuzzySolutionMap", () => {
  it("maps unmapped sources by tier and never mutates the input", () => {
    const base = identifyDataSources(
      parseSplunkExport(
        splunkExport([{ title: "r", search: "`salesforce` | stats count" }]),
      ),
      "splunk",
    );
    expect(base[0].confidence).toBe("none");
    const mapped = applyFuzzySolutionMap(base, ["Salesforce Service Cloud"]);
    expect(mapped[0].sentinelSolution).toBe("Salesforce Service Cloud");
    expect(mapped[0].confidence).toBe("medium");
    // Purity: the input entry is untouched.
    expect(base[0].sentinelSolution).toBe("");
    expect(base[0].confidence).toBe("none");
  });
});

describe("assembleMigrationPlan", () => {
  it("counts rules/building blocks and caps persisted rawSearch excerpts", () => {
    const longSearch = "`nonexistent_source_xyz` " + "x".repeat(1000);
    const rules: ParsedRule[] = parseSplunkExport(
      splunkExport([
        { title: "mapped", search: "`okta` | stats count" },
        { title: "unmapped", search: longSearch },
      ]),
    );
    const plan = assembleMigrationPlan({
      rules,
      platform: "splunk",
      fileName: "export.json",
    });
    expect(plan.totalRules).toBe(2);
    expect(plan.enabledRules).toBe(2);
    expect(plan.buildingBlocks).toBe(0);
    expect(plan.unmappedRules.map((r) => r.name)).toEqual(["unmapped"]);
    expect(plan.unmappedRules[0].rawSearch.length).toBeLessThanOrEqual(
      MIGRATION_RAW_SEARCH_CAP + 3,
    );
    expect(plan.totalSentinelRules).toBe(0);
  });

  it("THE NORMALIZATION FIX: a fuzzy-mapped dotted source no longer inflates unmappedRules", () => {
    // Legacy bug: identify keyed with [^a-z0-9.] but the unmapped check used
    // [^a-z0-9], so a dotted identifier never matched its own key.
    expect(normalizeSourceKey("Win.Security")).toBe("win.security");
    const rule: ParsedRule = {
      name: "dotted",
      platform: "splunk",
      enabled: true,
      dataSources: ["win.security"],
      macros: [],
      dataModels: [],
      sourcetypes: ["win.security"],
      contentExtension: "",
      eventCategories: [],
      mitreTactics: [],
      mitreTechniques: [],
      severity: "Unknown",
      description: "",
      rawSearch: "",
      isRule: true,
    };
    const plan = assembleMigrationPlan({
      rules: [rule],
      platform: "splunk",
      fileName: "x.json",
      solutionNames: ["Win Security"],
    });
    expect(plan.dataSources[0].sentinelSolution).toBe("Win Security");
    expect(plan.unmappedRules).toEqual([]);
  });
});

describe("buildMitreCoverage / enrichment", () => {
  it("rolls up tactics with technique and rule counts", () => {
    const rules = parseQRadarExport(
      [
        QRADAR_HEADER,
        "R1,EVENT,TRUE,TRUE,,,,,,Defense Evasion,T1070,,IBM QRadar DNS Analyzer,DNS",
        "R2,EVENT,TRUE,TRUE,,,,,,Defense Evasion,T1027,,IBM QRadar DNS Analyzer,DNS",
      ].join("\n"),
    );
    expect(buildMitreCoverage(rules)).toEqual([
      { tactic: "Defense Evasion", techniqueCount: 2, ruleCount: 2 },
    ]);
  });

  it("counts each solution's rules once across merged data sources", () => {
    const plan = assembleMigrationPlan({
      rules: parseSplunkExport(
        splunkExport([{ title: "r", search: "`okta` | stats count" }]),
      ),
      platform: "splunk",
      fileName: "x.json",
    });
    const enriched = enrichPlanWithAnalyticRules(
      plan,
      new Map([
        [
          "okta single sign-on",
          [{ name: "Rule A", severity: "High", tactics: [], query: "kql" }],
        ],
      ]),
    );
    expect(enriched.totalSentinelRules).toBe(1);
    expect(enriched.dataSources[0].sentinelAnalyticRules).toHaveLength(1);
  });
});

describe("detectSiemPlatform", () => {
  it("pins the legacy extension rule and adds content sniffing", () => {
    expect(detectSiemPlatform("rules.csv", "")).toBe("qradar");
    expect(detectSiemPlatform("rules.json", "")).toBe("splunk");
    expect(detectSiemPlatform("export.txt", '{"result":{}}')).toBe("splunk");
    expect(detectSiemPlatform("export.txt", `${QRADAR_HEADER}\nR,`)).toBe("qradar");
    expect(detectSiemPlatform("export.txt", "who knows")).toBe("splunk");
  });
});

describe("plan persistence codec", () => {
  it("round-trips a plan and reads junk as null", () => {
    const plan = assembleMigrationPlan({
      rules: [],
      platform: "qradar",
      fileName: "rules.csv",
    });
    expect(parseMigrationPlan(serializeMigrationPlan(plan))).toEqual(plan);
    expect(parseMigrationPlan(null)).toBeNull();
    expect(parseMigrationPlan("")).toBeNull();
    expect(parseMigrationPlan("not json")).toBeNull();
    expect(parseMigrationPlan('{"platform":"other"}')).toBeNull();
  });
});

describe("generateMigrationReport", () => {
  it("renders the injected date, the stats, and escapes HTML", () => {
    const plan = assembleMigrationPlan({
      rules: parseSplunkExport(
        splunkExport([{ title: "<b>xss</b>", search: "`nonexistent_thing_abc`" }]),
      ),
      platform: "splunk",
      fileName: "<export>.json",
    });
    const html = generateMigrationReport(plan, "2026-07-14T12:00:00Z");
    expect(html).toContain("Generated: <strong>2026-07-14</strong>");
    expect(html).toContain("&lt;export&gt;.json");
    expect(html).toContain("&lt;b&gt;xss&lt;/b&gt;");
    expect(html).not.toContain("<b>xss</b>");
    expect(migrationReportFileName(plan, "2026-07-14T12:00:00Z")).toBe(
      "siem-migration-report-splunk-2026-07-14.html",
    );
  });
});
