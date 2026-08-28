/**
 * Coverage catalog - WHAT CAN BE ONBOARDED, ported not invented.
 *
 * backlog.md#6: "The checkbox model exists as a file - port it, do not invent
 * one." The source is `resource-coverage.json` from the legacy Azure Log
 * Collection tool (`deprecated/Azure/Azure-LogCollection/core/`, v5.1.0,
 * production, catalogued as LOG-02), which is the single toggle file that
 * drove `Deploy-AllEnabledLogging`. Its shape is nearly what was asked for:
 * sources grouped by `method`, each with an `enabled` flag, plus tiers and
 * profiles wherever a source has sub-selections.
 *
 * THE `method` VALUES ARE THE SECTION KEYS. That is the load-bearing fact and
 * the reason this ports cleanly at all - the legacy file already grouped
 * sources the way backlog.md#6 wants the screen to. {@link CollectionMethod}
 * carries them verbatim: `built-in-policy`, `custom-initiative`, `script`,
 * `guided-portal`, `none`.
 *
 * WHAT THIS IS AND IS NOT. This module is the CATALOG - the fixed set of things
 * an operator may tick, with their sub-selections. It is not the selection
 * (that is `coverage-selection`, which persists to the app KV store per LOG-02),
 * and it is not the deploy semantics (that is `onboarding-selection`, the
 * additive-only contract from AZR-1, which this feeds).
 *
 * THE LEGACY FILE COVERS FOUR OF THE SIX SECTIONS, and pretending otherwise
 * would be the exact failure the "port, do not invent" instruction guards
 * against. Mapped against backlog.md#6a-6f:
 *
 *   6a  policy -> Event Hub    `built-in-policy` + `custom-initiative`  PORTED
 *   6b  direct ARM, no policy  `script`                                 PORTED
 *   6c  Defender XDR export    `guided-portal`                          PORTED
 *   6e  blob-only sources      `none` (the notSupported block)          PORTED
 *   6d  pull collectors        -- no legacy entry --                    ABSENT
 *   6f  agent-based (AMA+DCR)  -- partial: one notSupported entry --    ABSENT
 *
 * 6d and 6f have NO representation in `resource-coverage.json` because the
 * legacy tool did not do them; the only trace is `vmGuestLogs` sitting under
 * `notSupported` pointing at the separate DCR-Automation solution. They are not
 * stubbed here. A catalog that invented empty sections for them would report
 * coverage the port cannot back, and AZR-7 / AZR-9 are the cards that add them.
 *
 * The `enabled` flags in the source file are DEFAULTS, not state - see
 * {@link DEFAULT_ENABLED}. State lives in the KV store.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

/**
 * How a source is turned on. Verbatim from `resource-coverage.json`'s `method`
 * values, and per backlog.md#6 these ARE the screen's section keys.
 *
 *   built-in-policy    Microsoft's own initiative, assigned at MG scope
 *   custom-initiative  the 44-policy community bundle, imported and assigned
 *   script             direct ARM/Graph calls, no policy involved
 *   guided-portal      the app prepares it; a human finishes it in a portal
 *   none               cannot stream to Event Hub at all (reference only)
 */
export type CollectionMethod =
  | "built-in-policy"
  | "custom-initiative"
  | "script"
  | "guided-portal"
  | "none";

/** Deployment topology. Verbatim from `deploymentSettings.mode`. */
export type DeploymentMode = "Centralized" | "MultiRegion";

export const DEPLOYMENT_MODES: readonly DeploymentMode[] = ["Centralized", "MultiRegion"];

/**
 * A sub-selection carried by one item. Kept VERBATIM per backlog.md#6, which
 * names the tier/profile sub-selections as one of the two things not to
 * paraphrase.
 *
 *   tiers    a multi-select with an `All` shorthand (community policy tiers)
 *   profile  a single choice between named volume levels (Entra ID)
 *   export-tiers  the XDR table tiers, which are advisory groupings rather
 *                 than a deployable selection - the portal does the choosing
 */
export type SubSelectionKind = "tiers" | "profile" | "export-tiers";

/** One option inside a sub-selection, with the legacy file's own description. */
export interface SubSelectionOption {
  readonly key: string;
  /** The legacy `tierDetails` / profile note, verbatim where one existed. */
  readonly detail: string;
}

export interface SubSelection {
  readonly kind: SubSelectionKind;
  readonly options: readonly SubSelectionOption[];
  /** Default selection, from the legacy file's own `selected` / `profile`. */
  readonly defaultSelected: readonly string[];
  /** True when more than one option may be chosen at once. */
  readonly multi: boolean;
}

/** One tickable source. */
export interface CoverageItem {
  /** Stable id; also the {@link OnboardingItemId} used by onboarding-selection. */
  readonly id: string;
  /** The legacy JSON path this came from, so a reader can check the port. */
  readonly source: string;
  readonly method: CollectionMethod;
  readonly title: string;
  /** The legacy `description`, verbatim. */
  readonly description: string;
  /** The legacy `note`, verbatim, where one existed. */
  readonly note: string | null;
  /** The legacy `resourceCount`, verbatim, where one existed. */
  readonly resourceCount: string | null;
  readonly subSelection: SubSelection | null;
}

/**
 * A source that CANNOT stream to Event Hub. Kept verbatim per backlog.md#6 and
 * described in 6e. These are deliberately still in the catalog: the whole point
 * of the block is that an operator looking for VNet Flow Logs finds them,
 * learns they cannot work this way, and is told what does. Dropping them makes
 * the screen silently incomplete, which is the failure 6e exists to prevent.
 */
export interface UnsupportedItem {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly description: string;
  /** What to do instead. The legacy `alternative`, verbatim. */
  readonly alternative: string;
}

const COMMUNITY_TIERS: readonly SubSelectionOption[] = [
  { key: "Storage", detail: "Blob, File, Queue, Table, Storage Accounts" },
  {
    key: "Security",
    detail: "AKS, Firewall, NSG, Application Gateway, ExpressRoute, VirtualNetwork",
  },
  {
    key: "Data",
    detail: "CosmosDB, Data Factory, MySQL, PostgreSQL, MariaDB, Synapse, Databricks, etc.",
  },
  {
    key: "Compute",
    detail: "App Service, Function App, Batch, Machine Learning, Application Insights, etc.",
  },
  { key: "Integration", detail: "Logic Apps, Event Grid, Relay" },
  { key: "Networking", detail: "Load Balancer, Traffic Manager, CDN Endpoint" },
  { key: "AVD", detail: "Host Pool, Application Group, Workspace, Scaling Plan" },
  {
    key: "Other",
    detail: "Recovery Services, Healthcare APIs, IoT Hub, Cognitive Services, etc.",
  },
  { key: "All", detail: "Every tier above" },
];

/**
 * The XDR export tiers. ADVISORY, not deployable - `xdrStreaming` is a
 * `guided-portal` item, so the app prepares the Event Hub and validates
 * licences while a human picks tables in the Defender portal. Ported because
 * the guidance is the useful half and the legacy file carried the volume
 * warnings that stop someone enabling a 100 GB/day table by accident.
 */
const XDR_EXPORT_TIERS: readonly SubSelectionOption[] = [
  {
    key: "tier1_essential",
    detail:
      "Always export - high value, foundation for detection. AlertInfo, AlertEvidence, DeviceProcessEvents, DeviceNetworkEvents, DeviceLogonEvents, IdentityLogonEvents, EmailEvents",
  },
  {
    key: "tier2_recommended",
    detail:
      "High value for comprehensive visibility. DeviceFileEvents, DeviceRegistryEvents, DeviceEvents, EmailAttachmentInfo, EmailUrlInfo, UrlClickEvents, IdentityDirectoryEvents, CloudAppEvents",
  },
  {
    key: "tier3_situational",
    detail:
      "Evaluate based on specific use cases - often high volume. DeviceImageLoadEvents (CAUTION: ~100+ GB/day per 1K endpoints; consider filtering in Cribl), IdentityQueryEvents (CAUTION: high volume from normal AD operations - valuable but noisy), DeviceInfo, DeviceNetworkInfo, DeviceFileCertificateInfo, EmailPostDeliveryEvents",
  },
];

/**
 * The catalog, in the legacy file's own order so the port can be diffed against
 * it by eye.
 */
export const COVERAGE_CATALOG: readonly CoverageItem[] = [
  {
    id: "diagnosticSettingsInitiative",
    source: "builtInPolicies.diagnosticSettingsInitiative",
    method: "built-in-policy",
    title: "Microsoft Audit diagnostic-settings initiative",
    description: "69 resource types via Microsoft Audit initiative",
    note: null,
    resourceCount: "69 resource types",
    subSelection: null,
  },
  {
    id: "communityPolicyInitiative",
    source: "communityPolicyInitiative",
    method: "custom-initiative",
    title: "Community policy initiative",
    description:
      "44 resource types: Storage (Blob, File, Queue, Table, Accounts) + 39 additional types (Firewall, Synapse, AVD, etc.)",
    note: "Single initiative assignment instead of individual policies. Activity Log handled separately (subscription-level).",
    resourceCount: "44 resource types",
    subSelection: {
      kind: "tiers",
      options: COMMUNITY_TIERS,
      defaultSelected: ["All"],
      multi: true,
    },
  },
  {
    id: "activityLog",
    source: "supplementalPolicies.activityLog",
    method: "built-in-policy",
    title: "Azure Activity Log",
    description: "Azure Activity Log - Control plane operations (ARM operations, RBAC changes)",
    note: "Subscription-level policy, deployed separately from resource-type initiatives",
    resourceCount: null,
    subSelection: null,
  },
  {
    id: "entraId",
    source: "scriptBasedDeployment.entraId",
    method: "script",
    title: "Entra ID diagnostics",
    description:
      "Entra ID (Azure AD) - AuditLogs, SignInLogs, ServicePrincipal, ManagedIdentity, RiskyUsers",
    note: "HighVolume includes NonInteractiveUserSignInLogs (5-10x more volume)",
    resourceCount: null,
    subSelection: {
      kind: "profile",
      options: [
        { key: "Standard", detail: "AuditLogs, SignInLogs, ServicePrincipal, ManagedIdentity, RiskyUsers" },
        {
          key: "HighVolume",
          detail: "Standard plus NonInteractiveUserSignInLogs (5-10x more volume)",
        },
      ],
      defaultSelected: ["Standard"],
      multi: false,
    },
  },
  {
    id: "defenderExport",
    source: "scriptBasedDeployment.defenderExport",
    method: "script",
    title: "Defender for Cloud alert export",
    description: "Microsoft Defender for Cloud - Security alerts from enabled Defender plans",
    note: "Only exports alerts from already-enabled Defender plans (does not enable plans)",
    resourceCount: null,
    subSelection: null,
  },
  {
    id: "xdrStreaming",
    source: "defenderXDR.xdrStreaming",
    method: "guided-portal",
    title: "Defender XDR Streaming API",
    description:
      "Defender XDR Streaming API - Endpoint, Identity, Office 365, Cloud Apps telemetry",
    note: "Script creates Event Hub and validates licenses; portal configuration required for streaming",
    resourceCount: null,
    subSelection: {
      kind: "export-tiers",
      options: XDR_EXPORT_TIERS,
      defaultSelected: ["tier1_essential"],
      multi: true,
    },
  },
];

/**
 * Tables the XDR Streaming API does not carry. Verbatim from
 * `defenderXDR.xdrStreaming.tablesNotSupported`, and worth keeping for the same
 * reason as {@link UNSUPPORTED_SOURCES}: someone will go looking for them.
 */
export const XDR_TABLES_NOT_SUPPORTED = {
  tables: ["BehaviorEntities", "BehaviorInfo"] as readonly string[],
  reason:
    "Not yet supported in Streaming API. TVM tables (vulnerability/software inventory) also not available.",
} as const;

/** The `notSupported` block, verbatim. backlog.md#6e. */
export const UNSUPPORTED_SOURCES: readonly UnsupportedItem[] = [
  {
    id: "vnetFlowLogs",
    source: "notSupported.vnetFlowLogs",
    title: "VNet Flow Logs",
    description: "VNet Flow Logs - Storage Account only, use Cribl Azure Blob source",
    alternative:
      "Use Azure/dev/vNetFlowLogDiscovery for Cribl Blob source configuration",
  },
  {
    id: "nsgFlowLogs",
    source: "notSupported.nsgFlowLogs",
    title: "NSG Flow Logs",
    description: "NSG Flow Logs - Storage Account only, use Cribl Azure Blob source",
    alternative: "Use Cribl Azure Blob source with NSG flow log storage account",
  },
  {
    id: "resourceChangeTracking",
    source: "notSupported.resourceChangeTracking",
    title: "Resource change tracking",
    description: "Azure Resource Graph Change Analysis - Query-based only, no streaming",
    alternative: "Use scheduled Azure Resource Graph queries for change history",
  },
  {
    id: "vmGuestLogs",
    source: "notSupported.vmGuestLogs",
    title: "VM guest OS logs",
    description: "VM Guest OS Logs - Requires Azure Monitor Agent + DCR (not policy-based)",
    alternative: "Use DCR-Automation solution in this repository for AMA-based collection",
  },
];

/**
 * The legacy file's own `enabled` flags, carried across as the DEFAULT
 * selection rather than as state. Everything else defaults to unticked.
 *
 * These are defaults and nothing more: once an operator has saved a selection
 * it comes from the KV store, and this list stops being consulted. Keeping the
 * legacy defaults means a first run of the app proposes what the legacy tool
 * proposed, which is the closest thing to "no surprise" available here.
 */
export const DEFAULT_ENABLED: readonly string[] = [
  "diagnosticSettingsInitiative",
  "communityPolicyInitiative",
  "activityLog",
  "entraId",
];

/** Catalog lookup by id. Returns `undefined` for an unknown id, never throws. */
export function coverageItem(id: string): CoverageItem | undefined {
  return COVERAGE_CATALOG.find((i) => i.id === id);
}

/** Every item collected by one method - the screen's per-section list. */
export function itemsByMethod(method: CollectionMethod): readonly CoverageItem[] {
  return COVERAGE_CATALOG.filter((i) => i.method === method);
}
