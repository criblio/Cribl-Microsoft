/**
 * Architecture patterns - the data-driven reference-architecture advisor
 * (roadmap Phase 4, QUEUED 2026-07-07). The user selects the Cribl products
 * and Azure resources in use; this module recommends the matching reference
 * patterns, each with a tiered diagram the UI renders as self-contained inline
 * SVG (strict-CSP safe, no external assets).
 *
 * ADVISORY ONLY: it recommends and visualizes, it deploys nothing and gates
 * nothing. The catalog and the selection-to-pattern mapping are PURE DATA +
 * pure functions, pinned by architecture-patterns.test.ts.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/** The Cribl products a deployment may use. */
export type CriblProduct = "stream" | "edge" | "lake" | "search";

/** The Azure resources a deployment may use. */
export type AzureResource =
  | "sentinel"
  | "log-analytics"
  | "event-hub"
  | "blob-storage"
  | "private-link"
  | "entra-diagnostics"
  | "vnet-flow-logs";

/** One selectable catalog entry (product or resource) for the pickers. */
export interface CatalogEntry<T extends string> {
  id: T;
  label: string;
  description: string;
}

/** The selectable Cribl products, in display order. */
export const CRIBL_PRODUCTS: readonly CatalogEntry<CriblProduct>[] = [
  {
    id: "stream",
    label: "Cribl Stream",
    description: "Worker groups processing and routing data in motion.",
  },
  {
    id: "edge",
    label: "Cribl Edge",
    description: "Edge fleets collecting from endpoints and servers.",
  },
  {
    id: "lake",
    label: "Cribl Lake",
    description: "Cribl.Cloud data lake for full-fidelity retention.",
  },
  {
    id: "search",
    label: "Cribl Search",
    description: "Federated search over data where it lives.",
  },
];

/** The selectable Azure resources, in display order. */
export const AZURE_RESOURCES: readonly CatalogEntry<AzureResource>[] = [
  {
    id: "sentinel",
    label: "Microsoft Sentinel",
    description: "SIEM on a Log Analytics workspace.",
  },
  {
    id: "log-analytics",
    label: "Log Analytics workspace",
    description: "The ingestion destination (implied by Sentinel).",
  },
  {
    id: "event-hub",
    label: "Azure Event Hub",
    description: "Streaming fan-in for Azure service diagnostics.",
  },
  {
    id: "blob-storage",
    label: "Azure Blob Storage",
    description: "Cheap archive tier and collector source.",
  },
  {
    id: "private-link",
    label: "Private Link / AMPLS",
    description: "Private-endpoint ingestion (no public egress).",
  },
  {
    id: "entra-diagnostics",
    label: "Entra ID diagnostics",
    description: "Sign-in / audit log exports from Entra ID.",
  },
  {
    id: "vnet-flow-logs",
    label: "vNet / NSG Flow Logs",
    description: "Network flow logs written to storage accounts.",
  },
];

/** The diagram column a node renders in, left to right. */
export type DiagramTier = "source" | "cribl" | "azure" | "destination";

/** One diagram node. Labels stay short; the renderer wraps once if needed. */
export interface DiagramNode {
  id: string;
  label: string;
  tier: DiagramTier;
}

/** One directed diagram edge (left-to-right flow; optional label). */
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

/** A pattern's tiered flow diagram (pure data; the UI renders the SVG). */
export interface PatternDiagram {
  nodes: readonly DiagramNode[];
  edges: readonly DiagramEdge[];
}

/** One reference architecture pattern. */
export interface ArchitecturePattern {
  id: string;
  title: string;
  /** One sentence: what the pattern is. */
  summary: string;
  /** When/why to use it - the recommendation rationale. */
  why: string;
  requiresProducts: readonly CriblProduct[];
  requiresResources: readonly AzureResource[];
  /** Sizing notes, prerequisites, and gotchas. */
  considerations: readonly string[];
  diagram: PatternDiagram;
}

/**
 * The pattern catalog. Requirements reference "log-analytics" for the
 * ingestion destination; a Sentinel selection SATISFIES it (Sentinel sits on
 * a workspace - see expandResources).
 */
export const ARCHITECTURE_PATTERNS: readonly ArchitecturePattern[] = [
  {
    id: "direct-dcr",
    title: "Direct DCR ingestion (Stream to Sentinel)",
    summary:
      "Cribl Stream ships shaped events straight to Log Analytics tables through Kind:Direct Data Collection Rules.",
    why:
      "The simplest, lowest-latency path when workers have outbound internet: no Event Hub, no DCE, one DCR per table. This is the path this app deploys.",
    requiresProducts: ["stream"],
    requiresResources: ["log-analytics"],
    considerations: [
      "Cribl Stream 4.14+ is required for Kind:Direct DCRs.",
      "Direct DCR names are limited to 30 characters (this app auto-abbreviates).",
      "Grant Monitoring Metrics Publisher on each DCR to the ingestion identity - data cannot flow without it.",
      "Reduce and shape in Stream before ingestion: Log Analytics bills per GB ingested.",
    ],
    diagram: {
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Sentinel / LA", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "dcr", label: "logs ingestion API" },
        { from: "dcr", to: "law" },
      ],
    },
  },
  {
    id: "private-ingestion",
    title: "Private ingestion (DCE + AMPLS)",
    summary:
      "Stream ingests through a Data Collection Endpoint joined to an Azure Monitor Private Link Scope - no public egress.",
    why:
      "Required when policy forbids public ingestion endpoints: the DCE's private endpoint keeps the whole path inside the vNet.",
    requiresProducts: ["stream"],
    requiresResources: ["log-analytics", "private-link"],
    considerations: [
      "Join the DCE to the AMPLS and publish its private DNS zones to the worker vNet.",
      "DCE-based DCR names allow 64 characters (vs 30 for Direct).",
      "Workers need line of sight to the private endpoint - test DNS resolution from a worker first.",
      "The same per-DCR Monitoring Metrics Publisher grant applies.",
    ],
    diagram: {
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "stream", label: "Cribl Stream (vNet)", tier: "cribl" },
        { id: "dce", label: "DCE via AMPLS", tier: "azure" },
        { id: "law", label: "Sentinel / LA", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "dce", label: "private endpoint" },
        { from: "dce", to: "law", label: "DCR" },
      ],
    },
  },
  {
    id: "event-hub-fanin",
    title: "Event Hub fan-in",
    summary:
      "Azure service diagnostic settings stream into Event Hubs; Cribl Stream consumes, shapes, and routes.",
    why:
      "The standard way to collect Azure platform logs (activity, PaaS diagnostics) at scale: every service exports to Event Hub natively, and Stream tames the volume before Sentinel.",
    requiresProducts: ["stream"],
    requiresResources: ["event-hub"],
    considerations: [
      "One namespace with per-category hubs; size throughput units and partitions for peak, not average.",
      "Give each worker group its own consumer group to avoid partition contention.",
      "Route the full stream to cheap storage and only the security-relevant subset to Sentinel.",
      "This repo's Event Hub discovery tooling enumerates existing hubs and generates Stream sources.",
    ],
    diagram: {
      nodes: [
        { id: "diag", label: "Azure diagnostics", tier: "source" },
        { id: "eh", label: "Event Hub", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "DCR", tier: "azure" },
        { id: "law", label: "Sentinel / LA", tier: "destination" },
      ],
      edges: [
        { from: "diag", to: "eh" },
        { from: "eh", to: "stream", label: "EH source" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law" },
      ],
    },
  },
  {
    id: "entra-reroute",
    title: "Entra diagnostic reroute (content-preserving)",
    summary:
      "Entra ID sign-in/audit logs export to Event Hub, flow through Stream, and land in custom tables with function aliases preserving Sentinel content compatibility.",
    why:
      "Native Entra tables do not accept Kind:Direct DCRs, so rerouting through Cribl requires landing in _CL tables; function aliases keep existing analytics content working.",
    requiresProducts: ["stream"],
    requiresResources: ["event-hub", "entra-diagnostics", "sentinel"],
    considerations: [
      "Mode A (clean native-table ingestion) is NOT available for Entra identity tables today - this is the Mode B path.",
      "Create a KQL function alias named like the native table over the _CL table so rules and workbooks keep resolving.",
      "UEBA cannot follow rerouted tables - keep that limitation explicit with stakeholders.",
      "Preserve the original schema through Stream: content compatibility depends on it.",
    ],
    diagram: {
      nodes: [
        { id: "entra", label: "Entra ID diagnostics", tier: "source" },
        { id: "eh", label: "Event Hub", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "cl", label: "Custom _CL + alias", tier: "azure" },
        { id: "sentinel", label: "Sentinel content", tier: "destination" },
      ],
      edges: [
        { from: "entra", to: "eh" },
        { from: "eh", to: "stream" },
        { from: "stream", to: "cl", label: "schema preserved" },
        { from: "cl", to: "sentinel", label: "function alias" },
      ],
    },
  },
  {
    id: "edge-fleet",
    title: "Edge fleet to Stream to Sentinel",
    summary:
      "Cribl Edge collects on endpoints and servers, forwards to Stream worker groups, which shape and ingest to Sentinel.",
    why:
      "When collection starts on the hosts themselves (files, journals, metrics, Windows events), Edge replaces per-host agents and Stream centralizes the shaping.",
    requiresProducts: ["edge", "stream"],
    requiresResources: ["log-analytics"],
    considerations: [
      "Manage fleets from the same leader as the worker groups - one control plane.",
      "Enable persistent queues on Edge nodes that go offline (laptops, branch sites).",
      "Do heavy shaping in Stream, not on the endpoint - keep Edge light.",
    ],
    diagram: {
      nodes: [
        { id: "hosts", label: "Endpoints / servers", tier: "source" },
        { id: "edge", label: "Cribl Edge fleet", tier: "cribl" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "DCR", tier: "azure" },
        { id: "law", label: "Sentinel / LA", tier: "destination" },
      ],
      edges: [
        { from: "hosts", to: "edge" },
        { from: "edge", to: "stream" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law" },
      ],
    },
  },
  {
    id: "blob-archive-replay",
    title: "Blob archive and replay",
    summary:
      "Stream routes a full-fidelity copy to Azure Blob Storage while Sentinel receives only the reduced hot subset; replay pulls archived data back through Stream on demand.",
    why:
      "The biggest cost lever: keep everything cheaply in blob, pay Sentinel rates only for what detections need, and rehydrate history when an investigation demands it.",
    requiresProducts: ["stream"],
    requiresResources: ["blob-storage"],
    considerations: [
      "Apply lifecycle policies (cool/archive tiers) to the archive container.",
      "Partition archive paths by source and date so replay filters cheaply.",
      "Replay runs through the same pipelines - shaped identically to the original flow.",
    ],
    diagram: {
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "blob", label: "Blob archive", tier: "azure" },
        { id: "law", label: "Sentinel (reduced)", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "blob", label: "full fidelity" },
        { from: "stream", to: "law", label: "hot subset" },
        { from: "blob", to: "stream", label: "replay" },
      ],
    },
  },
  {
    id: "lake-tiering",
    title: "Cribl Lake tiering",
    summary:
      "Stream lands full-fidelity data in Cribl Lake while Sentinel receives the reduced detection subset; Search queries the Lake directly.",
    why:
      "On Cribl.Cloud, Lake replaces self-managed archive plumbing: retention, search, and replay in one place, with Sentinel kept lean.",
    requiresProducts: ["stream", "lake"],
    requiresResources: ["sentinel"],
    considerations: [
      "Cribl Lake is a Cribl.Cloud capability - the on-prem equivalent is the blob archive pattern.",
      "Route the Lake copy as a non-final route above the Sentinel route (this app's source wiring does this).",
      "Pair with Cribl Search for investigations over Lake datasets without rehydration.",
    ],
    diagram: {
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "lake", label: "Cribl Lake", tier: "destination" },
        { id: "law", label: "Sentinel (reduced)", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "lake", label: "full fidelity" },
        { from: "stream", to: "law", label: "hot subset" },
      ],
    },
  },
  {
    id: "search-in-place",
    title: "Search-in-place over the archive",
    summary:
      "Cribl Search queries data where it lives (blob archive or Lake) and forwards only findings to Sentinel.",
    why:
      "Investigations over months of history should not require ingesting months of history: search the archive in place and promote only what matters.",
    requiresProducts: ["search"],
    requiresResources: ["blob-storage"],
    considerations: [
      "Point Search datasets at the archive containers the blob pattern writes.",
      "Partitioned paths (source/date) keep searches scoped and cheap.",
      "Findings can be sent to Sentinel as incidents or ingested as a small curated table.",
    ],
    diagram: {
      nodes: [
        { id: "blob", label: "Blob archive", tier: "source" },
        { id: "search", label: "Cribl Search", tier: "cribl" },
        { id: "law", label: "Sentinel (findings)", tier: "destination" },
      ],
      edges: [
        { from: "blob", to: "search", label: "query in place" },
        { from: "search", to: "law", label: "findings only" },
      ],
    },
  },
  {
    id: "vnet-flow-collection",
    title: "vNet Flow Log collection",
    summary:
      "vNet/NSG flow logs written to storage accounts are collected by Stream on a schedule, enriched, and routed to Sentinel.",
    why:
      "Flow logs only export to storage; a Stream blob collector turns those JSON blobs into shaped, deduplicated network telemetry Sentinel can afford.",
    requiresProducts: ["stream"],
    requiresResources: ["vnet-flow-logs", "blob-storage"],
    considerations: [
      "Grant the collector identity Storage Blob Data Reader on the flow-log accounts.",
      "This repo's vNet Flow Log discovery enumerates flow logs tenant-wide and generates the collector configs.",
      "Flatten the flowTuples in Stream - the raw format multiplies event counts.",
    ],
    diagram: {
      nodes: [
        { id: "flow", label: "vNet flow logs", tier: "source" },
        { id: "blob", label: "Storage account", tier: "source" },
        { id: "stream", label: "Stream collector", tier: "cribl" },
        { id: "dcr", label: "DCR", tier: "azure" },
        { id: "law", label: "Sentinel / LA", tier: "destination" },
      ],
      edges: [
        { from: "flow", to: "blob" },
        { from: "blob", to: "stream", label: "scheduled collect" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law" },
      ],
    },
  },
];

/** The user's selection: products and resources in use. */
export interface ArchitectureSelection {
  products: readonly CriblProduct[];
  resources: readonly AzureResource[];
}

/**
 * Expand implied resources: Sentinel sits ON a Log Analytics workspace, so a
 * Sentinel selection satisfies any pattern requiring "log-analytics".
 */
export function expandResources(
  resources: readonly AzureResource[],
): Set<AzureResource> {
  const set = new Set(resources);
  if (set.has("sentinel")) {
    set.add("log-analytics");
  }
  return set;
}

/** How well a pattern fits the selection. */
export interface PatternRecommendation {
  pattern: ArchitecturePattern;
  /** "match" = every requirement selected; "near" = exactly one missing. */
  fit: "match" | "near";
  /** The missing product/resource ids (empty for a match). */
  missing: readonly string[];
}

/**
 * Recommend patterns for a selection: full matches first (most specific -
 * highest total requirement count - first), then near-misses (exactly ONE
 * requirement missing) so the user sees what a single addition unlocks. An
 * empty selection recommends nothing.
 */
export function recommendPatterns(
  selection: ArchitectureSelection,
): PatternRecommendation[] {
  if (selection.products.length === 0 && selection.resources.length === 0) {
    return [];
  }
  const products = new Set(selection.products);
  const resources = expandResources(selection.resources);

  const matches: PatternRecommendation[] = [];
  const nears: PatternRecommendation[] = [];
  for (const pattern of ARCHITECTURE_PATTERNS) {
    const missing: string[] = [
      ...pattern.requiresProducts.filter((p) => !products.has(p)),
      ...pattern.requiresResources.filter((r) => !resources.has(r)),
    ];
    if (missing.length === 0) {
      matches.push({ pattern, fit: "match", missing: [] });
    } else if (missing.length === 1) {
      nears.push({ pattern, fit: "near", missing });
    }
  }
  const specificity = (p: ArchitecturePattern) =>
    p.requiresProducts.length + p.requiresResources.length;
  matches.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
  nears.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
  return [...matches, ...nears];
}

/** Resolve a product/resource id to its display label (for missing chips). */
export function catalogLabel(id: string): string {
  const product = CRIBL_PRODUCTS.find((p) => p.id === id);
  if (product !== undefined) {
    return product.label;
  }
  const resource = AZURE_RESOURCES.find((r) => r.id === id);
  return resource !== undefined ? resource.label : id;
}
