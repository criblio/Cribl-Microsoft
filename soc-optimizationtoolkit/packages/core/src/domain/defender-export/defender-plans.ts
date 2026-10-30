/**
 * Defender for Cloud plans - WHICH PAID PLANS ARE ON, read and never written.
 *
 * AZR-3, the plan-detection half of the Defender continuous export. Ported from
 * `legacy/Deploy-DefenderExport.ps1` (a frozen copy of
 * `deprecated/Azure/Azure-LogCollection/core/Deploy-DefenderExport.ps1`):
 *
 *   lines 76-89    the 12-entry `$DefenderPlans` map  -> {@link DEFENDER_PLANS}
 *   lines 98-137   Get-DefenderPlanStatus             -> {@link parsePricings}
 *
 * THIS MODULE HAS NO WRITE BUILDER, AND THAT IS THE POINT. A Defender plan is
 * a paid service. Legacy said so in its header ("It does NOT enable any
 * Defender plans") and this port keeps the promise structurally: the only
 * request built here is a GET, and a source-scan pin fails if any file that
 * names the pricings resource ever pairs it with PUT, PATCH or DELETE.
 *
 * THREE DEPARTURES FROM LEGACY, all toward saying less than legacy did:
 *
 * 1. Legacy SWALLOWED a failed read (`catch { Write-WarningMsg }`, :128-130)
 *    and returned empty lists, so a 403 printed "No Defender plans enabled".
 *    {@link parsePricings} returns `unreadable` with Azure's own status, code
 *    and message instead, and only a `read` result may ever be summarised as
 *    "no paid plan".
 *
 * 2. Legacy DROPPED every pricing whose name was not in its map (:110). A plan
 *    Microsoft added later (CloudPosture is the likely example - an inference,
 *    on the live-verification list) would vanish, and a subscription paying
 *    for it would be reported as having no paid plan. Those come back here as
 *    `unrecognized` with their tier, and {@link anyStandard} counts them.
 *
 * 3. A pricing entry that is not the shape we expect makes the WHOLE read
 *    `unreadable` rather than being skipped. "No paid plan" is a claim about
 *    every entry; it cannot be made over a list with an entry we could not
 *    read.
 *
 * The tier is compared case-insensitively, as legacy's PowerShell `-eq` did.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. The caller
 * performs the request.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import type { PortHttpResponse } from "../../ports/http";

/**
 * api-version for Microsoft.Security/pricings. Legacy used the
 * Get-AzSecurityPricing cmdlet and pinned none, so this is chosen, not ported:
 * the GA version that returns `properties.pricingTier`. On the
 * live-verification list.
 */
export const SECURITY_PRICINGS_API_VERSION = "2024-01-01";

/** One Defender plan the legacy script knew about. */
export interface DefenderPlan {
  /** The pricing resource name ARM returns, e.g. "VirtualMachines". */
  readonly name: string;
  /** Legacy's display name, verbatim. */
  readonly displayName: string;
}

/**
 * The 12 plans, VERBATIM and IN ORDER from Deploy-DefenderExport.ps1:76-89.
 * Legacy's per-entry `Tier = "Standard"` is not carried: it was the same for
 * every entry and is the definition of "enabled", which lives in
 * {@link STANDARD_TIER}.
 */
export const DEFENDER_PLANS: readonly DefenderPlan[] = [
  { name: "VirtualMachines", displayName: "Defender for Servers" },
  { name: "AppServices", displayName: "Defender for App Service" },
  { name: "SqlServers", displayName: "Defender for SQL Servers" },
  { name: "SqlServerVirtualMachines", displayName: "Defender for SQL VMs" },
  { name: "OpenSourceRelationalDatabases", displayName: "Defender for OSS Databases" },
  { name: "CosmosDbs", displayName: "Defender for Cosmos DB" },
  { name: "StorageAccounts", displayName: "Defender for Storage" },
  { name: "Containers", displayName: "Defender for Containers" },
  { name: "KeyVaults", displayName: "Defender for Key Vault" },
  { name: "Arm", displayName: "Defender for Resource Manager" },
  { name: "Dns", displayName: "Defender for DNS" },
  { name: "Api", displayName: "Defender for APIs" },
];

/** The tier that means a plan is on and billed (legacy :112). */
export const STANDARD_TIER = "Standard";

/** A known plan with the tier Azure reported for it. */
export interface PlanStatus {
  readonly name: string;
  readonly displayName: string;
  readonly tier: string;
}

/** A pricing Azure returned whose name is not in {@link DEFENDER_PLANS}. */
export interface UnrecognizedPricing {
  readonly name: string;
  readonly tier: string;
}

/** The pricings list was read, and every entry in it was understood. */
export interface PricingsRead {
  readonly kind: "read";
  /** Known plans on the Standard tier, in {@link DEFENDER_PLANS} order. */
  readonly enabled: readonly PlanStatus[];
  /** Known plans on any other tier (normally "Free"), in the same order. */
  readonly disabled: readonly PlanStatus[];
  /** Everything else Azure returned, in response order, tier included. */
  readonly unrecognized: readonly UnrecognizedPricing[];
}

/**
 * The pricings list could not be read. `status` and `code` are Azure's own,
 * so the caller can tell a 403 (denied) from MissingSubscriptionRegistration
 * (provider not registered) from anything else; `message` is Azure's text,
 * or ours when the body was not an ARM error.
 */
export interface PricingsUnreadable {
  readonly kind: "unreadable";
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export type PricingsResult = PricingsRead | PricingsUnreadable;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Azure's error code and message, from `{error: {code, message}}` or flat. */
function armError(body: unknown): { code: string; message: string } {
  const inner = isRecord(body) && isRecord(body["error"]) ? body["error"] : body;
  if (!isRecord(inner)) return { code: "", message: "" };
  return { code: str(inner["code"]), message: str(inner["message"]) };
}

/** The ARM path of the subscription's pricings collection. */
function pricingsPath(subscriptionId: string): string {
  return `/subscriptions/${subscriptionId}/providers/Microsoft.Security/pricings`;
}

/**
 * The GET that lists every Defender pricing on one subscription. The ONLY
 * request this module builds.
 */
export function buildPricingsListRequest(subscriptionId: string): AzureManagementRequest {
  return {
    method: "GET",
    path: pricingsPath(subscriptionId),
    apiVersion: SECURITY_PRICINGS_API_VERSION,
  };
}

/**
 * Classify the pricings response.
 *
 * `read` only for a 2xx whose body has a `value` array in which every entry
 * has a string name and a string `properties.pricingTier`. Anything else -
 * a non-2xx, a 2xx without `value`, or one malformed entry - is `unreadable`.
 * Never throws.
 */
export function parsePricings(response: PortHttpResponse): PricingsResult {
  const { status, body } = response;
  if (status < 200 || status > 299) {
    const err = armError(body);
    return {
      kind: "unreadable",
      status,
      code: err.code,
      message: err.message !== "" ? err.message : `Azure answered HTTP ${status}.`,
    };
  }

  const value = isRecord(body) ? body["value"] : undefined;
  if (!Array.isArray(value)) {
    return {
      kind: "unreadable",
      status,
      code: "",
      message: "The pricings response had no list of plans in it.",
    };
  }

  const tierByName = new Map<string, string>();
  const unrecognized: UnrecognizedPricing[] = [];
  const known = new Set(DEFENDER_PLANS.map((p) => p.name));
  for (const [index, item] of value.entries()) {
    const name = isRecord(item) ? str(item["name"]) : "";
    const props = isRecord(item) && isRecord(item["properties"]) ? item["properties"] : {};
    const tier = props["pricingTier"];
    if (name === "" || typeof tier !== "string") {
      return {
        kind: "unreadable",
        status,
        code: "",
        message: `Pricing entry ${index + 1} has no readable name or tier.`,
      };
    }
    if (known.has(name)) {
      tierByName.set(name, tier);
    } else {
      unrecognized.push({ name, tier });
    }
  }

  const enabled: PlanStatus[] = [];
  const disabled: PlanStatus[] = [];
  for (const plan of DEFENDER_PLANS) {
    const tier = tierByName.get(plan.name);
    if (tier === undefined) continue;
    const entry = { name: plan.name, displayName: plan.displayName, tier };
    (isStandard(tier) ? enabled : disabled).push(entry);
  }
  return { kind: "read", enabled, disabled, unrecognized };
}

function isStandard(tier: string): boolean {
  return tier.toLowerCase() === STANDARD_TIER.toLowerCase();
}

/**
 * True when ANY pricing is on the Standard tier - a known plan, or one this
 * app does not recognise. The question "is a paid plan enabled?" is answered
 * from here and nowhere else, so an unrecognised Standard plan can never be
 * summarised as "no paid plan".
 */
export function anyStandard(read: PricingsRead): boolean {
  return read.enabled.length > 0 || read.unrecognized.some((p) => isStandard(p.tier));
}
