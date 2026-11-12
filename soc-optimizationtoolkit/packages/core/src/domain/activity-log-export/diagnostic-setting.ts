/**
 * Diagnostic settings - HOW THIS APP READS ONE, whoever wrote it.
 *
 * A Microsoft.Insights diagnostic setting (a subscription's Activity Log
 * export) and a microsoft.aadiam one (Entra ID) share the ARM shape this app
 * cares about: `properties.eventHubAuthorizationRuleId`,
 * `properties.eventHubName` and a `properties.logs` array of
 * `{ category | categoryGroup, enabled }`. Validate (AZR-32) read that shape
 * with its own private parser; the Activity Log deploy (AZR-98) needs the
 * same reading to decide whether to refuse. {@link readDiagnosticSetting} is
 * the one reading both use, so "what counts as an enabled category" is
 * decided once.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import { parseResourceId } from "../azure-resource-id/azure-resource-id";
import type { Listing } from "../inventory-listing/inventory-listing";
import { toListing } from "../inventory-listing/inventory-listing";

/** One diagnostic setting, as this app reads it. Carries no secret: a setting holds none. */
export interface DiagnosticSettingRead {
  /** The setting's ARM id, "" when the item had none. */
  readonly id: string;
  /** The setting's name; taken from the id's last segment when the item omits it. */
  readonly name: string;
  /** `eventHubAuthorizationRuleId`, "" when the setting does not send to an Event Hub. */
  readonly ruleId: string;
  /** `eventHubName`, "" when Azure picks the hub (the auto-created one). */
  readonly hub: string;
  /** Every enabled named `category`, in response order. Category groups are in {@link enabledGroups}. */
  readonly enabled: readonly string[];
  /** Every enabled `categoryGroup` (for example "allLogs"), in response order. */
  readonly enabledGroups: readonly string[];
  /** `workspaceId`, "" when the setting does not send to a Log Analytics workspace. */
  readonly workspaceId: string;
  /** `storageAccountId`, "" when the setting does not write to a storage account. */
  readonly storageAccountId: string;
  /** `marketplacePartnerId`, "" when the setting does not send to a partner solution. */
  readonly partnerId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, key: string): string {
  const inner = isRecord(value) ? value[key] : undefined;
  return typeof inner === "string" ? inner : "";
}

function enabledOf(logs: readonly unknown[], key: "category" | "categoryGroup"): string[] {
  return logs
    .filter((l) => isRecord(l) && l["enabled"] === true)
    .map((l) => str(l, key))
    .filter((c) => c !== "");
}

/**
 * Read one ARM item as a diagnostic setting. Never null: a row that is not an
 * object reads as a setting with every field empty, which matches nothing and
 * targets nothing - the reading Validate has always given it.
 */
export function readDiagnosticSetting(row: unknown): DiagnosticSettingRead {
  const props = isRecord(row) && isRecord(row["properties"]) ? row["properties"] : {};
  const logs = Array.isArray(props["logs"]) ? props["logs"] : [];
  const id = str(row, "id");
  const name = str(row, "name") !== "" ? str(row, "name") : parseResourceId(id).name;
  return {
    id,
    name,
    ruleId: str(props, "eventHubAuthorizationRuleId"),
    hub: str(props, "eventHubName"),
    workspaceId: str(props, "workspaceId"),
    storageAccountId: str(props, "storageAccountId"),
    partnerId: str(props, "marketplacePartnerId"),
    enabled: enabledOf(logs, "category"),
    enabledGroups: enabledOf(logs, "categoryGroup"),
  };
}

/**
 * Wrap the items of one listing (`value`) as a {@link Listing}. Items with
 * neither a name nor an id are dropped - there is nothing to call them by.
 * Zero items is the unverified `empty`, never a measured `none`, as for any
 * raw ARM list (inventory-listing).
 */
export function parseDiagnosticSettings(items: readonly unknown[]): Listing<DiagnosticSettingRead> {
  return toListing(
    items.map(readDiagnosticSetting).filter((s) => s.name !== "" || s.id !== ""),
  );
}

/**
 * True when the setting's rule lives in the namespace at `namespacePath`
 * (compared case-insensitively, as ARM ids are). A setting that names no rule
 * sends to no Event Hub and never matches.
 */
export function settingTargetsNamespace(setting: DiagnosticSettingRead, namespacePath: string): boolean {
  if (setting.ruleId === "" || namespacePath === "") return false;
  return setting.ruleId.toLowerCase().startsWith(`${namespacePath.toLowerCase()}/`);
}
