import { describe, expect, it } from "vitest";

import type { DiscoveredField } from "../sample-parsing/models";
import {
  SENTINEL_SCHEMA_MARKERS,
  detectPreIngested,
  buildSampleKeywords,
  scoreFileName,
  isEligibleRepoFile,
  buildRepoSampleMessage,
  consolidateByTableRouting,
  resolveRepoSamples,
  type RepoSample,
} from "./index";

function field(name: string): DiscoveredField {
  return { name, type: "string", types: ["string"], examples: [], occurrence: 1, required: true };
}

describe("SENTINEL_SCHEMA_MARKERS + detectPreIngested (3+-hits rule)", () => {
  it("has the CEF post-ingestion markers", () => {
    expect(SENTINEL_SCHEMA_MARKERS.has("SourceIP")).toBe(true);
    expect(SENTINEL_SCHEMA_MARKERS.has("DeviceAction")).toBe(true);
    // raw CEF field names are NOT markers
    expect(SENTINEL_SCHEMA_MARKERS.has("src")).toBe(false);
  });

  it("flags a sample with 3+ markers as pre-ingested, fewer as raw", () => {
    expect(detectPreIngested(["SourceIP", "DestinationIP", "DeviceAction"])).toBe(true);
    expect(detectPreIngested(["SourceIP", "DestinationIP"])).toBe(false);
    expect(detectPreIngested(["src", "dst", "spt", "dpt", "act"])).toBe(false);
  });
});

describe("ABBREVIATIONS scoring", () => {
  it("expands vendor abbreviations into search keywords", () => {
    const kw = buildSampleKeywords("Palo Alto Networks");
    expect(kw).toContain("panos");
    expect(kw).toContain("paloalto");
  });

  it("suppresses short keywords (< 4 chars) for substring scoring", () => {
    // "cs" is a CrowdStrike abbreviation but must not match "docs".
    expect(scoreFileName("docs.json", ["cs"])).toBe(0);
    // a >= 4-char keyword scores its own length
    expect(scoreFileName("crowdstrike_fdr.json", ["crowdstrike"])).toBe(11);
  });

  it("excludes schema/readme and EXCLUDE_PATTERN files", () => {
    expect(isEligibleRepoFile("PrismaCloud_audit.json")).toBe(false);
    expect(isEligibleRepoFile("vendor.schema.json")).toBe(false);
    expect(isEligibleRepoFile("README.txt")).toBe(false);
    expect(isEligibleRepoFile("crowdstrike_fdr.json")).toBe(true);
    expect(isEligibleRepoFile("ok.json", "PrismaCloud")).toBe(false);
  });
});

describe("buildRepoSampleMessage (the THREE user-facing messages)", () => {
  it("message 1: found samples (with optional suffixes)", () => {
    expect(
      buildRepoSampleMessage({
        finalCount: 2,
        finalEventTotal: 10,
        skippedCount: 1,
        matchedCount: 3,
        rawSampleCount: 40,
        hasSolutionTables: true,
      }),
    ).toBe(
      "Found 2 sample(s) with 10 total events. Skipped 1 pre-ingested. Consolidated 40 event types into 2 table groups.",
    );
  });

  it("message 2: all matches were pre-ingested Sentinel-schema data", () => {
    expect(
      buildRepoSampleMessage({
        finalCount: 0,
        finalEventTotal: 0,
        skippedCount: 4,
        matchedCount: 4,
        rawSampleCount: 0,
        hasSolutionTables: false,
      }),
    ).toBe(
      "All 4 sample(s) are in Sentinel schema format. Upload raw vendor samples or capture live data.",
    );
  });

  it("message 3: files matched but none parsed", () => {
    expect(
      buildRepoSampleMessage({
        finalCount: 0,
        finalEventTotal: 0,
        skippedCount: 0,
        matchedCount: 5,
        rawSampleCount: 0,
        hasSolutionTables: false,
      }),
    ).toBe("Found 5 matching file(s) but none could be parsed.");
  });
});

describe("resolveRepoSamples (end-to-end pipeline)", () => {
  const solution = "CrowdStrike Falcon Endpoint Protection";

  it("finds raw vendor samples and reports the found message", () => {
    const result = resolveRepoSamples(solution, [
      {
        fileName: "crowdstrike_fdr.json",
        content: '{"event_simpleName":"ProcessRollup2","aid":"a","CommandLine":"cmd.exe"}',
      },
    ]);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].preIngested).toBe(false);
    expect(result.message).toBe("Found 1 sample(s) with 1 total events.");
  });

  it("drops pre-ingested samples and reports message 2", () => {
    const result = resolveRepoSamples(solution, [
      {
        fileName: "crowdstrike_cef.json",
        content:
          '{"SourceIP":"1.2.3.4","DestinationIP":"5.6.7.8","DeviceAction":"Deny","SourcePort":"1024"}',
      },
    ]);
    expect(result.samples).toHaveLength(0);
    expect(result.skippedPreIngested).toBe(1);
    expect(result.message).toContain("in Sentinel schema format");
  });

  it("reports message 3 when a matched file cannot be parsed", () => {
    const result = resolveRepoSamples(solution, [
      { fileName: "crowdstrike_blank.txt", content: "    " },
    ]);
    expect(result.samples).toHaveLength(0);
    expect(result.message).toBe("Found 1 matching file(s) but none could be parsed.");
  });

  it("reports no-sample-data when nothing scores >= 8", () => {
    const result = resolveRepoSamples(solution, [
      { fileName: "okta_system.json", content: '{"a":1}' },
    ]);
    expect(result.filesSearched).toBe(0);
    expect(result.message).toContain("No sample data found");
  });

  it("preserves the ORIGINAL raw lines for syslog (not JSON)", () => {
    const line1 = "<134>Jan  1 00:00:00 host app: allow alice from 10.0.0.1";
    const line2 = "<134>Jan  1 00:00:00 host app: deny bob from 10.0.0.2";
    const result = resolveRepoSamples("PaperCut", [
      { fileName: "papercut.txt", content: `${line1}\n${line2}` },
    ]);
    const allRaw = result.samples.flatMap((s) => s.rawEvents);
    expect(allRaw.length).toBeGreaterThan(0);
    for (const raw of allRaw) {
      // the original vendor line survives, not a JSON-stringified object
      expect(raw.startsWith("{")).toBe(false);
      expect(raw.startsWith("<134>")).toBe(true);
    }
  });
});

describe("consolidateByTableRouting (CrowdStrike-style)", () => {
  it("merges many event types into one sample per destination table", () => {
    const rawSamples: RepoSample[] = [
      {
        vendor: "cs",
        logType: "ProcessRollup2",
        format: "ndjson",
        eventCount: 3,
        fieldCount: 1,
        rawEvents: ["r1", "r2", "r3"],
        timestampField: "",
        source: "s",
        fields: [field("a")],
        preIngested: false,
      },
      {
        vendor: "cs",
        logType: "DnsRequest",
        format: "ndjson",
        eventCount: 1,
        fieldCount: 1,
        rawEvents: ["d1"],
        timestampField: "",
        source: "s",
        fields: [field("b")],
        preIngested: false,
      },
      {
        vendor: "cs",
        logType: "Unmapped",
        format: "ndjson",
        eventCount: 1,
        fieldCount: 0,
        rawEvents: ["u1"],
        timestampField: "",
        source: "s",
        fields: [],
        preIngested: false,
      },
    ];
    const routing = new Map([
      ["ProcessRollup2", "ProcessEvents_CL"],
      ["DnsRequest", "DnsEvents_CL"],
    ]);
    const out = consolidateByTableRouting(rawSamples, routing, "cs");
    const byType = new Map(out.map((s) => [s.logType, s]));
    expect([...byType.keys()].sort()).toEqual(["DnsEvents", "ProcessEvents", "Unmapped"]);
    // at most 2 raw events per source type
    expect(byType.get("ProcessEvents")!.rawEvents).toEqual(["r1", "r2"]);
  });
});
