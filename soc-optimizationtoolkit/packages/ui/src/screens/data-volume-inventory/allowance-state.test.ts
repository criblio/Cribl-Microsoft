/**
 * MIG-15: the allowance cards' words and figures. Each pin is a place where an
 * unknown could turn into a zero, or a floor into an exact figure.
 */

import { describe, expect, it } from "vitest";
import type { WorkspaceInventory } from "@soc/core";
import {
  arithmeticLine,
  basisFigures,
  crossCheckLine,
  grantCardText,
  licenceNote,
  otherBasisNote,
  overCell,
  planNote,
  sentinelWorkspaceCount,
  tagLabel,
} from "./allowance-state";
import { allowances, grantView, usage } from "./allowance-test-fixture";
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
    expect(text.status).toBe("2.1 GB/day over");
    expect(text.granted).toBe("12.0 GB/day");
    expect(text.eligibleUsed).toBe("eligible 14.1 GB/day, used 12.0 GB/day");
  });

  it("says the headroom as granted minus eligible", () => {
    const text = grantCardText(
      grantView({ grantedMB: 30000, usage: usage({ eligibleDailyMB: 9300, usedDailyMB: 9300, overDailyMB: 0 }) }),
    );
    expect(text.status).toBe("20.7 GB/day headroom");
  });

  it("reads a floored granted figure as 'at least' and shows no headroom", () => {
    const text = grantCardText(
      grantView({ grantedMB: 12000, grantedIsFloor: true, usage: usage({ eligibleDailyMB: 9300 }) }),
    );
    expect(text.granted).toBe("at least 12.0 GB/day");
    expect(text.status).not.toMatch(/headroom/);
  });

  it("never renders an unread eligible volume as zero", () => {
    const text = grantCardText(grantView({ eligibleKnown: false, usage: usage({ usedDailyMB: 500 }) }));
    expect(text.eligibleUsed).toBe("eligible not read, used 0.5 GB/day");
    expect(text.status).toBe("over and headroom not read");
  });

  it("gives the reason for an unknown granted figure, and floors the sums", () => {
    const a = allowances({ sumsAreFloors: true, licences: { kind: "denied", detail: "HTTP 403" } });
    const text = grantCardText(
      grantView({ grantedMB: null, usage: usage({ eligibleDailyMB: 1000, usedDailyMB: 800, overDailyMB: 200 }) }),
      a,
    );
    expect(text.granted).toBe("not known - licence counts were not read and no benefit was applied in the window");
    expect(text.eligibleUsed).toBe("eligible at least 1.0 GB/day, used at least 0.8 GB/day");
    expect(text.status).toBe("at least 0.2 GB/day over");
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
      /^Consistent: .*13\.0 GB\/day.*purchased seats basis/,
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
        inGrace: 0,
        suspended: 0,
        possiblyMissing: 0,
        grantedMB: { assigned: 12000, purchased: 13000 },
      },
    },
  });

  it("writes the literal arithmetic for both bases", () => {
    const lines = basisFigures(grantView(), e5Read).map(arithmeticLine);
    expect(lines).toEqual([
      "assigned seats: 2,400 x 5 MB = 12.0 GB/day",
      "purchased seats: 2,600 x 5 MB = 13.0 GB/day",
    ]);
  });

  it("says when Microsoft matched the basis Granted does not use", () => {
    const view = grantView({ crossCheck: { kind: "matched", basis: "purchased", medianMB: 13000 } });
    expect(otherBasisNote(view, e5Read)).toBe(
      "Microsoft's applied figure matched the purchased seats basis (13.0 GB/day), not the assigned seats figure shown as Granted.",
    );
    expect(otherBasisNote(grantView({ crossCheck: { kind: "matched", basis: "assigned", medianMB: 1 } }), e5Read)).toBeNull();
  });

  it("leaves the in-subscription machine count not known when Resource Graph missed one", () => {
    const a = allowances({
      servers: {
        rows: [
          { subscriptionId: "s1", plan: "P2", machinesInSubscription: null, machinesReportingHere: 4 },
          { subscriptionId: "s2", plan: "off", machinesInSubscription: 9, machinesReportingHere: 2 },
        ],
        unattributedMachines: 0,
      },
    });
    const lines = basisFigures(grantView({ grant: "servers-p2" }), a).map(arithmeticLine);
    expect(lines).toEqual([
      "machines reporting here: 4 x 500 MB = 2.0 GB/day",
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

  it("adds four columns, empty (never 0) with no allowances", () => {
    const [header, row] = inventoryCsv(inventory, null).trim().split("\n");
    expect(header).toMatch(/,Allowance,AllowanceEligibleDailyMB,AllowanceUsedDailyMB,AllowanceOverDailyMB$/);
    expect(row).toMatch(/,E5 5 MB\/user,,,$/);
  });

  it("repeats the grant-level figures per row", () => {
    const a = allowances({
      grants: [grantView({ usage: usage({ eligibleDailyMB: 14100, usedDailyMB: 12000, overDailyMB: 2100 }) })],
    });
    const row = inventoryCsv(inventory, a).trim().split("\n")[1];
    expect(row).toMatch(/,E5 5 MB\/user,14100\.000,12000\.000,2100\.000$/);
  });
});
