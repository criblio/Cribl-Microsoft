/**
 * Test fixtures for the allowance cards: a GrantView and a DataAllowances with
 * every field set, overridable per test. Test-only; never imported by the app.
 */

import type { DataAllowances, GrantUsage, GrantView, ServersSubscriptionRow } from "@soc/core";
// Core's own arithmetic, by module path: the barrel does not export it, and a
// hand-written granted figure could disagree with the rows it sits beside.
import { serversGranted } from "@soc/core/src/domain/data-allowances/granted";

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

export function grantView(partial: Partial<GrantView> = {}): GrantView {
  return {
    grant: "e5",
    usage: usage(),
    grantedMB: 12000,
    eligibleKnown: true,
    grantedIsFloor: false,
    crossCheck: { kind: "no-capped-day" },
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
