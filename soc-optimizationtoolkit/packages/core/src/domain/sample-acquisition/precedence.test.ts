import { describe, expect, it } from "vitest";

import {
  selectByPrecedence,
  browseElasticFile,
  loadElasticFile,
  readCriblPackSamples,
  resolveUserSamples,
  resolveRepoSamples,
  browseRepoResult,
  loadRepoResult,
  type ElasticFile,
  type ResolvedSample,
  type SampleTier,
} from "./index";

describe("selectByPrecedence (user > cribl > elastic > synthesized)", () => {
  const s = (tier: SampleTier): ResolvedSample => ({
    tableName: "T",
    format: "json",
    rawEvents: ["{}"],
    source: `${tier}:x`,
    tier,
  });

  it("cribl beats elastic", () => {
    const out = selectByPrecedence(
      new Map([
        ["elastic", [s("elastic")]],
        ["cribl", [s("cribl")]],
      ]),
    );
    expect(out.map((x) => x.tier)).toEqual(["cribl"]);
  });

  it("user beats everything", () => {
    const out = selectByPrecedence(
      new Map([
        ["cribl", [s("cribl")]],
        ["user", [s("user")]],
      ]),
    );
    expect(out.map((x) => x.tier)).toEqual(["user"]);
  });

  it("falls through to elastic when higher tiers are empty", () => {
    const out = selectByPrecedence(new Map([["elastic", [s("elastic")]]]));
    expect(out.map((x) => x.tier)).toEqual(["elastic"]);
  });

  it("returns [] when every tier is empty", () => {
    expect(selectByPrecedence(new Map())).toEqual([]);
  });
});

describe("elastic browse/load ID STABILITY (the top footgun)", () => {
  const file: ElasticFile = {
    packageName: "panw",
    stream: "panos",
    fileName: "test.log",
    content: '{"type":"traffic","src":"10.0.0.1"}\n{"type":"threat","src":"10.0.0.2"}',
  };

  it("browse ids are the SAME across repeated calls", () => {
    const a = browseElasticFile(file).map((x) => x.id);
    const b = browseElasticFile(file).map((x) => x.id);
    expect(a).toEqual(b);
    expect(a).toEqual([
      "elastic:panw/panos/test.log:TRAFFIC",
      "elastic:panw/panos/test.log:THREAT",
    ]);
  });

  it("a browsed id round-trips through load (selection does not break)", () => {
    const browseId = "elastic:panw/panos/test.log:TRAFFIC";
    const loaded = loadElasticFile(file, new Set([browseId]), "CommonSecurityLog");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].source).toBe(browseId);
    expect(loaded[0].tableName).toBe("CommonSecurityLog");
    expect(loaded[0].logType).toBe("TRAFFIC");
  });
});

describe("event caps (50 / 50 / 100)", () => {
  it("elastic caps at 50 events per file (before split)", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `{"type":"x","n":${i}}`).join("\n");
    const [split] = browseElasticFile({
      packageName: "pkg",
      stream: "log",
      fileName: "f.log",
      content: lines,
    });
    expect(split.eventCount).toBe(50);
  });

  it("cribl caps at 50 events per file", () => {
    const arr = Array.from({ length: 60 }, (_, i) => ({ _raw: `line ${i}`, _time: i }));
    const [sample] = readCriblPackSamples("cribl-x", "CommonSecurityLog", [
      { fileName: "s.json", content: JSON.stringify(arr) },
    ]);
    expect(sample.rawEvents).toHaveLength(50);
    expect(sample.source).toBe("cribl:cribl-x/s.json");
    expect(sample.tier).toBe("cribl");
    expect(sample.logType).toBe("s");
  });

  it("user samples cap at 100 events", () => {
    const arr = Array.from({ length: 150 }, (_, i) => ({ n: i }));
    const [sample] = resolveUserSamples(
      [{ logType: "mylog", content: JSON.stringify(arr), fileName: "u.json" }],
      "Sol",
    );
    expect(sample.rawEvents).toHaveLength(100);
    expect(sample.tier).toBe("user");
    expect(sample.tableName).toBe("mylog");
  });
});

describe("cribl envelope unwrap", () => {
  it("pulls _raw out of the Cribl event envelope", () => {
    const [sample] = readCriblPackSamples("repo", "T", [
      {
        fileName: "asa.json",
        content: JSON.stringify([{ _raw: "%ASA-6-1: built", _time: 1 }]),
      },
    ]);
    expect(sample.rawEvents).toEqual(["%ASA-6-1: built"]);
  });
});

describe("sentinel-repo browse/load round-trip", () => {
  const solution = "CrowdStrike Falcon Endpoint Protection";
  const content =
    '{"event_simpleName":"ProcessRollup2","aid":"a"}\n{"event_simpleName":"DnsRequest","aid":"b"}';

  it("browse ids round-trip through load", () => {
    const result = resolveRepoSamples(solution, [
      { fileName: "crowdstrike_fdr.json", content },
    ]);
    const browse = browseRepoResult(result);
    expect(browse.length).toBeGreaterThan(0);
    const ids = browse.map((b) => b.id);
    const loaded = loadRepoResult(result, new Set(ids));
    expect(loaded.length).toBe(browse.length);
    for (const l of loaded) {
      expect(l.tier).toBe("sentinel-repo");
      expect(l.source.startsWith("sentinel-repo:")).toBe(true);
    }
  });
});
