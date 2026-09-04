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

  it("carries GEN-3's toolkit stamp INSIDE the shipped .crbl, not just in the builder", () => {
    // The unit pin on buildPackageJson proves the string is composed right. It
    // does NOT prove the stamp survives scaffolding, tar and gzip into the
    // artifact an operator actually installs - and the artifact is the only
    // thing that can answer "what built this pack?".
    //
    // This matters more than it looks: Pack Maintenance REGENERATES the .crbl
    // on download from the stored definition rather than serving saved bytes,
    // and PackBuildRecord does not carry toolkitVersion. The stamp survives
    // only because the stored definition is a full PipelinePlan, which is where
    // toolkitVersion lives. If that ever changes, every downloaded pack quietly
    // loses its provenance and nothing else here would notice.
    const input = scaffoldInput();
    const built = assemblePack({
      ...input,
      plan: { ...input.plan, toolkitVersion: "1.12.3" },
    });
    const manifest = parseUstarTar(ungzipStored(built.crbl)).find((e) =>
      e.path.endsWith("package.json"),
    );

    expect(manifest).toBeDefined();
    const pkg = JSON.parse(new TextDecoder().decode(manifest!.content));
    expect(pkg.author).toBe("Cribl SOC Toolkit 1.12.3");
  });

  it("ships the bare author when nothing stamped a toolkit version", () => {
    // A pack built without the shell is honestly silent rather than claiming a
    // version it does not know.
    const built = assemblePack(scaffoldInput());
    const manifest = parseUstarTar(ungzipStored(built.crbl)).find((e) =>
      e.path.endsWith("package.json"),
    );
    const pkg = JSON.parse(new TextDecoder().decode(manifest!.content));

    expect(pkg.author).toBe("Cribl SOC Toolkit");
  });

  it("REPORTS every table that shipped placeholder destination values", () => {
    // The silent half of the 2026-08-11 bug. Falling back to placeholders is a
    // legitimate outcome - a table with no deployed DCR has nothing else to
    // ship - but doing it without saying so let operators install a pack whose
    // destination pointed at dcr-000...0 and looked entirely successful. If
    // this list is ever empty while placeholders were emitted, the caller has
    // no way to warn and the failure goes back to being invisible.
    const plan = buildPipelinePlan(paloPlanInput());
    const built = assemblePack(scaffoldInput({ plan }));
    // No tableInputs supplied, so EVERY table falls back - and every one is
    // named. A report that listed only some would be worse than none, because
    // the omitted tables would read as fine.
    expect(built.placeholderTables).toEqual(
      plan.tables.map((t) => t.sentinelTable),
    );
    // And the emitted YAML really does carry the placeholder, so the report is
    // about the artifact rather than about the input.
    const outputs = built.tree.get("default/outputs.yml") as string;
    expect(outputs).toContain("dcr-00000000000000000000000000000000");
  });

  it("reports NO placeholders when every table supplies real values", () => {
    const plan = buildPipelinePlan(paloPlanInput());
    const built = assemblePack(
      scaffoldInput({
        plan,
        tableInputs: plan.tables.map((table) => ({
          destination: {
            id: table.destinationId,
            dcrImmutableId: "dcr-11111111111111111111111111111111",
            ingestionEndpoint: "https://real.ingest.monitor.azure.com",
            streamName: table.streamName,
            tenantId: "tenant",
            ingestionClientId: "client",
          },
        })),
      }),
    );
    expect(built.placeholderTables).toEqual([]);
    const outputs = built.tree.get("default/outputs.yml") as string;
    expect(outputs).not.toContain("dcr-00000000000000000000000000000000");
    expect(outputs).toContain("dcr-11111111111111111111111111111111");
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

/**
 * Sample-id uniqueness. Zscaler Internet Access shipped a pack with TEN log
 * types and ZERO samples: two ids collided, so one sample file overwrote
 * another AND samples.yml carried a duplicate mapping key, which Cribl rejects
 * wholesale. Nothing errored - the build reported success, the YAML validator
 * passed, and the pack installed clean. Only opening the pack in Cribl showed
 * the loss, which is why these pins assert COUNTS and KEYS, not "some sample
 * exists" (the pre-existing layout pin used `.some()` and stayed green
 * throughout).
 */
describe("scaffold - sample ids are unique per pack", () => {
  const ZSCALER_LOG_TYPES = [
    "firewall",
    "ALLOWED",
    "CAUTIONED",
    "web-BLOCKED",
    "firewall-BLOCKED",
    "OUTOFRANGE",
    "dns-http-endpoint",
    "dns",
    "tunnel-http-endpoint",
    "tunnel",
  ];

  /** The exact shape that lost a sample in the field. */
  function zscalerTree() {
    return scaffoldPack({
      plan: buildPipelinePlan({
        solutionName: "Zscaler Internet Access",
        packName: "MS-Sentinel-Zscaler-Internet",
        tables: ZSCALER_LOG_TYPES.map((logType) => ({
          sentinelTable: "CommonSecurityLog",
          logType,
          sourceFormat: "cef" as const,
        })),
      }),
      builtAtMs: 1_700_000_000_000,
    });
  }

  function sampleIds(tree: ReturnType<typeof scaffoldPack>): string[] {
    return tree
      .paths()
      .filter((p) => p.startsWith("data/samples/"))
      .map((p) => p.slice("data/samples/".length, -".json".length));
  }

  /** samples.yml top-level keys, in file order (duplicates preserved). */
  function registryKeys(tree: ReturnType<typeof scaffoldPack>): string[] {
    return ((tree.get("default/samples.yml") as string).match(/^\S+(?=:$)/gm) ?? []).slice();
  }

  it("emits ONE sample file per table - never fewer", () => {
    // The collision silently dropped a file: 10 tables produced 9 samples.
    expect(sampleIds(zscalerTree())).toHaveLength(ZSCALER_LOG_TYPES.length);
  });

  it("never repeats a key in samples.yml", () => {
    // A duplicate mapping key makes the document invalid, and Cribl responds by
    // discarding EVERY sample in the pack - not just the duplicated one.
    const keys = registryKeys(zscalerTree());
    expect(keys).toHaveLength(ZSCALER_LOG_TYPES.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("registers exactly the sample files it wrote", () => {
    const tree = zscalerTree();
    expect(registryKeys(tree).sort()).toEqual(sampleIds(tree).sort());
  });

  it("stays deterministic across builds", () => {
    // Uniqueness must not be bought with a counter that depends on run order.
    expect(sampleIds(zscalerTree())).toEqual(sampleIds(zscalerTree()));
  });
});

describe("pack shape decides the two files that gate where the pack can be used", () => {
  // GEN-13. A user reported that an app-built pack could not be selected from
  // the Routes page pipeline dropdown. Diffing against a known-good pack they
  // supplied (HelloPacks_1.0.0.crbl) narrowed it to two files, and this suite
  // holds the outputs.yml half - the route-output half is pinned beside it in
  // pack-shape.test.ts. They are ONE decision in two places, so each is pinned
  // where it lives and both are asserted for each shape.

  it("ships outputs.yml for an ALL-INCLUSIVE pack, the default and the pre-2026-09-04 behaviour", () => {
    const tree = scaffoldPack(scaffoldInput());
    expect(tree.paths()).toContain("default/outputs.yml");
  });

  it("OMITS outputs.yml for a ROUTABLE pack, exactly as HelloPacks does", () => {
    // Not an optimisation. A routable pack's routes hand events back with
    // `output: default`, so a shipped Sentinel destination would be an output
    // nothing routes to - carrying a secret reference the group may not
    // resolve. The two files move together or the pack is broken.
    const plan = buildPipelinePlan({ ...paloPlanInput(), packShape: "routable" });
    const tree = scaffoldPack(scaffoldInput({ plan }));
    expect(tree.paths()).not.toContain("default/outputs.yml");
  });

  it("still writes everything else, so the shape changes ONE file and not the pack", () => {
    // The guard against over-reach: a routable pack is the same pack, wired
    // differently. If this fails the shape has started removing pipelines,
    // samples or breakers, which is not what the operator chose.
    const plan = buildPipelinePlan({ ...paloPlanInput(), packShape: "routable" });
    const routable = scaffoldPack(scaffoldInput({ plan }));
    const inclusive = scaffoldPack(scaffoldInput());
    const dropped = inclusive
      .paths()
      .filter((path) => !routable.paths().includes(path));
    expect(dropped).toEqual(["default/outputs.yml"]);
  });
});
