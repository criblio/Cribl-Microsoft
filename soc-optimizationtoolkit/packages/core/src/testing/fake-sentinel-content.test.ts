/**
 * Contract tests for FakeSentinelContent + FakeContentCache (porting-plan
 * Unit 14). The fake computes recursion and deprecation with the real domain
 * helpers, so these pin the port's semantics.
 */
import { describe, expect, it } from "vitest";
import { FakeContentCache, FakeSentinelContent } from "./fake-sentinel-content";

const content = new FakeSentinelContent({
  commitSha: "deadbeef0000",
  files: {
    "Solutions/Acme/Data Connectors/Acme.json": '{ "title": "Acme" }',
    "Solutions/Acme/Data Connectors/nested/Acme_DCR.json": '{ "resources": [] }',
    "Solutions/Acme/Analytic Rules/r1.yaml": "id: 1",
    "Solutions/Acme/Analytic Rules/r2.yaml": "id: 2",
    // A deprecated solution (all connectors carry [Deprecated]).
    "Solutions/OldVendor/Data Connectors/Old.json": '{ "title": "[Deprecated] Old" }',
    // A solution deprecated by its directory name.
    "Solutions/Legacy Thing (Legacy)/Data Connectors/x.json": '{ "title": "x" }',
  },
});

describe("FakeSentinelContent", () => {
  it("listSolutions sorts by name and annotates deprecation", async () => {
    const sols = await content.listSolutions();
    expect(sols.map((s) => s.name)).toEqual([
      "Acme",
      "Legacy Thing (Legacy)",
      "OldVendor",
    ]);
    const acme = sols.find((s) => s.name === "Acme");
    expect(acme?.deprecated).toBeUndefined();

    const old = sols.find((s) => s.name === "OldVendor");
    expect(old).toMatchObject({ deprecated: true, deprecationReason: "All connectors deprecated" });

    const legacy = sols.find((s) => s.name === "Legacy Thing (Legacy)");
    expect(legacy).toMatchObject({ deprecated: true, deprecationReason: "Solution marked as legacy" });
  });

  it("listSolutionFiles returns direct children only (non-recursive)", async () => {
    const rules = await content.listSolutionFiles("Acme", "Analytic Rules");
    expect(rules.map((f) => f.name)).toEqual(["r1.yaml", "r2.yaml"]);
    // The nested connector under Data Connectors/nested is NOT a direct child.
    const conn = await content.listSolutionFiles("Acme", "Data Connectors");
    expect(conn.map((f) => f.name)).toEqual(["Acme.json"]);
  });

  it("listConnectorFiles recurses into nested dirs", async () => {
    const files = await content.listConnectorFiles("Acme");
    expect(files.map((f) => f.name).sort()).toEqual(["Acme.json", "Acme_DCR.json"]);
  });

  it("readFile / rawFetch resolve content or null; getCommitSha is the seed", async () => {
    expect(await content.readFile("Solutions/Acme/Data Connectors/Acme.json")).toBe(
      '{ "title": "Acme" }',
    );
    expect(await content.readFile("Solutions/Acme/missing.json")).toBeNull();
    expect(await content.rawFetch("Solutions/Acme/Data Connectors/Acme.json", "ignored")).toBe(
      '{ "title": "Acme" }',
    );
    expect(await content.getCommitSha()).toBe("deadbeef0000");
  });
});

describe("FakeContentCache", () => {
  it("get is null on a miss, echoes a deep copy on a hit", async () => {
    const cache = new FakeContentCache();
    expect(await cache.get("k")).toBeNull();
    await cache.set("k", { a: [1, 2] });
    expect(await cache.get("k")).toEqual({ a: [1, 2] });
    expect(cache.size).toBe(1);
  });
});
