/**
 * Window totals (MIG-33): the data allowances summed over the inventory
 * window instead of averaged per day - billable over the window against the
 * allowance over the same days, and the benefit Microsoft actually applied
 * beside it. Pure: no IO, no clock.
 *
 * THE ARITHMETIC.
 *  - E5: assigned qualifying seats x 5 MB x the complete days in the window.
 *    Seats hold on every day, so the grant is a per-day figure times days.
 *  - Defender for Servers P2: the granted figure is already machine-days
 *    averaged over the window (a machine earns 500 MB only on a day it
 *    reported), so the window total is that average times the window length -
 *    exactly the machine-days times 500 MB, whatever the day count.
 *  - Net: billable over the window minus the allowance over the window.
 *
 * UNKNOWN IS NOT ZERO (docs/inventory-standard.md). Refused licence counts
 * make the E5 allowance unknown, never 0 (the largest benefit applied on one
 * day is a per-day floor, not a window figure). A lower bound on either side
 * of the net makes the net a bound in one direction only, and unknown in the
 * other.
 */

import { INVENTORY_WINDOW_DAYS } from "../workspace-inventory/workspace-inventory";
import type { GrantId } from "./allowance-catalog";

/** The days the window totals cover. */
export interface CompleteDays {
  /** Complete UTC days the totals cover: the window, or fewer when the data starts later. */
  days: number;
  /** The window length the inventory asked for. */
  windowDays: number;
  /**
   * True when `days` is below the window: it is the most days any one table
   * had data, which can understate the days the workspace had any data, so a
   * figure multiplied by it is a lower bound.
   */
  isFloor: boolean;
}

/**
 * The complete days in the window that had data: the most days any one table
 * had data (Usage DaysWithData), never more than the window. No table rows
 * (nothing billed, or the list not read) leaves the whole window.
 */
export function completeDays(
  daysWithData: readonly number[],
  windowDays: number = INVENTORY_WINDOW_DAYS,
): CompleteDays {
  const seen = daysWithData.filter((d) => Number.isFinite(d) && d > 0);
  if (seen.length === 0) return { days: windowDays, windowDays, isFloor: false };
  const days = Math.min(windowDays, Math.max(...seen));
  return { days, windowDays, isFloor: days < windowDays };
}

/** Why a grant's window allowance is not known. */
export type AllowanceUnknown =
  /** E5: the seat counts were refused or this shell cannot read them. */
  | "licences-not-read"
  /** Servers P2: no plan, machine or subscription could be established. */
  | "granted-not-known";

/** The licence count a grant rests on, as shown on its card. */
export type LicenceCount =
  | { kind: "seats"; assigned: number; purchased: number; isFloor: boolean }
  | { kind: "machines"; dailyAverage: number; isFloor: boolean }
  | { kind: "not-read" };

export interface GrantWindowInput {
  grant: GrantId;
  /** The grant per day from licence counts; null when it could not be established. */
  perDayMB: number | null;
  perDayIsFloor: boolean;
  /** How the per-day figure scales to the window (see the module comment). */
  basis: "per-complete-day" | "window-average";
  licences: LicenceCount;
  /** Eligible billable volume summed over the window; null when not read. */
  eligibleMB: number | null;
  eligibleIsFloor: boolean;
  /** The benefit Microsoft applied to this grant over the window; null when only the total is known. */
  appliedMB: number | null;
  appliedIsFloor: boolean;
}

export interface GrantWindowTotals extends Omit<GrantWindowInput, "perDayMB" | "perDayIsFloor" | "basis"> {
  /** Granted per day x days; null when not known (never 0 for unknown). */
  allowanceMB: number | null;
  allowanceIsFloor: boolean;
  /** Why `allowanceMB` is null; null when it is known. */
  unknown: AllowanceUnknown | null;
  /** The per-day figure and the multiplier, so the screen can show the arithmetic. */
  perDayMB: number | null;
  multiplier: number;
  basis: GrantWindowInput["basis"];
}

/** One grant's allowance over the window: the per-day grant times the days it covers. */
export function grantWindowTotals(input: GrantWindowInput, days: CompleteDays): GrantWindowTotals {
  const { perDayMB, perDayIsFloor, ...rest } = input;
  // Machine-days are already per day: the average times the window is their sum.
  const multiplier = input.basis === "window-average" ? days.windowDays : days.days;
  const daysFloor = input.basis === "per-complete-day" && days.isFloor;
  const unknown: AllowanceUnknown | null =
    perDayMB !== null ? null : input.grant === "e5" ? "licences-not-read" : "granted-not-known";
  return {
    ...rest,
    perDayMB,
    multiplier,
    allowanceMB: perDayMB === null ? null : perDayMB * multiplier,
    allowanceIsFloor: perDayMB !== null && (perDayIsFloor || daysFloor),
    unknown,
  };
}

/** Billable over the window against the allowance over the window. */
export type WindowNet =
  | { kind: "over" | "under" | "even"; mb: number; bound: "exact" | "at-least" }
  | { kind: "not-known"; reason: string };

/**
 * Net = billable - allowance. A floored billable can only be higher, so an
 * overage stays an overage ("at least") but an underage could vanish; a
 * floored allowance can only be higher, so an underage stays ("at least") but
 * an overage could vanish. Both floored: no direction is known.
 */
export function windowNet(
  billableMB: number,
  billableIsFloor: boolean,
  allowanceMB: number | null,
  allowanceIsFloor: boolean,
): WindowNet {
  if (allowanceMB === null) return { kind: "not-known", reason: "the allowance is not known" };
  if (billableIsFloor && allowanceIsFloor) {
    return { kind: "not-known", reason: "both the billable total and the allowance are lower bounds" };
  }
  const diff = billableMB - allowanceMB;
  if (billableIsFloor) {
    return diff > 0
      ? { kind: "over", mb: diff, bound: "at-least" }
      : { kind: "not-known", reason: "the billable total is a lower bound, so it may be over" };
  }
  if (allowanceIsFloor) {
    return diff < 0
      ? { kind: "under", mb: -diff, bound: "at-least" }
      : { kind: "not-known", reason: "the allowance is a lower bound, so it may be under" };
  }
  if (diff === 0) return { kind: "even", mb: 0, bound: "exact" };
  return diff > 0 ? { kind: "over", mb: diff, bound: "exact" } : { kind: "under", mb: -diff, bound: "exact" };
}

export interface WindowTotals {
  days: CompleteDays;
  /** Billable volume over the window, from Usage. */
  billableMB: number;
  billableIsFloor: boolean;
  /** Every grant's allowance summed; null when any grant's is not known or no grant applies. */
  allowanceMB: number | null;
  allowanceIsFloor: boolean;
  /** Why `allowanceMB` is null; null when it is known. */
  allowanceUnknown: { grant: GrantId; why: AllowanceUnknown } | { grant: null; why: "no-grant" } | null;
  /** The benefit Microsoft applied over the window, all grants (Operation). */
  appliedMB: number;
  appliedIsFloor: boolean;
  net: WindowNet;
  grants: GrantWindowTotals[];
}

export interface WindowTotalsInput {
  days: CompleteDays;
  billableMB: number;
  billableIsFloor: boolean;
  appliedMB: number;
  appliedIsFloor: boolean;
  grants: readonly GrantWindowTotals[];
  /**
   * Set when the net would mislead: in one workspace's view the E5 grant is
   * tenant-wide and shared, so a workspace's billable cannot be netted against
   * the whole grant. The reason is shown in place of the net.
   */
  netWithheld: string | null;
}

/** The workspace (or tenant) strip: billable, allowance and applied over the window, and the net. */
export function windowTotals(input: WindowTotalsInput): WindowTotals {
  const unknownGrant = input.grants.find((g) => g.allowanceMB === null);
  let allowanceMB: number | null;
  let allowanceUnknown: WindowTotals["allowanceUnknown"];
  if (input.grants.length === 0) {
    allowanceMB = null;
    allowanceUnknown = { grant: null, why: "no-grant" };
  } else if (unknownGrant !== undefined) {
    allowanceMB = null;
    allowanceUnknown = { grant: unknownGrant.grant, why: unknownGrant.unknown ?? "granted-not-known" };
  } else {
    allowanceMB = input.grants.reduce((sum, g) => sum + (g.allowanceMB ?? 0), 0);
    allowanceUnknown = null;
  }
  const allowanceIsFloor = allowanceMB !== null && input.grants.some((g) => g.allowanceIsFloor);
  const net: WindowNet =
    input.netWithheld !== null
      ? { kind: "not-known", reason: input.netWithheld }
      : allowanceUnknown?.why === "no-grant"
        ? { kind: "not-known", reason: "no grant covers a table with billable volume here" }
        : windowNet(input.billableMB, input.billableIsFloor, allowanceMB, allowanceIsFloor);
  return {
    days: input.days,
    billableMB: input.billableMB,
    billableIsFloor: input.billableIsFloor,
    allowanceMB,
    allowanceIsFloor,
    allowanceUnknown,
    appliedMB: input.appliedMB,
    appliedIsFloor: input.appliedIsFloor,
    net,
    grants: [...input.grants],
  };
}

/** The sum of a per-day map: a window total, never an average. */
export function windowSum(byDay: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const mb of byDay.values()) sum += mb;
  return sum;
}
