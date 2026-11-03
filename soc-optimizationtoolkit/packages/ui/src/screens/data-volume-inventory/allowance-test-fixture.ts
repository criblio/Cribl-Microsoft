/**
 * Test fixtures for the allowance cards: a GrantView and a DataAllowances with
 * every field set, overridable per test. Test-only; never imported by the app.
 */

import type { DataAllowances, GrantUsage, GrantView } from "@soc/core";

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

export function allowances(partial: Partial<DataAllowances> = {}): DataAllowances {
  return {
    attribution: "per-grant",
    grants: [],
    pooled: null,
    afterAllowancesDailyMB: 0,
    sumsAreFloors: false,
    licences: { kind: "not-bound" },
    servers: { rows: [], unattributedMachines: 0 },
    scope: { kind: "workspace", sentinelWorkspaces: 1 },
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
