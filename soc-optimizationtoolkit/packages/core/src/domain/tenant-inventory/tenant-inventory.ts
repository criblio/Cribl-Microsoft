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

export type ArchiveState =
  | { readonly kind: "archived"; readonly via: "storage" | "cribl" }
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
    const unread = reads.length - readCount;
    const scopes = { collected, read: readCount, unread };
    let state: CellState;
    if (reads.length === 0) state = { kind: "could-not-check", reason: NO_SUBSCRIPTION_VISIBLE };
    else if (readCount === 0) {
      state = { kind: "could-not-check", reason: unreadReasons[0] ?? NO_SUBSCRIPTION_VISIBLE };
    } else if (collected === readCount && unread === 0) state = { kind: "collected", scopes };
    else if (collected > 0) state = { kind: "partly", scopes };
    else if (unread > 0) {
      state = {
        kind: "could-not-check",
        reason: `${unread} of ${reads.length} subscriptions could not be read: ${unreadReasons[0]}`,
      };
    } else state = { kind: "not-collected" };
    return {
      category: "activityLog",
      logType: category,
      title: category,
      collectors,
      state,
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
 * named with a " (disabled)" suffix, so the operator sees it exists.
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
          destinations: automationDestinations(a),
        });
      }
    }
    const unread = reads.length - readCount;
    const scopes = { collected, read: readCount, unread };
    let state: CellState;
    if (reads.length === 0) state = { kind: "could-not-check", reason: NO_SUBSCRIPTION_VISIBLE };
    else if (readCount === 0) {
      state = { kind: "could-not-check", reason: unreadReasons[0] ?? NO_SUBSCRIPTION_VISIBLE };
    } else if (collected === readCount && unread === 0) state = { kind: "collected", scopes };
    else if (collected > 0) state = { kind: "partly", scopes };
    else if (unread > 0) {
      state = {
        kind: "could-not-check",
        reason: `${unread} of ${reads.length} subscriptions could not be read: ${unreadReasons[0]}`,
      };
    } else state = { kind: "not-collected" };
    return {
      category: DEFENDER_EXPORT_ITEM_ID,
      logType: type.logType,
      title: type.title,
      collectors,
      state,
      archive: ARCHIVE_NOT_CLASSIFIED,
    };
  });
}
