/**
 * architecture-patterns pins: catalog integrity (unique ids, valid
 * requirements, well-formed diagrams) and the recommender contract (matches
 * before nears, specificity ordering, the sentinel-implies-log-analytics
 * expansion, empty-selection silence).
 */

import { describe, expect, it } from "vitest";

import {
  ARCHITECTURE_PATTERNS,
  AZURE_RESOURCES,
  CRIBL_PRODUCTS,
  catalogLabel,
  expandResources,
  recommendPatterns,
  unifyPatternDiagrams,
} from "./architecture-patterns";

const PRODUCT_IDS = new Set(CRIBL_PRODUCTS.map((p) => p.id));
const RESOURCE_IDS = new Set(AZURE_RESOURCES.map((r) => r.id));

describe("catalog integrity", () => {
  it("has a meaningful catalog with unique pattern ids", () => {
    expect(ARCHITECTURE_PATTERNS.length).toBeGreaterThanOrEqual(8);
    const ids = new Set(ARCHITECTURE_PATTERNS.map((p) => p.id));
    expect(ids.size).toBe(ARCHITECTURE_PATTERNS.length);
  });

  it("every requirement references a real product/resource", () => {
    for (const pattern of ARCHITECTURE_PATTERNS) {
      for (const p of pattern.requiresProducts) {
        expect(PRODUCT_IDS.has(p), `${pattern.id}: unknown product ${p}`).toBe(true);
      }
      for (const r of pattern.requiresResources) {
        expect(RESOURCE_IDS.has(r), `${pattern.id}: unknown resource ${r}`).toBe(true);
      }
      expect(
        pattern.requiresProducts.length + pattern.requiresResources.length,
        `${pattern.id}: needs at least one requirement`,
      ).toBeGreaterThan(0);
    }
  });

  it("every diagram is well-formed (edges reference nodes, unique node ids)", () => {
    for (const pattern of ARCHITECTURE_PATTERNS) {
      const nodeIds = new Set(pattern.diagram.nodes.map((n) => n.id));
      expect(nodeIds.size).toBe(pattern.diagram.nodes.length);
      expect(pattern.diagram.nodes.length).toBeGreaterThanOrEqual(3);
      for (const edge of pattern.diagram.edges) {
        expect(nodeIds.has(edge.from), `${pattern.id}: edge from ${edge.from}`).toBe(true);
        expect(nodeIds.has(edge.to), `${pattern.id}: edge to ${edge.to}`).toBe(true);
      }
    }
  });

  it("every pattern carries rationale and considerations", () => {
    for (const pattern of ARCHITECTURE_PATTERNS) {
      expect(pattern.summary.length).toBeGreaterThan(20);
      expect(pattern.why.length).toBeGreaterThan(20);
      expect(pattern.considerations.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("expandResources", () => {
  it("sentinel implies log-analytics", () => {
    expect(expandResources(["sentinel"]).has("log-analytics")).toBe(true);
  });
  it("log-analytics alone does not imply sentinel", () => {
    expect(expandResources(["log-analytics"]).has("sentinel")).toBe(false);
  });
});

describe("recommendPatterns", () => {
  it("recommends nothing for an empty selection", () => {
    expect(recommendPatterns({ products: [], resources: [] })).toEqual([]);
  });

  it("the app's MVP combo (Stream + Sentinel) matches Direct DCR ingestion", () => {
    const recs = recommendPatterns({ products: ["stream"], resources: ["sentinel"] });
    const matched = recs.filter((r) => r.fit === "match").map((r) => r.pattern.id);
    expect(matched).toContain("direct-dcr");
  });

  it("adding Event Hub also matches the fan-in pattern", () => {
    const recs = recommendPatterns({
      products: ["stream"],
      resources: ["sentinel", "event-hub"],
    });
    const matched = recs.filter((r) => r.fit === "match").map((r) => r.pattern.id);
    expect(matched).toContain("event-hub-fanin");
    expect(matched).toContain("direct-dcr");
  });

  it("matches rank before nears; more specific matches rank first", () => {
    const recs = recommendPatterns({
      products: ["stream"],
      resources: ["sentinel", "event-hub", "entra-diagnostics"],
    });
    const fits = recs.map((r) => r.fit);
    expect(fits.indexOf("near")).toBeGreaterThanOrEqual(
      fits.lastIndexOf("match") === -1 ? 0 : fits.lastIndexOf("match"),
    );
    // entra-reroute (4 requirements) outranks direct-dcr (2) among matches.
    const matchedIds = recs.filter((r) => r.fit === "match").map((r) => r.pattern.id);
    expect(matchedIds.indexOf("entra-reroute")).toBeLessThan(
      matchedIds.indexOf("direct-dcr"),
    );
  });

  it("a near-miss names exactly the one missing selection", () => {
    // Everything for entra-reroute except Sentinel.
    const recs = recommendPatterns({
      products: ["stream"],
      resources: ["event-hub", "entra-diagnostics"],
    });
    const near = recs.find((r) => r.pattern.id === "entra-reroute");
    expect(near?.fit).toBe("near");
    expect(near?.missing).toEqual(["sentinel"]);
  });

  it("patterns missing two or more requirements are not offered", () => {
    const recs = recommendPatterns({ products: ["search"], resources: [] });
    // search-in-place needs blob-storage too -> near (one missing), fine;
    // but lake-tiering (stream+lake+sentinel) misses three -> absent.
    expect(recs.find((r) => r.pattern.id === "lake-tiering")).toBeUndefined();
    expect(recs.find((r) => r.pattern.id === "search-in-place")?.fit).toBe("near");
  });
});

describe("catalogLabel", () => {
  it("resolves product, resource, and unknown ids", () => {
    expect(catalogLabel("stream")).toBe("Cribl Stream");
    expect(catalogLabel("event-hub")).toBe("Azure Event Hub");
    expect(catalogLabel("mystery")).toBe("mystery");
  });
});

describe("unifyPatternDiagrams", () => {
  it("returns an empty graph for no patterns", () => {
    expect(unifyPatternDiagrams([])).toEqual({ nodes: [], edges: [] });
  });

  it("merges shared-label nodes across patterns and dedupes edges", () => {
    const directDcr = ARCHITECTURE_PATTERNS.find((p) => p.id === "direct-dcr");
    const eventHub = ARCHITECTURE_PATTERNS.find((p) => p.id === "event-hub-fanin");
    expect(directDcr && eventHub).toBeTruthy();
    const unified = unifyPatternDiagrams([directDcr!, eventHub!]);

    // "Cribl Stream" and "Sentinel / LA" appear in both -> one node each.
    const labels = unified.nodes.map((n) => n.label);
    expect(labels.filter((l) => l === "Cribl Stream")).toHaveLength(1);
    expect(labels.filter((l) => l === "Sentinel / LA")).toHaveLength(1);

    // Node ids are canonical keys and edges reference them.
    const streamKey = unified.nodes.find((n) => n.label === "Cribl Stream")?.id;
    expect(streamKey).toBe("criblstream");
    expect(unified.edges.every((e) => e.from !== e.to)).toBe(true);
    // Every edge endpoint resolves to a node in the unified set.
    const ids = new Set(unified.nodes.map((n) => n.id));
    expect(unified.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });

  it("carries a single canonical graph for one pattern (idempotent shape)", () => {
    const p = ARCHITECTURE_PATTERNS.find((x) => x.id === "direct-dcr")!;
    const unified = unifyPatternDiagrams([p]);
    expect(unified.nodes).toHaveLength(p.diagram.nodes.length);
    expect(unified.edges).toHaveLength(p.diagram.edges.length);
  });
});
