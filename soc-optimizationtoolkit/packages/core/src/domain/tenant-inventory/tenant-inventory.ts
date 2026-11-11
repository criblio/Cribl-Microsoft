/**
 * Tenant inventory - the cells of the heat map, one per log type.
 *
 * A cell answers "is this log type collected, and is it archived?" from what a
 * read returned. A read that was refused, failed or never sent is
 * could-not-check with its reason, never not-collected: the absence of an
 * answer is not the answer "no".
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import type { DiagnosticSettingRead } from "../activity-log-export/diagnostic-setting";
import type { OnboardingSourceId } from "../onboarding-howto/sources";
import { onboardingSource } from "../onboarding-howto/sources";
import type { OnboardingProgress } from "../onboarding-howto/progress-document";
import { ENTRA_CATEGORIES } from "../entra-diagnostics/entra-categories";
import { ACTIVITY_LOG_CATEGORIES } from "../activity-log-export/activity-log-setting";
import type { DefenderAutomation } from "../defender-export/defender-automation";
import { DEFENDER_EXPORT_ITEM_ID } from "../defender-export/defender-automation";
import type { Listing } from "../inventory-listing/inventory-listing";
import { listingRows } from "../inventory-listing/inventory-listing";

export type InventoryCategoryId =
  | Exclude<OnboardingSourceId, "diagnosticSettingsInitiative" | "communityPolicyInitiative">
  | "resourceLogs";

export type DestinationKind = "workspace" | "event-hub" | "storage" | "partner";

export interface Destination {
  readonly kind: DestinationKind;
  readonly resourceId: string;
}

export interface Collector {
  readonly kind: "diagnostic-setting" | "security-automation";
  readonly name: string;
  /** A subscription id, or "tenant". */
  readonly scope: string;
  /**
   * False for a collector that exists but sends nothing (a disabled Defender
   * automation). It is listed so the operator sees it, but its destinations
   * never count toward collection or archiving.
   */
  readonly enabled: boolean;
  readonly destinations: readonly Destination[];
}

export type CellState =
  | {
      readonly kind: "collected";
      readonly scopes: { readonly collected: number; readonly read: number; readonly unread: number };
    }
  | {
      readonly kind: "partly";
      readonly scopes: { readonly collected: number; readonly read: number; readonly unread: number };
    }
  | { readonly kind: "not-collected" }
  | { readonly kind: "could-not-check"; readonly reason: string };

/**
 * Archiving is judged per collecting scope (a subscription, or the tenant).
 * `archived` means EVERY collecting scope has an archiving collector; when only
 * some do the cell is `partial`, with the counts, and never reads as archived.
 */
export type ArchiveState =
  | { readonly kind: "archived"; readonly via: "storage" | "cribl" | "storage-and-cribl" }
  | { readonly kind: "partial"; readonly archived: number; readonly collecting: number }
  | { readonly kind: "not-archived" }
  | { readonly kind: "unknown"; readonly reason: string };

export interface LogTypeCell {
  readonly category: InventoryCategoryId;
  readonly logType: string;
  readonly title: string;
  readonly collectors: readonly Collector[];
  readonly state: CellState;
  readonly archive: ArchiveState;
}

export type EntraRead =
  | { readonly kind: "read"; readonly settings: Listing<DiagnosticSettingRead> }
  | { readonly kind: "unread"; readonly reason: string };

/** Where a setting sends its logs, in a fixed order; empty ids are skipped. */
export function destinationsOf(setting: DiagnosticSettingRead): readonly Destination[] {
  const out: Destination[] = [];
  if (setting.workspaceId !== "") out.push({ kind: "workspace", resourceId: setting.workspaceId });
  if (setting.ruleId !== "") out.push({ kind: "event-hub", resourceId: setting.ruleId });
  if (setting.storageAccountId !== "") out.push({ kind: "storage", resourceId: setting.storageAccountId });
  if (setting.partnerId !== "") out.push({ kind: "partner", resourceId: setting.partnerId });
  return out;
}

const ALL_LOGS = "alllogs";
const ARCHIVE_NOT_CLASSIFIED: ArchiveState = { kind: "unknown", reason: "not classified yet" };

function collectorOf(setting: DiagnosticSettingRead, scope: string): Collector {
  return {
    kind: "diagnostic-setting",
    name: setting.name,
    scope,
    enabled: true,
    destinations: destinationsOf(setting),
  };
}

function collectsCategory(setting: DiagnosticSettingRead, category: string): boolean {
  const want = category.toLowerCase();
  return (
    setting.enabled.some((c) => c.toLowerCase() === want) ||
    setting.enabledGroups.some((g) => g.toLowerCase() === ALL_LOGS)
  );
}

/** The settings that collect a category, as collectors at one scope. */
function collectorsFor(
  settings: readonly DiagnosticSettingRead[],
  category: string,
  scope: string,
): readonly Collector[] {
  return settings.filter((s) => collectsCategory(s, category)).map((s) => collectorOf(s, scope));
}

/** The first enabled category group this reading does not recognise, or null. */
function unrecognisedGroup(settings: readonly DiagnosticSettingRead[]): string | null {
  for (const s of settings) {
    const g = s.enabledGroups.find((x) => x.toLowerCase() !== ALL_LOGS);
    if (g !== undefined) return g;
  }
  return null;
}

/**
 * One cell per Entra category, in ENTRA_CATEGORIES order. A setting with no
 * enabled category for a log type is not that log type's collector. When no
 * setting collects a category and some setting enables a category group this
 * reading does not recognise, the group might include it, so the cell is
 * could-not-check naming the group rather than not-collected.
 */
export function entraCells(read: EntraRead): readonly LogTypeCell[] {
  const settings = read.kind === "read" ? listingRows(read.settings) : [];
  const group = unrecognisedGroup(settings);
  return ENTRA_CATEGORIES.map((c): LogTypeCell => {
    const collectors = collectorsFor(settings, c.name, "tenant");
    let state: CellState;
    if (read.kind === "unread") state = { kind: "could-not-check", reason: read.reason };
    else if (collectors.length > 0) state = { kind: "collected", scopes: { collected: 1, read: 1, unread: 0 } };
    else if (group !== null) {
      state = {
        kind: "could-not-check",
        reason: `A setting enables the category group "${group}", which this app cannot expand`,
      };
    } else state = { kind: "not-collected" };
    return {
      category: "entraId",
      logType: c.name,
      title: c.name,
      collectors,
      state,
      archive: ARCHIVE_NOT_CLASSIFIED,
    };
  });
}

export type SubscriptionSettingsRead = { readonly subscriptionId: string } & (
  | { readonly kind: "read"; readonly settings: Listing<DiagnosticSettingRead> }
  | { readonly kind: "unread"; readonly reason: string }
);

const NO_SUBSCRIPTION_VISIBLE = "no subscription was visible to this connection";

/**
 * The per-subscription state ladder shared by every subscription-scoped
 * category. `total` subscriptions were listed, `readCount` of them were read,
 * and `collected` of those collect the log type; `unreadReasons` holds one
 * reason per unread subscription.
 *
 * Collected only when every subscription was read and collects. Something
 * found with a subscription short is partly. Nothing found with a
 * subscription unread is could-not-check: an unread scope cannot prove
 * absence. An empty subscription list is could-not-check too - a
 * permission-filtered list is not "no subscriptions".
 */
export function scopeState(
  total: number,
  readCount: number,
  collected: number,
  unreadReasons: readonly string[],
): CellState {
  const unread = total - readCount;
  const scopes = { collected, read: readCount, unread };
  if (total === 0) return { kind: "could-not-check", reason: NO_SUBSCRIPTION_VISIBLE };
  if (readCount === 0) return { kind: "could-not-check", reason: unreadReasons[0] ?? NO_SUBSCRIPTION_VISIBLE };
  if (collected === readCount && unread === 0) return { kind: "collected", scopes };
  if (collected > 0) return { kind: "partly", scopes };
  if (unread > 0) {
    return {
      kind: "could-not-check",
      reason: `${unread} of ${total} subscriptions could not be read: ${unreadReasons[0] ?? NO_SUBSCRIPTION_VISIBLE}`,
    };
  }
  return { kind: "not-collected" };
}

/**
 * One cell per Activity Log category, in ACTIVITY_LOG_CATEGORIES order,
 * counted across subscriptions. Collected only when every subscription was
 * read and has a setting collecting the category; a subscription that could
 * not be read makes the cell at best partly, and a cell with nothing found and
 * a subscription unread is could-not-check, never not-collected. An empty
 * subscription list is could-not-check: a permission-filtered list is not
 * "no subscriptions".
 */
export function activityLogCells(reads: readonly SubscriptionSettingsRead[]): readonly LogTypeCell[] {
  const unreadReasons = reads.flatMap((r) => (r.kind === "unread" ? [r.reason] : []));
  return ACTIVITY_LOG_CATEGORIES.map((category): LogTypeCell => {
    const collectors: Collector[] = [];
    let collected = 0;
    let readCount = 0;
    for (const r of reads) {
      if (r.kind !== "read") continue;
      readCount += 1;
      const found = collectorsFor(listingRows(r.settings), category, r.subscriptionId);
      if (found.length > 0) collected += 1;
      collectors.push(...found);
    }
    return {
      category: "activityLog",
      logType: category,
      title: category,
      collectors,
      state: scopeState(reads.length, readCount, collected, unreadReasons),
      archive: ARCHIVE_NOT_CLASSIFIED,
    };
  });
}

/**
 * The Defender for Cloud export types and the Azure Security automation
 * `eventSource` values that carry each. Documented values, NOT measured against
 * a live subscription.
 */
export const DEFENDER_EXPORT_TYPES: readonly {
  readonly logType: "alerts" | "recommendations" | "secureScore" | "compliance";
  readonly title: string;
  readonly eventSources: readonly string[];
}[] = [
  { logType: "alerts", title: "Security alerts", eventSources: ["Alerts"] },
  {
    logType: "recommendations",
    title: "Security recommendations",
    eventSources: ["Assessments", "AssessmentsSnapshot", "SubAssessments", "SubAssessmentsSnapshot"],
  },
  {
    logType: "secureScore",
    title: "Secure score",
    eventSources: ["SecureScores", "SecureScoresSnapshot", "SecureScoreControls", "SecureScoreControlsSnapshot"],
  },
  {
    logType: "compliance",
    title: "Regulatory compliance",
    eventSources: ["RegulatoryComplianceAssessment", "RegulatoryComplianceAssessmentSnapshot"],
  },
];

export type SubscriptionAutomationsRead = { readonly subscriptionId: string } & (
  | { readonly kind: "read"; readonly automations: Listing<DefenderAutomation> }
  | { readonly kind: "unread"; readonly reason: string }
);

/** Event Hub and Workspace actions become destinations; other action types are ignored. */
function automationDestinations(a: DefenderAutomation): readonly Destination[] {
  const out: Destination[] = [];
  for (const action of a.actions) {
    const type = action.actionType.toLowerCase();
    if (type === "eventhub" && action.eventHubResourceId !== "") {
      out.push({ kind: "event-hub", resourceId: action.eventHubResourceId });
    } else if (type === "workspace" && action.workspaceResourceId !== "") {
      out.push({ kind: "workspace", resourceId: action.workspaceResourceId });
    }
  }
  return out;
}

/**
 * One cell per Defender export type, in DEFENDER_EXPORT_TYPES order, counted
 * across subscriptions with the same ladder as {@link activityLogCells}. Only an
 * enabled automation collects; a disabled one is still listed as a collector,
 * named with a " (disabled)" suffix and `enabled: false`, so the operator sees
 * it exists - and it never counts toward collection or archiving.
 */
export function defenderCells(reads: readonly SubscriptionAutomationsRead[]): readonly LogTypeCell[] {
  const unreadReasons = reads.flatMap((r) => (r.kind === "unread" ? [r.reason] : []));
  return DEFENDER_EXPORT_TYPES.map((type): LogTypeCell => {
    const sources = type.eventSources.map((e) => e.toLowerCase());
    const collectors: Collector[] = [];
    let collected = 0;
    let readCount = 0;
    for (const r of reads) {
      if (r.kind !== "read") continue;
      readCount += 1;
      const matching = listingRows(r.automations).filter((a) =>
        a.sources.some((s) => sources.includes(s.toLowerCase())),
      );
      if (matching.some((a) => a.isEnabled)) collected += 1;
      for (const a of matching) {
        collectors.push({
          kind: "security-automation",
          name: a.isEnabled ? a.name : `${a.name} (disabled)`,
          scope: r.subscriptionId,
          enabled: a.isEnabled,
          destinations: automationDestinations(a),
        });
      }
    }
    return {
      category: DEFENDER_EXPORT_ITEM_ID,
      logType: type.logType,
      title: type.title,
      collectors,
      state: scopeState(reads.length, readCount, collected, unreadReasons),
      archive: ARCHIVE_NOT_CLASSIFIED,
    };
  });
}

// ---------------------------------------------------------------------------
// Archive classification
// ---------------------------------------------------------------------------

/** What the app's own Cribl setup says about where logs end up. */
export interface AppArchiveEvidence {
  /** The Event Hub namespace resource path the app's Cribl sources read, or null when the plan does not name one. */
  readonly namespacePath: string | null;
  /** Categories whose Cribl source exists and whose Lake route was written. */
  readonly lakeRoutedSources: readonly InventoryCategoryId[];
}

/** The categories this phase reads, which are also the ones a Lake route can name. */
const ROUTABLE_CATEGORIES: readonly InventoryCategoryId[] = ["entraId", "activityLog", DEFENDER_EXPORT_ITEM_ID];

export function archiveEvidenceFrom(progress: OnboardingProgress): AppArchiveEvidence {
  const sub = progress.planValues["subscriptionId"] ?? "";
  const rg = progress.planValues["resourceGroup"] ?? "";
  const ns = progress.planValues["namespace"] ?? "";
  const namespacePath =
    sub === "" || rg === "" || ns === ""
      ? null
      : `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.EventHub/namespaces/${ns}`;
  const lakeRoutedSources = ROUTABLE_CATEGORIES.filter((id) => {
    const key = id as OnboardingSourceId;
    return (
      progress.criblSources[key] !== undefined &&
      (progress.criblLakeRoutes?.[key]?.routeId ?? null) !== null
    );
  });
  return { namespacePath, lakeRoutedSources };
}

/** Why an Event Hub destination cannot be judged when the app's own record could not be read. */
export const NO_APP_ARCHIVE_EVIDENCE = "this app's own Cribl setup could not be read";

type ScopeArchive =
  | { readonly kind: "archived"; readonly via: "storage" | "cribl" }
  | { readonly kind: "not-archived" }
  | { readonly kind: "unknown"; readonly reason: string };

/** Whether one collecting scope's destinations archive this category. */
function scopeArchive(
  destinations: readonly Destination[],
  category: InventoryCategoryId,
  evidence: AppArchiveEvidence | null,
): ScopeArchive {
  if (destinations.some((d) => d.kind === "storage")) return { kind: "archived", via: "storage" };
  const hubs = destinations.filter((d) => d.kind === "event-hub");
  if (hubs.length === 0) return { kind: "not-archived" };
  if (evidence === null) return { kind: "unknown", reason: NO_APP_ARCHIVE_EVIDENCE };
  const path = evidence.namespacePath?.toLowerCase() ?? null;
  const inNamespace = path !== null && hubs.some((d) => d.resourceId.toLowerCase().startsWith(`${path}/`));
  if (inNamespace && evidence.lakeRoutedSources.includes(category)) return { kind: "archived", via: "cribl" };
  return {
    kind: "unknown",
    reason: inNamespace
      ? "this app has no Lake route for this category"
      : "an Event Hub this app's Cribl sources do not read",
  };
}

/**
 * Archived only when every collecting scope has an archiving collector; only
 * some scopes archiving is `partial`. Only enabled collectors count: a
 * disabled automation's destinations receive nothing.
 */
function classify(cell: LogTypeCell, evidence: AppArchiveEvidence | null): ArchiveState {
  if (cell.state.kind === "not-collected" || cell.state.kind === "could-not-check") return cell.archive;
  const byScope = new Map<string, Destination[]>();
  for (const c of cell.collectors) {
    if (!c.enabled) continue;
    byScope.set(c.scope, [...(byScope.get(c.scope) ?? []), ...c.destinations]);
  }
  const verdicts = [...byScope.values()].map((d) => scopeArchive(d, cell.category, evidence));
  const vias = new Set(verdicts.flatMap((v) => (v.kind === "archived" ? [v.via] : [])));
  const archived = verdicts.filter((v) => v.kind === "archived").length;
  if (verdicts.length > 0 && archived === verdicts.length) {
    return { kind: "archived", via: vias.size > 1 ? "storage-and-cribl" : vias.has("cribl") ? "cribl" : "storage" };
  }
  if (archived > 0) return { kind: "partial", archived, collecting: verdicts.length };
  return verdicts.find((v) => v.kind === "unknown") ?? { kind: "not-archived" };
}

/**
 * Fills in each cell's archive state from the collectors it already carries.
 * `evidence` is null when the app's own progress record could not be read:
 * an Event Hub destination is then unknown, never archived.
 */
export function withArchive(
  cells: readonly LogTypeCell[],
  evidence: AppArchiveEvidence | null,
): readonly LogTypeCell[] {
  return cells.map((c) => ({ ...c, archive: classify(c, evidence) }));
}

// ---------------------------------------------------------------------------
// Category cards
// ---------------------------------------------------------------------------

export type CardColour = "green" | "amber" | "red" | "blue" | "mixed";
type Tone = Exclude<CardColour, "mixed">;

export interface CategoryCard {
  readonly id: InventoryCategoryId;
  readonly title: string;
  readonly colour: CardColour;
  readonly counts: Readonly<Record<Tone, number>>;
  /** Collected cells over cells that could be checked; null when none could. */
  readonly collectedShare: number | null;
  /** Archived cells over cells that could be checked; null when none could. */
  readonly archivedShare: number | null;
  /** The reason a category is not read at all, or null. */
  readonly notChecked: string | null;
}

export const NOT_CHECKED_YET = "Not checked yet: this category is not read yet.";

const RESOURCE_LOGS_TITLE = "Resource logs";
/** Cards in display order. */
const CARD_IDS: readonly InventoryCategoryId[] = [
  "entraId",
  "activityLog",
  DEFENDER_EXPORT_ITEM_ID,
  "xdrStreaming",
  "resourceLogs",
  "vnetFlowLogs",
  "nsgFlowLogs",
];

function cardTitle(id: InventoryCategoryId): string {
  return id === "resourceLogs" ? RESOURCE_LOGS_TITLE : (onboardingSource(id)?.title ?? id);
}

/** A partly collected cell is never green, however it is archived. */
export function cellTone(cell: LogTypeCell): Tone {
  switch (cell.state.kind) {
    case "could-not-check":
      return "blue";
    case "not-collected":
      return "red";
    case "partly":
      return "amber";
    case "collected":
      return cell.archive.kind === "archived" ? "green" : "amber";
  }
}

/** How much of a log type is collected: its collecting share of the read scopes. */
function collectedWeight(cell: LogTypeCell): number {
  const s = cell.state;
  if ((s.kind !== "collected" && s.kind !== "partly") || s.scopes.read === 0) return 0;
  return s.scopes.collected / s.scopes.read;
}

/** How much of a log type is archived: its archiving share of the read scopes. */
function archivedWeight(cell: LogTypeCell): number {
  const s = cell.state;
  if ((s.kind !== "collected" && s.kind !== "partly") || s.scopes.read === 0) return 0;
  const a = cell.archive;
  const scopes = a.kind === "archived" ? s.scopes.collected : a.kind === "partial" ? a.archived : 0;
  return scopes / s.scopes.read;
}

/**
 * The bars count log types across subscriptions: a log type collected in 3
 * of 5 read subscriptions adds 3/5 of a log type to the collected bar, not a
 * whole one.
 */
export function categoryCards(cells: readonly LogTypeCell[]): readonly CategoryCard[] {
  return CARD_IDS.map((id): CategoryCard => {
    const mine = cells.filter((c) => c.category === id);
    const counts: Record<Tone, number> = { green: 0, amber: 0, red: 0, blue: 0 };
    for (const c of mine) counts[cellTone(c)] += 1;
    const checked = counts.green + counts.amber + counts.red;
    const present = (Object.keys(counts) as Tone[]).filter((t) => counts[t] > 0);
    const colour: CardColour = present.length === 1 ? present[0]! : present.length === 0 ? "blue" : "mixed";
    const sum = (weight: (c: LogTypeCell) => number): number => mine.reduce((n, c) => n + weight(c), 0);
    return {
      id,
      title: cardTitle(id),
      colour,
      counts,
      collectedShare: checked === 0 ? null : sum(collectedWeight) / checked,
      archivedShare: checked === 0 ? null : sum(archivedWeight) / checked,
      notChecked: ROUTABLE_CATEGORIES.includes(id) ? null : NOT_CHECKED_YET,
    };
  });
}
