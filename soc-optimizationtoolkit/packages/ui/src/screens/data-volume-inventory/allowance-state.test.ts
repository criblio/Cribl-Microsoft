/**
 * MIG-15: the allowance cards' words and figures. Each pin is a place where an
 * unknown could turn into a zero, or a floor into an exact figure.
 */

import { describe, expect, it } from "vitest";
import type { WorkspaceDiscovery, WorkspaceInventory } from "@soc/core";
import {
  afterAllowancesText,
  ALLOWANCE_TIPS,
  arithmeticLine,
  headroomApplies,
  basisFigures,
  crossCheckLine,
  grantCardText,
  grantedTip,
  grantedUnknownReason,
  licenceNote,
  meterOf,
  noGrantsText,
  otherBasisNote,
  overCell,
  planNote,
  sentinelWorkspaceCount,
  sentinelWorkspaceCountIsFloor,
  sentinelWorkspaceIds,
  tagLabel,
  tenantDiscoveryNote,
} from "./allowance-state";
import { allowances, grantView, servers as serversBlock, usage } from "./allowance-test-fixture";
import { inventoryCsv } from "./workspace-inventory-state";

describe("tagLabel", () => {
  it("names each tag, with the conditional suffix", () => {
    expect(tagLabel({ kind: "free" })).toBe("Free");
    expect(tagLabel({ kind: "billable" })).toBe("Billable");
    expect(tagLabel({ kind: "grant", grant: "e5", condition: null })).toBe("E5 5 MB/user");
    expect(tagLabel({ kind: "grant", grant: "servers-p2", condition: "x" })).toBe(
      "Servers P2 500 MB/machine (conditional)",
    );
  });
});

describe("grantCardText", () => {
  it("says the overage when eligible ran over the grant", () => {
    const text = grantCardText(
      grantView({
        grantedMB: 12000,
        usage: usage({ eligibleDailyMB: 14100, usedDailyMB: 12000, overDailyMB: 2100 }),
      }),
    );
    expect(text.status).toBe("2.10 GB/day over");
    expect(text.granted).toBe("12.00 GB/day");
    expect(text.eligibleUsed).toBe("eligible 14.10 GB/day, used 12.00 GB/day");
  });

  it("says the headroom as granted minus eligible", () => {
    const text = grantCardText(
      grantView({ grantedMB: 30000, usage: usage({ eligibleDailyMB: 9300, usedDailyMB: 9300, overDailyMB: 0 }) }),
    );
    expect(text.status).toBe("20.70 GB/day headroom");
  });

  it("reads a floored granted figure as 'at least' and shows no headroom", () => {
    const text = grantCardText(
      grantView({ grantedMB: 12000, grantedIsFloor: true, usage: usage({ eligibleDailyMB: 9300 }) }),
    );
    expect(text.granted).toBe("at least 12.00 GB/day");
    expect(text.status).not.toMatch(/headroom/);
  });

  it("never renders an unread eligible volume as zero", () => {
    const text = grantCardText(grantView({ eligibleKnown: false, usage: usage({ usedDailyMB: 500 }) }));
    expect(text.eligibleUsed).toBe("eligible not read, used 500.0 MB/day");
    expect(text.status).toBe("over and headroom not read");
  });

  it("gives the reason for an unknown granted figure, and floors the sums", () => {
    const a = allowances({ sumsAreFloors: true, licences: { kind: "denied", detail: "HTTP 403" } });
    const text = grantCardText(
      grantView({ grantedMB: null, usage: usage({ eligibleDailyMB: 1000, usedDailyMB: 800, overDailyMB: 200 }) }),
      a,
    );
    expect(text.granted).toBe("not known - licence counts were not read and no benefit was applied in the window");
    expect(text.eligibleUsed).toBe("eligible at least 1.00 GB/day, used at least 800.0 MB/day");
    expect(text.status).toBe("at least 200.0 MB/day over");
  });

  it("shows no headroom from a floored eligible sum even when Granted is exact (R11 tenant case)", () => {
    const text = grantCardText(
      grantView({ grantedMB: 12000, grantedIsFloor: false, usage: usage({ eligibleDailyMB: 9300, overDailyMB: 0 }) }),
      allowances({ sumsAreFloors: true }),
    );
    expect(text.status).toBe("over not known (partial read)");
  });

  it("a partial benefit read: used reads at least and over is not known, never an exact figure", () => {
    const text = grantCardText(
      grantView({ usage: usage({ eligibleDailyMB: 14100, usedDailyMB: 12000, overDailyMB: 2100 }) }),
      allowances({ usedIsFloor: true }),
    );
    expect(text.eligibleUsed).toBe("eligible 14.10 GB/day, used at least 12.00 GB/day");
    expect(text.status).toBe("over not known (partial benefit read)");
  });

  it("E5 headroom and meter only when this is the tenant's only Sentinel workspace", () => {
    const e5 = grantView({ grantedMB: 30000, usage: usage({ eligibleDailyMB: 9300, overDailyMB: 0 }) });
    const one = allowances({ scope: { kind: "workspace", sentinelWorkspaces: 1, sentinelWorkspacesAtLeast: false } });
    expect(grantCardText(e5, one).status).toBe("20.70 GB/day headroom");
    expect(meterOf(e5, one)).not.toBeNull();
    for (const n of [2, null]) {
      const shared = allowances({ scope: { kind: "workspace", sentinelWorkspaces: n, sentinelWorkspacesAtLeast: false } });
      expect(grantCardText(e5, shared).status).toBe("headroom is tenant-wide - use Compare against the whole tenant");
      expect(meterOf(e5, shared)).toBeNull();
    }
    // The tenant comparison compares tenant-wide granted with the tenant-wide sum.
    const tenant = allowances({ scope: { kind: "tenant", workspaces: ["a", "b"], notRead: [] } });
    expect(grantCardText(e5, tenant).status).toBe("20.70 GB/day headroom");
    // Servers P2 is granted per workspace (machines reporting here): its headroom stays.
    const servers = grantView({ grant: "servers-p2", grantedMB: 2000, usage: usage({ eligibleDailyMB: 500 }) });
    const shared = allowances({ scope: { kind: "workspace", sentinelWorkspaces: 3, sentinelWorkspacesAtLeast: false } });
    expect(grantCardText(servers, shared).status).toBe("1.50 GB/day headroom");
    expect(meterOf(servers, shared)).not.toBeNull();
  });
});

describe("grantedUnknownReason (Servers P2)", () => {
  const servers = grantView({ grant: "servers-p2", grantedMB: null });
  it("says machines were not read when Heartbeat failed, never that none were found", () => {
    const a = allowances({
      servers: serversBlock([], { heartbeatComplete: false }),
    });
    expect(grantedUnknownReason(servers, a)).toBe("reporting machines were not read");
  });
  it("says none were found only for an answered, empty Heartbeat", () => {
    expect(grantedUnknownReason(servers, allowances())).toBe("no reporting machines were found");
    const unattributed = allowances({
      servers: serversBlock([], { unattributedMachines: 2 }),
    });
    expect(grantedUnknownReason(servers, unattributed)).toBe("no reporting machine was attributed to a subscription");
  });
});

describe("afterAllowancesText", () => {
  it("is billable minus used, at least with floored sums, at most with a floored Used", () => {
    expect(afterAllowancesText(allowances({ afterAllowancesDailyMB: 400 }))).toBe("400.0 MB");
    expect(afterAllowancesText(allowances({ afterAllowancesDailyMB: 400, sumsAreFloors: true }))).toBe(
      "at least 400.0 MB",
    );
    expect(afterAllowancesText(allowances({ afterAllowancesDailyMB: 400, usedIsFloor: true }))).toBe(
      "at most 400.0 MB",
    );
    expect(
      afterAllowancesText(allowances({ afterAllowancesDailyMB: 400, usedIsFloor: true, sumsAreFloors: true })),
    ).toBe("not known (partial read)");
  });
});

describe("noGrantsText", () => {
  const tenant = (workspaces: string[], notRead: string[]) =>
    ({ kind: "tenant", workspaces, notRead: notRead.map((id) => ({ id, error: "HTTP 403" })) }) as const;

  it("claims no covered table had billable volume only when eligible volume was read", () => {
    expect(noGrantsText(allowances())).toMatch(/no table a grant covers has billable volume/);
    const unread = noGrantsText(allowances({ eligibleKnown: false }));
    expect(unread).toMatch(/Eligible volume was not read/);
    expect(unread).not.toMatch(/no table a grant covers has billable volume/);
  });

  it("limits the claim to the workspaces read, and makes none when none was read", () => {
    const some = noGrantsText(allowances({ scope: tenant(["a", "b"], ["b"]) }));
    expect(some).toMatch(/applied to the 1 workspace\(s\) that were read/);
    expect(some).toMatch(/The 1 workspace\(s\) not read are not covered by this\./);
    const none = noGrantsText(allowances({ eligibleKnown: false, scope: tenant(["a", "b"], ["a", "b"]) }));
    expect(none).toMatch(/^No workspace was read/);
    expect(none).not.toMatch(/no data allowance benefit applied/);
  });

  it("says the Operation record was read only in part when the benefit read was partial", () => {
    expect(noGrantsText(allowances({ usedIsFloor: true }))).toMatch(/read only in part/);
  });
});

describe("overCell", () => {
  const e5Over = allowances({
    grants: [grantView({ usage: usage({ eligibleDailyMB: 14100, overDailyMB: 2100 }) })],
  });

  it("reads a grant table as a share of the pooled overage, never a split", () => {
    expect(overCell({ table: "SigninLogs", billableMB: 300 }, e5Over, 30)).toBe("share of 2.10 GB");
  });

  it("gives a billable table its own daily average and a free table 0", () => {
    expect(overCell({ table: "Syslog", billableMB: 90 }, e5Over, 30)).toBe("3.0 MB");
    expect(overCell({ table: "AzureActivity", billableMB: 0 }, e5Over, 30)).toBe("0");
  });

  it("a Free-tagged table Usage still bills shows its billable volume, never 0 (IsBillable is the authority)", () => {
    expect(overCell({ table: "SecurityAlert", billableMB: 300 }, e5Over, 30)).toBe("10.0 MB");
    expect(overCell({ table: "SecurityAlert", billableMB: 300 }, null, 30)).toBe("10.0 MB");
  });

  it("a partial benefit read leaves a grant table's over not known, never 0 or a share", () => {
    const a = allowances({ usedIsFloor: true, grants: [grantView({ usage: usage({ overDailyMB: 2100 }) })] });
    expect(overCell({ table: "SigninLogs", billableMB: 300 }, a, 30)).toBe("not known (partial benefit read)");
    const pooled = allowances({ usedIsFloor: true, attribution: "pooled", pooled: usage({ overDailyMB: 2100 }) });
    expect(overCell({ table: "SigninLogs", billableMB: 300 }, pooled, 30)).toBe("not known (partial benefit read)");
  });

  it("says not read, never 0, when the eligible read failed", () => {
    const a = allowances({ grants: [grantView({ eligibleKnown: false })] });
    expect(overCell({ table: "SigninLogs", billableMB: 300 }, a, 30)).toBe("not read");
    // No view for a table Usage billed: the eligible read did not see it.
    expect(overCell({ table: "SecurityEvent", billableMB: 300 }, a, 30)).toBe("not read");
  });

  it("pooled: a share of the total when eligible was read, not read when it was not", () => {
    const pooled = usage({ eligibleDailyMB: 14100, overDailyMB: 2100 });
    const read = allowances({ attribution: "pooled", pooled });
    expect(overCell({ table: "SigninLogs", billableMB: 300 }, read, 30)).toBe("share of 2.10 GB (all grants)");
    const unread = allowances({ attribution: "pooled", pooled: usage(), eligibleKnown: false, grants: [] });
    expect(overCell({ table: "SigninLogs", billableMB: 300 }, unread, 30)).toBe("not read");
  });

  it("floored sums: a share reads 'at least', and a zero overage is not known, never 0 (MIG-22)", () => {
    const floored = (overDailyMB: number) =>
      allowances({ sumsAreFloors: true, grants: [grantView({ usage: usage({ overDailyMB }) })] });
    expect(overCell({ table: "SigninLogs", billableMB: 300 }, floored(2100), 30)).toBe("share of at least 2.10 GB");
    expect(overCell({ table: "SigninLogs", billableMB: 300 }, floored(0), 30)).toBe("not known (partial read)");
    const pooled = allowances({ sumsAreFloors: true, attribution: "pooled", pooled: usage({ overDailyMB: 2100 }) });
    expect(overCell({ table: "SigninLogs", billableMB: 300 }, pooled, 30)).toBe(
      "share of at least 2.10 GB (all grants)",
    );
  });

  it("is empty for a grant table before allowances are read", () => {
    expect(overCell({ table: "SigninLogs", billableMB: 300 }, null, 30)).toBe("");
  });
});

describe("crossCheckLine", () => {
  it("repeats a skip reason", () => {
    const reason = "Cross-check skipped: seat counts not read (LicenseAssignment.Read.All).";
    expect(crossCheckLine({ kind: "skipped", reason })).toBe(reason);
    expect(crossCheckLine({ kind: "skipped", reason: "no granted figure to compare against" })).toBe(
      "Cross-check skipped: no granted figure to compare against.",
    );
  });

  it("says no capped day cannot be confirmed yet, never consistent", () => {
    const line = crossCheckLine({ kind: "no-capped-day" });
    expect(line).toMatch(/cannot be confirmed yet/i);
    expect(line).not.toMatch(/consistent/i);
  });

  it("names the matched basis, and both differences when unmatched", () => {
    expect(crossCheckLine({ kind: "matched", basis: "purchased", medianMB: 13000 })).toMatch(
      /^Consistent: .*13\.00 GB\/day.*purchased seats basis/,
    );
    expect(
      crossCheckLine({
        kind: "unmatched",
        medianMB: 11000,
        diffs: [
          { basis: "assigned", pct: -0.0833 },
          { basis: "purchased", pct: 0.1 },
        ],
      }),
    ).toMatch(/assigned seats by -8\.3%, purchased seats by \+10\.0%\. Neither basis is marked/);
  });
});

describe("granted arithmetic and the other basis", () => {
  const e5Read = allowances({
    licences: {
      kind: "read",
      readAt: "2026-11-03T00:00:00Z",
      e5: {
        rows: [],
        purchased: 2600,
        assigned: 2400,
        assignedMayDoubleCount: false,
        inGrace: 0,
        suspended: 0,
        possiblyMissing: 0,
        grantedMB: { assigned: 12000, purchased: 13000 },
      },
    },
  });

  it("writes the literal arithmetic for both bases", () => {
    const lines = basisFigures(grantView(), e5Read).map((f) => arithmeticLine(f));
    expect(lines).toEqual([
      "assigned seats: 2,400 x 5 MB = 12.00 GB/day",
      "purchased seats: 2,600 x 5 MB = 13.00 GB/day",
    ]);
  });

  it("says when Microsoft matched the basis Granted does not use", () => {
    const view = grantView({ crossCheck: { kind: "matched", basis: "purchased", medianMB: 13000 } });
    expect(otherBasisNote(view, e5Read)).toBe(
      "Microsoft's applied figure matched the purchased seats basis (13.00 GB/day), not the assigned seats figure shown as Granted.",
    );
    expect(otherBasisNote(grantView({ crossCheck: { kind: "matched", basis: "assigned", medianMB: 1 } }), e5Read)).toBeNull();
  });

  it("leaves the in-subscription machine count not known when Resource Graph missed one", () => {
    const a = allowances({
      servers: serversBlock([
        { subscriptionId: "s1", plan: "P2", machinesInSubscription: null, machinesReportingHere: 4 },
        { subscriptionId: "s2", plan: "off", machinesInSubscription: 9, machinesReportingHere: 2 },
      ]),
    });
    const lines = basisFigures(grantView({ grant: "servers-p2" }), a).map((f) => arithmeticLine(f));
    expect(lines).toEqual([
      "machines reporting here: 4 x 500 MB = 2.00 GB/day",
      "machines in the subscription: not known",
    ]);
  });
});

describe("licenceNote", () => {
  it("names the permission only for a permission refusal", () => {
    const denied = licenceNote(
      allowances({ licences: { kind: "denied", detail: "Graph subscribedSkus: HTTP 403 - consent needed" } }),
    );
    expect(denied).toMatch(/LicenseAssignment\.Read\.All/);
    const other = licenceNote(allowances({ licences: { kind: "denied", detail: "Graph subscribedSkus: HTTP 500" } }));
    expect(other).toBe("Licence counts could not be read: Graph subscribedSkus: HTTP 500");
    expect(licenceNote(allowances({ licences: { kind: "not-bound" } }))).toBe(
      "Licence counts are not available in this shell.",
    );
  });
});

describe("planNote and sentinelWorkspaceCount", () => {
  it("flags a non-Analytics plan and says nothing for an unread one", () => {
    expect(planNote("Basic")).toBe("Basic plan - grant may not apply on this plan");
    expect(planNote("Analytics")).toBeNull();
    expect(planNote(null)).toBeNull();
  });

  it("is null before discovery and when a hidden workspace could raise a count of one", () => {
    expect(sentinelWorkspaceCount(null)).toBeNull();
    const ws = (sentinel: "enabled" | "unknown") => ({
      id: "x",
      name: "x",
      subscriptionId: "s",
      subscriptionName: "",
      resourceGroup: "r",
      location: "l",
      sentinel,
    });
    expect(
      sentinelWorkspaceCount({ workspaces: { kind: "rows", rows: [ws("enabled")] }, subscriptionsSearched: 1, failures: [] }),
    ).toBe(1);
    expect(
      sentinelWorkspaceCount({
        workspaces: { kind: "rows", rows: [ws("enabled"), ws("unknown")] },
        subscriptionsSearched: 1,
        failures: [],
      }),
    ).toBeNull();
  });
});

describe("sentinelWorkspaceCount with failed subscriptions (MIG-22)", () => {
  const ws = (id: string) => ({
    id,
    name: id,
    subscriptionId: "s",
    subscriptionName: "",
    resourceGroup: "r",
    location: "l",
    sentinel: "enabled" as const,
  });
  const failed = [{ subscriptionId: "s9", subscriptionName: "", error: "403" }];
  const found = (first: string, ...rest: string[]): WorkspaceDiscovery => ({
    workspaces: { kind: "rows", rows: [ws(first), ...rest.map(ws)] },
    subscriptionsSearched: 2,
    failures: failed,
  });

  it("is null, not 1, when one Sentinel workspace was seen but a subscription failed", () => {
    expect(sentinelWorkspaceCount(found("a"))).toBeNull();
    expect(sentinelWorkspaceCount({ workspaces: { kind: "empty" }, subscriptionsSearched: 2, failures: failed })).toBeNull();
  });

  it("is a floor of the count seen when two or more were found despite a failure", () => {
    expect(sentinelWorkspaceCount(found("a", "b"))).toBe(2);
  });
});

describe("sentinelWorkspaceIds and tenantDiscoveryNote (MIG-16)", () => {
  const ws = (id: string, sentinel: "enabled" | "not-enabled" | "unknown") => ({
    id,
    name: id,
    subscriptionId: "s",
    subscriptionName: "",
    resourceGroup: "r",
    location: "l",
    sentinel,
  });

  it("returns only the Sentinel-enabled ids, in discovery order", () => {
    expect(sentinelWorkspaceIds(null)).toEqual([]);
    expect(
      sentinelWorkspaceIds({
        workspaces: { kind: "rows", rows: [ws("a", "enabled"), ws("b", "not-enabled"), ws("c", "unknown"), ws("d", "enabled")] },
        subscriptionsSearched: 1,
        failures: [],
      }),
    ).toEqual(["a", "d"]);
    expect(sentinelWorkspaceIds({ workspaces: { kind: "empty" }, subscriptionsSearched: 1, failures: [] })).toEqual([]);
  });

  it("says what discovery could not see, and nothing when it saw everything", () => {
    expect(
      tenantDiscoveryNote({ workspaces: { kind: "rows", rows: [ws("a", "enabled")] }, subscriptionsSearched: 1, failures: [] }),
    ).toBeNull();
    expect(
      tenantDiscoveryNote({
        workspaces: { kind: "rows", rows: [ws("a", "enabled"), ws("c", "unknown")] },
        subscriptionsSearched: 2,
        failures: [{ subscriptionId: "s2", subscriptionName: "", error: "HTTP 403" }],
      }),
    ).toBe(
      "Discovery was incomplete - 1 subscription(s) not listed, 1 workspace(s) with Sentinel state unknown - " +
        "so Sentinel workspaces it could not see are not in this comparison.",
    );
  });
});

describe("inventoryCsv allowance columns", () => {
  const inventory: WorkspaceInventory = {
    workspaceId: "/w",
    windowDays: 30,
    tables: {
      kind: "rows",
      rows: [
        {
          table: "SigninLogs",
          totalMB: 300,
          billableMB: 300,
          daysWithData: 30,
          solutions: [],
          dailyAverageMB: 10,
          sources: { kind: "failed", error: "timeout" },
        },
      ],
    },
  } as unknown as WorkspaceInventory;

  // The four by-source columns (MIG-29) append after the allowance ones; these pins are about the latter.
  const withoutSourceColumns = (line: string | undefined) => line?.replace(/,,,,$/, "");
  const rowOf = (a: Parameters<typeof inventoryCsv>[1]) =>
    withoutSourceColumns(inventoryCsv(inventory, a).trim().split("\n")[1]);

  it("adds five columns, empty (never 0) with no allowances", () => {
    const [header, row] = inventoryCsv(inventory, null).trim().split("\n");
    expect(header).toMatch(
      /,Allowance,AllowanceEligibleDailyMB,AllowanceUsedDailyMB,AllowanceOverDailyMB,AllowanceFigures,SourceIdentity,Collector,BillableDailyMB,FreeDailyMB$/,
    );
    expect(withoutSourceColumns(row)).toMatch(/,E5 5 MB\/user,,,,$/);
  });

  it("repeats the grant-level figures per row, marked exact", () => {
    const a = allowances({
      grants: [grantView({ usage: usage({ eligibleDailyMB: 14100, usedDailyMB: 12000, overDailyMB: 2100 }) })],
    });
    expect(rowOf(a)).toMatch(/,E5 5 MB\/user,14100\.000,12000\.000,2100\.000,exact$/);
  });

  it("pooled: per-grant Used and Over are empty, never 0, and never marked exact (MIG-21)", () => {
    const a = allowances({
      attribution: "pooled",
      pooled: usage(),
      grants: [grantView({ usage: usage({ eligibleDailyMB: 14100 }) })],
    });
    expect(rowOf(a)).toMatch(
      /,E5 5 MB\/user,14100\.000,,,benefit known only in total - used and over are not split by grant$/,
    );
  });

  it("an unread eligible volume leaves Eligible and Over empty, never 0, and never marked exact (MIG-21)", () => {
    const a = allowances({ grants: [grantView({ eligibleKnown: false, usage: usage({ usedDailyMB: 12000 }) })] });
    expect(rowOf(a)).toMatch(/,E5 5 MB\/user,,12000\.000,,eligible not read - eligible and over are not known$/);
  });

  it("floored sums are marked lower bound, and a floored zero over is empty, never 0.000", () => {
    const zero = allowances({
      sumsAreFloors: true,
      grants: [grantView({ usage: usage({ eligibleDailyMB: 9300, usedDailyMB: 9300, overDailyMB: 0 }) })],
    });
    expect(rowOf(zero)).toMatch(/,E5 5 MB\/user,9300\.000,9300\.000,,lower bound$/);
    const over = allowances({
      sumsAreFloors: true,
      grants: [grantView({ usage: usage({ eligibleDailyMB: 14100, usedDailyMB: 12000, overDailyMB: 2100 }) })],
    });
    expect(rowOf(over)).toMatch(/,14100\.000,12000\.000,2100\.000,lower bound$/);
  });

  it("a partial benefit read leaves Over empty and says Used is a lower bound", () => {
    const a = allowances({
      usedIsFloor: true,
      grants: [grantView({ usage: usage({ eligibleDailyMB: 14100, usedDailyMB: 12000, overDailyMB: 2100 }) })],
    });
    expect(rowOf(a)).toMatch(
      /,14100\.000,12000\.000,,partial benefit read - used is a lower bound and over is not known$/,
    );
  });
});

describe("allowance honesty edge cases (MIG-21)", () => {
  const p2Rows = serversBlock([
    { subscriptionId: "s1", plan: "P2", machinesInSubscription: 6, machinesReportingHere: 4 },
  ]);

  it("a floored Servers Granted makes both arithmetic lines 'at least'", () => {
    const a = allowances({ servers: p2Rows });
    expect(basisFigures(grantView({ grant: "servers-p2", grantedIsFloor: true }), a).map((f) => arithmeticLine(f))).toEqual([
      "machines reporting here: at least 4 x 500 MB = at least 2.00 GB/day",
      "machines in the subscription: at least 6 x 500 MB = at least 3.00 GB/day",
    ]);
    expect(basisFigures(grantView({ grant: "servers-p2", grantedIsFloor: false }), a).map((f) => arithmeticLine(f))).toEqual([
      "machines reporting here: 4 x 500 MB = 2.00 GB/day",
      "machines in the subscription: 6 x 500 MB = 3.00 GB/day",
    ]);
  });

  it("says beside the assigned arithmetic when two qualifying SKUs may count one user twice", () => {
    const e5 = (assignedMayDoubleCount: boolean) =>
      allowances({
        licences: {
          kind: "read",
          readAt: "2026-11-03T00:00:00Z",
          e5: {
            rows: [],
            purchased: 2600,
            assigned: 2400,
            assignedMayDoubleCount,
            inGrace: 0,
            suspended: 0,
            possiblyMissing: 0,
            grantedMB: { assigned: 12000, purchased: 13000 },
          },
        },
      });
    const [assigned, purchased] = basisFigures(grantView(), e5(true)).map((f) => arithmeticLine(f));
    expect(assigned).toMatch(/^assigned seats: 2,400 x 5 MB = 12\.00 GB\/day \(may count a user twice/);
    expect(purchased).toBe("purchased seats: 2,600 x 5 MB = 13.00 GB/day");
    expect(basisFigures(grantView(), e5(false)).map((f) => arithmeticLine(f))[0]).toBe("assigned seats: 2,400 x 5 MB = 12.00 GB/day");
  });

  it("draws no meter when Granted is only a lower bound", () => {
    const floor = grantView({ grant: "servers-p2", grantedMB: 2000, grantedIsFloor: true, usage: usage({ eligibleDailyMB: 500 }) });
    expect(meterOf(floor, allowances())).toBeNull();
    expect(meterOf({ ...floor, grantedIsFloor: false }, allowances())).not.toBeNull();
  });

  it("a discovery-floored Sentinel count is a floor, and never makes E5 headroom comparable", () => {
    const ws = (id: string, sentinel: "enabled" | "unknown") => ({
      id,
      name: id,
      subscriptionId: "s",
      subscriptionName: "",
      resourceGroup: "r",
      location: "l",
      sentinel,
    });
    expect(
      sentinelWorkspaceCountIsFloor({ workspaces: { kind: "rows", rows: [ws("a", "enabled"), ws("b", "enabled")] }, subscriptionsSearched: 2, failures: [{ subscriptionId: "s9", subscriptionName: "", error: "403" }] }),
    ).toBe(true);
    expect(
      sentinelWorkspaceCountIsFloor({ workspaces: { kind: "rows", rows: [ws("a", "enabled"), ws("b", "enabled"), ws("c", "unknown")] }, subscriptionsSearched: 1, failures: [] }),
    ).toBe(true);
    expect(
      sentinelWorkspaceCountIsFloor({ workspaces: { kind: "rows", rows: [ws("a", "enabled"), ws("b", "enabled")] }, subscriptionsSearched: 1, failures: [] }),
    ).toBe(false);
    // A count discovery could not establish is null, not a floor.
    expect(
      sentinelWorkspaceCountIsFloor({ workspaces: { kind: "rows", rows: [ws("a", "enabled"), ws("c", "unknown")] }, subscriptionsSearched: 1, failures: [] }),
    ).toBe(false);
    expect(sentinelWorkspaceCountIsFloor(null)).toBe(false);
    // The only floored state production produces: two or more workspaces seen, more possibly unseen.
    const floored = allowances({ scope: { kind: "workspace", sentinelWorkspaces: 2, sentinelWorkspacesAtLeast: true } });
    expect(headroomApplies(grantView(), floored)).toBe(false);
  });

  it("the Over column tip no longer says a free table is always 0", () => {
    expect(ALLOWANCE_TIPS.overColumn).toContain("unless Usage still bills it");
    // and the cell it describes does show billed volume for a billed Free table
    expect(overCell({ table: "AzureActivity", billableMB: 300 }, allowances(), 30)).toBe("10.0 MB");
  });
});

describe("grantedTip", () => {
  it("says 'this workspace' for Servers P2 only in a one-workspace view", () => {
    const servers = grantView({ grant: "servers-p2" });
    expect(grantedTip(servers, allowances())).toBe(ALLOWANCE_TIPS.grantedServers);
    const tenant = allowances({ scope: { kind: "tenant", workspaces: ["a", "b"], notRead: [] } });
    expect(grantedTip(servers, tenant)).toBe(ALLOWANCE_TIPS.grantedServersTenant);
    expect(ALLOWANCE_TIPS.grantedServersTenant).not.toMatch(/this workspace/);
    expect(grantedTip(grantView({ grant: "e5" }), tenant)).toBe(ALLOWANCE_TIPS.grantedE5);
  });
});
