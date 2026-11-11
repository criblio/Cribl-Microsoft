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
import { ENTRA_CATEGORIES } from "../entra-diagnostics/entra-categories";
import type { Listing } from "../inventory-listing/inventory-listing";
import { listingRows } from "../inventory-listing/inventory-listing";

export type InventoryCategoryId =
  | "entraId"
  | "activityLog"
  | "defenderExport"
  | "resourceLogs"
  | "xdrStreaming"
  | "vnetFlowLogs"
  | "nsgFlowLogs";

export type DestinationKind = "workspace" | "event-hub" | "storage" | "partner";

export interface Destination {
  readonly kind: DestinationKind;
  readonly resourceId: string;
}

export interface Collector {
  readonly kind: "diagnostic-setting" | "defender-export";
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

function collectorOf(setting: DiagnosticSettingRead): Collector {
  return {
    kind: "diagnostic-setting",
    name: setting.name,
    scope: "tenant",
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
    const collectors = settings.filter((s) => collectsCategory(s, c.name)).map(collectorOf);
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
