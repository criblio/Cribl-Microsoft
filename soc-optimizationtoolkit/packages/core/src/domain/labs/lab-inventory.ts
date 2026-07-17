/**
 * Lab inventory - roadmap Phase 5: discover the app-provisioned (and legacy
 * UnifiedLab) lab resource groups in a subscription so the operator can see
 * what is running, how long it has left, and act on it (extend the TTL,
 * destroy now).
 *
 * Identification is TAG-driven, matching what the foundation stamps: a
 * ManagedBy of this app or the legacy "UnifiedAzureLab", or an explicit
 * TTL_Enabled marker. Expiry math runs against an INJECTED nowIso - core
 * never reads a clock.
 *
 * Pure: no IO, no fetch, no React, no Date reads (instants are injected).
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import { LAB_RESOURCE_GROUPS_API_VERSION } from "./lab-foundation";

/** ManagedBy tag values that mark a lab resource group (new + legacy). */
export const LAB_MANAGED_BY_VALUES: readonly string[] = [
  "SOC-OptimizationToolkit",
  "UnifiedAzureLab",
] as const;

/** GET every resource group in the subscription (paginated via nextLink). */
export function buildResourceGroupsListRequest(
  subscriptionId: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: `/subscriptions/${subscriptionId}/resourcegroups`,
    apiVersion: LAB_RESOURCE_GROUPS_API_VERSION,
  };
}

/** DELETE a lab resource group (async: ARM answers 202 and deletes behind it). */
export function buildResourceGroupDeleteRequest(
  subscriptionId: string,
  resourceGroup: string,
): AzureManagementRequest {
  return {
    method: "DELETE",
    path: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`,
    apiVersion: LAB_RESOURCE_GROUPS_API_VERSION,
  };
}

/** One discovered lab. */
export interface LabInventoryEntry {
  name: string;
  location: string;
  /** The ManagedBy tag ("" when the group matched on TTL tags alone). */
  managedBy: string;
  /** True when the TTL_Enabled tag is "true". */
  ttlEnabled: boolean;
  /** TTL_ExpirationTime tag verbatim ("" when absent). */
  expiresAt: string;
  /** TTL_UserEmail tag verbatim ("" when absent). */
  userEmail: string;
  /** Hours until expiry vs the injected now (negative = past due). */
  remainingHours: number | null;
  /** True when the TTL expiry is in the past (deletion imminent/overdue). */
  expired: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** True when a resource group's tags mark it as a lab. */
export function isLabResourceGroup(tags: Record<string, string>): boolean {
  return (
    LAB_MANAGED_BY_VALUES.includes(tags["ManagedBy"] ?? "") ||
    tags["TTL_Enabled"] === "true"
  );
}

/**
 * Parse a resource-group list page's items into inventory entries, keeping
 * only lab-tagged groups. Sorted soonest-expiry first (no-TTL labs last).
 */
export function parseLabInventory(
  items: readonly unknown[],
  nowIso: string,
): LabInventoryEntry[] {
  const nowMs = new Date(nowIso).getTime();
  const entries: LabInventoryEntry[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const rawTags = isRecord(item["tags"]) ? item["tags"] : {};
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawTags)) {
      if (typeof value === "string") {
        tags[key] = value;
      }
    }
    if (!isLabResourceGroup(tags)) {
      continue;
    }
    const expiresAt = tags["TTL_ExpirationTime"] ?? "";
    const expiryMs = expiresAt !== "" ? new Date(expiresAt).getTime() : Number.NaN;
    const remainingHours = Number.isFinite(expiryMs)
      ? (expiryMs - nowMs) / 3600_000
      : null;
    entries.push({
      name: str(item["name"]),
      location: str(item["location"]),
      managedBy: tags["ManagedBy"] ?? "",
      ttlEnabled: tags["TTL_Enabled"] === "true",
      expiresAt,
      userEmail: tags["TTL_UserEmail"] ?? "",
      remainingHours,
      expired: remainingHours !== null && remainingHours <= 0,
    });
  }
  entries.sort((a, b) => {
    if (a.remainingHours === null && b.remainingHours === null) {
      return a.name.localeCompare(b.name);
    }
    if (a.remainingHours === null) {
      return 1;
    }
    if (b.remainingHours === null) {
      return -1;
    }
    return a.remainingHours - b.remainingHours;
  });
  return entries;
}
