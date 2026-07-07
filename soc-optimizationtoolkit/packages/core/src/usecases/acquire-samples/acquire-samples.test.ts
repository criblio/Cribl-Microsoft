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
