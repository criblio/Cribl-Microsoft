/**
 * analyzeSamples usecase tests - porting-plan Unit 18 (ENG-12). Drives the
 * chunked generator over the FakeSentinelContent (seeded with the byte-faithful
 * CrowdStrikeCustomDCR.json) and the bundled SchemaCatalog, plus the vendored
 * CrowdStrike FDR Process corpus.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { FakeSentinelContent } from "../../testing/fake-sentinel-content";
import { createBundledSchemaCatalog } from "../../domain/field-matcher/index";
import { CROWDSTRIKE_CUSTOM_DCR } from "../../assets/sentinel-connectors/index";
import { analyzeSamples, collectGapReports } from "./analyze-samples";
import type { AnalyzeSamplesPorts } from "./analyze-samples";

const SOLUTION = "CrowdStrike Falcon";
const DCR_PATH =
  "Solutions/CrowdStrike Falcon/Data Connectors/CrowdstrikeReplicatorCLv2/" +
  "Data Collection Rules/CrowdStrikeCustomDCR.json";
const PROCESS_TABLE = "CrowdStrike_Process_Events_CL";

function readCorpus(table: string): string {
  const url = new URL(
    `../../assets/sample-corpus/${table}.json`,
    import.meta.url,
  );
  return readFileSync(url, "utf8");
}

function makePorts(): AnalyzeSamplesPorts {
  const content = new FakeSentinelContent({
    files: { [DCR_PATH]: JSON.stringify(CROWDSTRIKE_CUSTOM_DCR) },
  });
  return { content, catalog: createBundledSchemaCatalog() };
}

describe("analyzeSamples (chunked DCR gap analysis)", () => {
  it("yields exactly one typed report per sample, in order", async () => {
    const ports = makePorts();
    const yielded: string[] = [];
    for await (const report of analyzeSamples(ports, {
      solutionName: SOLUTION,
      samples: [
        { logType: "process", tableName: PROCESS_TABLE, content: readCorpus(PROCESS_TABLE) },
        {
          logType: "dns",
          tableName: "CrowdStrike_DNS_Events_CL",
          content: readCorpus("CrowdStrike_DNS_Events_CL"),
        },
      ],
    })) {
      yielded.push(report.logType);
    }
    expect(yielded).toEqual(["process", "dns"]);
  });

  it("builds the six stat tiles from a real solution + sample", async () => {
    const [report] = await collectGapReports(makePorts(), {
      solutionName: SOLUTION,
      samples: [
        { logType: "process", tableName: PROCESS_TABLE, content: readCorpus(PROCESS_TABLE) },
      ],
    });
    expect(report.tableName).toBe(PROCESS_TABLE);
    expect(report.stats.map((s) => s.label)).toEqual([
      "Source Fields",
      "Dest Columns",
      "Passthrough",
      "DCR Handles",
      "Cribl Handles",
      "Overflow",
    ]);
    expect(report.sourceFieldCount).toBeGreaterThan(0);
    expect(report.destFieldCount).toBeGreaterThan(20);
  });

  it("resolves the real DCR flow (project-rename id -> CrowdStrikeId)", async () => {
    const [report] = await collectGapReports(makePorts(), {
      solutionName: SOLUTION,
      samples: [
        { logType: "process", tableName: PROCESS_TABLE, content: readCorpus(PROCESS_TABLE) },
      ],
    });
    expect(report.dcrRenames).toContainEqual({
      source: "id",
      dest: "CrowdStrikeId",
    });
    expect(report.dcrHandledCount).toBeGreaterThan(0);
    // The Process flow is stream-routed (no event_simpleName filter).
    expect(report.routeCondition).toBe("true");
  });

  it("surfaces the AdditionalData_d-missing warning through the usecase", async () => {
    const [report] = await collectGapReports(makePorts(), {
      solutionName: SOLUTION,
      samples: [
        { logType: "process", tableName: PROCESS_TABLE, content: readCorpus(PROCESS_TABLE) },
      ],
    });
    expect(report.overflowLossy).toBe(true);
    expect(report.warnings.some((w) => w.includes("AdditionalData_d"))).toBe(true);
  });

  it("degrades gracefully for an unknown table (no schema, no DCR flow)", async () => {
    const [report] = await collectGapReports(makePorts(), {
      solutionName: SOLUTION,
      samples: [
        {
          logType: "mystery",
          tableName: "Nonexistent_CL",
          content: '{"foo":"bar","n":1}',
        },
      ],
    });
    expect(report.destFieldCount).toBe(0);
    expect(report.dcrRenames).toEqual([]);
    expect(report.warnings.some((w) => w.includes("No destination schema"))).toBe(
      true,
    );
  });

  it("degrades gracefully when the solution cannot be matched at all", async () => {
    const reports = await collectGapReports(makePorts(), {
      solutionName: "Totally Unknown Vendor",
      samples: [
        { logType: "process", tableName: PROCESS_TABLE, content: readCorpus(PROCESS_TABLE) },
      ],
    });
    expect(reports).toHaveLength(1);
    // No DCR flow -> synthetic no-op flow -> no DCR renames.
    expect(reports[0].dcrRenames).toEqual([]);
    // The schema still resolves from the bundled catalog, so tiles are real.
    expect(reports[0].destFieldCount).toBeGreaterThan(20);
  });
});

describe("per-sample vendor-mapping guard (Phase 0 packs)", () => {
  const CSL_SAMPLE = '{"cltip":"10.1.1.1","login":"a@b.com","deviceowner":"jsmith"}';

  it("applies a pack entry only when its destination column is in the schema", async () => {
    const ports: AnalyzeSamplesPorts = {
      content: new FakeSentinelContent({ files: {} }),
      catalog: {
        // A schema WITHOUT SourceIP: the cltip->SourceIP entry must NOT
        // produce a phantom mapping onto a nonexistent column.
        resolveSchema: async () => [{ name: "Message", type: "string" }],
      },
    };
    const [report] = await collectGapReports(ports, {
      solutionName: "Zscaler Internet Access",
      samples: [{ logType: "web", tableName: "SomeTable", content: CSL_SAMPLE }],
      vendorMappings: [
        { sourceName: "cltip", destName: "SourceIP", sourceType: "", destType: "", action: "map" },
      ],
    });
    expect(
      report.fieldMappings.some((m) => m.dest === "SourceIP"),
    ).toBe(false);
  });

  it("first entry wins a per-sample destination collision", async () => {
    const ports: AnalyzeSamplesPorts = {
      content: new FakeSentinelContent({ files: {} }),
      catalog: {
        resolveSchema: async () => [
          { name: "SourceUserName", type: "string" },
          { name: "AdditionalExtensions", type: "string" },
        ],
      },
    };
    // Both login and deviceowner are pack-mapped to SourceUserName (web feed
    // vs mined entry); the sample carries BOTH, so only the first-declared
    // entry may claim the column - Phase 0 has no reservation of its own.
    const [report] = await collectGapReports(ports, {
      solutionName: "Zscaler Internet Access",
      samples: [{ logType: "web", tableName: "SomeTable", content: CSL_SAMPLE }],
      vendorMappings: [
        { sourceName: "login", destName: "SourceUserName", sourceType: "", destType: "", action: "map" },
        { sourceName: "deviceowner", destName: "SourceUserName", sourceType: "", destType: "", action: "map" },
      ],
    });
    const claimants = report.fieldMappings.filter(
      (m) => m.dest === "SourceUserName" && m.action !== "overflow",
    );
    expect(claimants.map((m) => m.source)).toEqual(["login"]);
  });
});
