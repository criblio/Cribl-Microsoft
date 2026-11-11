/**
 * Test fixtures for the allowance cards: a GrantView and a DataAllowances with
 * every field set, overridable per test. Test-only; never imported by the app.
 */

import { serversGranted } from "@soc/core";
import type {
  DataAllowances,
  GrantUsage,
  GrantView,
  GrantWindowTotals,
  ServersSubscriptionRow,
  WindowTotals,
} from "@soc/core";

export function usage(partial: Partial<GrantUsage> = {}): GrantUsage {
  return {
    eligibleDailyMB: 0,
    usedDailyMB: 0,
    overDailyMB: 0,
    maxUsedDayMB: 0,
    cappedDays: [],
    eligibleByDay: new Map([["2026-10-01", 100]]),
    usedByDay: new Map([["2026-10-01", 80]]),
    ...partial,
  };
}

/** An E5 grant's window: 2,400 seats x 5 MB x 30 days, eligible 100 MB, applied 80 MB (as usage()). */
export function grantWindow(partial: Partial<GrantWindowTotals> = {}): GrantWindowTotals {
  return {
    grant: "e5",
    licences: { kind: "seats", assigned: 2400, purchased: 2400, isFloor: false },
    eligibleMB: 100,
    eligibleIsFloor: false,
    appliedMB: 80,
    appliedIsFloor: false,
    perDayMB: 12000,
    multiplier: 30,
    basis: "per-complete-day",
    allowanceMB: 360000,
    allowanceIsFloor: false,
    unknown: null,
    ...partial,
  };
}

/** The strip's window: 30 full days, 6 GB billable, no grant unless given. */
export function windowTotals(partial: Partial<WindowTotals> = {}): WindowTotals {
  return {
    days: { days: 30, windowDays: 30, isFloor: false },
    billableMB: 6000,
    billableIsFloor: false,
    allowanceMB: null,
    allowanceIsFloor: false,
    allowanceUnknown: { grant: null, why: "no-grant" },
    appliedMB: 0,
    appliedIsFloor: false,
    net: { kind: "not-known", reason: "no grant covers a table with billable volume here" },
    grants: [],
    ...partial,
  };
}

export function grantView(partial: Partial<GrantView> = {}): GrantView {
  return {
    grant: "e5",
    usage: usage(),
    grantedMB: 12000,
    eligibleKnown: true,
    grantedIsFloor: false,
    crossCheck: { kind: "no-capped-day" },
    window: grantWindow(),
    eligibleTables: [],
    ...partial,
  };
}

/** The servers block for `rows`, with `granted` computed from them as core does. */
export function servers(
  rows: ServersSubscriptionRow[] = [],
  partial: Partial<Omit<DataAllowances["servers"], "rows" | "granted">> = {},
): DataAllowances["servers"] {
  return { rows, unattributedMachines: 0, heartbeatComplete: true, ...partial, granted: serversGranted(rows) };
}

export function allowances(partial: Partial<DataAllowances> = {}): DataAllowances {
  return {
    attribution: "per-grant",
    grants: [],
    pooled: null,
    eligibleKnown: true,
    afterAllowancesDailyMB: 0,
    sumsAreFloors: false,
    usedIsFloor: false,
    licences: { kind: "not-bound" },
    window: windowTotals(),
    servers: servers(),
    scope: { kind: "workspace", sentinelWorkspaces: 1, sentinelWorkspacesAtLeast: false },
    queries: {
      benefit: "Operation | benefit",
      eligible: "Usage | eligible",
      heartbeat: "Heartbeat | machines",
      machines: "resources | machines",
      graph: "GET /v1.0/subscribedSkus",
      pricings: "GET pricings",
      tables: "/w/tables",
    },
    gaps: [],
    ...partial,
  };
}
