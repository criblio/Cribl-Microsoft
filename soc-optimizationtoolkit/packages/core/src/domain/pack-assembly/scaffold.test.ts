/**
 * Scaffold tests - Unit 19 task item 2. The legacy had ZERO deterministic
 * coverage; the structure assertions from IS-T/test-uat-pack-build.ts (sample
 * files contain only _raw + envelope; route.yml references every pipeline; CEF
 * renames) are converted here to deterministic core tests, plus the two pinned
 * legacy-defect fixes (unified naming; streamtags read) and the layout contract.
 */

import { describe, expect, it } from "vitest";

import type { MatchResult } from "../field-matcher";
import { buildPipelinePlan, checkCriblYaml } from "../pipeline-generation";
import type {
  BuildPipelinePlanInput,
  PipelineFieldMapping,
} from "../pipeline-generation";

import { streamtagsFromPackage } from "./package-json";
import { assemblePack, scaffoldPack, type PackScaffoldInput } from "./scaffold";
import { parseUstarTar, ungzipStored } from "./tar";
import type { PackVendorSample } from "./sample-file";

const ENVELOPE_KEYS = new Set(["_raw", "_time", "source", "sourcetype", "host", "index"]);

const CEF_RENAMES: PipelineFieldMapping[] = [
  { source: "cs1", target: "DeviceCustomString1", type: "string", action: "rename" },
  { source: "spt", target: "SourcePort", type: "int", action: "rename" },
  { source: "act", target: "DeviceAction", type: "string", action: "rename" },
  { source: "src", target: "SourceIP", type: "string", action: "rename" },
];

function cefSample(): PackVendorSample {
  return {
    tableName: "CommonSecurityLog",
    source: "PaloAlto:TRAFFIC",
    logType: "TRAFFIC",
    format: "cef",
    rawEvents: [
      JSON.stringify({
        CEFVersion: 0,
        DeviceVendor: "Palo Alto",
        DeviceProduct: "PAN-OS",
        Name: "traffic",
        Severity: "5",
        cs1: "label",
        spt: "50210",
        act: "allow",
        src: "10.0.0.1",
      }),
    ],
  };
}

function paloPlanInput(): BuildPipelinePlanInput {
  return {
    solutionName: "PaloAlto-PAN-OS",
    packName: "paloalto-pan-os-sentinel",
    version: "1.0.0",
    tables: [
      {
        sentinelTable: "CommonSecurityLog",
        logType: "TRAFFIC",
        sourceFormat: "cef",
        presetFields: CEF_RENAMES,
      },
    ],
  };
}

function scaffoldInput(over: Partial<PackScaffoldInput> = {}): PackScaffoldInput {
  return {
    plan: buildPipelinePlan(paloPlanInput()),
    vendorSamples: [cefSample()],
    builtAtMs: 1_700_000_000_000,
    ...over,
  };
}

function readSampleEvents(tree: ReturnType<typeof scaffoldPack>): unknown[] {
  const [path] = tree.paths().filter((p) => p.startsWith("data/samples/"));
  return JSON.parse(tree.get(path) as string);
}

describe("scaffold - sample file envelope (test-uat TEST 7)", () => {
  it("emits ONLY _raw + envelope keys per event", () => {
    const events = readSampleEvents(scaffoldPack(scaffoldInput())) as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    for (const evt of events) {
      const keys = Object.keys(evt);
      expect(keys).toContain("_raw");
      expect(keys).toContain("_time");
      expect(keys.filter((k) => !ENVELOPE_KEYS.has(k))).toEqual([]);
    }
  });

  it("reconstructs the raw CEF line into _raw", () => {
    const events = readSampleEvents(scaffoldPack(scaffoldInput())) as Array<Record<string, unknown>>;
    expect(typeof events[0]._raw).toBe("string");
    expect(events[0]._raw as string).toContain("CEF:");
    expect(events[0]._raw as string).toContain("cs1=label");
  });
});

describe("scaffold - route.yml references every pipeline (test-uat TEST 8)", () => {
  it("every pipeline dir is referenced by a route, and no route dangles", () => {
    const tree = scaffoldPack(scaffoldInput());
    const route = tree.get("default/pipelines/route.yml") as string;

    const pipelineDirs = tree
      .paths()
      .filter((p) => p.startsWith("default/pipelines/") && p.endsWith("/conf.yml"))
      .map((p) => p.slice("default/pipelines/".length, -"/conf.yml".length));
    expect(pipelineDirs.length).toBeGreaterThan(0);

    // Every emitted pipeline dir is referenced by the route.yml.
    for (const dir of pipelineDirs) {
      expect(route).toContain(`pipeline: ${dir}`);
    }

    // Every `pipeline:` the route references EXISTS as a pipeline dir (the
    // unified-naming fix: a route can never dangle to a missing dir).
    const referenced = [...route.matchAll(/^\s*pipeline: (.+)$/gm)].map((m) => m[1].trim());
    expect(referenced.length).toBeGreaterThan(0);
    for (const ref of referenced) {
      expect(pipelineDirs).toContain(ref);
    }
  });
});

describe("scaffold - unified naming (section 3 item 2 defect fix)", () => {
  it("_CL table + long log type: route suffix == pipeline dir suffix", () => {
    const plan = buildPipelinePlan({
      solutionName: "Cloudflare",
      packName: "cloudflare-sentinel",
      tables: [
        {
          sentinelTable: "CloudflareV2_CL",
          logType: "HTTP_Requests_With_A_Very_Long_LogType_Name_Overflowing",
          sourceFormat: "json",
        },
      ],
    });
    const tree = scaffoldPack({ plan, builtAtMs: 1_700_000_000_000 });
    const route = tree.get("default/pipelines/route.yml") as string;
    const referenced = [...route.matchAll(/^\s*pipeline: (.+)$/gm)].map((m) => m[1].trim());
    const dirs = tree
      .paths()
      .filter((p) => p.startsWith("default/pipelines/") && p.endsWith("/conf.yml"))
      .map((p) => p.slice("default/pipelines/".length, -"/conf.yml".length));
    for (const ref of referenced) expect(dirs).toContain(ref);
    // Suffix is capped at 25 and _CL stripped by the single naming source.
    expect(plan.tables[0].suffix.length).toBeLessThanOrEqual(25);
    expect(plan.tables[0].suffix).not.toMatch(/_CL$/i);
  });
});

describe("scaffold - CEF renames + parser (test-uat TEST 6)", () => {
  it("emits currentName/newName renames and the CEF eval parser", () => {
    const tree = scaffoldPack(scaffoldInput());
    const confPath = tree
      .paths()
      .find((p) => p.endsWith("/conf.yml") && !p.includes("/Reduction_") && p !== "default/pipelines/route.yml")!;
    const conf = tree.get(confPath) as string;
    expect(conf).toContain("currentName: cs1");
    expect(conf).toContain("newName: DeviceCustomString1");
    expect(conf).toContain("currentName: spt");
    expect(conf).toContain("newName: SourcePort");
    // CEF eval parser present for cef format.
    expect(conf).toContain("__cefParts");
    expect(conf).toContain("__cefExtension");
  });

  it("CEF overflow serializes into the overflow field", () => {
    const match: MatchResult = {
      matched: [
        {
          sourceName: "cs1",
          sourceType: "string",
          destName: "DeviceCustomString1",
          destType: "string",
          confidence: "alias",
          action: "rename",
          needsCoercion: false,
          description: "alias",
        },
      ],
      overflow: [
        {
          sourceName: "customField",
          sourceType: "string",
          destName: "",
          destType: "string",
          confidence: "unmatched",
          action: "overflow",
          needsCoercion: false,
          description: "overflow",
        },
      ],
      unmatchedSource: [],
      unmatchedDest: [],
      overflowConfig: {
        enabled: true,
        fieldName: "AdditionalExtensions",
        fieldType: "string",
        sourceFields: ["customField"],
      },
      totalSource: 2,
      totalDest: 1,
      matchRate: 1,
      warnings: [],
    };
    const plan = buildPipelinePlan({
      solutionName: "PaloAlto-PAN-OS",
      packName: "paloalto-pan-os-sentinel",
      tables: [{ sentinelTable: "CommonSecurityLog", logType: "TRAFFIC", sourceFormat: "cef", matchResult: match }],
    });
    const tree = scaffoldPack({ plan, builtAtMs: 1_700_000_000_000 });
    const conf = tree.get(`default/pipelines/${plan.tables[0].pipelineName}/conf.yml`) as string;
    expect(conf).toContain("id: serialize");
    expect(conf).toContain("dstField: AdditionalExtensions");
  });
});

describe("scaffold - package.json + streamtags fix (test-uat TEST 9)", () => {
  it("has name/version and a readable tags.streamtags array", () => {
    const tree = scaffoldPack(scaffoldInput());
    const pkg = JSON.parse(tree.get("package.json") as string);
    expect(pkg.name).toBe("paloalto-pan-os-sentinel");
    expect(pkg.version).toBe("1.0.0");
    expect(Array.isArray(pkg.tags.streamtags)).toBe(true);
    // The streamtags READ fix: nested array is recovered (legacy read top-level
    // string and always got []).
    expect(streamtagsFromPackage(pkg)).toEqual(pkg.tags.streamtags);
    expect(streamtagsFromPackage(pkg)).toContain("sentinel");
  });
});

describe("scaffold - layout + Cribl-YAML acceptance", () => {
  it("places registry files at default/ and data at data/", () => {
    const tree = scaffoldPack(scaffoldInput());
    expect(tree.has("default/pack.yml")).toBe(true);
    expect(tree.has("default/breakers.yml")).toBe(true);
    expect(tree.has("default/samples.yml")).toBe(true);
    expect(tree.has("default/outputs.yml")).toBe(true);
    expect(tree.has("default/pipelines/route.yml")).toBe(true);
    expect(tree.paths().some((p) => p.startsWith("data/samples/"))).toBe(true);
    // No stray report files leaked into the tree.
    expect(tree.paths().some((p) => /FIELD_MAPPING_|GAP_ANALYSIS|VENDOR_RESEARCH/.test(p))).toBe(false);
  });

  it("route.yml and every conf.yml pass the Cribl-YAML validator", () => {
    const tree = scaffoldPack(scaffoldInput());
    for (const p of tree.paths().filter((x) => x.endsWith(".yml"))) {
      expect(checkCriblYaml(tree.get(p) as string, p)).toEqual([]);
    }
  });

  it("lookups.yml lives at default/, NEVER data/lookups/ (memory contract)", () => {
    const match: MatchResult = {
      matched: [
        {
          sourceName: "src",
          sourceType: "string",
          destName: "SourceIP",
          destType: "string",
          confidence: "alias",
          action: "rename",
          needsCoercion: false,
          description: "alias",
        },
      ],
      overflow: [],
      unmatchedSource: [],
      unmatchedDest: [],
      overflowConfig: { enabled: false, fieldName: "AdditionalExtensions", fieldType: "string", sourceFields: [] },
      totalSource: 1,
      totalDest: 1,
      matchRate: 1,
      warnings: [],
    };
    const tree = scaffoldPack(scaffoldInput({ tableInputs: [{ matchResult: match }] }));
    expect(tree.has("default/lookups.yml")).toBe(true);
    expect(tree.paths().some((p) => p === "data/lookups.yml")).toBe(false);
    // The CSV data file itself is under data/lookups/.
    expect(tree.paths().some((p) => p.startsWith("data/lookups/") && p.endsWith(".csv"))).toBe(true);
  });
});

describe("scaffold - breakers CrowdStrike tuning", () => {
  it("uses the 768KB max event bytes for CrowdStrike solutions", () => {
    const plan = buildPipelinePlan({
      solutionName: "CrowdStrike Falcon Endpoint Protection",
      packName: "crowdstrike-sentinel",
      tables: [{ sentinelTable: "CrowdStrike_Process_Events_CL", logType: "ProcessRollup2", sourceFormat: "ndjson" }],
    });
    const tree = scaffoldPack({ plan, builtAtMs: 1 });
    const breakers = tree.get("default/breakers.yml") as string;
    expect(breakers).toContain("maxEventBytes: 786432");
    expect(breakers).toContain('timestampAnchorRegex: /"timestamp"\\s*:\\s*"/');
  });
});

describe("assemblePack - deterministic .crbl + build record", () => {
  it("round-trips the built .crbl to the scaffolded tree", () => {
    const input = scaffoldInput();
    const built = assemblePack(input);
    const extracted = new Map(
      parseUstarTar(ungzipStored(built.crbl))
        .filter((e) => !e.isDir)
        .map((e) => [e.path, e.content.length]),
    );
    // Every tree file appears in the archive (report files excluded, none here).
    for (const path of built.tree.paths()) {
      expect(extracted.has(path)).toBe(true);
    }
    expect(built.crblFileName).toBe("paloalto-pan-os-sentinel_1.0.0.crbl");
  });

  it("produces byte-identical .crbl for identical inputs", () => {
    const a = assemblePack(scaffoldInput());
    const b = assemblePack(scaffoldInput());
    expect(Buffer.from(a.crbl).equals(Buffer.from(b.crbl))).toBe(true);
  });

  it("build record carries the deduplicated table list + builtAt input", () => {
    const built = assemblePack(scaffoldInput());
    expect(built.record.tables).toEqual(["CommonSecurityLog"]);
    expect(built.record.version).toBe("1.0.0");
    expect(built.record.builtAtMs).toBe(1_700_000_000_000);
    expect(built.record.crblSizeBytes).toBe(built.crbl.length);
  });
});

describe("scaffold - multi-logType single table (overflow collision fix)", () => {
  it("emits one pipeline pair per logType but ONE outputs entry", () => {
    const plan = buildPipelinePlan({
      solutionName: "Cloudflare",
      packName: "cloudflare-sentinel",
      tables: [
        { sentinelTable: "CloudflareV2_CL", logType: "HTTP", sourceFormat: "json" },
        { sentinelTable: "CloudflareV2_CL", logType: "DNS", sourceFormat: "json" },
      ],
    });
    const tree = scaffoldPack({ plan, builtAtMs: 1 });
    const transformDirs = tree
      .paths()
      .filter((p) => p.endsWith("/conf.yml") && !p.includes("Reduction_"))
      .map((p) => p.slice("default/pipelines/".length, -"/conf.yml".length));
    expect(new Set(transformDirs).size).toBe(2); // HTTP + DNS
    // outputs.yml has exactly one destination for the shared table.
    const outputs = tree.get("default/outputs.yml") as string;
    const destCount = [...outputs.matchAll(/MS-Sentinel-CloudflareV2-dest:/g)].length;
    expect(destCount).toBe(1);
  });
});
