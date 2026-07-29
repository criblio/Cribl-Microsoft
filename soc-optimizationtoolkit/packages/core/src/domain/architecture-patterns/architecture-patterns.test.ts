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
  LOG_SOURCES,
  catalogLabel,
  expandResources,
  recommendPatterns,
  unifyPatternDiagrams,
  diagramNodeInfo,
} from "./architecture-patterns";

const PRODUCT_IDS = new Set(CRIBL_PRODUCTS.map((p) => p.id));
const RESOURCE_IDS = new Set(AZURE_RESOURCES.map((r) => r.id));
const SOURCE_IDS = new Set(LOG_SOURCES.map((s) => s.id));

describe("catalog integrity", () => {
  it("has a meaningful catalog with unique pattern ids", () => {
    expect(ARCHITECTURE_PATTERNS.length).toBeGreaterThanOrEqual(8);
    const ids = new Set(ARCHITECTURE_PATTERNS.map((p) => p.id));
    expect(ids.size).toBe(ARCHITECTURE_PATTERNS.length);
  });

  it("every requirement references a real product/resource/source", () => {
    for (const pattern of ARCHITECTURE_PATTERNS) {
      for (const p of pattern.requiresProducts) {
        expect(PRODUCT_IDS.has(p), `${pattern.id}: unknown product ${p}`).toBe(true);
      }
      for (const r of pattern.requiresResources) {
        expect(RESOURCE_IDS.has(r), `${pattern.id}: unknown resource ${r}`).toBe(true);
      }
      for (const s of pattern.requiresSources ?? []) {
        expect(SOURCE_IDS.has(s), `${pattern.id}: unknown source ${s}`).toBe(true);
      }
      expect(
        pattern.requiresProducts.length +
          pattern.requiresResources.length +
          (pattern.requiresSources?.length ?? 0),
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
  it("the data lake implies sentinel AND its workspace", () => {
    const expanded = expandResources(["sentinel-data-lake"]);
    expect(expanded.has("sentinel")).toBe(true);
    expect(expanded.has("log-analytics")).toBe(true);
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
  it("resolves product, resource, source, and unknown ids", () => {
    expect(catalogLabel("stream")).toBe("Cribl Stream");
    expect(catalogLabel("event-hub")).toBe("Event Hub (source into Cribl)");
    expect(catalogLabel("palo-alto-syslog")).toBe("Palo Alto NGFW (syslog)");
    expect(catalogLabel("mystery")).toBe("mystery");
  });
});

describe("log sources and role-split resources (2026-07-29)", () => {
  it("source-ingress patterns stay hidden until their source is selected", () => {
    const withoutSource = recommendPatterns({
      products: ["stream"],
      resources: ["sentinel"],
    });
    expect(
      withoutSource.find((r) => r.pattern.id === "windows-wef-ingress"),
    ).toBeUndefined();

    const withSource = recommendPatterns({
      products: ["stream"],
      resources: ["sentinel"],
      sources: ["windows-wef"],
    });
    const matched = withSource.filter((r) => r.fit === "match").map((r) => r.pattern.id);
    expect(matched).toContain("windows-wef-ingress");
    expect(matched).toContain("direct-dcr");
  });

  it("a selected source can still be one product away (Edge missing)", () => {
    const recs = recommendPatterns({
      products: ["stream"],
      resources: ["sentinel"],
      sources: ["windows-edge"],
    });
    const near = recs.find((r) => r.pattern.id === "windows-edge-ingress");
    expect(near?.fit).toBe("near");
    expect(near?.missing).toEqual(["edge"]);
  });

  it("the AMA path matches with no Cribl products at all", () => {
    const recs = recommendPatterns({
      products: [],
      resources: ["sentinel"],
      sources: ["windows-ama"],
    });
    expect(
      recs.find((r) => r.pattern.id === "windows-ama-direct")?.fit,
    ).toBe("match");
  });

  it("Event Hub roles stay DISTINCT nodes in the unified diagram (no cycle)", () => {
    const fanin = ARCHITECTURE_PATTERNS.find((p) => p.id === "event-hub-fanin")!;
    const egress = ARCHITECTURE_PATTERNS.find((p) => p.id === "event-hub-egress")!;
    const unified = unifyPatternDiagrams([fanin, egress]);
    const labels = unified.nodes.map((n) => n.label);
    expect(labels).toContain("Event Hub");
    expect(labels).toContain("Event Hub (egress)");
    expect(unified.edges.every((e) => e.from !== e.to)).toBe(true);
  });

  it("ADX disambiguates by product: Stream lands it, Search queries it", () => {
    const recs = recommendPatterns({
      products: ["stream", "search"],
      resources: ["adx"],
    });
    const matched = recs.filter((r) => r.fit === "match").map((r) => r.pattern.id);
    expect(matched).toContain("adx-destination");
    expect(matched).toContain("adx-search-in-place");
    // The merged diagram carries ONE ADX node in the land-then-search loop.
    const unified = unifyPatternDiagrams(
      recs.filter((r) => r.fit === "match").map((r) => r.pattern),
    );
    const adxNodes = unified.nodes.filter((n) => n.label === "Azure Data Explorer");
    expect(adxNodes).toHaveLength(1);
    const adxKey = adxNodes[0].id;
    expect(unified.edges.some((e) => e.to === adxKey)).toBe(true);
    expect(unified.edges.some((e) => e.from === adxKey)).toBe(true);
  });
});

describe("Windows collection methods stay distinct (2026-07-29 bug fix)", () => {
  const byId = (id: string) => ARCHITECTURE_PATTERNS.find((p) => p.id === id)!;

  it("WEF, Winlogbeat, and Splunk UF draw three distinct paths into Stream", () => {
    const unified = unifyPatternDiagrams([
      byId("windows-wef-ingress"),
      byId("windows-winlogbeat-ingress"),
      byId("windows-splunk-uf-ingress"),
    ]);
    const intoStream = unified.edges.filter((e) => e.to === "criblstream");
    expect(intoStream.map((e) => e.from).sort()).toEqual([
      "splunkufagents",
      "windowsendpoints",
      "winlogbeatagents",
    ]);
    // The one remaining DIRECT endpoints->Stream edge is the WEF method.
    expect(
      intoStream.find((e) => e.from === "windowsendpoints")?.label,
    ).toBe("WEF (Kerberos/mTLS)");
  });

  it("all six Windows methods merge with exactly one direct endpoints edge", () => {
    const unified = unifyPatternDiagrams([
      byId("windows-wef-ingress"),
      byId("windows-wec-relay"),
      byId("windows-edge-ingress"),
      byId("windows-winlogbeat-ingress"),
      byId("windows-splunk-uf-ingress"),
      byId("windows-ama-direct"),
    ]);
    const labels = unified.nodes.map((n) => n.label);
    for (const expected of [
      "WEC server",
      "Cribl Edge fleet",
      "Winlogbeat agents",
      "Splunk UF agents",
      "Azure Monitor Agent",
    ]) {
      expect(labels).toContain(expected);
    }
    expect(
      unified.edges.filter(
        (e) => e.from === "windowsendpoints" && e.to === "criblstream",
      ),
    ).toHaveLength(1);
  });
});

describe("Sentinel data lake (2026-07-29)", () => {
  it("Stream + data lake matches the tiering pattern with the mirror edge", () => {
    const recs = recommendPatterns({
      products: ["stream"],
      resources: ["sentinel-data-lake"],
    });
    const matched = recs.filter((r) => r.fit === "match").map((r) => r.pattern.id);
    expect(matched).toContain("sentinel-data-lake-tiering");
    // The implied sentinel/log-analytics ALSO light the backbone pattern.
    expect(matched).toContain("direct-dcr");
    const tiering = ARCHITECTURE_PATTERNS.find(
      (p) => p.id === "sentinel-data-lake-tiering",
    )!;
    expect(
      tiering.diagram.edges.some(
        (e) => e.label === "tier mirroring (single copy)",
      ),
    ).toBe(true);
  });

  it("Search over the lake rides the lake KQL query API, not the LA query API", () => {
    const pattern = ARCHITECTURE_PATTERNS.find(
      (p) => p.id === "search-sentinel-data-lake",
    )!;
    expect(
      pattern.diagram.edges.some((e) => e.label === "lake KQL query API"),
    ).toBe(true);
    const considerations = pattern.considerations.join(" ");
    expect(considerations).toContain("api.securityplatform.microsoft.com");
    expect(considerations).toContain("api.loganalytics.io");
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
    // The 2026-07-28 correctness fix: both patterns ride the PUBLIC ingestion
    // path, so their DCR nodes are Kind:Direct and MERGE into one node (a
    // plain "DCR" would wrongly imply a DCE-less non-Direct rule).
    expect(labels.filter((l) => l === "Kind:Direct DCR")).toHaveLength(1);
    expect(labels.filter((l) => l === "DCR")).toHaveLength(0);

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

describe("diagramNodeInfo (2026-07-28 info popovers)", () => {
  it("every catalog node label has a purpose and at least one doc link", () => {
    for (const pattern of ARCHITECTURE_PATTERNS) {
      for (const node of pattern.diagram.nodes) {
        const info = diagramNodeInfo(node.label);
        expect(info, `missing info for '${node.label}' (${pattern.id})`).toBeDefined();
        expect(info!.purpose.length).toBeGreaterThan(20);
        expect(info!.docs.length).toBeGreaterThanOrEqual(1);
        for (const doc of info!.docs) {
          expect(doc.url).toMatch(
            /^https:\/\/(learn\.microsoft\.com|docs\.cribl\.io|packs\.cribl\.io)\//,
          );
          expect(doc.label.length).toBeGreaterThan(3);
        }
      }
    }
  });

  it("resolves by canonical label (case/punctuation insensitive)", () => {
    expect(diagramNodeInfo("kind:direct dcr")).toBeDefined();
    expect(diagramNodeInfo("KIND DIRECT DCR")).toBeDefined();
    expect(diagramNodeInfo("Not A Real Node")).toBeUndefined();
  });

  it("the private path models DCE and DCE-based DCR as distinct nodes", () => {
    const privatePattern = ARCHITECTURE_PATTERNS.find(
      (p) => p.id === "private-ingestion",
    )!;
    const labels = privatePattern.diagram.nodes.map((n) => n.label);
    expect(labels).toContain("Data Collection Endpoint");
    expect(labels).toContain("DCE-based DCR");
    // The DCE fronts the DCR: stream -> dce -> dcr -> workspace.
    const edges = privatePattern.diagram.edges;
    expect(edges.some((e) => e.from === "dce" && e.to === "dcrdce")).toBe(true);
    expect(edges.some((e) => e.from === "dcrdce" && e.to === "law")).toBe(true);
  });
});
