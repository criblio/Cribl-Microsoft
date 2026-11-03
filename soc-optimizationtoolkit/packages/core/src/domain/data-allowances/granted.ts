/**
 * Granted allowances and the cross-check (MIG-13): how many MB/day Microsoft
 * grants this tenant (E5 seats, Defender for Servers P2 machines), and whether
 * a capped day in the benefit data agrees with that figure. Pure: no IO.
 */

import {
  E5_MB_PER_SEAT_PER_DAY,
  E5_QUALIFYING_SKUS,
  LICENSING_CSV_AS_OF,
  SERVERS_MB_PER_MACHINE_PER_DAY,
} from "./allowance-catalog";
import type { QualifyingSku } from "./allowance-catalog";

export interface SubscribedSku {
  skuId: string;
  skuPartNumber: string;
  capabilityStatus: string;
  enabled: number;
  warning: number;
  suspended: number;
  lockedOut: number;
  consumed: number;
  appliesTo: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Parse Graph GET /subscribedSkus. Throws when `value` is not an array. */
export function parseSubscribedSkus(body: unknown): SubscribedSku[] {
  const value = isRecord(body) ? body["value"] : undefined;
  if (!Array.isArray(value)) {
    throw new Error("The subscribed SKUs response had no list of SKUs in it.");
  }
  return value.map((item): SubscribedSku => {
    const o = isRecord(item) ? item : {};
    const prepaid = isRecord(o["prepaidUnits"]) ? o["prepaidUnits"] : {};
    return {
      skuId: str(o["skuId"]),
      skuPartNumber: str(o["skuPartNumber"]),
      capabilityStatus: str(o["capabilityStatus"]),
      appliesTo: str(o["appliesTo"]),
      consumed: num(o["consumedUnits"]),
      enabled: num(prepaid["enabled"]),
      warning: num(prepaid["warning"]),
      suspended: num(prepaid["suspended"]),
      lockedOut: num(prepaid["lockedOut"]),
    };
  });
}

export interface LicenceRow extends SubscribedSku {
  qualifies: boolean;
  family: QualifyingSku["family"] | null;
  reason: string;
}

const QUALIFYING_BY_ID = new Map(E5_QUALIFYING_SKUS.map((s) => [s.skuId.toLowerCase(), s]));
/** Part numbers that look like the offer but are not in the matched list. */
const MAY_QUALIFY = /E5|A5|F5|G5|E7|FLW/i;

/** 0 qualifying, 1 may qualify (unlisted), 2 plain non-qualifying. */
type Tier = 0 | 1 | 2;

function classify(sku: SubscribedSku): { row: LicenceRow; tier: Tier } {
  const hit = QUALIFYING_BY_ID.get(sku.skuId.toLowerCase());
  if (hit) {
    return {
      row: { ...sku, qualifies: true, family: hit.family, reason: `Qualifies: Microsoft 365 ${hit.family} family` },
      tier: 0,
    };
  }
  if (MAY_QUALIFY.test(sku.skuPartNumber)) {
    return {
      row: {
        ...sku,
        qualifies: false,
        family: null,
        reason: `may qualify - not in the matched SKU list as of ${LICENSING_CSV_AS_OF}; check the offer FAQ`,
      },
      tier: 1,
    };
  }
  return {
    row: { ...sku, qualifies: false, family: null, reason: "not in the Microsoft 365 E5/A5/F5/G5/E7 offer" },
    tier: 2,
  };
}

export function e5Granted(skus: readonly SubscribedSku[]): {
  rows: LicenceRow[];
  purchased: number;
  assigned: number;
  inGrace: number;
  suspended: number;
  possiblyMissing: number;
  grantedMB: { assigned: number; purchased: number };
} {
  const classified = skus
    .map(classify)
    .sort((a, b) => a.tier - b.tier || b.row.consumed - a.row.consumed);
  let purchased = 0;
  let assigned = 0;
  let inGrace = 0;
  let suspended = 0;
  let possiblyMissing = 0;
  for (const { row, tier } of classified) {
    if (tier === 0) {
      purchased += row.enabled;
      assigned += row.consumed;
      inGrace += row.warning;
      suspended += row.suspended;
    } else if (tier === 1) {
      possiblyMissing += row.consumed;
    }
  }
  return {
    rows: classified.map((c) => c.row),
    purchased,
    assigned,
    inGrace,
    suspended,
    possiblyMissing,
    grantedMB: {
      assigned: assigned * E5_MB_PER_SEAT_PER_DAY,
      purchased: purchased * E5_MB_PER_SEAT_PER_DAY,
    },
  };
}

export interface ServersSubscriptionRow {
  subscriptionId: string;
  plan: "P2" | "P1" | "off" | "not-read";
  machinesInSubscription: number | null;
  /**
   * Machines that sent Heartbeat here, counted PER DAY and averaged over the
   * window (the grant is 500 MB per machine per day, so a machine that lived
   * one day earns one day's grant, not thirty). May be fractional.
   */
  machinesReportingHere: number;
}

/**
 * Defender for Servers P2 grant. Only P2 subscriptions grant; machines that
 * could not be attributed to a subscription never change the figure. A
 * subscription that could not be read makes the figure a lower bound.
 */
export function serversGranted(
  rows: readonly ServersSubscriptionRow[],
  _unattributedMachines: number,
): { grantedMB: { reportingHere: number; inSubscription: number | null }; atLeast: boolean } {
  let here = 0;
  let inSub: number | null = 0;
  let atLeast = false;
  for (const r of rows) {
    if (r.plan === "not-read") atLeast = true;
    if (r.plan !== "P2") continue;
    here += r.machinesReportingHere;
    inSub = inSub === null || r.machinesInSubscription === null ? null : inSub + r.machinesInSubscription;
  }
  return {
    grantedMB: {
      reportingHere: here * SERVERS_MB_PER_MACHINE_PER_DAY,
      inSubscription: inSub === null ? null : inSub * SERVERS_MB_PER_MACHINE_PER_DAY,
    },
    atLeast,
  };
}

export type CrossCheck =
  | { kind: "no-capped-day" }
  | { kind: "skipped"; reason: string }
  | { kind: "matched"; basis: string; medianMB: number }
  | { kind: "unmatched"; medianMB: number; diffs: Array<{ basis: string; pct: number }> };

/** The middle value (mean of the middle two for an even count). Empty input is the caller's to avoid. */
export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Does the median usage on capped days (days the grant was fully used) equal
 * a granted figure? Matched only when exactly one basis is within tolerance;
 * zero or several is unmatched, since an ambiguous match proves nothing.
 */
export function crossCheck(
  capped: ReadonlyArray<{ usedMB: number }>,
  bases: ReadonlyArray<{ basis: string; mb: number }>,
  tolerance = 0.02,
): CrossCheck {
  if (capped.length === 0) return { kind: "no-capped-day" };
  const usable = bases.filter((b) => b.mb > 0);
  if (usable.length === 0) return { kind: "skipped", reason: "no granted figure to compare against" };
  const medianMB = median(capped.map((c) => c.usedMB));
  const diffs = usable.map((b) => ({ basis: b.basis, pct: (medianMB - b.mb) / b.mb }));
  const within = diffs.filter((d) => Math.abs(d.pct) <= tolerance);
  if (within.length === 1) return { kind: "matched", basis: within[0].basis, medianMB };
  return { kind: "unmatched", medianMB, diffs };
}
