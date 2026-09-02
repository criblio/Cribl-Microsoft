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

/**
 * The Azure resources a deployment may use. Role-ambiguous services carry
 * ROLE-SPLIT entries (2026-07-29 user direction): Event Hub and Blob Storage
 * can each sit on either side of Cribl Stream, so the selection must say
 * which side is in play for the diagram to draw correctly. ADX needs no
 * split - the product disambiguates it (Stream = destination, Search =
 * source).
 */
export type AzureResource =
  | "sentinel"
  | "sentinel-data-lake"
  | "log-analytics"
  | "event-hub"
  | "event-hub-egress"
  | "blob-storage"
  | "blob-storage-source"
  | "adx"
  | "private-link-law"
  | "private-link-blob"
  | "private-link-eventhub"
  | "private-link-adx"
  | "entra-diagnostics"
  | "vnet-flow-logs";

/**
 * The specific log sources a deployment may name (2026-07-29 user
 * direction): concrete ingress variants with different transports - the
 * SAME data (Windows events) draws three different left edges depending on
 * whether WEF, Cribl Edge, or the Azure Monitor Agent carries it.
 */
export type LogSource =
  | "palo-alto-syslog"
  | "windows-wef"
  | "windows-wec"
  | "windows-edge"
  | "windows-winlogbeat"
  | "windows-splunk-uf"
  | "windows-ama";

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
    id: "sentinel-data-lake",
    label: "Sentinel data lake",
    description: "Long-term lake tier mirrored from the analytics tier (up to 12 years).",
  },
  {
    id: "log-analytics",
    label: "Log Analytics workspace",
    description: "The ingestion destination (implied by Sentinel).",
  },
  {
    id: "event-hub",
    label: "Event Hub (source into Cribl)",
    description: "Streaming fan-in for Azure service diagnostics.",
  },
  {
    id: "event-hub-egress",
    label: "Event Hub (Stream destination)",
    description: "Stream egress into Event Hubs for downstream consumers.",
  },
  {
    id: "blob-storage",
    label: "Blob Storage (archive destination)",
    description: "Cheap full-fidelity archive tier written by Stream.",
  },
  {
    id: "blob-storage-source",
    label: "Blob Storage (collector source)",
    description: "Existing blobs collected on a schedule by Stream.",
  },
  {
    id: "adx",
    label: "Azure Data Explorer (ADX)",
    description: "Kusto cluster - Stream destination and/or Cribl Search source.",
  },
  {
    id: "private-link-law",
    label: "Private endpoint: Log Analytics (AMPLS)",
    description: "Workspace ingestion over a private endpoint via an AMPLS.",
  },
  {
    id: "private-link-blob",
    label: "Private endpoint: Blob Storage",
    description: "Storage-account access over a private endpoint in the vNet.",
  },
  {
    id: "private-link-eventhub",
    label: "Private endpoint: Event Hub",
    description: "Event Hub namespace access over a private endpoint in the vNet.",
  },
  {
    id: "private-link-adx",
    label: "Private endpoint: ADX",
    description: "Kusto cluster access over a private endpoint in the vNet.",
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

/**
 * The selectable log sources, in display order. The six Windows entries are
 * the same DATA over different collection methods - each draws a different
 * ingress edge, which is the point of selecting one.
 */
export const LOG_SOURCES: readonly CatalogEntry<LogSource>[] = [
  {
    id: "palo-alto-syslog",
    label: "Palo Alto NGFW (syslog)",
    description: "PAN-OS Traffic/Threat logs over syslog (CSV or CEF).",
  },
  {
    id: "windows-wef",
    label: "Windows Events (WEF to Stream)",
    description: "Windows Event Forwarding straight to Stream - Stream acts as the collector.",
  },
  {
    id: "windows-wec",
    label: "Windows Events (WEC server relay)",
    description: "WEF into a dedicated Windows Event Collector server; Cribl Edge forwards from it.",
  },
  {
    id: "windows-edge",
    label: "Windows Events (Cribl Edge)",
    description: "Cribl Edge on the hosts reading Windows Event Logs locally.",
  },
  {
    id: "windows-winlogbeat",
    label: "Windows Events (Winlogbeat)",
    description: "Winlogbeat shipping to Stream's Elasticsearch-compatible API source.",
  },
  {
    id: "windows-splunk-uf",
    label: "Windows Events (Splunk UF)",
    description: "Splunk Universal Forwarders sending S2S to Stream's Splunk TCP source.",
  },
  {
    id: "windows-ama",
    label: "Windows Events (Azure Monitor Agent)",
    description: "AMA shipping direct to Sentinel through its own DCR - no Cribl in path.",
  },
];

/**
 * The functional category a node renders as (color-coded across ALL
 * diagrams, user directive 2026-07-31): sources, routing tables/routes,
 * pipelines/packs, and destinations each carry a distinct color; "cribl"
 * covers the remaining Cribl machinery (products, breakers, worker groups)
 * and "azure" the Azure plumbing (DCR/DCE/DNS).
 */
export type DiagramTier =
  | "source"
  | "route"
  | "pipeline"
  | "cribl"
  | "azure"
  | "destination";

/** One diagram node. Labels stay short; the renderer wraps once if needed. */
export interface DiagramNode {
  id: string;
  label: string;
  tier: DiagramTier;
  /**
   * Per-node info for LIVE diagrams (composed from real config); catalog
   * nodes omit it and resolve through diagramNodeInfo(label) instead.
   */
  info?: DiagramNodeInfo;
  /**
   * Card badge override for LIVE diagrams (stage/type caption, e.g.
   * "collection source", "Event breaker"); catalog nodes omit it and the
   * renderer derives the badge from the tier/label.
   */
  badge?: string;
  /**
   * Service tags rendered as small chips OVERLAPPING the card's bottom-right
   * corner (user direction 2026-07-29: Microsoft Sentinel is a service ON
   * the workspace, shown as a tag, not a separate node).
   */
  overlays?: readonly string[];
  /**
   * The card offers an explode/collapse toggle (2026-07-30: pack cards
   * expand into their internal sources/routes/pipelines/destinations).
   * The renderer surfaces the button; the OWNER of the diagram rebuilds it
   * with the node expanded. `expanded` reflects the current state.
   */
  expandable?: boolean;
  expanded?: boolean;
  /**
   * Render subdued (2026-07-30: a DISABLED route in the exploded routing
   * table draws dimmed - present as config, processing nothing).
   */
  muted?: boolean;
}

/**
 * Relative billing weight of the path an edge lands data on. The RULE
 * (pinned by test): cost annotates edges whose TARGET is a billing
 * destination - analytics-tier targets (Log Analytics workspace, Custom
 * _CL + alias) and license-billed SIEM targets (Splunk indexers - per-GB
 * ingest licensing, 2026-07-30) are "premium"; low-cost store/egress
 * targets (Blob archive, Cribl Lake, Sentinel data lake, Azure Data
 * Explorer, Event Hub (egress)) are "economical". Transit and
 * service-layer edges (workspace -> Microsoft Sentinel) carry no cost.
 */
export type EdgeCostTier = "premium" | "economical";

/**
 * Distinct line colors for flows whose DIRECTION of travel is easy to
 * misread. "search" marks the Cribl Search send path (user directive
 * 2026-07-29): findings return THROUGH Cribl Stream before landing in the
 * workspace, and that leg draws in its own color so it never reads as the
 * primary ingest flow.
 */
export type EdgeFlowTone = "search";

/** One directed diagram edge (left-to-right flow; optional label). */
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  /** Omitted = neutral (no badge, default pipe color). */
  cost?: EdgeCostTier;
  /** Omitted = default pipe color; set = the flow's distinct line color. */
  tone?: EdgeFlowTone;
  /** Render subdued, without flow animation (edge into a disabled node). */
  muted?: boolean;
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
  /** Specific log sources the pattern needs selected (ingress patterns). */
  requiresSources?: readonly LogSource[];
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
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "dcr", label: "logs ingestion API" },
        { from: "dcr", to: "law", cost: "premium" },
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
    requiresResources: ["log-analytics", "private-link-law"],
    considerations: [
      "Join the DCE to the AMPLS and LINK the privatelink.monitor.azure.com private DNS zone to the worker vNet (or forward to it from your custom DNS) - without the zone, workers resolve the PUBLIC IP and the private path silently never engages.",
      "Verify from a worker that the ingestion hostname resolves to the PRIVATE IP before cutting over; then disable public network access on the DCE.",
      "Workers need a NETWORK PATH to the private endpoint's IP: same vNet, peering, or VPN/ExpressRoute, with NSGs allowing 443 to the endpoint subnet.",
      "DCE-based DCR names allow 64 characters (vs 30 for Direct).",
      "The same per-DCR Monitoring Metrics Publisher grant applies.",
    ],
    diagram: {
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "stream", label: "Cribl Stream (vNet)", tier: "cribl" },
        { id: "dns", label: "DNS: privatelink.monitor.azure.com", tier: "azure" },
        { id: "dce", label: "Data Collection Endpoint", tier: "azure" },
        { id: "dcrdce", label: "DCE-based DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "dns", label: "worker DNS lookup" },
        { from: "dns", to: "dce", label: "resolves to the private IP" },
        { from: "stream", to: "dce", label: "private IP via vNet path (AMPLS)" },
        { from: "dce", to: "dcrdce" },
        { from: "dcrdce", to: "law", cost: "premium" },
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
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "diag", to: "eh" },
        { from: "eh", to: "stream", label: "Azure Event Hubs source" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law", cost: "premium" },
      ],
    },
  },
  // DBT-3: the copy below is deliberately dated where something was measured
  // and hedged where it was not, and the two are not the same claim. Only ONE
  // fact here was established: the Logs Ingestion API supported-tables list
  // carries no Entra identity table, and only as a snapshot (content updated
  // 2026-06-03, docs/features/content-preserving-native-reroute.md:35), which
  // Microsoft says "may be added to" - so it states its date instead of
  // "today". The other two claims trace to section 8 of that same doc, which
  // records BOTH as unverified: whether the native Entra tables would accept a
  // Kind:Direct DCR even if they were listed (:239), and whether a workspace
  // will register a function alias named for an existing table (:241). Say
  // what the SOURCE says is unverified and no more - an earlier rewrite was
  // reverted for trading the unhedged claim for a differently-unhedged one
  // ("nobody has tested that against a live workspace"), which is a claim
  // about the state of the world that nobody established either.
  //
  // NO PIN GUARDS THIS, deliberately. The property worth protecting is "no
  // unhedged assertion sourced from an unverified section", and that is a
  // judgement about prose, not an assertion a test can make. The reverted
  // attempt's pin blocked four literal spellings, so the identical defect was
  // reintroduced in different words and the suite still passed 52 of 52. A pin
  // that reads as protection while the defect is on screen is worse than none.
  {
    id: "entra-reroute",
    title: "Entra diagnostic reroute (content-preserving)",
    // DBT-3: THIS FIELD RENDERS ALONE. The near-miss recommendation list shows
    // `summary` with no `why` beside it, so a hedge that lives only in `why`
    // is a hedge the operator never sees - which is how the first fix left the
    // card's exact defect on screen while reporting it fixed. It said aliases
    // "preserv[e] Sentinel content compatibility"; the source records alias
    // registration over an existing table as UNVERIFIED (:241), so the summary
    // now states the INTENT and marks the mechanism unproven, in the field
    // that is actually read.
    summary:
      "Entra ID sign-in/audit logs export to Event Hub, flow through Stream, and land in custom tables, with a function alias intended to keep Sentinel content resolving - alias registration over an existing table is unverified.",
    why:
      "Entra identity tables are absent from the Logs Ingestion API supported-tables list (snapshot content updated 2026-06-03), so a reroute through Cribl has to land in _CL tables and lean on a function alias to keep existing analytics content resolving. The reroute plan records both mechanisms as unverified: whether those native tables would accept a Kind:Direct DCR even if they were listed, and whether a workspace will register an alias named for a native table that already exists.",
    requiresProducts: ["stream"],
    requiresResources: ["event-hub", "entra-diagnostics", "sentinel"],
    considerations: [
      "Mode A (clean native-table ingestion) was unavailable for Entra identity tables as of the 2026-06-03 supported-tables snapshot - Microsoft says the list may be added to, so recheck it rather than assuming Mode B is still the only path.",
      "Create a KQL function alias named like the native table over the _CL table so rules and workbooks keep resolving - but prove the registration in the target workspace first: the reroute plan records alias-versus-existing-table collision behaviour as inconsistently documented and not settled by Microsoft.",
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
        { from: "eh", to: "stream", label: "Azure Event Hubs source" },
        { from: "stream", to: "dcr", label: "schema preserved" },
        { from: "dcr", to: "cl", cost: "premium" },
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
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "hosts", to: "edge" },
        { from: "edge", to: "stream" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law", cost: "premium" },
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
      "The reduction itself happens in Stream's pipelines BEFORE the DCR: drop null and duplicate fields, trim raw payloads, aggregate flow records, and sample verbose allow-traffic noise - verbose sources commonly shrink 30-50% before billing starts.",
      "Apply lifecycle policies (cool/archive tiers) to the archive container.",
      "Partition archive paths by source and date so replay filters cheaply.",
      "Replay runs through the same pipelines - shaped identically to the original flow.",
      "Pair with the workspace log-tiers pattern when high-volume feeds must stay QUERYABLE in the workspace, not just archived.",
    ],
    diagram: {
      // The hot subset rides the SAME ingestion path as everything else -
      // through the Kind:Direct DCR, never straight into the workspace
      // (user report 2026-07-29).
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "blob", label: "Blob archive", tier: "azure" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "blob", label: "full fidelity", cost: "economical" },
        { from: "stream", to: "dcr", label: "reduced hot subset" },
        { from: "dcr", to: "law", cost: "premium" },
        { from: "blob", to: "stream", label: "replay (Azure Blob source)" },
      ],
    },
  },
  {
    id: "workspace-log-tiers",
    title: "Workspace log tiers (Analytics vs Auxiliary)",
    summary:
      "Stream splits by value INSIDE the workspace too: detections-grade events land on Analytics-plan tables while high-volume low-value telemetry lands on Auxiliary-plan custom tables at a fraction of the rate, with summary rules lifting aggregates back into Analytics.",
    why:
      "Blob solves retention, but some high-volume feeds still need to be QUERYABLE in the workspace day to day - the Auxiliary plan keeps them there cheaply, and detections run on summary-rule aggregates instead of raw volume.",
    requiresProducts: ["stream"],
    requiresResources: ["sentinel"],
    considerations: [
      "Auxiliary-plan tables are custom (_CL) tables fed through the Logs Ingestion API - Stream lands verbose feeds (firewall allow traffic, flow logs, DNS, proxy) there instead of the Analytics plan.",
      "Auxiliary KQL is limited (single-table queries, reduced operators) and analytics rules cannot target these tables directly - use SUMMARY RULES to aggregate into an Analytics table that detections and workbooks use.",
      "Summary-rule output is billed as Analytics ingest - the aggregates are small, and that is the point: detections see minutes-grain rollups, not raw volume.",
      "Interactive retention on the Auxiliary plan is 30 days (long-term retention beyond that is cheap) - keep anything detections need in full fidelity on Analytics.",
      "The Basic plan sits between the two - more query capability than Auxiliary at a higher rate - when Auxiliary is too restrictive for a feed.",
      "The Sentinel data lake tier SUPERSEDES the Auxiliary plan: onboarding the workspace to the lake surfaces Auxiliary tables as lake-tier tables and switches their billing to the lake meters. Auxiliary/Basic are not being enhanced further - plan new low-value feeds toward the lake tier where it is available.",
      "Pair with the blob archive pattern: blob holds the full-fidelity replay copy; the Auxiliary tier holds what analysts want queryable without rehydration.",
    ],
    diagram: {
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
        { id: "aux", label: "Auxiliary-plan table", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "dcr", label: "split by value" },
        { from: "dcr", to: "law", cost: "premium" },
        {
          from: "dcr",
          to: "aux",
          label: "high-volume, low-value",
          cost: "economical",
        },
        {
          from: "aux",
          to: "law",
          label: "summary rules (aggregates)",
          cost: "premium",
        },
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
      // Same honesty as the blob pattern: the hot subset enters the
      // workspace through the Kind:Direct DCR.
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "lake", label: "Cribl Lake", tier: "destination" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "lake", label: "full fidelity", cost: "economical" },
        { from: "stream", to: "dcr", label: "hot subset" },
        { from: "dcr", to: "law", cost: "premium" },
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
      "Findings do NOT go straight to the workspace: the send operator forwards them to a Cribl HTTP source on a Stream worker group, and Stream's routes deliver them through the DCR (the violet path).",
    ],
    diagram: {
      nodes: [
        { id: "blob", label: "Blob archive", tier: "source" },
        { id: "search", label: "Cribl Search", tier: "cribl" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "blob", to: "search", label: "query in place" },
        {
          from: "search",
          to: "stream",
          label: "send findings (Cribl HTTP source)",
          tone: "search",
        },
        { from: "stream", to: "dcr", label: "findings only", tone: "search" },
        { from: "dcr", to: "law", cost: "premium", tone: "search" },
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
    // The storage account is IMPLIED by flow logs (they only export to
    // storage) - no separate role selection needed for this pattern.
    requiresResources: ["vnet-flow-logs"],
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
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "flow", to: "blob" },
        { from: "blob", to: "stream", label: "Azure Blob source (scheduled)" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law", cost: "premium" },
      ],
    },
  },
  {
    id: "sentinel-data-lake-tiering",
    title: "Sentinel data lake tiering",
    summary:
      "Stream ingests shaped events through DCRs into the workspace; the analytics tier mirrors into the Sentinel data lake for long-term retention, and low-value tables go lake-tier-only.",
    why:
      "The lake keeps up to 12 years of security data at lake economics without a second copy: analytics-tier tables mirror automatically, and per-table tier settings put high-volume/low-detection data in the lake ONLY - the same cost lever as blob archiving, natively inside Sentinel.",
    requiresProducts: ["stream"],
    requiresResources: ["sentinel-data-lake"],
    considerations: [
      "Onboard the workspace to the Sentinel data lake first (Defender portal); analytics-tier tables then mirror to the lake automatically - a single copy, and mirroring adds NO lake ingestion charge (lake ingestion + data processing meters apply only to lake-tier-ONLY tables).",
      "Set high-volume, low-detection tables to the data-lake-only tier; keep detection-critical tables in the analytics tier where rules and hunting run.",
      "Lake economics: storage bills per GB/month at a uniform 6:1 compression assumption once analytics retention ends; KQL lake queries and jobs bill per GB scanned; Jupyter notebook / Spark sessions (advanced data insights) bill per compute hour.",
      "Lake data is queried with KQL lake exploration and notebooks, and promoted BACK to the analytics tier via one-time or scheduled KQL jobs when an investigation needs it hot - promoted data bills as analytics ingest, so promote windows, not months.",
      "The lake tier SUPERSEDES the Auxiliary and Basic plans: onboarding surfaces existing Auxiliary tables as lake-tier tables and switches archive/search/auxiliary meters to the lake meters; Microsoft recommends the lake tier for new low-value feeds.",
      "Cribl's reduction still pays for itself at the analytics tier; route full-fidelity copies toward lake-tier tables instead of dropping them.",
    ],
    diagram: {
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
        { id: "sdl", label: "Sentinel data lake", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "dcr", label: "logs ingestion API" },
        { from: "dcr", to: "law", cost: "premium" },
        { from: "law", to: "sdl", label: "tier mirroring (single copy)", cost: "economical" },
        {
          from: "sdl",
          to: "law",
          label: "promote on demand (KQL jobs)",
          cost: "premium",
        },
      ],
    },
  },
  {
    id: "search-sentinel-data-lake",
    title: "Cribl Search over the Sentinel data lake",
    summary:
      "Cribl Search queries the Sentinel data lake in place through the lake's KQL query API and forwards only findings - years of retention stay where they are cheap.",
    why:
      "Investigations over lake-tier history should not require promoting months of data first: federated search hits the lake's own query endpoint and only conclusions move.",
    requiresProducts: ["search"],
    requiresResources: ["sentinel-data-lake"],
    considerations: [
      "The lake has its OWN query endpoint - https://api.securityplatform.microsoft.com/lake/kql/v1/rest/query - NOT the Log Analytics Query API (api.loganalytics.io) that serves analytics-tier queries. Auth is an Entra OAuth bearer token.",
      "Long-running lake queries ride the asynchronous jobs endpoint (/lake/kql/jobs); the synchronous endpoint is for interactive exploration.",
      "Cribl Search has no dedicated Sentinel-data-lake dataset provider today - use the GENERIC HTTP API dataset provider against the lake query endpoint (configurable endpoints, auth, headers, and request body). The Azure API provider does not fit: it is preconfigured for four management-plane endpoints (VMs, disks, NSGs, web apps), not KQL APIs.",
      "Auxiliary/lake-tier tables are reachable the same way: before lake onboarding through the Log Analytics /search REST API (single-table KQL, limited operators, time span in the request header); after onboarding they surface in the lake and answer through the lake KQL endpoint.",
      "Promote findings to the analytics tier (or ingest a small curated table) so detections and cases can act on them.",
      "The promotion rides the send operator: findings return to a Cribl HTTP source on a Stream worker group, and Stream delivers them through the DCR (the violet path).",
    ],
    diagram: {
      nodes: [
        { id: "sdl", label: "Sentinel data lake", tier: "source" },
        { id: "search", label: "Cribl Search", tier: "cribl" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "sdl", to: "search", label: "lake KQL query API" },
        {
          from: "search",
          to: "stream",
          label: "send findings (Cribl HTTP source)",
          tone: "search",
        },
        { from: "stream", to: "dcr", label: "findings only", tone: "search" },
        { from: "dcr", to: "law", cost: "premium", tone: "search" },
      ],
    },
  },
  {
    id: "palo-alto-syslog-ingress",
    title: "Palo Alto NGFW over syslog",
    summary:
      "PAN-OS firewalls send Traffic/Threat logs over syslog to Stream, where the Palo Alto pack parses and maps them before landing in CommonSecurityLog.",
    why:
      "Firewall syslog is the classic high-volume feed: Stream terminates syslog at scale, the Palo Alto source pack normalizes CSV/CEF, and Sentinel receives shaped CommonSecurityLog rows instead of raw noise.",
    requiresProducts: ["stream"],
    requiresResources: [],
    requiresSources: ["palo-alto-syslog"],
    considerations: [
      "Terminate syslog on Stream workers behind a load balancer; prefer TLS (6514) over UDP 514 where the firewall supports it.",
      "Apply the Cribl Pack for Palo Alto Networks as the syslog source's pre-processing pipeline; it expects the PAN-OS CSV format by default and also handles CEF.",
      "Route to the native CommonSecurityLog table through the DCR so existing Sentinel firewall content keeps working.",
      "Keep an eye on PAN-OS log-forwarding profiles: Traffic vs Threat volumes differ by orders of magnitude - sample or drop allowed-traffic noise in Stream.",
    ],
    diagram: {
      nodes: [
        { id: "pan", label: "Palo Alto NGFW", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "pan", to: "stream", label: "Syslog source (514/6514, CSV/CEF)" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law", cost: "premium" },
      ],
    },
  },
  {
    id: "windows-wef-ingress",
    title: "Windows Events via WEF to Stream",
    summary:
      "Windows endpoints forward events natively (WEF over WinRM) straight to Cribl Stream's Windows Event Forwarder source - Stream IS the collector.",
    why:
      "Agentless on the endpoints and serverless in the middle: no dedicated WEC boxes, no per-host shipper - the built-in Windows forwarding infrastructure lands directly on workers that shape and route.",
    requiresProducts: ["stream"],
    requiresResources: [],
    requiresSources: ["windows-wef"],
    considerations: [
      "Stream's WEF source authenticates with Kerberos or mutual TLS; both work behind a load balancer for scale-out.",
      "A single WEF subscription XPath query caps at roughly 22 EventIDs - use multiple <Query> blocks in one subscription to cover larger EventID sets.",
      "Shape into the SecurityEvent/WindowsEvent native tables (the Cribl Windows Events pack maps them) so Sentinel content resolves.",
      "GPO-driven subscription rollout means collection policy stays in AD - Stream only replaces the collector tier.",
    ],
    diagram: {
      nodes: [
        { id: "win", label: "Windows endpoints", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "win", to: "stream", label: "WEF source (Kerberos/mTLS)" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law", cost: "premium" },
      ],
    },
  },
  {
    id: "windows-wec-relay",
    title: "Windows Events via a WEC server relay",
    summary:
      "Endpoints forward over WEF to a dedicated Windows Event Collector server; Cribl Edge on the WEC reads the forwarded-events channel and ships to Stream.",
    why:
      "Keeps an existing WEC investment: environments that already operate collector servers add one Edge node per WEC instead of re-pointing thousands of endpoint subscriptions.",
    requiresProducts: ["edge", "stream"],
    requiresResources: [],
    requiresSources: ["windows-wec"],
    considerations: [
      "Cribl Edge on the WEC reads the ForwardedEvents channel with the Windows Event Logs source - no agent on the endpoints themselves.",
      "The WEC server is a fan-in bottleneck: monitor its subscription health and size it for peak forwarding bursts.",
      "Migration path: this pattern usually precedes WEF-to-Stream (retiring the WEC) or full Edge rollout - the diagrams differ only at the left edge.",
    ],
    diagram: {
      nodes: [
        { id: "win", label: "Windows endpoints", tier: "source" },
        { id: "wec", label: "WEC server", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "win", to: "wec", label: "WEF subscription" },
        { from: "wec", to: "stream", label: "Cribl Edge on the WEC" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law", cost: "premium" },
      ],
    },
  },
  {
    id: "windows-edge-ingress",
    title: "Windows Events via Cribl Edge",
    summary:
      "Cribl Edge runs on the Windows hosts, reads Event Logs locally, and forwards to Stream - one managed fleet instead of per-host shippers plus collectors.",
    why:
      "When you can deploy an agent, Edge collapses the whole collection tier: local WEL reads, metrics and files from the same node, persistent queues for offline hosts, one control plane with Stream.",
    requiresProducts: ["edge", "stream"],
    requiresResources: [],
    requiresSources: ["windows-edge"],
    considerations: [
      "Edge's Windows Event Logs source reads channels locally - no WinRM, no WEF subscriptions, no collector servers.",
      "Enable persistent queues on nodes that go offline (laptops, branch sites).",
      "Keep Edge light: heavy shaping belongs in Stream worker groups.",
      "Manage fleets from the same leader as the worker groups - one control plane.",
    ],
    diagram: {
      nodes: [
        { id: "win", label: "Windows endpoints", tier: "source" },
        { id: "edge", label: "Cribl Edge fleet", tier: "cribl" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "win", to: "edge", label: "local Event Log read" },
        { from: "edge", to: "stream" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law", cost: "premium" },
      ],
    },
  },
  {
    id: "windows-winlogbeat-ingress",
    title: "Windows Events via Winlogbeat",
    summary:
      "Existing Winlogbeat agents point their Elasticsearch output at Stream's Elasticsearch API source - Stream impersonates Elastic and takes over routing.",
    why:
      "Zero endpoint change for Elastic shops: edit winlogbeat.yml to target Stream's endpoint and the same agents now feed Sentinel (and anything else) through Cribl.",
    requiresProducts: ["stream"],
    requiresResources: [],
    requiresSources: ["windows-winlogbeat"],
    considerations: [
      "To the Beat, Stream IS Elasticsearch: point winlogbeat.yml's Elasticsearch output at the Elasticsearch API source endpoint and set matching auth tokens.",
      "The event shape is Beats/ECS, not native Windows XML - map to SecurityEvent/WindowsEvent fields in Stream before the DCR.",
      "A staged migration can run Winlogbeat and Edge side by side; retire the Beat once Edge owns the host.",
    ],
    diagram: {
      // The agent is a NODE, not just an edge label: several Windows methods
      // share the endpoints->Stream pair, and the unify merge dedupes edges
      // by node pair - distinct transport nodes keep each method visible
      // when more than one is selected (user report 2026-07-29).
      nodes: [
        { id: "win", label: "Windows endpoints", tier: "source" },
        { id: "wlb", label: "Winlogbeat agents", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "win", to: "wlb", label: "local Event Log read" },
        { from: "wlb", to: "stream", label: "Elasticsearch API source" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law", cost: "premium" },
      ],
    },
  },
  {
    id: "windows-splunk-uf-ingress",
    title: "Windows Events via Splunk Universal Forwarder",
    summary:
      "Existing Splunk UFs add Stream workers to outputs.conf; Stream's Splunk TCP source receives S2S and routes to Sentinel alongside (or instead of) Splunk.",
    why:
      "The most common brownfield: thousands of UFs already collect Windows events. Re-pointing outputs.conf is a config push, not an agent migration - and Stream can dual-route during a SIEM transition.",
    requiresProducts: ["stream"],
    requiresResources: [],
    requiresSources: ["windows-splunk-uf"],
    considerations: [
      "Configure the UF (or a heavy forwarder) with outputs.conf stanzas targeting Stream's Splunk TCP source port; enable the S2S protocol version your UFs speak.",
      "Dual-route during migration: the same S2S feed can go to both Splunk and Sentinel until cutover.",
      "Cooked Splunk events need field extraction in Stream before mapping to SecurityEvent/WindowsEvent.",
    ],
    diagram: {
      // Distinct transport node for the same reason as the Winlogbeat
      // pattern: keep every selected Windows method visible at once.
      nodes: [
        { id: "win", label: "Windows endpoints", tier: "source" },
        { id: "uf", label: "Splunk UF agents", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "win", to: "uf", label: "local Event Log read" },
        { from: "uf", to: "stream", label: "Splunk TCP source (S2S)" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law", cost: "premium" },
      ],
    },
  },
  {
    id: "splunk-siem-migration",
    title: "Splunk SIEM migration (before and after)",
    summary:
      "One picture of the whole transition: the BEFORE state (UFs shipping into Splunk) stays visible but subdued, while the AFTER state re-points the same UF fleet at Cribl Stream, which dual-writes to Splunk and Sentinel until cutover.",
    why:
      "A SIEM migration is a transition, not a flag day: the collection fleet stays where it is, Stream takes over transport on day one with a zero-risk passthrough, Sentinel fills in parallel, and the previous SIEM is decommissioned only after detections prove out.",
    requiresProducts: ["stream"],
    requiresResources: ["sentinel"],
    requiresSources: ["windows-splunk-uf"],
    considerations: [
      "Phase 1 - intercept at the HF tier: change outputs.conf on the Heavy Forwarders FIRST - a handful of HFs cover the whole estate while thousands of UFs stay untouched. Stream passes through to the indexers unchanged; rollback is one config push.",
      "Phase 2 - dual-run: add the Sentinel route - map cooked S2S events to SecurityEvent/CommonSecurityLog through the Kind:Direct DCR - while Splunk keeps receiving everything.",
      "Phase 3 - migrate content: convert Splunk saved searches and correlation rules to KQL analytics rules (this app's SIEM Migration screen automates the conversion).",
      "Phase 4 - validate parity: run both SIEMs against the same feed and compare detections before anything is switched off. Dual-run deliberately pays BOTH premium bills (Splunk license and Sentinel analytics) - time-box this phase.",
      "Phase 5 - cutover and collapse the tiers: drop the Splunk route in Stream and decommission the indexer tier, then re-point UFs straight at Stream and decommission the HFs - Stream absorbs their parsing/routing role. Keep an HF only where it hosts modular inputs or apps, until those are re-homed on Cribl sources or Edge.",
      "The subdued lines are the BEFORE topology: UFs through the HF tier into Splunk, no shaping, no Sentinel. The HF-to-Stream leg is the TEMPORARY bridge - it exists only until UFs point at Stream directly.",
    ],
    diagram: {
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "uf", label: "Splunk UF agents", tier: "source" },
        { id: "hf", label: "Splunk Heavy Forwarders", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "splunk", label: "Splunk indexers", tier: "destination" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "uf" },
        { from: "uf", to: "hf", label: "before: cooked S2S", muted: true },
        {
          from: "hf",
          to: "splunk",
          label: "before: parsed to indexers",
          muted: true,
          cost: "premium",
        },
        {
          from: "hf",
          to: "stream",
          label: "during: HF outputs to Stream (temporary)",
        },
        { from: "uf", to: "stream", label: "after: UFs direct to Stream (S2S)" },
        {
          from: "stream",
          to: "splunk",
          label: "during: dual-run until cutover",
          cost: "premium",
        },
        { from: "stream", to: "dcr", label: "SecurityEvent / CommonSecurityLog" },
        { from: "dcr", to: "law", cost: "premium" },
      ],
    },
  },
  {
    id: "windows-ama-direct",
    title: "Windows Events via Azure Monitor Agent",
    summary:
      "The Azure Monitor Agent on Windows machines ships events directly to Sentinel through its own agent-assigned DCR - Cribl is not in this path.",
    why:
      "Honest alternative for comparison: AMA is Microsoft's native path (required for some Sentinel connectors) but offers no reduction or shaping before ingest - every event bills at analytics-tier rates.",
    requiresProducts: [],
    requiresResources: ["log-analytics"],
    requiresSources: ["windows-ama"],
    considerations: [
      "The DCR here is AMA-managed (agent association + xPath filters), not this app's Kind:Direct kind - different creation path, different limits.",
      "No Cribl in the path means no reduction: pair AMA-mandated hosts with aggressive DCR xPath filtering, and prefer WEF/Edge paths where cost and shaping matter.",
      "Sentinel's 'Windows Security Events via AMA' connector drives this path; it can coexist with Cribl-fed tables in the same workspace.",
    ],
    diagram: {
      nodes: [
        { id: "win", label: "Windows endpoints", tier: "source" },
        { id: "ama", label: "Azure Monitor Agent", tier: "source" },
        { id: "amadcr", label: "DCR (AMA-managed)", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "win", to: "ama" },
        { from: "ama", to: "amadcr", label: "agent association" },
        { from: "amadcr", to: "law", cost: "premium" },
      ],
    },
  },
  {
    id: "event-hub-egress",
    title: "Event Hub egress (Stream destination)",
    summary:
      "Stream routes shaped events INTO Event Hubs for downstream consumers - ADX ingestion, partner SIEMs, other tenants - from the same pipelines that feed Sentinel.",
    why:
      "One shaped stream, many consumers: Event Hubs is the neutral hand-off when another team or system needs the data and a direct integration is not wanted.",
    requiresProducts: ["stream"],
    requiresResources: ["event-hub-egress"],
    considerations: [
      "Size throughput units and partitions for the egress peak; Stream's Event Hubs destination speaks the Kafka-compatible endpoint.",
      "Event Hubs is a native ADX ingestion source - pair this with the ADX pattern when the consumer is a Kusto cluster.",
      "Keep the Sentinel route and the egress route on the same pipelines so both consumers see identical shaping.",
    ],
    diagram: {
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "eh", label: "Event Hub (egress)", tier: "azure" },
        { id: "consumers", label: "Downstream consumers", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        { from: "stream", to: "eh", label: "EH destination", cost: "economical" },
        { from: "eh", to: "consumers" },
      ],
    },
  },
  {
    id: "blob-collector",
    title: "Blob collection (storage as source)",
    summary:
      "Stream's scheduled blob collector reads existing blobs from a storage account - exports, application drops, archived logs - and ingests the shaped result.",
    why:
      "Plenty of telemetry is already landing in storage accounts without an agent in sight; a scheduled collector turns those containers into a first-class source.",
    requiresProducts: ["stream"],
    requiresResources: ["blob-storage-source"],
    considerations: [
      "Grant the collector identity Storage Blob Data Reader on the account.",
      "Partitioned paths (source/date) keep collection runs scoped and cheap to filter.",
      "Any producer works - service exports, AzCopy drops, legacy archivers; the vNet flow-log pattern is this same shape specialized for Network Watcher.",
    ],
    diagram: {
      nodes: [
        { id: "blob", label: "Storage account", tier: "source" },
        { id: "stream", label: "Stream collector", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "blob", to: "stream", label: "Azure Blob source (scheduled)" },
        { from: "stream", to: "dcr" },
        { from: "dcr", to: "law", cost: "premium" },
      ],
    },
  },
  {
    id: "adx-destination",
    title: "ADX as a Stream destination",
    summary:
      "Stream lands full-fidelity or specialized copies in an Azure Data Explorer cluster - the Kusto store for analytics Sentinel does not need to bill for.",
    why:
      "ADX gives KQL over massive volumes at a fraction of analytics-tier cost: the classic split routes detections to Sentinel and everything else to Kusto.",
    requiresProducts: ["stream"],
    requiresResources: ["adx"],
    considerations: [
      "Stream's Azure Data Explorer destination supports queued (batching) and streaming ingestion - pick per table volume and latency need.",
      "This app's CompleteLab profile deploys a working example: an ADX cluster with a CriblLogs database and the CommonSecurityLog table schema.",
      "Grant the ingestion identity Database Ingestor on the target database.",
    ],
    diagram: {
      nodes: [
        { id: "src", label: "Log sources", tier: "source" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "adx", label: "Azure Data Explorer", tier: "destination" },
      ],
      edges: [
        { from: "src", to: "stream" },
        {
          from: "stream",
          to: "adx",
          label: "ADX destination (queued/streaming)",
          cost: "economical",
        },
      ],
    },
  },
  {
    id: "adx-search-in-place",
    title: "Cribl Search over ADX",
    summary:
      "Cribl Search queries Azure Data Explorer in place through its native ADX dataset provider and forwards only findings.",
    why:
      "Data already in Kusto should be searched in Kusto: the ADX provider federates KQL-backed datasets into Search so investigations span ADX, archives, and Lake from one query bar.",
    requiresProducts: ["search"],
    requiresResources: ["adx"],
    considerations: [
      "Configure the ADX dataset provider with the cluster URI and an app registration granted Database Viewer.",
      "Pair with the ADX destination pattern for the land-then-search loop: Stream fills the cluster, Search investigates it.",
      "Findings can be promoted to Sentinel as a curated table or incidents - the bulk stays in ADX. The promotion rides the send operator back through a Stream worker group (the violet path).",
    ],
    diagram: {
      nodes: [
        { id: "adx", label: "Azure Data Explorer", tier: "source" },
        { id: "search", label: "Cribl Search", tier: "cribl" },
        { id: "stream", label: "Cribl Stream", tier: "cribl" },
        { id: "dcr", label: "Kind:Direct DCR", tier: "azure" },
        { id: "law", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "adx", to: "search", label: "ADX dataset provider (KQL)" },
        {
          from: "search",
          to: "stream",
          label: "send findings (Cribl HTTP source)",
          tone: "search",
        },
        { from: "stream", to: "dcr", label: "findings only", tone: "search" },
        { from: "dcr", to: "law", cost: "premium", tone: "search" },
      ],
    },
  },
  {
    id: "private-blob-endpoint",
    title: "Blob Storage over a private endpoint",
    summary:
      "Stream reaches the storage account through a private endpoint in the vNet: the blob hostname must resolve to the PRIVATE IP, and the workers need a network path to it.",
    why:
      "When policy closes the storage account's public endpoint, the archive/collector path stays inside the vNet - but ONLY if DNS and routing are both in place; a missing DNS zone silently falls back to the public IP.",
    requiresProducts: ["stream"],
    requiresResources: ["blob-storage", "private-link-blob"],
    considerations: [
      "Link the privatelink.blob.core.windows.net private DNS zone to the worker vNet (or forward to it from custom DNS); verify from a worker that the account hostname resolves to the PRIVATE IP.",
      "Workers need a NETWORK PATH to the endpoint's IP: same vNet, peering, or VPN/ExpressRoute, with NSGs allowing 443 to the endpoint subnet.",
      "Once the private path is verified, disable public network access on the storage account - the honest test that nothing still rides the public route.",
    ],
    diagram: {
      nodes: [
        { id: "stream", label: "Cribl Stream (vNet)", tier: "cribl" },
        { id: "dns", label: "DNS: privatelink.blob.core.windows.net", tier: "azure" },
        { id: "pe", label: "Private endpoint (Blob)", tier: "azure" },
        { id: "blob", label: "Blob archive", tier: "destination" },
      ],
      edges: [
        { from: "stream", to: "dns", label: "worker DNS lookup" },
        { from: "dns", to: "pe", label: "resolves to the private IP" },
        { from: "stream", to: "pe", label: "private IP via vNet path" },
        { from: "pe", to: "blob", cost: "economical" },
      ],
    },
  },
  {
    id: "private-eventhub-endpoint",
    title: "Event Hub over a private endpoint",
    summary:
      "Stream consumes the Event Hub namespace through a private endpoint: the servicebus hostname must resolve to the PRIVATE IP, and the workers need a vNet path to it.",
    why:
      "Locked-down namespaces (public access disabled) still feed Cribl - the Kafka/AMQP session simply rides the private IP, provided DNS and routing are wired.",
    requiresProducts: ["stream"],
    requiresResources: ["event-hub", "private-link-eventhub"],
    considerations: [
      "Link the privatelink.servicebus.windows.net private DNS zone to the worker vNet (or forward from custom DNS); verify the namespace hostname resolves to the PRIVATE IP from a worker.",
      "Workers need a NETWORK PATH to the endpoint's IP (vNet, peering, or VPN/ExpressRoute) with 9093/5671 allowed to the endpoint subnet.",
      "Disable the namespace's public network access once the private path is verified.",
    ],
    diagram: {
      nodes: [
        { id: "eh", label: "Event Hub", tier: "source" },
        { id: "dns", label: "DNS: privatelink.servicebus.windows.net", tier: "azure" },
        { id: "pe", label: "Private endpoint (Event Hub)", tier: "azure" },
        { id: "stream", label: "Cribl Stream (vNet)", tier: "cribl" },
      ],
      edges: [
        { from: "stream", to: "dns", label: "worker DNS lookup" },
        { from: "dns", to: "pe", label: "resolves to the private IP" },
        { from: "eh", to: "pe" },
        { from: "pe", to: "stream", label: "Azure Event Hubs source (private)" },
      ],
    },
  },
  {
    id: "private-adx-endpoint",
    title: "ADX over a private endpoint",
    summary:
      "Stream ingests into the Kusto cluster through a private endpoint: the cluster hostname must resolve to the PRIVATE IP, and the workers need a vNet path to it.",
    why:
      "Clusters with public access disabled still take Cribl's queued/streaming ingestion over the private IP - DNS zone linkage and a routed path are the two prerequisites.",
    requiresProducts: ["stream"],
    requiresResources: ["adx", "private-link-adx"],
    considerations: [
      "Link the region-scoped privatelink.kusto.windows.net private DNS zone to the worker vNet (ADX zones are per region); verify the cluster URI resolves to the PRIVATE IP from a worker.",
      "Workers need a NETWORK PATH to the endpoint's IP with 443 allowed to the endpoint subnet; ADX private endpoints also front the ingestion blob/queue endpoints - all must resolve privately.",
      "Disable the cluster's public network access once the private path is verified.",
    ],
    diagram: {
      nodes: [
        { id: "stream", label: "Cribl Stream (vNet)", tier: "cribl" },
        { id: "dns", label: "DNS: privatelink.kusto.windows.net", tier: "azure" },
        { id: "pe", label: "Private endpoint (ADX)", tier: "azure" },
        { id: "adx", label: "Azure Data Explorer", tier: "destination" },
      ],
      edges: [
        { from: "stream", to: "dns", label: "worker DNS lookup" },
        { from: "dns", to: "pe", label: "resolves to the private IP" },
        { from: "stream", to: "pe", label: "private IP via vNet path" },
        { from: "pe", to: "adx", cost: "economical" },
      ],
    },
  },
];

/** The user's selection: products, resources, and specific log sources. */
export interface ArchitectureSelection {
  products: readonly CriblProduct[];
  resources: readonly AzureResource[];
  /** Specific log sources in use (optional; ingress patterns key on these). */
  sources?: readonly LogSource[];
  /**
   * Sentinel-solution sources by EXACT shipped-classification name (see
   * solution-ingress.ts / recommendWithSolutions). Optional; the solution
   * pickers feed this.
   */
  solutionSources?: readonly string[];
}

/**
 * Expand implied resources: Sentinel sits ON a Log Analytics workspace, so a
 * Sentinel selection satisfies any pattern requiring "log-analytics"; the
 * Sentinel data lake presupposes Sentinel workspaces onboarded to it, so it
 * implies both.
 */
export function expandResources(
  resources: readonly AzureResource[],
): Set<AzureResource> {
  const set = new Set(resources);
  if (set.has("sentinel-data-lake")) {
    set.add("sentinel");
  }
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
  extraPatterns: readonly ArchitecturePattern[] = [],
): PatternRecommendation[] {
  const selectedSources = selection.sources ?? [];
  if (
    selection.products.length === 0 &&
    selection.resources.length === 0 &&
    selectedSources.length === 0 &&
    extraPatterns.length === 0
  ) {
    return [];
  }
  const products = new Set(selection.products);
  const resources = expandResources(selection.resources);
  const sources = new Set(selectedSources);

  const matches: PatternRecommendation[] = [];
  const nears: PatternRecommendation[] = [];
  for (const pattern of [...ARCHITECTURE_PATTERNS, ...extraPatterns]) {
    const requiredSources = pattern.requiresSources ?? [];
    // Source-ingress patterns never surface unless their source is SELECTED:
    // a near-miss must not suggest adding a source the user did not name.
    if (requiredSources.some((s) => !sources.has(s))) {
      continue;
    }
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
    p.requiresProducts.length +
    p.requiresResources.length +
    (p.requiresSources?.length ?? 0);
  matches.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
  nears.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
  return [...matches, ...nears];
}

/** A one-click journey preset: applies a whole selection at once. */
export interface ArchitecturePreset {
  id: string;
  label: string;
  /** One sentence shown as the chip tooltip. */
  description: string;
  selection: ArchitectureSelection;
}

/**
 * The journey presets - named scenarios that set every picker at once so a
 * customer starts from a story instead of blank multiselects. Every preset
 * is pinned to yield at least one full pattern match.
 */
export const ARCHITECTURE_PRESETS: readonly ArchitecturePreset[] = [
  {
    id: "siem-migration-splunk",
    label: "SIEM migration from Splunk",
    description:
      "Re-point Splunk Universal Forwarders at Stream and dual-route to Splunk and Sentinel through cutover.",
    selection: {
      products: ["stream"],
      resources: ["sentinel"],
      sources: ["windows-splunk-uf"],
    },
  },
  {
    id: "cost-reduction-archive",
    label: "Cost reduction and archive",
    description:
      "Reduce in the pipeline, full fidelity to cheap blob, the hot subset to Sentinel Analytics, high-volume feeds on the Auxiliary plan, search the archive in place.",
    selection: {
      products: ["stream", "search"],
      resources: ["sentinel", "blob-storage"],
    },
  },
  {
    id: "long-term-retention-sdl",
    label: "Long-term retention (data lake)",
    description:
      "Up to 12 years at lake economics: analytics tables mirror into the Sentinel data lake and Search queries it in place.",
    selection: {
      products: ["stream", "search"],
      resources: ["sentinel-data-lake"],
    },
  },
  {
    id: "private-regulated",
    label: "Private and regulated",
    description:
      "No public ingestion endpoints: a DCE joined to an AMPLS keeps the whole path inside the vNet.",
    selection: {
      products: ["stream"],
      resources: ["sentinel", "private-link-law"],
    },
  },
  {
    id: "azure-platform-fanin",
    label: "Azure platform logs fan-in",
    description:
      "Platform diagnostics and Entra ID exports stream into Event Hubs; Stream tames the volume before Sentinel.",
    selection: {
      products: ["stream"],
      resources: ["sentinel", "event-hub", "entra-diagnostics"],
    },
  },
  {
    id: "windows-estate",
    label: "Windows estate onboarding",
    description:
      "Cribl Edge on the hosts plus an Edge relay on existing WEC servers - one control plane for Windows collection.",
    selection: {
      products: ["stream", "edge"],
      resources: ["sentinel"],
      sources: ["windows-edge", "windows-wec"],
    },
  },
];

/**
 * When to reach for each product - the capability legend's second line. The
 * "what it is" line reuses CRIBL_PRODUCTS descriptions so the two cannot
 * drift. Record over the union: compile-time exhaustive.
 */
export const PRODUCT_WHEN_TO_USE: Record<CriblProduct, string> = {
  stream:
    "Use when data is in motion: reduce, shape, enrich, and route feeds before they bill at the destination.",
  edge:
    "Use when collection starts on the hosts: one managed fleet replaces per-endpoint agents and forwards to Stream.",
  lake:
    "Use for full-fidelity retention on Cribl.Cloud: keep everything cheaply searchable while Sentinel gets only the hot subset.",
  search:
    "Use to investigate data where it lives - blob archives, Lake, ADX, the Sentinel data lake - instead of ingesting it first.",
};

/** Resolve a product/resource/source id to its display label (missing chips). */
export function catalogLabel(id: string): string {
  const product = CRIBL_PRODUCTS.find((p) => p.id === id);
  if (product !== undefined) {
    return product.label;
  }
  const resource = AZURE_RESOURCES.find((r) => r.id === id);
  if (resource !== undefined) {
    return resource.label;
  }
  const source = LOG_SOURCES.find((s) => s.id === id);
  return source !== undefined ? source.label : id;
}

/** A node's canonical merge key: its label reduced to lowercase alphanumerics. */
function canonicalNodeKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The Cribl SOURCE TYPE named by an ingress edge label, or null. Ingress
 * labels follow the "<Source type> source (detail)" convention (2026-07-29
 * user direction), so "Syslog source (514/6514, CSV/CEF)" yields "Syslog"
 * and "replay (Azure Blob source)" yields "Azure Blob". Renderers attach
 * these as tags on the receiving Cribl node.
 */
export function criblSourceTypeFromLabel(label: string): string | null {
  const match = /([A-Za-z][A-Za-z ]*) source\b/.exec(label);
  if (match === null) {
    return null;
  }
  const type = match[1].trim();
  return type === "" ? null : type;
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
        nodes.set(key, {
          id: key,
          label: node.label,
          tier: node.tier,
          ...(node.muted === true ? { muted: true } : {}),
        });
      }
    }
    for (const edge of pattern.diagram.edges) {
      const from = localToKey.get(edge.from);
      const to = localToKey.get(edge.to);
      if (from === undefined || to === undefined || from === to) continue;
      const key = `${from}\u0000${to}`;
      if (!edges.has(key)) {
        edges.set(key, {
          from,
          to,
          ...(edge.label !== undefined ? { label: edge.label } : {}),
          ...(edge.cost !== undefined ? { cost: edge.cost } : {}),
          ...(edge.tone !== undefined ? { tone: edge.tone } : {}),
          ...(edge.muted !== undefined ? { muted: edge.muted } : {}),
        });
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * Apply selection-driven SERVICE OVERLAYS to a unified diagram (user
 * direction 2026-07-29): Microsoft Sentinel is a service ON the workspace,
 * so when the selection includes Sentinel (directly or implied by the data
 * lake), the "Log Analytics workspace" node gains a corner tag instead of a
 * separate chained node. Pure; returns a new diagram, input untouched.
 */
export function applySentinelOverlay(
  diagram: PatternDiagram,
  selection: ArchitectureSelection,
): PatternDiagram {
  if (!expandResources(selection.resources).has("sentinel")) {
    return diagram;
  }
  return {
    nodes: diagram.nodes.map((node) =>
      node.label === "Log Analytics workspace"
        ? {
            ...node,
            overlays: [
              ...new Set([...(node.overlays ?? []), "Microsoft Sentinel"]),
            ],
          }
        : node,
    ),
    edges: diagram.edges,
  };
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

/**
 * One routing-table row rendered VISUALLY in a node popover (2026-07-30
 * user direction: the routes list should look like the Cribl UI's route
 * table scaled down - clean bubbles, not a text dump). The filter never
 * renders inline; it surfaces as the row's hover tooltip.
 */
export interface DiagramRouteRow {
  name: string;
  /** The pack or pipeline the route runs ("passthru" when none). */
  pipeline: string;
  destination: string;
  /** Full filter expression - shown as the row tooltip only. */
  filter?: string;
  disabled?: boolean;
  /** Non-final route: clones the events and continues down the table. */
  copy?: boolean;
}

/** One labeled detail row in a node popover ("Type: eventhub"). */
export interface DiagramFact {
  label: string;
  value: string;
}

/** One ordered step (a pipeline function) in a node popover. */
export interface DiagramStep {
  name: string;
  disabled?: boolean;
}

/** A diagram node's purpose text plus its vendor documentation links. */
export interface DiagramNodeInfo {
  /** What this component does in the flow, in a sentence or two. */
  purpose: string;
  docs: readonly DiagramDocLink[];
  /** Labeled detail rows drawn under the purpose (2026-07-30: every live
   * popover presents structured facts, not prose dumps). */
  facts?: readonly DiagramFact[];
  /** Numbered step pills (pipeline functions, in evaluation order). */
  steps?: readonly DiagramStep[];
  /** Routing-table rows drawn as visual bubbles under the purpose text. */
  routes?: readonly DiagramRouteRow[];
}

const MS = "https://learn.microsoft.com";
const CRIBL = "https://docs.cribl.io";
const PACKS = "https://packs.cribl.io";

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
  [canonicalNodeKey("Log Analytics workspace")]: {
    purpose:
      "The Log Analytics workspace - where shaped events land in tables and analytics-tier billing applies. Microsoft Sentinel, when enabled, is a SERVICE on top of this workspace, not a separate store.",
    docs: [
      {
        label: "Log Analytics workspaces",
        url: MS + "/azure/azure-monitor/logs/log-analytics-workspace-overview",
      },
      { label: "Microsoft Sentinel overview", url: MS + "/azure/sentinel/overview" },
    ],
  },
  [canonicalNodeKey("Auxiliary-plan table")]: {
    purpose:
      "A custom (_CL) table on the Auxiliary log plan: ingest at a small fraction of the Analytics-plan rate for high-volume, low-value telemetry. Single-table KQL with limited operators, 30-day interactive retention, no direct analytics rules - summary rules lift aggregates into Analytics tables for detections. The Sentinel data lake tier is its successor: onboarding the workspace to the lake surfaces Auxiliary tables as lake-tier tables and switches billing to the lake meters.",
    docs: [
      {
        label: "Azure Monitor table plans",
        url: MS + "/azure/azure-monitor/logs/data-platform-logs",
      },
      {
        label: "Summary rules",
        url: MS + "/azure/azure-monitor/logs/summary-rules",
      },
    ],
  },
  [canonicalNodeKey("Microsoft Sentinel")]: {
    purpose:
      "The SIEM service enabled ON the workspace (the SecurityInsights solution): detections, hunting, incidents, and workbooks running over the workspace tables. Selecting only Log Analytics draws the workspace without it.",
    docs: [
      { label: "Microsoft Sentinel overview", url: MS + "/azure/sentinel/overview" },
      {
        label: "Enable Sentinel on a workspace",
        url: MS + "/azure/sentinel/quickstart-onboard",
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
  [canonicalNodeKey("Cribl Lake")]: {
    purpose:
      "Cribl's managed data lake tier: full-fidelity retention with Search on top, while Sentinel gets the reduced subset.",
    docs: [{ label: "Cribl Lake docs", url: CRIBL + "/lake/" }],
  },
  [canonicalNodeKey("Cribl Search")]: {
    purpose:
      "Query data where it lives - blob archives, Cribl Lake, ADX, the Sentinel data lake - without ingesting it first; forward only findings to Sentinel.",
    docs: [
      { label: "Cribl Search docs", url: CRIBL + "/search/" },
      {
        label: "Search dataset providers",
        url: CRIBL + "/search/connect-to-data/",
      },
    ],
  },
  [canonicalNodeKey("Private endpoint (Blob)")]: {
    purpose:
      "The storage account's private endpoint: a NIC with a PRIVATE IP inside the vNet fronting the blob service. Reaching it needs the privatelink DNS zone (so the hostname resolves privately) AND a routed network path from the workers.",
    docs: [
      {
        label: "Storage private endpoints",
        url: MS + "/azure/storage/common/storage-private-endpoints",
      },
      {
        label: "Private endpoint DNS",
        url: MS + "/azure/private-link/private-endpoint-dns",
      },
    ],
  },
  [canonicalNodeKey("Private endpoint (Event Hub)")]: {
    purpose:
      "The Event Hub namespace's private endpoint: a private IP inside the vNet fronting the servicebus endpoint. Needs the privatelink DNS zone linked and a network path (9093/5671) from the workers.",
    docs: [
      {
        label: "Event Hubs Private Link",
        url: MS + "/azure/event-hubs/private-link-service",
      },
      {
        label: "Private endpoint DNS",
        url: MS + "/azure/private-link/private-endpoint-dns",
      },
    ],
  },
  [canonicalNodeKey("Private endpoint (ADX)")]: {
    purpose:
      "The Kusto cluster's private endpoint: private IPs fronting the cluster AND its ingestion blob/queue endpoints. Needs the region-scoped privatelink DNS zones linked and a routed path from the workers.",
    docs: [
      {
        label: "ADX private endpoints",
        url: MS + "/azure/data-explorer/security-network-private-endpoint",
      },
      {
        label: "Private endpoint DNS",
        url: MS + "/azure/private-link/private-endpoint-dns",
      },
    ],
  },
  [canonicalNodeKey("DNS: privatelink.monitor.azure.com")]: {
    purpose:
      "The Azure Monitor privatelink DNS zone: linked to the worker vNet (or forwarded from custom DNS) it makes the ingestion hostnames resolve to the PRIVATE IP. Without it, resolution falls back to the public IP and the private path silently never engages.",
    docs: [
      {
        label: "Azure Monitor Private Link DNS",
        url: MS + "/azure/azure-monitor/logs/private-link-security",
      },
      {
        label: "Private endpoint DNS",
        url: MS + "/azure/private-link/private-endpoint-dns",
      },
    ],
  },
  [canonicalNodeKey("DNS: privatelink.blob.core.windows.net")]: {
    purpose:
      "The blob privatelink DNS zone: linked to the worker vNet it resolves the storage-account hostname to the private endpoint's IP - the DNS half of the private path (routing is the other half).",
    docs: [
      {
        label: "Private endpoint DNS",
        url: MS + "/azure/private-link/private-endpoint-dns",
      },
    ],
  },
  [canonicalNodeKey("DNS: privatelink.servicebus.windows.net")]: {
    purpose:
      "The Service Bus / Event Hubs privatelink DNS zone: linked to the worker vNet it resolves the namespace hostname to the private endpoint's IP - the DNS half of the private path.",
    docs: [
      {
        label: "Private endpoint DNS",
        url: MS + "/azure/private-link/private-endpoint-dns",
      },
    ],
  },
  [canonicalNodeKey("DNS: privatelink.kusto.windows.net")]: {
    purpose:
      "The (region-scoped) Kusto privatelink DNS zone: linked to the worker vNet it resolves the cluster URI to the private endpoint's IP - the DNS half of the private path.",
    docs: [
      {
        label: "Private endpoint DNS",
        url: MS + "/azure/private-link/private-endpoint-dns",
      },
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
      "A storage account whose existing blobs Cribl collects on a schedule - vNet flow logs (insights-logs-flowlogflowevent), service exports, application drops.",
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
      "A scheduled Cribl collection job pulling blobs on a cron (the flow-log job runs hourly at :15 over a -75m..-15m window), breaking and shaping them before ingestion.",
    docs: [
      { label: "Cribl collectors", url: CRIBL + "/stream/collectors/" },
      {
        label: "Cribl Azure Blob source",
        url: CRIBL + "/stream/sources-azure-blob/",
      },
    ],
  },
  [canonicalNodeKey("Sentinel data lake")]: {
    purpose:
      "Sentinel's long-term lake tier: analytics-tier tables mirror into it (single copy, open Parquet, mirroring itself adds no lake ingestion charge), retention runs to 12 years, and KQL jobs promote data back to the analytics tier on demand. Storage bills at a uniform 6:1 compression assumption, KQL queries per GB scanned, notebooks (Spark) per compute hour. It has its OWN query endpoint (api.securityplatform.microsoft.com/lake/kql) - distinct from the Log Analytics Query API - and its tier supersedes the Auxiliary/Basic plans.",
    docs: [
      {
        label: "Sentinel data lake overview",
        url: MS + "/azure/sentinel/datalake/sentinel-lake-overview",
      },
      {
        label: "Lake KQL query APIs",
        url: MS + "/azure/sentinel/datalake/kql-queries-api",
      },
      {
        label: "KQL and the data lake",
        url: MS + "/azure/sentinel/datalake/kql-overview",
      },
      {
        label: "Sentinel billing (data lake meters)",
        url: MS + "/azure/sentinel/billing",
      },
    ],
  },
  [canonicalNodeKey("Palo Alto NGFW")]: {
    purpose:
      "PAN-OS firewalls forwarding Traffic/Threat logs over syslog (CSV or CEF); the Cribl Palo Alto pack parses and maps them toward CommonSecurityLog.",
    docs: [
      { label: "Cribl syslog source", url: CRIBL + "/stream/sources-syslog/" },
      {
        label: "Cribl Pack for Palo Alto Networks",
        url: PACKS + "/packs/cribl-palo-alto-networks",
      },
    ],
  },
  [canonicalNodeKey("Windows endpoints")]: {
    purpose:
      "The Windows machines producing Security/System/Application events - collected via WEF, a WEC relay, Cribl Edge, Winlogbeat, Splunk UF, or the Azure Monitor Agent depending on the selected method.",
    docs: [
      {
        label: "Cribl upstream agents guide",
        url: CRIBL + "/stream/usecase-logging-agents/",
      },
      {
        label: "Cribl Windows Events pack",
        url: PACKS + "/packs/cribl-windows-events",
      },
    ],
  },
  [canonicalNodeKey("Winlogbeat agents")]: {
    purpose:
      "Existing Winlogbeat shippers reading Windows Event Log channels locally. Their Elasticsearch output points at Cribl Stream's Elasticsearch API source - to the Beat, Stream IS Elasticsearch.",
    docs: [
      {
        label: "Cribl Elasticsearch API source",
        url: CRIBL + "/stream/sources-elastic/",
      },
      {
        label: "Cribl upstream agents guide",
        url: CRIBL + "/stream/usecase-logging-agents/",
      },
    ],
  },
  [canonicalNodeKey("Splunk Heavy Forwarders")]: {
    purpose:
      "The intermediate Splunk forwarding tier most estates run - parsing, routing, and hosting modular inputs. The migration's fastest intercept point: one outputs.conf change here re-routes the whole estate through Stream, and the tier is decommissioned once UFs point at Stream directly and its inputs are re-homed.",
    docs: [
      {
        label: "Cribl Splunk TCP source",
        url: CRIBL + "/stream/sources-splunk-tcp/",
      },
    ],
  },
  [canonicalNodeKey("Splunk indexers")]: {
    purpose:
      "The existing Splunk indexer tier - the before state of this migration and the dual-run target during it. Stream's Splunk Load Balanced destination keeps feeding it until detection parity is proven in Sentinel; the tier is then decommissioned on the customer's schedule while the UF fleet stays on as transport.",
    docs: [
      {
        label: "Cribl Splunk Load Balanced destination",
        url: CRIBL + "/stream/destinations-splunk-lb/",
      },
    ],
  },
  [canonicalNodeKey("Splunk UF agents")]: {
    purpose:
      "Existing Splunk Universal Forwarders collecting Windows events. Their outputs.conf targets Cribl Stream's Splunk TCP source over S2S - a config push, not an agent migration; dual-routing to Splunk and Sentinel can run through cutover.",
    docs: [
      {
        label: "Cribl Splunk TCP source",
        url: CRIBL + "/stream/sources-splunk-tcp/",
      },
      {
        label: "Cribl upstream agents guide",
        url: CRIBL + "/stream/usecase-logging-agents/",
      },
    ],
  },
  [canonicalNodeKey("WEC server")]: {
    purpose:
      "A dedicated Windows Event Collector receiving WEF subscriptions; Cribl Edge on the WEC reads the ForwardedEvents channel and ships to Stream - keeps an existing collector investment.",
    docs: [
      {
        label: "Cribl WEF configuration guide",
        url: CRIBL + "/stream/usecase-wef-config/",
      },
      {
        label: "Edge Windows Event Logs source",
        url: CRIBL + "/edge/sources-windows-event-logs/",
      },
    ],
  },
  [canonicalNodeKey("Azure Monitor Agent")]: {
    purpose:
      "Microsoft's native collection agent: ships Windows events directly to the workspace through an agent-assigned DCR. No Cribl in this path - no reduction or shaping before ingest.",
    docs: [
      {
        label: "Azure Monitor Agent overview",
        url: MS + "/azure/azure-monitor/agents/azure-monitor-agent-overview",
      },
      {
        label: "Windows Security Events via AMA",
        url: MS + "/azure/sentinel/data-connectors/windows-security-events-via-ama",
      },
    ],
  },
  [canonicalNodeKey("DCR (AMA-managed)")]: {
    purpose:
      "The Data Collection Rule the Azure Monitor Agent path uses: associated to the machines, filtering with xPath queries - a different kind and creation path than this app's Kind:Direct DCRs.",
    docs: [
      {
        label: "Collect events with AMA",
        url: MS + "/azure/azure-monitor/agents/data-collection-windows-events",
      },
      {
        label: "Data collection rules overview",
        url: MS + "/azure/azure-monitor/essentials/data-collection-rule-overview",
      },
    ],
  },
  [canonicalNodeKey("Event Hub (egress)")]: {
    purpose:
      "Event Hubs on the OUTBOUND side of Stream: the neutral hand-off for downstream consumers (ADX ingestion, partner SIEMs, other tenants) fed from the same shaped pipelines.",
    docs: [
      { label: "Azure Event Hubs", url: MS + "/azure/event-hubs/event-hubs-about" },
      {
        label: "Cribl Azure Event Hubs destination",
        url: CRIBL + "/stream/destinations-azure-event-hubs/",
      },
    ],
  },
  [canonicalNodeKey("Downstream consumers")]: {
    purpose:
      "Whatever reads the egress hub: ADX ingestion pipelines, partner SIEMs, another team's tenant - consumers that want the shaped stream without a direct integration.",
    docs: [
      {
        label: "Event Hubs consumer groups",
        url: MS + "/azure/event-hubs/event-hubs-features",
      },
    ],
  },
  [canonicalNodeKey("Sentinel connector (pull)")]: {
    purpose:
      "A Codeless Connector Framework PULL connector (RestApiPoller, WebSocket, cloud-storage kinds): Sentinel initiates collection on a schedule. Cribl can deliver into the SAME table via the Logs Ingestion API - run one path or events duplicate.",
    docs: [
      {
        label: "Codeless Connector Framework",
        url: MS + "/azure/sentinel/create-codeless-connector",
      },
      {
        label: "Sentinel data connectors",
        url: MS + "/azure/sentinel/connect-data-sources",
      },
    ],
  },
  [canonicalNodeKey("Agent / Functions connector")]: {
    purpose:
      "A legacy-class connector: an agent (AMA/legacy Log Analytics agent) or an Azure Functions poller feeds the workspace. There is no native Logs Ingestion target - the Cribl alternative lands in a custom table with a function alias.",
    docs: [
      {
        label: "Sentinel data connectors",
        url: MS + "/azure/sentinel/connect-data-sources",
      },
      {
        label: "Azure Monitor Agent overview",
        url: MS + "/azure/azure-monitor/agents/azure-monitor-agent-overview",
      },
    ],
  },
  [canonicalNodeKey("Azure Data Explorer")]: {
    purpose:
      "The Kusto cluster: a Stream DESTINATION for full-fidelity or specialized copies (queued or streaming ingestion) and a Cribl Search SOURCE through the native ADX dataset provider.",
    docs: [
      {
        label: "Azure Data Explorer",
        url: MS + "/azure/data-explorer/data-explorer-overview",
      },
      {
        label: "Cribl ADX destination",
        url: CRIBL + "/stream/destinations-azure-data-explorer/",
      },
      {
        label: "Cribl Search ADX provider",
        url: CRIBL + "/search/set-up-azure-data-explorer/",
      },
    ],
  },
};

/**
 * The generic info for a dynamic Sentinel-solution source node (labels end
 * " (solution)"; see solution-ingress.ts). One entry serves all ~436
 * solutions - the pattern's why/considerations carry the per-solution story.
 */
const SOLUTION_SOURCE_INFO: DiagramNodeInfo = {
  purpose:
    "A vendor log source packaged as a Microsoft Sentinel solution. Its data connector's kind decides the drawn Cribl integration point: Push and custom-table connectors take the Logs Ingestion API directly; pull and agent connectors show the native path next to the Cribl alternative.",
  docs: [
    {
      label: "Sentinel content hub catalog",
      url: MS + "/azure/sentinel/sentinel-solutions-catalog",
    },
    {
      label: "Cribl Microsoft Sentinel destination",
      url: CRIBL + "/stream/destinations-sentinel/",
    },
  ],
};

/**
 * The info entry for a node LABEL (the same canonical key the diagram merge
 * uses). Dynamic solution-source labels (ending " (solution)") resolve the
 * generic entry; anything else outside the catalog resolves undefined.
 */
export function diagramNodeInfo(label: string): DiagramNodeInfo | undefined {
  const entry = DIAGRAM_NODE_INFO[canonicalNodeKey(label)];
  if (entry !== undefined) {
    return entry;
  }
  return label.endsWith(" (solution)") ? SOLUTION_SOURCE_INFO : undefined;
}
