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
        { id: "dce", label: "Data Collection Endpoint", tier: "azure" },
        { id: "dcrdce", label: "DCE-based DCR", tier: "azure" },
        { id: "law", label: "Sentinel / LA", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "dce", label: "private endpoint (AMPLS)" },
        { from: "dce", to: "dcrdce" },
        { from: "dcrdce", to: "law" },
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
      "Public-path ingestion uses Kind:Direct DCRs; a Data Collection Endpoint is only needed when Private Link ingestion is in play (see the Private ingestion pattern).",
    ],
    diagram: {
      nodes: [
        { id: "diag", label: "Azure diagnostics", tier: "source" },
        { id: "eh", label: "Event Hub", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
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
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "cl", label: "Custom _CL + alias", tier: "azure" },
        { id: "sentinel", label: "Sentinel content", tier: "destination" },
      ],
      edges: [
        { from: "entra", to: "eh" },
        { from: "eh", to: "stream" },
        { from: "stream", to: "dcr", label: "schema preserved" },
        { from: "dcr", to: "cl" },
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
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
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
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
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

/** A node's canonical merge key: its label reduced to lowercase alphanumerics. */
function canonicalNodeKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Merge several patterns' tiered diagrams into ONE canonical graph for the
 * interactive dataflow view: nodes with the same label collapse (so shared
 * endpoints - Log sources, Cribl Stream, Sentinel - appear once and the
 * distinct middle paths fan through them), and edges dedupe by endpoint pair.
 * Node ids in the result are the canonical keys (stable across patterns), so
 * edges reference them directly. Pure - order of `patterns` sets first-wins
 * label/tier and edge-label.
 */
export function unifyPatternDiagrams(
  patterns: readonly ArchitecturePattern[],
): PatternDiagram {
  const nodes = new Map<string, DiagramNode>();
  const edges = new Map<string, DiagramEdge>();
  for (const pattern of patterns) {
    // Local node id -> canonical key, for remapping this pattern's edges.
    const localToKey = new Map<string, string>();
    for (const node of pattern.diagram.nodes) {
      const key = canonicalNodeKey(node.label);
      localToKey.set(node.id, key);
      if (!nodes.has(key)) {
        nodes.set(key, { id: key, label: node.label, tier: node.tier });
      }
    }
    for (const edge of pattern.diagram.edges) {
      const from = localToKey.get(edge.from);
      const to = localToKey.get(edge.to);
      if (from === undefined || to === undefined || from === to) continue;
      const key = `${from} ${to}`;
      if (!edges.has(key)) {
        edges.set(key, {
          from,
          to,
          ...(edge.label !== undefined ? { label: edge.label } : {}),
        });
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// ---------------------------------------------------------------------------
// Per-node info: purpose text + vendor documentation links (user feature
// 2026-07-28) - surfaced by the interactive diagram's "i" popovers.
// ---------------------------------------------------------------------------

/** One vendor documentation link. */
export interface DiagramDocLink {
  label: string;
  url: string;
}

/** A diagram node's purpose text plus its vendor documentation links. */
export interface DiagramNodeInfo {
  /** What this component does in the flow, in a sentence or two. */
  purpose: string;
  docs: readonly DiagramDocLink[];
}

const MS = "https://learn.microsoft.com";
const CRIBL = "https://docs.cribl.io";

/**
 * Node info keyed by the SAME canonical label key the diagram merge uses, so
 * every unified node resolves exactly one entry. The completeness test pins
 * that every catalog node label has one.
 */
const DIAGRAM_NODE_INFO: Record<string, DiagramNodeInfo> = {
  [canonicalNodeKey("Log sources")]: {
    purpose:
      "The upstream feeds - syslog, agents, APIs, appliances - that Cribl collects, shapes, and routes.",
    docs: [{ label: "Cribl Stream sources", url: CRIBL + "/stream/sources/" }],
  },
  [canonicalNodeKey("Cribl Stream")]: {
    purpose:
      "The routing and shaping engine: reduces, enriches, and routes events between any source and destination.",
    docs: [{ label: "Cribl Stream docs", url: CRIBL + "/stream/" }],
  },
  [canonicalNodeKey("Cribl Stream (vNet)")]: {
    purpose:
      "Cribl Stream workers deployed inside the virtual network so ingestion can ride private endpoints instead of public egress.",
    docs: [
      { label: "Cribl Stream docs", url: CRIBL + "/stream/" },
      {
        label: "Azure Monitor Private Link",
        url: MS + "/azure/azure-monitor/logs/private-link-security",
      },
    ],
  },
  [canonicalNodeKey("Kind:Direct DCR")]: {
    purpose:
      "A Data Collection Rule with direct ingestion endpoints (Kind:Direct): clients post straight to the DCR's logs-ingestion endpoint - no Data Collection Endpoint needed on the public path. Requires Cribl Stream 4.14+.",
    docs: [
      {
        label: "Data collection rules overview",
        url: MS + "/azure/azure-monitor/essentials/data-collection-rule-overview",
      },
      {
        label: "Logs Ingestion API",
        url: MS + "/azure/azure-monitor/logs/logs-ingestion-api-overview",
      },
      {
        label: "Cribl Microsoft Sentinel destination",
        url: CRIBL + "/stream/destinations-sentinel/",
      },
    ],
  },
  [canonicalNodeKey("Data Collection Endpoint")]: {
    purpose:
      "The regional ingestion endpoint non-Direct DCRs post through. Needed when Private Link is in play: the DCE joins an Azure Monitor Private Link Scope so ingestion never leaves the vNet.",
    docs: [
      {
        label: "Data collection endpoints",
        url: MS + "/azure/azure-monitor/essentials/data-collection-endpoint-overview",
      },
      {
        label: "Azure Monitor Private Link",
        url: MS + "/azure/azure-monitor/logs/private-link-security",
      },
    ],
  },
  [canonicalNodeKey("DCE-based DCR")]: {
    purpose:
      "A Data Collection Rule addressed through a Data Collection Endpoint (not Kind:Direct). The DCE fronts ingestion, so this is the shape Private Link deployments use; names allow 64 characters vs 30 for Direct.",
    docs: [
      {
        label: "Data collection rules overview",
        url: MS + "/azure/azure-monitor/essentials/data-collection-rule-overview",
      },
      {
        label: "Data collection endpoints",
        url: MS + "/azure/azure-monitor/essentials/data-collection-endpoint-overview",
      },
    ],
  },
  [canonicalNodeKey("Sentinel / LA")]: {
    purpose:
      "The Log Analytics workspace with Microsoft Sentinel enabled - where shaped events land and detections run.",
    docs: [
      { label: "Microsoft Sentinel overview", url: MS + "/azure/sentinel/overview" },
      {
        label: "Log Analytics workspaces",
        url: MS + "/azure/azure-monitor/logs/log-analytics-workspace-overview",
      },
    ],
  },
  [canonicalNodeKey("Azure diagnostics")]: {
    purpose:
      "Azure platform and resource diagnostic settings exporting logs and metrics - the native way every Azure service emits telemetry.",
    docs: [
      {
        label: "Diagnostic settings",
        url: MS + "/azure/azure-monitor/essentials/diagnostic-settings",
      },
    ],
  },
  [canonicalNodeKey("Event Hub")]: {
    purpose:
      "The high-throughput streaming buffer Azure services export into; Cribl consumes it with the Kafka-compatible Event Hub source.",
    docs: [
      { label: "Azure Event Hubs", url: MS + "/azure/event-hubs/event-hubs-about" },
      {
        label: "Cribl Azure Event Hubs source",
        url: CRIBL + "/stream/sources-azure-event-hubs/",
      },
    ],
  },
  [canonicalNodeKey("Entra ID diagnostics")]: {
    purpose:
      "Entra ID sign-in and audit log exports streamed to Event Hub via diagnostic settings.",
    docs: [
      {
        label: "Stream Entra logs to Event Hub",
        url: MS + "/entra/identity/monitoring-health/howto-stream-logs-to-event-hub",
      },
    ],
  },
  [canonicalNodeKey("Custom _CL + alias")]: {
    purpose:
      "A custom Log Analytics table (_CL) receiving the rerouted events, fronted by a KQL function alias named like the native table so existing Sentinel content keeps resolving.",
    docs: [
      {
        label: "Create custom tables",
        url: MS + "/azure/azure-monitor/logs/create-custom-table",
      },
      {
        label: "KQL functions (aliases)",
        url: MS + "/azure/azure-monitor/logs/functions",
      },
    ],
  },
  [canonicalNodeKey("Sentinel content")]: {
    purpose:
      "The analytics rules, workbooks, and hunting content that keep working against the rerouted data through the function alias.",
    docs: [
      { label: "Microsoft Sentinel overview", url: MS + "/azure/sentinel/overview" },
    ],
  },
  [canonicalNodeKey("Endpoints / servers")]: {
    purpose:
      "The hosts where collection starts - files, journals, metrics, Windows events - running Cribl Edge instead of per-host agents.",
    docs: [{ label: "Cribl Edge docs", url: CRIBL + "/edge/" }],
  },
  [canonicalNodeKey("Cribl Edge fleet")]: {
    purpose:
      "Managed Cribl Edge nodes collecting on the hosts and forwarding to Stream worker groups - one control plane on the same leader.",
    docs: [{ label: "Cribl Edge docs", url: CRIBL + "/edge/" }],
  },
  [canonicalNodeKey("Blob archive")]: {
    purpose:
      "Cheap full-fidelity storage in Azure Blob: everything lands here while Sentinel receives only the reduced hot subset; replay rehydrates on demand.",
    docs: [
      {
        label: "Azure Blob Storage",
        url: MS + "/azure/storage/blobs/storage-blobs-introduction",
      },
      {
        label: "Cribl Azure Blob destination",
        url: CRIBL + "/stream/destinations-azure-blob/",
      },
    ],
  },
  [canonicalNodeKey("Sentinel (reduced)")]: {
    purpose:
      "Sentinel receiving only the reduced, security-relevant subset - the cost lever: full fidelity lives in cheaper storage.",
    docs: [
      { label: "Microsoft Sentinel overview", url: MS + "/azure/sentinel/overview" },
    ],
  },
  [canonicalNodeKey("Cribl Lake")]: {
    purpose:
      "Cribl's managed data lake tier: full-fidelity retention with Search on top, while Sentinel gets the reduced subset.",
    docs: [{ label: "Cribl Lake docs", url: CRIBL + "/lake/" }],
  },
  [canonicalNodeKey("Cribl Search")]: {
    purpose:
      "Query data where it lives - blob archives, Lake - without ingesting it first; forward only findings to Sentinel.",
    docs: [{ label: "Cribl Search docs", url: CRIBL + "/search/" }],
  },
  [canonicalNodeKey("Sentinel (findings)")]: {
    purpose:
      "Sentinel receiving only search FINDINGS - the archive stays in place and only conclusions are ingested.",
    docs: [
      { label: "Microsoft Sentinel overview", url: MS + "/azure/sentinel/overview" },
    ],
  },
  [canonicalNodeKey("vNet flow logs")]: {
    purpose:
      "Virtual network flow logs written by Network Watcher - per-tuple network telemetry landing in a storage account.",
    docs: [
      {
        label: "vNet flow logs",
        url: MS + "/azure/network-watcher/vnet-flow-logs-overview",
      },
    ],
  },
  [canonicalNodeKey("Storage account")]: {
    purpose:
      "The storage account flow logs land in (insights-logs-flowlogflowevent) - the source Cribl's scheduled blob collector reads.",
    docs: [
      {
        label: "Azure Blob Storage",
        url: MS + "/azure/storage/blobs/storage-blobs-introduction",
      },
      {
        label: "Cribl Azure Blob source",
        url: CRIBL + "/stream/sources-azure-blob/",
      },
    ],
  },
  [canonicalNodeKey("Stream collector")]: {
    purpose:
      "A scheduled Cribl collection job pulling flow-log blobs on a cron (hourly at :15 over a -75m..-15m window), breaking and flattening them before ingestion.",
    docs: [
      { label: "Cribl collectors", url: CRIBL + "/stream/collectors/" },
      {
        label: "Cribl Azure Blob source",
        url: CRIBL + "/stream/sources-azure-blob/",
      },
    ],
  },
};

/**
 * The info entry for a node LABEL (the same canonical key the diagram merge
 * uses), or undefined for labels outside the catalog.
 */
export function diagramNodeInfo(label: string): DiagramNodeInfo | undefined {
  return DIAGRAM_NODE_INFO[canonicalNodeKey(label)];
}
