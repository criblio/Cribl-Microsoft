import { describe, expect, it } from "vitest";

import { FakeSentinelContent } from "../../testing/fake-sentinel-content";
import {
  browseSamples,
  browseSamplesDetailed,
  loadSamples,
  type RemoteSampleSource,
  type AcquireSamplesDeps,
} from "./index";

const SOLUTION = "CrowdStrike Falcon Endpoint Protection";

const source: RemoteSampleSource = {
  async listElasticTestFiles(pkg, stream) {
    if (pkg === "crowdstrike" && stream === "fdr") {
      return [
        {
          fileName: "test-crowdstrike-fdr.log",
          content:
            '{"type":"traffic","src":"1.1.1.1"}\n{"type":"threat","src":"2.2.2.2"}',
        },
      ];
    }
    return [];
  },
  async listCriblPackSamples(repo) {
    if (repo === "cribl_crowdstrike") {
      return [
        { fileName: "falcon.json", content: JSON.stringify([{ _raw: "evt1", _time: 1 }]) },
      ];
    }
    return [];
  },
};

function makeDeps(): AcquireSamplesDeps {
  const content = new FakeSentinelContent({
    files: {
      [`Solutions/${SOLUTION}/Sample Data/crowdstrike_fdr.json`]:
        '{"event_simpleName":"ProcessRollup2","aid":"a"}',
    },
  });
  return { content, source };
}

describe("acquire-samples usecase (lazy per-solution fetch)", () => {
  it("browses sentinel-repo AND elastic samples for a solution", async () => {
    const deps = makeDeps();
    const browse = await browseSamples(deps, { solutionName: SOLUTION });
    const tiers = new Set(browse.map((b) => b.tier));
    expect(tiers.has("sentinel-repo")).toBe(true);
    expect(tiers.has("elastic")).toBe(true);
    // elastic split into TRAFFIC + THREAT
    expect(browse.filter((b) => b.tier === "elastic").map((b) => b.logType).sort()).toEqual([
      "THREAT",
      "TRAFFIC",
    ]);
  });

  it("loads the selected ids across every owning tier (repo, elastic, cribl)", async () => {
    const deps = makeDeps();
    const browse = await browseSamples(deps, { solutionName: SOLUTION });
    const ids = browse.map((b) => b.id);
    ids.push("cribl:cribl_crowdstrike/falcon.json"); // cribl is a load-only tier

    const loaded = await loadSamples(deps, { solutionName: SOLUTION, selectedIds: ids });
    const tiers = new Set(loaded.map((l) => l.tier));
    expect(tiers.has("sentinel-repo")).toBe(true);
    expect(tiers.has("elastic")).toBe(true);
    expect(tiers.has("cribl")).toBe(true);
  });

  it("returns the sentinel-repo resolution alongside the browse entries", async () => {
    const deps = makeDeps();
    const detailed = await browseSamplesDetailed(deps, { solutionName: SOLUTION });
    expect(detailed.available).toEqual(
      await browseSamples(deps, { solutionName: SOLUTION }),
    );
    expect(detailed.repo).not.toBeNull();
    expect(detailed.repo?.samples.length ?? 0).toBeGreaterThan(0);
  });

  it("surfaces the pre-ingested skip in the repo result (Sentinel-schema data)", async () => {
    const content = new FakeSentinelContent({
      files: {
        // A file whose fields are Sentinel POST-ingestion schema markers (>= 3),
        // so the ENG-42 resolver drops it as pre-ingested and reports the skip.
        [`Solutions/${SOLUTION}/Sample Data/crowdstrike_traffic.json`]:
          '{"SourceIP":"1.1.1.1","DestinationIP":"2.2.2.2","SourcePort":80,"DeviceAction":"allow"}',
      },
    });
    const deps: AcquireSamplesDeps = {
      content,
      source: { async listElasticTestFiles() { return []; }, async listCriblPackSamples() { return []; } },
    };
    const detailed = await browseSamplesDetailed(deps, { solutionName: SOLUTION });
    expect(detailed.repo?.samples).toEqual([]);
    expect(detailed.repo?.skippedPreIngested ?? 0).toBeGreaterThan(0);
    expect(detailed.repo?.message).toMatch(/Sentinel schema/);
    // browse entries drop the pre-ingested sample.
    expect(detailed.available.filter((a) => a.tier === "sentinel-repo")).toEqual([]);
  });

  it("ignores ids that match nothing", async () => {
    const deps = makeDeps();
    const loaded = await loadSamples(deps, {
      solutionName: SOLUTION,
      selectedIds: ["elastic:crowdstrike/fdr/test-crowdstrike-fdr.log:NOPE"],
    });
    expect(loaded).toEqual([]);
  });
});

describe("repo-root Sample Data discovery (the legacy primary location)", () => {
  const CEF_LINE =
    "CEF:0|Palo Alto Networks|PAN-OS|10.2|end|TRAFFIC|1|src=10.1.1.1 dst=10.2.2.2 spt=1234 dpt=443 act=allow";

  it("finds keyword-matched files under the repo-root Sample Data tree", async () => {
    const content = new FakeSentinelContent({
      files: {
        // Like PaloAlto-PAN-OS: NO per-solution Sample Data folder at all.
        "Solutions/PaloAlto-PAN-OS/Data Connectors/conn.json": "{}",
        "Sample Data/CEF/PaloAlto_PAN_OS_Traffic_CEF.txt": `${CEF_LINE}
${CEF_LINE}`,
        "Sample Data/CEF/Unrelated_Vendor.txt": "CEF:0|Other|X|1|1|n|5|src=1.1.1.1",
        "Sample Data/README.md": "not a sample",
      },
    });
    const deps: AcquireSamplesDeps = { content, source };
    const detailed = await browseSamplesDetailed(deps, {
      solutionName: "PaloAlto-PAN-OS",
    });
    // The root-dir file was found, read, and survived the ENG-42 scorer.
    expect(detailed.repo).not.toBeNull();
    expect(detailed.repo?.samples.length ?? 0).toBeGreaterThan(0);
    const repoEntries = detailed.available.filter(
      (entry) => entry.tier === "sentinel-repo",
    );
    expect(repoEntries.length).toBeGreaterThan(0);
    // The unrelated vendor's file never matched the solution keywords.
    const allText = JSON.stringify(detailed);
    expect(allText).not.toContain("Unrelated_Vendor");
  });

  it("still resolves nothing for a solution with no matching root files", async () => {
    const content = new FakeSentinelContent({
      files: {
        "Solutions/Acme/Data Connectors/conn.json": "{}",
        "Sample Data/CEF/PaloAlto_PAN_OS_Traffic_CEF.txt": CEF_LINE,
      },
    });
    const deps: AcquireSamplesDeps = { content, source };
    const detailed = await browseSamplesDetailed(deps, { solutionName: "Acme" });
    expect(
      detailed.available.filter((entry) => entry.tier === "sentinel-repo"),
    ).toEqual([]);
  });

  it("skips files the listing reports as oversized without reading them", async () => {
    const content = new FakeSentinelContent({
      files: {
        "Solutions/PaloAlto-PAN-OS/Data Connectors/conn.json": "{}",
        // Over MAX_REPO_SAMPLE_FILE_BYTES: must never be read (the cloud
        // fetch bridge refuses oversized responses).
        "Sample Data/CEF/PaloAlto_PAN_OS_Huge_CEF.txt": `${CEF_LINE}\n`.repeat(
          8000,
        ),
        "Sample Data/CEF/PaloAlto_PAN_OS_Traffic_CEF.txt": CEF_LINE,
      },
    });
    const reads: string[] = [];
    const guarded: typeof content = Object.create(content);
    guarded.readFile = async (path: string) => {
      reads.push(path);
      return content.readFile(path);
    };
    const deps: AcquireSamplesDeps = { content: guarded, source };
    const detailed = await browseSamplesDetailed(deps, {
      solutionName: "PaloAlto-PAN-OS",
    });
    expect(reads).not.toContain("Sample Data/CEF/PaloAlto_PAN_OS_Huge_CEF.txt");
    expect(reads).toContain("Sample Data/CEF/PaloAlto_PAN_OS_Traffic_CEF.txt");
    expect(detailed.repo?.samples.length ?? 0).toBeGreaterThan(0);
  });
});

describe("browse resilience (one failing fetch must not kill the modal)", () => {
  const CEF_LINE =
    "CEF:0|Palo Alto Networks|PAN-OS|10.2|end|TRAFFIC|1|src=10.1.1.1 dst=10.2.2.2 spt=1234 dpt=443 act=allow";

  it("degrades to warnings when every Sentinel content call fails", async () => {
    const failing = new FakeSentinelContent({ files: {} });
    const boom = async () => {
      throw new TypeError("Failed to fetch");
    };
    failing.listSolutionFiles = boom;
    failing.listRepoFiles = boom;
    failing.readFile = boom;
    const deps: AcquireSamplesDeps = { content: failing, source };
    const detailed = await browseSamplesDetailed(deps, { solutionName: SOLUTION });
    // The elastic tier still browsed; the sentinel failures became warnings.
    expect(
      detailed.available.filter((e) => e.tier === "elastic").length,
    ).toBeGreaterThan(0);
    expect(detailed.warnings.length).toBeGreaterThan(0);
    expect(detailed.warnings.join("\n")).toContain("Failed to fetch");
  });

  it("keeps other files when a single read fails", async () => {
    const content = new FakeSentinelContent({
      files: {
        "Solutions/PaloAlto-PAN-OS/Data Connectors/conn.json": "{}",
        "Sample Data/CEF/PaloAlto_PAN_OS_Broken_CEF.txt": CEF_LINE,
        "Sample Data/CEF/PaloAlto_PAN_OS_Traffic_CEF.txt": `${CEF_LINE}\n${CEF_LINE}`,
      },
    });
    const guarded: typeof content = Object.create(content);
    guarded.readFile = async (path: string) => {
      if (path.includes("Broken")) {
        throw new TypeError("Failed to fetch");
      }
      return content.readFile(path);
    };
    const deps: AcquireSamplesDeps = { content: guarded, source };
    const detailed = await browseSamplesDetailed(deps, {
      solutionName: "PaloAlto-PAN-OS",
    });
    expect(detailed.repo?.samples.length ?? 0).toBeGreaterThan(0);
    expect(detailed.warnings.join("\n")).toContain("PaloAlto_PAN_OS_Broken_CEF");
  });

  it("degrades the elastic tier to a warning when its listing fails", async () => {
    const deps: AcquireSamplesDeps = {
      content: new FakeSentinelContent({
        files: {
          [`Solutions/${SOLUTION}/Sample Data/crowdstrike_fdr.json`]:
            '{"event_simpleName":"ProcessRollup2","aid":"a"}',
        },
      }),
      source: {
        async listElasticTestFiles() {
          throw new TypeError("Failed to fetch");
        },
        async listCriblPackSamples() {
          return [];
        },
      },
    };
    const detailed = await browseSamplesDetailed(deps, { solutionName: SOLUTION });
    expect(
      detailed.available.filter((e) => e.tier === "sentinel-repo").length,
    ).toBeGreaterThan(0);
    expect(detailed.warnings.join("\n")).toContain("Elastic samples");
  });
});

describe("stream-scoped log types on collision (web-BLOCKED vs firewall-BLOCKED)", () => {
  const twoStreamSource: RemoteSampleSource = {
    async listElasticTestFiles(pkg, stream) {
      if (pkg !== "zscaler_zia") return [];
      // Two actions per file so the discriminator-based split fires (a
      // single-action file falls back to the filename log type).
      if (stream === "web") {
        return [{
          fileName: "test-web.log",
          content:
            '{"event":{"action":"blocked","b64url":"d3d3Lg==","cltip":"10.0.0.1"}}\n' +
            '{"event":{"action":"allowed","b64url":"d3d3Mg==","cltip":"10.0.0.4"}}',
        }];
      }
      if (stream === "firewall") {
        return [{
          fileName: "test-firewall.log",
          content:
            '{"event":{"action":"blocked","csip":"10.0.0.2","cdip":"10.0.0.3"}}\n' +
            '{"event":{"action":"allowed","csip":"10.0.0.5","cdip":"10.0.0.6"}}',
        }];
      }
      return [];
    },
    async listCriblPackSamples() { return []; },
  };
  const deps: AcquireSamplesDeps = {
    content: new FakeSentinelContent({ files: {} }),
    source: twoStreamSource,
  };

  it("browse shows stream-scoped names while ids keep the raw split name", async () => {
    const browse = (await browseSamples(deps, { solutionName: "Zscaler Internet Access" }))
      .filter((b) => b.tier === "elastic");
    const logTypes = browse.map((b) => b.logType).sort();
    expect(logTypes).toEqual([
      "firewall-ALLOWED",
      "firewall-BLOCKED",
      "web-ALLOWED",
      "web-BLOCKED",
    ]);
    // Selection ids are untouched (browse/load id stability contract).
    for (const b of browse) {
      expect(b.id).toMatch(/:(BLOCKED|ALLOWED)$/);
    }
  });

  it("a subset load still stores the stream-scoped name", async () => {
    const browse = (await browseSamples(deps, { solutionName: "Zscaler Internet Access" }))
      .filter((b) => b.tier === "elastic" && b.logType === "web-BLOCKED");
    const loaded = await loadSamples(deps, {
      solutionName: "Zscaler Internet Access",
      selectedIds: browse.map((b) => b.id),
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].logType).toBe("web-BLOCKED");
  });

  it("single-stream splits stay unprefixed (CrowdStrike contract intact)", async () => {
    const browse = await browseSamples(makeDeps(), { solutionName: SOLUTION });
    const elastic = browse.filter((b) => b.tier === "elastic").map((b) => b.logType).sort();
    expect(elastic).toEqual(["THREAT", "TRAFFIC"]);
  });
});
