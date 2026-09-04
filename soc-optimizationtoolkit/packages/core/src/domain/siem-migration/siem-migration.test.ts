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
  QRADAR_EXTENSION_MAP,
  SOLUTIONS_WITHOUT_SENTINEL_FOLDER,
  SPLUNK_DATAMODEL_MAP,
  SPLUNK_MACRO_MAP,
  SPLUNK_PREFIX_MAP,
  applyFuzzySolutionMap,
  assembleMigrationPlan,
  buildMitreCoverage,
  detectSiemPlatform,
  enrichPlanWithAnalyticRules,
  generateMigrationReport,
  hasSentinelSolutionFolder,
  identifyDataSources,
  migrationReportFileName,
  normalizeSourceKey,
  parseMigrationPlan,
  parseQRadarExport,
  parseRfc4180Csv,
  parseSplunkExport,
  resolveSplunkMacro,
  serializeMigrationPlan,
} from "./index";
import type { ParsedRule, SolutionTableTarget } from "./index";
import solutionDirectories from "./solution-directories.fixture.json";
import { lookupSolutionIngestion } from "../sentinel-content/ingestion-classification";
import { detectVendorIdentity } from "../vendor-identity/vendor-identity";

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
    // DBT-104: was "DNS", a name no Solutions/ directory carries. Windows
    // Server DNS is the one that declares DnsEvents.
    expect(source.sentinelSolution).toBe("Windows Server DNS");
    expect(source.sentinelTable).toBe("DnsEvents");
    expect(source.confidence).toBe("high");
  });
});

/**
 * Every {key -> target} pair across the four knowledge bases, flattened once
 * so the shape pins below cannot miss a map somebody adds an entry to.
 */
const KB_ENTRIES: ReadonlyArray<{
  map: string;
  key: string;
  target: SolutionTableTarget;
}> = [
  ...Object.entries(SPLUNK_MACRO_MAP).map(([key, target]) => ({
    map: "SPLUNK_MACRO_MAP",
    key,
    target,
  })),
  ...Object.entries(SPLUNK_DATAMODEL_MAP).map(([key, target]) => ({
    map: "SPLUNK_DATAMODEL_MAP",
    key,
    target,
  })),
  ...Object.entries(QRADAR_EXTENSION_MAP).map(([key, target]) => ({
    map: "QRADAR_EXTENSION_MAP",
    key,
    target,
  })),
  ...SPLUNK_PREFIX_MAP.map(({ prefix, solution, table }) => ({
    map: "SPLUNK_PREFIX_MAP",
    key: prefix,
    target: { solution, table },
  })),
];

/**
 * The set the pivot actually resolves against - every directory under
 * `Solutions/` - and the ladder it walks: exact, then case-insensitive, then
 * separator-insensitive (resolveSelectedSolution, browser-state.ts).
 *
 * THE LADDER IS RESTATED HERE, NOT IMPORTED, and that is a real seam: core
 * cannot import ui. So these pins hold WHICH RUNG each knowledge-base name
 * needs; that the product still OFFERS the rung is browser-state.test.ts's
 * job. Neither half claims the other's - if the third rung is ever removed
 * from the product, it is that suite which must fail, and this one that says
 * which two names would fall over when it does.
 */
const SOLUTION_DIRECTORIES: readonly string[] = solutionDirectories.directories;

/** The one separator-collapsing rule, matching ui's collapseForSearch. */
function collapseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

type ResolutionRung =
  | "exact"
  | "case-insensitive"
  | "separator-insensitive"
  | "none";

/** The rung a solution NAME lands on against the directory list, or "none". */
function resolutionRung(name: string): ResolutionRung {
  if (SOLUTION_DIRECTORIES.includes(name)) {
    return "exact";
  }
  const lower = name.toLowerCase();
  if (SOLUTION_DIRECTORIES.some((d) => d.toLowerCase() === lower)) {
    return "case-insensitive";
  }
  const collapsed = collapseName(name);
  if (
    collapsed !== "" &&
    SOLUTION_DIRECTORIES.some((d) => collapseName(d) === collapsed)
  ) {
    return "separator-insensitive";
  }
  return "none";
}

describe("DBT-103: an identifier must not resolve to another vendor's solution", () => {
  it("resolves every f5_ macro AND sourcetype to the F5 solution", () => {
    // The prefix map is the ONLY f5 knowledge in the base - one rule catching
    // every f5_ identifier - so pinning one name would pin the lot. These are
    // pinned anyway because the card names a sourcetype and a macro, and the
    // Splunk parser feeds BOTH through resolveSplunkMacro.
    for (const id of ["f5_bigip", "f5_bigip_asm", "f5_asm_syslog", "f5_ltm"]) {
      expect(resolveSplunkMacro(id)).toEqual({
        solution: "F5 Networks",
        table: "CommonSecurityLog",
      });
    }
  });

  it("carries the fix through the parser to the plan, from a sourcetype", () => {
    const plan = assembleMigrationPlan({
      rules: parseSplunkExport(
        splunkExport([
          { title: "F5 ASM alert", search: 'index=f5 sourcetype=f5_bigip_asm' },
        ]),
      ),
      platform: "splunk",
      fileName: "splunk.json",
    });
    const [ds] = plan.dataSources;
    expect(ds.name).toBe("f5_bigip_asm");
    expect(ds.sentinelSolution).toBe("F5 Networks");
    // The failure this card is about, stated as itself.
    expect(ds.sentinelSolution).not.toBe("Cisco ASA");
    expect(ds.sentinelTable).toBe("CommonSecurityLog");
  });

  it("resolves a zeek_ identifier to Corelight, not to a Windows solution", () => {
    // The SECOND instance of the same class, found while auditing the maps
    // for DBT-104: zeek_ (open-source network monitoring) resolved to
    // "Windows Security Events" / "SecurityEvent". The cross-vendor SHAPE pin
    // below cannot see it - neither Zeek nor Corelight is one of the 18
    // curated vendors - so it is pinned by name.
    for (const id of ["zeek_conn", "zeek_dns", "zeek_notice"]) {
      expect(resolveSplunkMacro(id), id).toEqual({
        solution: "Corelight",
        table: "",
      });
    }
    // Stated as itself, the way the f5_ pin states its own failure.
    expect(resolveSplunkMacro("zeek_conn")?.solution).not.toBe(
      "Windows Security Events",
    );
    // Corelight is a real address, at the strongest rung - so this fix does
    // not lean on the separator-insensitive rung the way "Cisco ASA" does.
    expect(resolutionRung("Corelight")).toBe("exact");
    // And it is not a dead end dressed up: the pivot keeps `medium` (prefix,
    // not a direct macro) rather than being capped at `low`.
    const [ds] = identifyDataSources(
      parseSplunkExport(splunkExport([{ title: "r", search: "`zeek_conn`" }])),
      "splunk",
    );
    expect(ds.sentinelSolution).toBe("Corelight");
    expect(ds.confidence).toBe("medium");
  });

  it("SHAPE: no entry maps one curated vendor's identifier to another's solution", () => {
    // The cross-vendor guard, so a future data edit cannot reintroduce the
    // class silently. Both sides are read through the SAME curated list the
    // pack builder uses for DeviceVendor (domain/vendor-identity): the
    // identifier with underscores opened out, and the solution name.
    //
    // COVERAGE, stated rather than implied: detectVendorIdentity knows 18
    // vendors, so this sees only the entries whose IDENTIFIER names one of
    // them - 3 of the 102 entries today. It is a guard against the specific
    // class (f5_ -> Cisco ASA), NOT a proof that the other 99 are right; a
    // cross-vendor mapping between two uncurated vendors would pass it.
    const exercised = KB_ENTRIES.map((e) => ({
      ...e,
      keyVendor: detectVendorIdentity(e.key.replace(/_/g, " ")),
    })).filter((e) => e.target.solution !== "" && e.keyVendor !== null);

    // Anti-vacuity: the entry the card names must be one of the ones seen.
    expect(exercised.map((e) => e.key)).toContain("f5_");
    expect(exercised.length).toBeGreaterThanOrEqual(3);

    const crossVendor = exercised
      .filter(
        (e) =>
          detectVendorIdentity(e.target.solution)?.vendor !==
          e.keyVendor?.vendor,
      )
      .map((e) => `${e.map}.${e.key} -> ${e.target.solution}`);
    expect(crossVendor).toEqual([]);
  });
});

describe("DBT-104: a solution name must be one Integrate can land on", () => {
  /**
   * THE AUTHORITY IS THE DIRECTORY LIST, NOT THE CLASSIFICATION ASSET. These
   * pins used to ask `lookupSolutionIngestion` whether a name was known, which
   * is a different question twice over. That asset holds the 436 solutions
   * that HAVE a Data Connectors directory - only 434 of which are still
   * directory names - so it is blind to the ~140 directories carrying no
   * connector, in the dangerous direction: a name declared absent that IS a
   * connector-less directory passed, while suppressing a pivot that lands. And
   * its lookup collapses separators in ONE step, so it could never say which
   * RUNG a name needs - the thing DBT-28 made load-bearing the same day.
   *
   * solution-directories.fixture.json is the 574 names the pivot resolves
   * against; its `meta` says how it is refreshed and how it ages (stale makes
   * these pins more permissive, never flaky - and blind to an upstream
   * deletion, which only a live re-check can see).
   *
   * Cost, stated: 16 KB of committed names, refreshed by hand with the one gh
   * command in that file. Bought: these pins now fail on a name no directory
   * carries AND on a spacing-only edit that demotes a name to a weaker rung.
   */
  const MAPPED_SOLUTIONS: readonly string[] = [
    ...new Set(KB_ENTRIES.map((e) => e.target.solution).filter((s) => s !== "")),
  ].sort();

  const namesAtRung = (rung: ResolutionRung): string[] =>
    MAPPED_SOLUTIONS.filter((s) => resolutionRung(s) === rung);

  it("SHAPE: every mapped solution resolves to a directory, or is declared absent", () => {
    // Anti-vacuity: an empty or gutted map would satisfy every filter below.
    expect(MAPPED_SOLUTIONS).toHaveLength(27);
    expect(namesAtRung("exact").length).toBeGreaterThan(10);

    const undeclaredAndUnresolvable = MAPPED_SOLUTIONS.filter(
      (s) => resolutionRung(s) === "none" && hasSentinelSolutionFolder(s),
    );
    expect(undeclaredAndUnresolvable).toEqual([]);
  });

  it("SHAPE: nothing is declared absent that a directory actually carries", () => {
    // The other direction: declaring a real solution absent would suppress a
    // pivot that works, so the declaration list cannot be used as a dumping
    // ground either.
    const declaredButPresent = Object.keys(SOLUTIONS_WITHOUT_SENTINEL_FOLDER)
      .filter((s) => resolutionRung(s) !== "none")
      .sort();
    expect(declaredButPresent).toEqual([]);
    expect(Object.keys(SOLUTIONS_WITHOUT_SENTINEL_FOLDER)).toHaveLength(7);
    // Both directions in one statement: the names that resolve to nothing are
    // EXACTLY the declared ones.
    expect(namesAtRung("none")).toEqual(
      Object.keys(SOLUTIONS_WITHOUT_SENTINEL_FOLDER).sort(),
    );
  });

  it("SHAPE: pins WHICH rung each name needs, not merely that one exists", () => {
    // A name that only resolves through a weaker rung is a working pivot with
    // a dependency, and the dependency has to be visible: 25 of the 27 names
    // are directory names verbatim, and these two are not.
    //
    // This is also the pin that catches a SPACING-ONLY edit. Renaming any
    // exact name to a separator variant ("Okta Single Sign-On" ->
    // "OktaSingleSignOn") still resolves - the third rung sees to that, so
    // asserting it breaks would be a lie - but it drops off the exact rung and
    // lands in the list below, which fails. Measured 2026-09-04.
    expect(namesAtRung("case-insensitive")).toEqual([
      // Directory "Azure kubernetes Service" - upstream's own casing slip.
      "Azure Kubernetes Service",
    ]);
    expect(namesAtRung("separator-insensitive")).toEqual([
      // Directory "CiscoASA". Resolves ONLY because DBT-28 added the third
      // rung on 2026-09-04; before that this name reached nothing.
      "Cisco ASA",
    ]);
    expect(namesAtRung("exact")).toHaveLength(18);
  });

  it("keeps the repointed entries on directories that exist", () => {
    // The two SHAPE pins above cannot see a regression back onto a name that
    // is ALSO declared - reverting gws_ to "Google Workspace" passed both,
    // because "Google Workspace" is legitimately declared for the ambiguous
    // `google_`. So the four repointed names are pinned by name.
    const repointed: ReadonlyArray<readonly [string, string]> = [
      ["gws_login", "GoogleWorkspaceReports"],
      ["gsuite_admin", "GoogleWorkspaceReports"],
      ["github_audit", "GitHub"],
      ["github_enterprise", "GitHub"],
      [
        "windows_exchange_iis",
        "Microsoft Exchange Security - Exchange On-Premises",
      ],
      [
        "msexchange_management",
        "Microsoft Exchange Security - Exchange On-Premises",
      ],
    ];
    for (const [id, solution] of repointed) {
      expect(resolveSplunkMacro(id)?.solution, id).toBe(solution);
      // A repointed name is a name somebody CHOSE, so it gets the strongest
      // rung - no leaning on case or separator forgiveness.
      expect(resolutionRung(solution), solution).toBe("exact");
      // ...and it can actually receive data: the shipped classification only
      // carries solutions that HAVE a Data Connectors directory, so a null
      // here would mean the pivot lands on a solution with nothing to ingest
      // into. This is the one question the directory list cannot answer.
      expect(lookupSolutionIngestion(solution), solution).not.toBeNull();
    }
    expect(QRADAR_EXTENSION_MAP["IBM QRadar DNS Analyzer"].solution).toBe(
      "Windows Server DNS",
    );
  });

  it("leaves only the ambiguous google_ prefix on the declared Google Workspace", () => {
    // The declaration exists for ONE reason: `google_` covers Workspace and
    // Google Cloud and the export does not say which. Anything else landing
    // on that name is a regression borrowing the declaration as cover.
    expect(
      KB_ENTRIES.filter((e) => e.target.solution === "Google Workspace").map(
        (e) => e.key,
      ),
    ).toEqual(["google_"]);
  });

  it("every declaration says what was checked, not just that it failed", () => {
    for (const [name, reason] of Object.entries(
      SOLUTIONS_WITHOUT_SENTINEL_FOLDER,
    )) {
      expect(reason.length, name).toBeGreaterThan(60);
      expect(reason, name).toMatch(/directory|directories/i);
    }
  });

  it("caps a declared solution at low confidence on the Splunk path", () => {
    const [ds] = identifyDataSources(
      parseSplunkExport(splunkExport([{ title: "r", search: "`pingid`" }])),
      "splunk",
    );
    // Still identified - PingID IS the vendor - but not sold as settled.
    expect(ds.sentinelSolution).toBe("PingID");
    expect(hasSentinelSolutionFolder("PingID")).toBe(false);
    expect(ds.confidence).toBe("low");
    // A neighbour in the same map, whose folder does exist, keeps `high`.
    const [okta] = identifyDataSources(
      parseSplunkExport(splunkExport([{ title: "r", search: "`okta`" }])),
      "splunk",
    );
    expect(okta.confidence).toBe("high");
  });

  it("caps a declared solution at low confidence on the QRadar path", () => {
    const [ds] = identifyDataSources(
      parseQRadarExport(
        [
          QRADAR_HEADER,
          "R,EVENT,TRUE,TRUE,,,,,,,,,IBM Security QRadar Reconnaissance Content Extension,Recon",
        ].join("\n"),
      ),
      "qradar",
    );
    // "Firewall" is a category the export never narrows; the pivot cannot land.
    expect(ds.sentinelSolution).toBe("Firewall");
    expect(ds.confidence).toBe("low");
  });

  it("leaves a low-confidence dead end alone instead of letting fuzzy re-guess it", () => {
    // low, not none: applyFuzzySolutionMap only rewrites `none`, and "Firewall"
    // substring-matches ten real firewall solutions - it would happily promote
    // a known dead end into an invented live one.
    const base = identifyDataSources(
      parseQRadarExport(
        [
          QRADAR_HEADER,
          "R,EVENT,TRUE,TRUE,,,,,,,,,IBM QRadar Data Exfiltration Content Extension,Exfil",
        ].join("\n"),
      ),
      "qradar",
    );
    const mapped = applyFuzzySolutionMap(base, [
      "Azure Firewall",
      "SonicWall Firewall",
    ]);
    expect(mapped[0].sentinelSolution).toBe("Firewall");
    expect(mapped[0].confidence).toBe("low");
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
