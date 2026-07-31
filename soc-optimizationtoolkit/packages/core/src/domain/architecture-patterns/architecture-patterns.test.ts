/**
 * architecture-patterns pins: catalog integrity (unique ids, valid
 * requirements, well-formed diagrams) and the recommender contract (matches
 * before nears, specificity ordering, the sentinel-implies-log-analytics
 * expansion, empty-selection silence).
 */

import { describe, expect, it } from "vitest";

import {
  ARCHITECTURE_PATTERNS,
  ARCHITECTURE_PRESETS,
  AZURE_RESOURCES,
  CRIBL_PRODUCTS,
  LOG_SOURCES,
  PRODUCT_WHEN_TO_USE,
  applySentinelOverlay,
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

describe("ARCHITECTURE_PRESETS and PRODUCT_WHEN_TO_USE (2026-07-29)", () => {
  it("preset ids are unique with real copy", () => {
    const ids = new Set(ARCHITECTURE_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(ARCHITECTURE_PRESETS.length);
    for (const preset of ARCHITECTURE_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(3);
      expect(preset.description.length).toBeGreaterThan(20);
    }
  });

  it("every preset selection id resolves in the catalogs", () => {
    for (const preset of ARCHITECTURE_PRESETS) {
      for (const p of preset.selection.products) {
        expect(PRODUCT_IDS.has(p), `${preset.id}: ${p}`).toBe(true);
      }
      for (const r of preset.selection.resources) {
        expect(RESOURCE_IDS.has(r), `${preset.id}: ${r}`).toBe(true);
      }
      for (const s of preset.selection.sources ?? []) {
        expect(SOURCE_IDS.has(s), `${preset.id}: ${s}`).toBe(true);
      }
    }
  });

  it("every preset yields at least one full match", () => {
    for (const preset of ARCHITECTURE_PRESETS) {
      const recs = recommendPatterns(preset.selection);
      expect(
        recs.some((r) => r.fit === "match"),
        `${preset.id} matched nothing`,
      ).toBe(true);
    }
  });

  it("headline patterns stay pinned to their presets", () => {
    const matchedIds = (presetId: string): string[] => {
      const preset = ARCHITECTURE_PRESETS.find((p) => p.id === presetId)!;
      return recommendPatterns(preset.selection)
        .filter((r) => r.fit === "match")
        .map((r) => r.pattern.id);
    };
    expect(matchedIds("siem-migration-splunk")).toContain("windows-splunk-uf-ingress");
    expect(matchedIds("cost-reduction-archive")).toEqual(
      expect.arrayContaining(["blob-archive-replay", "search-in-place"]),
    );
    expect(matchedIds("long-term-retention-sdl")).toContain(
      "sentinel-data-lake-tiering",
    );
    expect(matchedIds("private-regulated")).toContain("private-ingestion");
    expect(matchedIds("azure-platform-fanin")).toContain("entra-reroute");
    expect(matchedIds("windows-estate")).toEqual(
      expect.arrayContaining(["windows-edge-ingress", "windows-wec-relay"]),
    );
  });

  it("every product carries when-to-use copy in the shared voice", () => {
    for (const product of CRIBL_PRODUCTS) {
      const text = PRODUCT_WHEN_TO_USE[product.id];
      expect(text.length).toBeGreaterThan(30);
      expect(text.startsWith("Use ")).toBe(true);
    }
  });
});

describe("edge cost tiers (2026-07-29)", () => {
  // The RULE from the DiagramEdge doc: cost is a function of the TARGET
  // node's label class. Pinned here over the whole catalog so a new pattern
  // cannot mis-tag an edge.
  // Splunk indexers: per-GB license-billed ingest (2026-07-30) - premium
  // like the analytics tier, stated vendor-neutrally as a billing fact.
  const PREMIUM_TARGETS = new Set([
    "loganalyticsworkspace",
    "customclalias",
    "splunkindexers",
  ]);
  const ECONOMICAL_TARGETS = new Set([
    "blobarchive",
    "cribllake",
    "sentineldatalake",
    "azuredataexplorer",
    "eventhubegress",
    "auxiliaryplantable",
  ]);
  const canonical = (label: string) => label.toLowerCase().replace(/[^a-z0-9]/g, "");

  it("every catalog edge follows the target-class cost rule", () => {
    for (const pattern of ARCHITECTURE_PATTERNS) {
      const labelById = new Map(pattern.diagram.nodes.map((n) => [n.id, n.label]));
      for (const edge of pattern.diagram.edges) {
        const targetKey = canonical(labelById.get(edge.to) ?? "");
        if (PREMIUM_TARGETS.has(targetKey)) {
          expect(edge.cost, `${pattern.id}: ${edge.from}->${edge.to}`).toBe("premium");
        } else if (ECONOMICAL_TARGETS.has(targetKey)) {
          expect(edge.cost, `${pattern.id}: ${edge.from}->${edge.to}`).toBe(
            "economical",
          );
        } else {
          expect(edge.cost, `${pattern.id}: ${edge.from}->${edge.to}`).toBeUndefined();
        }
      }
    }
  });

  it("no canonical edge pair carries two different costs (first-wins safety)", () => {
    const seen = new Map<string, string>();
    for (const pattern of ARCHITECTURE_PATTERNS) {
      const labelById = new Map(pattern.diagram.nodes.map((n) => [n.id, n.label]));
      for (const edge of pattern.diagram.edges) {
        const key = `${canonical(labelById.get(edge.from) ?? "")}>${canonical(labelById.get(edge.to) ?? "")}`;
        const cost = edge.cost ?? "none";
        const prior = seen.get(key);
        if (prior !== undefined) {
          expect(cost, `conflicting cost on ${key}`).toBe(prior);
        }
        seen.set(key, cost);
      }
    }
  });

  it("cost survives the unify merge", () => {
    const directDcr = ARCHITECTURE_PATTERNS.find((p) => p.id === "direct-dcr")!;
    const unified = unifyPatternDiagrams([directDcr]);
    expect(
      unified.edges.find((e) => e.from === "kinddirectdcr" && e.to === "loganalyticsworkspace")
        ?.cost,
    ).toBe("premium");
    const blob = ARCHITECTURE_PATTERNS.find((p) => p.id === "blob-archive-replay")!;
    const lake = ARCHITECTURE_PATTERNS.find((p) => p.id === "lake-tiering")!;
    const merged = unifyPatternDiagrams([blob, lake]);
    expect(
      merged.edges.find((e) => e.from === "criblstream" && e.to === "blobarchive")?.cost,
    ).toBe("economical");
    // The hot subset rides the Logs Ingestion API: Stream never writes the
    // workspace directly - it goes through the Kind:Direct DCR (user report
    // 2026-07-29: cost-reduction showed Stream -> LogA without a DCR).
    expect(
      merged.edges.some(
        (e) => e.from === "criblstream" && e.to === "loganalyticsworkspace",
      ),
    ).toBe(false);
    expect(
      merged.edges.some((e) => e.from === "criblstream" && e.to === "kinddirectdcr"),
    ).toBe(true);
    expect(
      merged.edges.find(
        (e) => e.from === "kinddirectdcr" && e.to === "loganalyticsworkspace",
      )?.cost,
    ).toBe("premium");
  });
});

describe("Splunk SIEM migration pattern (2026-07-30)", () => {
  it("tells before (subdued), during (dual-run), and after in one diagram", () => {
    const pattern = ARCHITECTURE_PATTERNS.find(
      (p) => p.id === "splunk-siem-migration",
    )!;
    // The BEFORE topology runs through the Heavy Forwarder tier, subdued.
    const beforeUfHf = pattern.diagram.edges.find(
      (e) => e.from === "uf" && e.to === "hf",
    )!;
    expect(beforeUfHf.muted).toBe(true);
    expect(beforeUfHf.label).toContain("before");
    const beforeHfSplunk = pattern.diagram.edges.find(
      (e) => e.from === "hf" && e.to === "splunk",
    )!;
    expect(beforeHfSplunk.muted).toBe(true);
    // Splunk ingest is license-billed per GB - premium, before AND during
    // (dual-run pays both bills; the considerations say to time-box it).
    expect(beforeHfSplunk.cost).toBe("premium");
    expect(
      pattern.diagram.edges.find((e) => e.from === "stream" && e.to === "splunk")
        ?.cost,
    ).toBe("premium");
    // The HF tier is ALSO the temporary during-migration intercept point.
    const hfBridge = pattern.diagram.edges.find(
      (e) => e.from === "hf" && e.to === "stream",
    )!;
    expect(hfBridge.muted).toBeUndefined();
    expect(hfBridge.label).toContain("during");
    expect(hfBridge.label).toContain("temporary");
    expect(
      pattern.diagram.edges.find((e) => e.from === "uf" && e.to === "stream")
        ?.label,
    ).toContain("after");
    expect(
      pattern.diagram.edges.find((e) => e.from === "stream" && e.to === "splunk")
        ?.label,
    ).toContain("dual-run");
    // The after state lands in Sentinel through the DCR at analytics rates.
    expect(
      pattern.diagram.edges.find((e) => e.from === "dcr" && e.to === "law")?.cost,
    ).toBe("premium");
    // The story is phased - all five phases are in the considerations.
    const text = pattern.considerations.join(" ");
    for (const phase of ["Phase 1", "Phase 2", "Phase 3", "Phase 4", "Phase 5"]) {
      expect(text).toContain(phase);
    }
  });

  it("matches the SIEM-migration preset and the muted edge survives unify", () => {
    const preset = ARCHITECTURE_PRESETS.find(
      (p) => p.id === "siem-migration-splunk",
    )!;
    const recs = recommendPatterns(preset.selection);
    const matches = recs.filter((r) => r.fit === "match");
    expect(matches.map((r) => r.pattern.id)).toContain("splunk-siem-migration");
    const unified = unifyPatternDiagrams(matches.map((r) => r.pattern));
    expect(
      unified.edges.find(
        (e) => e.from === "splunkheavyforwarders" && e.to === "splunkindexers",
      )?.muted,
    ).toBe(true);
  });
});

describe("workspace log tiers (2026-07-30 cost-reduction realism)", () => {
  it("splits Analytics vs Auxiliary, summary rules lift aggregates back", () => {
    const pattern = ARCHITECTURE_PATTERNS.find(
      (p) => p.id === "workspace-log-tiers",
    )!;
    expect(
      pattern.diagram.edges.find((e) => e.from === "dcr" && e.to === "aux")?.cost,
    ).toBe("economical");
    // Summary-rule output bills as Analytics ingest - small on purpose.
    const summary = pattern.diagram.edges.find(
      (e) => e.from === "aux" && e.to === "law",
    )!;
    expect(summary.label).toContain("summary rules");
    expect(summary.cost).toBe("premium");
    const text = pattern.considerations.join(" ");
    expect(text).toContain("SUMMARY RULES");
    expect(text).toContain("single-table");
    expect(text).toContain("Basic plan");
  });

  it("the cost-reduction preset now yields the full tiering story", () => {
    const preset = ARCHITECTURE_PRESETS.find(
      (p) => p.id === "cost-reduction-archive",
    )!;
    const matched = recommendPatterns(preset.selection)
      .filter((r) => r.fit === "match")
      .map((r) => r.pattern.id);
    expect(matched).toEqual(
      expect.arrayContaining([
        "blob-archive-replay",
        "search-in-place",
        "workspace-log-tiers",
      ]),
    );
    // The reduction MECHANISM is stated, not implied.
    const blob = ARCHITECTURE_PATTERNS.find((p) => p.id === "blob-archive-replay")!;
    expect(blob.considerations.join(" ")).toContain("BEFORE the DCR");
    expect(
      blob.diagram.edges.find((e) => e.from === "stream" && e.to === "dcr")?.label,
    ).toBe("reduced hot subset");
  });
});

describe("Search send path (2026-07-29)", () => {
  const SEARCH_PATTERN_IDS = [
    "search-in-place",
    "search-sentinel-data-lake",
    "adx-search-in-place",
  ];

  it("findings return THROUGH Stream and the DCR - never straight to the workspace", () => {
    for (const id of SEARCH_PATTERN_IDS) {
      const pattern = ARCHITECTURE_PATTERNS.find((p) => p.id === id)!;
      const edges = pattern.diagram.edges;
      expect(
        edges.some((e) => e.from === "search" && e.to === "law"),
        `${id}: direct search->workspace edge`,
      ).toBe(false);
      expect(
        edges.find((e) => e.from === "search" && e.to === "stream")?.label,
        `${id}: send leg`,
      ).toBe("send findings (Cribl HTTP source)");
      expect(
        edges.some((e) => e.from === "stream" && e.to === "dcr"),
        `${id}: stream->dcr leg`,
      ).toBe(true);
      expect(
        edges.find((e) => e.from === "dcr" && e.to === "law")?.cost,
        `${id}: workspace leg stays premium`,
      ).toBe("premium");
      // Every leg of the send path carries the distinct color tone.
      for (const e of edges.filter((x) => x.from !== "blob" && x.from !== "sdl" && x.from !== "adx")) {
        expect(e.tone, `${id}: ${e.from}->${e.to} tone`).toBe("search");
      }
    }
  });

  it("the tone survives the unify merge", () => {
    const pattern = ARCHITECTURE_PATTERNS.find((p) => p.id === "search-in-place")!;
    const unified = unifyPatternDiagrams([pattern]);
    expect(
      unified.edges.find((e) => e.from === "criblsearch" && e.to === "criblstream")
        ?.tone,
    ).toBe("search");
  });
});

describe("Sentinel layering and per-service private endpoints (2026-07-29)", () => {
  it("selecting Sentinel tags the workspace card - no separate node", () => {
    // Sentinel is a SERVICE riding on the workspace (user directive
    // 2026-07-29): the overlay tags the Log Analytics card's corner instead
    // of chaining a "Microsoft Sentinel" node after it.
    const selection = {
      products: ["stream"],
      resources: ["sentinel"],
    } as const;
    const recs = recommendPatterns(selection);
    const matches = recs.filter((r) => r.fit === "match");
    const unified = applySentinelOverlay(
      unifyPatternDiagrams(matches.map((r) => r.pattern)),
      selection,
    );
    const labels = unified.nodes.map((n) => n.label);
    expect(labels.filter((l) => l === "Log Analytics workspace")).toHaveLength(1);
    expect(labels).not.toContain("Microsoft Sentinel");
    const workspace = unified.nodes.find(
      (n) => n.label === "Log Analytics workspace",
    )!;
    expect(workspace.overlays).toEqual(["Microsoft Sentinel"]);
    // Applying twice never duplicates the tag.
    const again = applySentinelOverlay(unified, selection);
    expect(
      again.nodes.find((n) => n.label === "Log Analytics workspace")!.overlays,
    ).toEqual(["Microsoft Sentinel"]);
  });

  it("Log Analytics alone draws the workspace WITHOUT the Sentinel tag", () => {
    const selection = {
      products: ["stream"],
      resources: ["log-analytics"],
    } as const;
    const recs = recommendPatterns(selection);
    const matches = recs.filter((r) => r.fit === "match");
    const unified = applySentinelOverlay(
      unifyPatternDiagrams(matches.map((r) => r.pattern)),
      selection,
    );
    const labels = unified.nodes.map((n) => n.label);
    expect(labels).toContain("Log Analytics workspace");
    expect(labels).not.toContain("Microsoft Sentinel");
    for (const node of unified.nodes) {
      expect(node.overlays ?? []).toHaveLength(0);
    }
  });

  it("the blanket private-link resource is replaced by four specific ones", () => {
    const ids = RESOURCE_IDS as Set<string>;
    expect(ids.has("private-link")).toBe(false);
    for (const id of [
      "private-link-law",
      "private-link-blob",
      "private-link-eventhub",
      "private-link-adx",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("private-endpoint patterns draw the DNS and vNet-path requirements", () => {
    const expectations: Array<[string, string]> = [
      ["private-blob-endpoint", "DNS: privatelink.blob.core.windows.net"],
      ["private-eventhub-endpoint", "DNS: privatelink.servicebus.windows.net"],
      ["private-adx-endpoint", "DNS: privatelink.kusto.windows.net"],
      ["private-ingestion", "DNS: privatelink.monitor.azure.com"],
    ];
    for (const [patternId, dnsLabel] of expectations) {
      const pattern = ARCHITECTURE_PATTERNS.find((p) => p.id === patternId)!;
      const labels = pattern.diagram.nodes.map((n) => n.label);
      expect(labels, patternId).toContain(dnsLabel);
      expect(
        pattern.diagram.edges.some((e) => e.label === "resolves to the private IP"),
        `${patternId}: DNS edge`,
      ).toBe(true);
      // The worker reaches OUT to the DNS zone (user report 2026-07-29: the
      // DNS object floated with nothing connecting the worker to it).
      const dnsId = pattern.diagram.nodes.find((n) => n.label === dnsLabel)!.id;
      expect(
        pattern.diagram.edges.some(
          (e) =>
            e.from === "stream" && e.to === dnsId && e.label === "worker DNS lookup",
        ),
        `${patternId}: worker lookup edge`,
      ).toBe(true);
      expect(
        pattern.diagram.edges.some((e) => e.label?.includes("vNet path") === true) ||
          patternId === "private-eventhub-endpoint",
        `${patternId}: path edge`,
      ).toBe(true);
    }
  });

  it("blob private endpoint matches with the role-split selection", () => {
    const recs = recommendPatterns({
      products: ["stream"],
      resources: ["blob-storage", "private-link-blob"],
    });
    expect(
      recs.filter((r) => r.fit === "match").map((r) => r.pattern.id),
    ).toContain("private-blob-endpoint");
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
    ).toBe("WEF source (Kerberos/mTLS)");
  });

  it("every ingress edge into Stream names its Cribl source type", () => {
    // 2026-07-29 user direction: the visual must say WHICH Cribl source
    // receives the feed (Syslog source, Splunk TCP source, ...).
    const expectations: Array<[string, string]> = [
      ["palo-alto-syslog-ingress", "Syslog source (514/6514, CSV/CEF)"],
      ["windows-wef-ingress", "WEF source (Kerberos/mTLS)"],
      ["windows-winlogbeat-ingress", "Elasticsearch API source"],
      ["windows-splunk-uf-ingress", "Splunk TCP source (S2S)"],
      ["event-hub-fanin", "Azure Event Hubs source"],
      ["entra-reroute", "Azure Event Hubs source"],
      ["vnet-flow-collection", "Azure Blob source (scheduled)"],
      ["blob-collector", "Azure Blob source (scheduled)"],
    ];
    for (const [patternId, label] of expectations) {
      const pattern = ARCHITECTURE_PATTERNS.find((p) => p.id === patternId)!;
      expect(
        pattern.diagram.edges.some((e) => e.label === label),
        `${patternId}: missing "${label}"`,
      ).toBe(true);
    }
    const replay = ARCHITECTURE_PATTERNS.find((p) => p.id === "blob-archive-replay")!;
    expect(
      replay.diagram.edges.some((e) => e.label === "replay (Azure Blob source)"),
    ).toBe(true);
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
    // The only fitting Cribl Search provider is the GENERIC HTTP API one -
    // the Azure API provider covers four management endpoints, not KQL.
    expect(considerations).toContain("GENERIC HTTP API");
    // Auxiliary tables are reachable pre-onboarding via /search, post via
    // the lake endpoint (2026-07-31 research).
    expect(considerations).toContain("/search REST API");
  });

  it("the lake promotes on demand and supersedes the Auxiliary plan (2026-07-31)", () => {
    const tiering = ARCHITECTURE_PATTERNS.find(
      (p) => p.id === "sentinel-data-lake-tiering",
    )!;
    const promote = tiering.diagram.edges.find(
      (e) => e.from === "sdl" && e.to === "law",
    );
    expect(promote?.label).toBe("promote on demand (KQL jobs)");
    // Promoted data bills as analytics ingest - premium on purpose.
    expect(promote?.cost).toBe("premium");
    expect(tiering.considerations.join(" ")).toContain(
      "SUPERSEDES the Auxiliary",
    );
    const logTiers = ARCHITECTURE_PATTERNS.find(
      (p) => p.id === "workspace-log-tiers",
    )!;
    expect(logTiers.considerations.join(" ")).toContain(
      "lake-tier tables",
    );
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

    // "Cribl Stream" and "Log Analytics workspace" appear in both -> one node each.
    const labels = unified.nodes.map((n) => n.label);
    expect(labels.filter((l) => l === "Cribl Stream")).toHaveLength(1);
    expect(labels.filter((l) => l === "Log Analytics workspace")).toHaveLength(1);
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
