/**
 * Onboarding sources - WHAT A CUSTOMER CAN CHOOSE TO ONBOARD, from either side.
 *
 * The AZR-18 screen lays the coverage catalog out as sections (onboarding-
 * sections) and deploys what is built. The How-to path (AZR-31) and the
 * dataflow diagram (AZR-30) need a different cut of the same facts: one entry
 * per SOURCE, saying how its logs travel (Event Hub or Blob), which Cribl input
 * type receives them, and which hubs Azure will write to. That is this catalog.
 *
 * NOTHING HERE IS RETYPED. Ids and titles come from COVERAGE_CATALOG and
 * UNSUPPORTED_SOURCES; Entra hub names come from ENTRA_PROFILE_CATEGORIES.
 * ONBOARDING_SECTIONS and its pins are unchanged (ADR 0007, D18).
 *
 * AUTOMATABLE IS A FUNCTION, NOT A FIELD (D2). {@link isAutomatable} asks
 * onboarding-sections' itemAvailability, the one authority on what the app can
 * deploy. Storing a copy here would let the two drift, and a drifted "true"
 * would offer an Automated mode with no deploy path behind it.
 *
 * THE CRIBL INPUT TYPE IS `eventhub`, NOT `azure_eventhub` (D8). The latter is
 * the DESTINATION type in the vendored OpenAPI spec; an input created with it
 * would be refused or, worse, be something else.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import {
  COVERAGE_CATALOG,
  UNSUPPORTED_SOURCES,
  XDR_TABLES_NOT_SUPPORTED,
  coverageItem,
} from "../coverage-model";
import {
  ENTRA_PROFILES,
  ENTRA_PROFILE_CATEGORIES,
  type EntraProfile,
} from "../entra-diagnostics/entra-categories";
import { XDR_TABLES_ROW_ID, itemAvailability } from "../onboarding-sections";
import type { PlanValues } from "./plan-values";

/** The six coverage-catalog ids plus the two blob-only flow-log sources. */
export type OnboardingSourceId =
  | "diagnosticSettingsInitiative"
  | "communityPolicyInitiative"
  | "activityLog"
  | "entraId"
  | "defenderExport"
  | "xdrStreaming"
  | "vnetFlowLogs"
  | "nsgFlowLogs";

/** How the logs leave Azure for Cribl. */
export type OnboardingTransport = "eventhub" | "blob";

/** The Cribl INPUT type that receives them (D8). */
export type CriblInputType = "eventhub" | "azure_blob";

/** What in Azure emits the logs. Drives the diagram's first card. */
export type EmitterKind =
  | "policy-initiative"
  | "activity-log-setting"
  | "tenant-diagnostic-setting"
  | "defender-export"
  | "xdr-streaming-api"
  | "vnet-flow-log"
  | "nsg-flow-log";

/**
 * Who names the hub the emitter writes to (D9).
 *
 *   named         the emitter names it (Defender export): one known hub
 *   auto-created  Azure creates `insights-*` hubs itself, one per category
 *   portal        an operator picks it in a portal Cribl cannot read (XDR)
 *   null          a blob source; no hub at all
 */
export type HubNaming = "named" | "auto-created" | "portal" | null;

export interface OnboardingSource {
  readonly id: OnboardingSourceId;
  /** Visible title, taken from the coverage catalog or UNSUPPORTED_SOURCES. */
  readonly title: string;
  readonly transport: OnboardingTransport;
  readonly criblInputType: CriblInputType;
  readonly emitterKind: EmitterKind;
  readonly hubNaming: HubNaming;
  /**
   * The prefix Azure gives hubs it creates itself, when the exact names cannot
   * be known in advance (a policy initiative covers dozens of categories).
   * `null` when {@link expectedHubNames} is exhaustive or there is no hub.
   */
  readonly autoCreatedHubPrefix: string | null;
  /** The blob container a blob source writes to by default; `null` for Event Hub. */
  readonly defaultContainer: string | null;
  /**
   * The hub names this source is EXPECTED to write to, given the plan values
   * and the source's sub-selection. An expectation, never a measurement: D9
   * creates a Cribl input only for hubs Validate measured. Empty when the names
   * cannot be known (policy initiatives, an unnamed XDR hub, any blob source).
   */
  readonly expectedHubNames: (
    values: PlanValues,
    subSelection: readonly string[],
  ) => readonly string[];
}

/** Azure's own name for an auto-created per-category hub. */
function insightsHub(category: string): string {
  return `insights-logs-${category.toLowerCase()}`;
}

function entraProfileFrom(subSelection: readonly string[]): EntraProfile {
  const chosen = subSelection.find((s): s is EntraProfile =>
    (ENTRA_PROFILES as readonly string[]).includes(s),
  );
  // The catalog's own default, so an absent sub-selection means what the
  // coverage selection's default means.
  return chosen ?? (coverageItem("entraId")?.subSelection?.defaultSelected[0] as EntraProfile);
}

function namedHub(values: PlanValues): readonly string[] {
  return values.hubName.trim() === "" ? [] : [values.hubName.trim()];
}

function catalogTitle(id: string): string {
  const fromCatalog = coverageItem(id)?.title;
  if (fromCatalog !== undefined) return fromCatalog;
  const unsupported = UNSUPPORTED_SOURCES.find((u) => u.id === id);
  if (unsupported !== undefined) return unsupported.title;
  throw new Error(`onboarding-howto: no catalog title for ${id}`);
}

const NONE: readonly string[] = [];

type SourceShape = Omit<OnboardingSource, "title">;

/** Per-id facts, keyed so the catalog order (below) is the coverage catalog's. */
const SHAPES: Readonly<Record<OnboardingSourceId, SourceShape>> = {
  diagnosticSettingsInitiative: {
    id: "diagnosticSettingsInitiative",
    transport: "eventhub",
    criblInputType: "eventhub",
    emitterKind: "policy-initiative",
    hubNaming: "auto-created",
    autoCreatedHubPrefix: "insights-logs-",
    defaultContainer: null,
    expectedHubNames: () => NONE,
  },
  communityPolicyInitiative: {
    id: "communityPolicyInitiative",
    transport: "eventhub",
    criblInputType: "eventhub",
    emitterKind: "policy-initiative",
    hubNaming: "auto-created",
    autoCreatedHubPrefix: "insights-logs-",
    defaultContainer: null,
    expectedHubNames: () => NONE,
  },
  activityLog: {
    id: "activityLog",
    transport: "eventhub",
    criblInputType: "eventhub",
    emitterKind: "activity-log-setting",
    hubNaming: "auto-created",
    autoCreatedHubPrefix: null,
    defaultContainer: null,
    expectedHubNames: () => ["insights-activity-logs"],
  },
  entraId: {
    id: "entraId",
    transport: "eventhub",
    criblInputType: "eventhub",
    emitterKind: "tenant-diagnostic-setting",
    hubNaming: "auto-created",
    autoCreatedHubPrefix: null,
    defaultContainer: null,
    expectedHubNames: (_values, subSelection) =>
      ENTRA_PROFILE_CATEGORIES[entraProfileFrom(subSelection)].map(insightsHub),
  },
  defenderExport: {
    id: "defenderExport",
    transport: "eventhub",
    criblInputType: "eventhub",
    emitterKind: "defender-export",
    hubNaming: "named",
    autoCreatedHubPrefix: null,
    defaultContainer: null,
    expectedHubNames: (values) => namedHub(values),
  },
  xdrStreaming: {
    id: "xdrStreaming",
    transport: "eventhub",
    criblInputType: "eventhub",
    emitterKind: "xdr-streaming-api",
    hubNaming: "portal",
    autoCreatedHubPrefix: null,
    defaultContainer: null,
    // The portal can name the hub or leave it to Azure; the plan's hub is a
    // candidate the operator typed, and D9 still creates from measured hubs only.
    expectedHubNames: (values) => namedHub(values),
  },
  vnetFlowLogs: {
    id: "vnetFlowLogs",
    transport: "blob",
    criblInputType: "azure_blob",
    emitterKind: "vnet-flow-log",
    hubNaming: null,
    autoCreatedHubPrefix: null,
    defaultContainer: "insights-logs-flowlogflowevent",
    expectedHubNames: () => NONE,
  },
  nsgFlowLogs: {
    id: "nsgFlowLogs",
    transport: "blob",
    criblInputType: "azure_blob",
    emitterKind: "nsg-flow-log",
    hubNaming: null,
    autoCreatedHubPrefix: null,
    defaultContainer: "insights-logs-networksecuritygroupflowevent",
    expectedHubNames: () => NONE,
  },
};

const BLOB_SOURCE_IDS: readonly OnboardingSourceId[] = ["vnetFlowLogs", "nsgFlowLogs"];

/**
 * Every source the How-to path and the diagram know, in coverage-catalog order
 * followed by the two blob sources. Lanes follow this order.
 */
export const ONBOARDING_SOURCES: readonly OnboardingSource[] = [
  ...COVERAGE_CATALOG.map((item) => item.id as OnboardingSourceId),
  ...BLOB_SOURCE_IDS,
].map((id) => ({ ...SHAPES[id], title: catalogTitle(id) }));

/** Lookup by id. `undefined` for an id this release does not know; never throws. */
export function onboardingSource(id: string): OnboardingSource | undefined {
  return ONBOARDING_SOURCES.find((s) => s.id === id);
}

/** Whether `id` names an onboarding source. */
export function isOnboardingSourceId(id: string): id is OnboardingSourceId {
  return onboardingSource(id) !== undefined;
}

/**
 * Whether the app can deploy this source's Azure side itself (the Automated
 * mode). Derived from itemAvailability every call, never stored (D2).
 */
export function isAutomatable(id: OnboardingSourceId): boolean {
  return itemAvailability(id).status === "available";
}

/** Something that cannot be onboarded through Event Hub or Blob, and what to do instead. */
export interface NotOnboardable {
  readonly id: string;
  readonly title: string;
  /** The catalog's own alternative, verbatim. */
  readonly alternative: string;
}

/**
 * The reference rows: catalog entries neither path can carry. Built from
 * UNSUPPORTED_SOURCES minus the blob sources, plus the XDR tables the Streaming
 * API does not carry.
 */
export const NOT_ONBOARDABLE: readonly NotOnboardable[] = [
  ...UNSUPPORTED_SOURCES.filter(
    (u) => !(BLOB_SOURCE_IDS as readonly string[]).includes(u.id),
  ).map((u) => ({ id: u.id, title: u.title, alternative: u.alternative })),
  {
    id: XDR_TABLES_ROW_ID,
    title: `Defender XDR tables: ${XDR_TABLES_NOT_SUPPORTED.tables.join(", ")}`,
    alternative: XDR_TABLES_NOT_SUPPORTED.reason,
  },
];
