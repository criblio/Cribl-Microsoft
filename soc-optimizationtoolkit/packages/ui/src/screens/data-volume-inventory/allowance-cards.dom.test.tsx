// @vitest-environment happy-dom
/**
 * MIG-15: the allowance cards rendered from a DataAllowances result. The pins
 * are the honesty states: a refused licence read, no benefit, an unread
 * eligible volume, a pooled benefit, and every stated gap.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DataAllowances } from "@soc/core";
import { AllowanceCards, AllowanceTagCell } from "./allowance-cards";
import { allowances, grantView, usage } from "./allowance-test-fixture";

afterEach(cleanup);

function renderCards(a: DataAllowances) {
  return render(<AllowanceCards allowances={a} readAt="2026-11-03T10:00:00.000Z" />);
}

const text = () => document.body.textContent ?? "";

describe("AllowanceCards", () => {
  it("names LicenseAssignment.Read.All and shows no headroom when the licence read is refused", () => {
    renderCards(
      allowances({
        licences: { kind: "denied", detail: "Graph subscribedSkus: HTTP 403 - consent needed" },
        grants: [
          grantView({
            grantedMB: 9000,
            grantedIsFloor: true,
            usage: usage({ eligibleDailyMB: 8000, usedDailyMB: 8000, overDailyMB: 0 }),
            crossCheck: { kind: "skipped", reason: "Cross-check skipped: seat counts not read (LicenseAssignment.Read.All)." },
          }),
        ],
      }),
    );
    expect(document.querySelectorAll(".allowance-card")).toHaveLength(1);
    expect(screen.getByText(/Licence counts were not read: .*LicenseAssignment\.Read\.All/)).toBeTruthy();
    expect(text()).toContain("granted at least 9.0 GB/day");
    expect(text()).not.toContain("GB/day headroom");
    expect(text()).toContain("Headroom is not shown");
  });

  it("does not name the permission for a refusal that is not a permission refusal", () => {
    renderCards(
      allowances({
        licences: { kind: "denied", detail: "Graph subscribedSkus: HTTP 502" },
        grants: [grantView({ grantedMB: null })],
      }),
    );
    expect(screen.getByText("Licence counts could not be read: Graph subscribedSkus: HTTP 502")).toBeTruthy();
    expect(text()).not.toContain("LicenseAssignment.Read.All");
  });

  it("renders no card and says no benefit was applied when there are no grants", () => {
    renderCards(allowances({ grants: [] }));
    expect(document.querySelectorAll(".allowance-card")).toHaveLength(0);
    expect(text()).toMatch(/no data allowance benefit applied to this workspace in\s+the last 30 complete days/);
  });

  it("grants [] with eligible volume unread: never claims no covered table had billable volume", () => {
    renderCards(allowances({ grants: [], eligibleKnown: false }));
    expect(text()).toContain("Eligible volume was not read");
    expect(text()).not.toContain("no table a grant covers has billable volume");
  });

  it("draws no E5 meter or headroom when the grant is shared across Sentinel workspaces", () => {
    renderCards(
      allowances({
        scope: { kind: "workspace", sentinelWorkspaces: 2 },
        grants: [grantView({ usage: usage({ eligibleDailyMB: 6000 }) })],
      }),
    );
    expect(document.querySelector(".allowance-meter")).toBeNull();
    expect(text()).not.toContain("GB/day headroom");
    expect(text()).toContain("headroom is tenant-wide - use Compare against the whole tenant");
  });

  it("says the grant is tenant-wide on the E5 card only, never on the Servers P2 card (MIG-19)", () => {
    const scope = { kind: "workspace", sentinelWorkspaces: 61 } as const;
    renderCards(allowances({ scope, grants: [grantView({ grant: "e5" })] }));
    expect(text()).toContain("Tenant-wide, shared across 61 Sentinel workspaces.");
    cleanup();
    renderCards(allowances({ scope, grants: [grantView({ grant: "servers-p2", grantedMB: 500 })] }));
    expect(text()).not.toContain("shared across 61");
    cleanup();
    renderCards(allowances({ scope: { kind: "workspace", sentinelWorkspaces: null }, grants: [grantView({ grant: "servers-p2", grantedMB: 500 })] }));
    expect(text()).not.toContain("how many Sentinel workspaces share it is not known");
  });

  it("shows every gap as a warning line", () => {
    renderCards(allowances({ gaps: ["Table plans were not read: HTTP 403", "Reporting machines were not read: x"] }));
    const warnings = [...document.querySelectorAll(".match-warning")].map((e) => e.textContent);
    expect(warnings).toEqual(["Table plans were not read: HTTP 403", "Reporting machines were not read: x"]);
  });

  it("draws no meter and says not read when eligible volume is unknown", () => {
    renderCards(allowances({ grants: [grantView({ eligibleKnown: false, usage: usage({ usedDailyMB: 500 }) })] }));
    expect(document.querySelector(".allowance-meter")).toBeNull();
    expect(text()).toContain("eligible not read");
    expect(text()).toContain("over and headroom not read");
  });

  it("draws the meter when eligible and granted are both known", () => {
    renderCards(allowances({ grants: [grantView({ usage: usage({ eligibleDailyMB: 6000 }) })] }));
    expect(document.querySelector(".allowance-meter")).not.toBeNull();
    expect(text()).toContain("6.0 GB/day headroom");
  });

  it("lists every SKU with its reason, warns of possibly missing seats, and names the matched other basis", () => {
    renderCards(
      allowances({
        licences: {
          kind: "read",
          readAt: "2026-11-03T10:00:00.000Z",
          e5: {
            rows: [
              { skuId: "a", skuPartNumber: "SPE_E5", capabilityStatus: "Enabled", enabled: 2600, warning: 0, suspended: 0, lockedOut: 0, consumed: 2400, appliesTo: "User", qualifies: true, family: "E5", reason: "Qualifies: Microsoft 365 E5 family" },
              { skuId: "b", skuPartNumber: "ODD_E5_X", capabilityStatus: "Enabled", enabled: 50, warning: 0, suspended: 0, lockedOut: 0, consumed: 40, appliesTo: "User", qualifies: false, family: null, reason: "may qualify - not in the matched SKU list" },
              { skuId: "c", skuPartNumber: "SPE_E3", capabilityStatus: "Enabled", enabled: 900, warning: 0, suspended: 0, lockedOut: 0, consumed: 800, appliesTo: "User", qualifies: false, family: null, reason: "not in the Microsoft 365 E5/A5/F5/G5/E7 offer" },
            ],
            purchased: 2600,
            assigned: 2400,
            inGrace: 0,
            suspended: 0,
            possiblyMissing: 40,
            grantedMB: { assigned: 12000, purchased: 13000 },
          },
        },
        grants: [
          grantView({
            grantedIsFloor: true,
            crossCheck: { kind: "matched", basis: "purchased", medianMB: 13000 },
          }),
        ],
      }),
    );
    expect(screen.getByText("SPE_E5")).toBeTruthy();
    expect(screen.getByText("may qualify - not in the matched SKU list")).toBeTruthy();
    expect(document.querySelectorAll(".allowance-row-dim")).toHaveLength(2);
    expect(text()).toContain("40 assigned seat(s) are on SKUs that may qualify");
    expect(text()).toContain("assigned seats: 2,400 x 5 MB = 12.0 GB/day");
    expect(text()).toContain("purchased seats: 2,600 x 5 MB = 13.0 GB/day");
    expect(text()).toContain("matched the purchased seats basis (13.0 GB/day)");
  });

  it("shows a pooled benefit as one combined line with no per-grant meter", () => {
    renderCards(
      allowances({
        attribution: "pooled",
        pooled: usage({ eligibleDailyMB: 20000, usedDailyMB: 15000, overDailyMB: 5000 }),
        grants: [
          grantView({
            crossCheck: { kind: "skipped", reason: "Cross-check skipped: the benefit type(s) X could not be attributed." },
            eligibleTables: [{ table: "SigninLogs", eligibleDailyMB: 300, plan: "Basic", criblWritable: "no" }],
          }),
        ],
      }),
    );
    expect(document.querySelector(".allowance-meter")).toBeNull();
    expect(text()).toContain("5.0 GB/day over, all grants together");
    expect(text()).toContain("could not be attributed");
    expect(text()).toContain("Basic plan - grant may not apply on this plan");
    expect(text()).toContain("Cribl cannot write this table (Microsoft connector only)");
  });

  it("pooled with a partial eligible read: eligible and over read not read, never an exact figure", () => {
    renderCards(
      allowances({
        attribution: "pooled",
        eligibleKnown: false,
        pooled: usage({ eligibleDailyMB: 4000, usedDailyMB: 15000, overDailyMB: 0 }),
        grants: [grantView({ eligibleKnown: false })],
      }),
    );
    expect(text()).toContain("eligible not read");
    expect(text()).toContain("over: not read");
    expect(text()).not.toContain("GB/day over");
    expect(text()).not.toContain("eligible 4.0 GB/day");
  });

  it("pooled with grants [] after a failed eligible read: no eligible 0.0 and no 0.0 over", () => {
    renderCards(
      allowances({
        attribution: "pooled",
        eligibleKnown: false,
        pooled: usage({ eligibleDailyMB: 0, usedDailyMB: 15000, overDailyMB: 0 }),
        grants: [],
      }),
    );
    expect(text()).toContain("eligible not read");
    expect(text()).toContain("over: not read");
    expect(text()).not.toContain("0.0 GB/day");
  });

  it("renders an unread Defender plan as not read and an unknown machine count as not known", () => {
    renderCards(
      allowances({
        servers: {
          rows: [{ subscriptionId: "sub-x", plan: "not-read", machinesInSubscription: null, machinesReportingHere: 3 }],
          unattributedMachines: 0,
          heartbeatComplete: true,
        },
        grants: [grantView({ grant: "servers-p2", grantedMB: null })],
      }),
    );
    const row = screen.getByText("sub-x").closest("tr")!;
    expect(row.textContent).toContain("not read");
    expect(row.textContent).not.toContain("off");
    expect(row.textContent).toContain("not known");
  });

  it("omits the tables call in a tenant comparison", () => {
    renderCards(
      allowances({
        grants: [grantView()],
        queries: { ...allowances().queries, tables: null },
      }),
    );
    expect(text()).not.toContain("GET /w/tables");
  });
});

describe("AllowanceCards - tenant comparison (MIG-16)", () => {
  const WS = (name: string) =>
    `/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.OperationalInsights/workspaces/${name}`;

  it("lists an unread workspace by name as not read, and the granted figures read at least", () => {
    renderCards(
      allowances({
        sumsAreFloors: true,
        scope: {
          kind: "tenant",
          workspaces: [WS("law-1"), WS("law-2"), WS("law-3")],
          notRead: [{ id: WS("law-3"), error: "read Usage: HTTP 403" }],
        },
        queries: { ...allowances().queries, tables: null },
        grants: [
          grantView({ grant: "servers-p2", grantedMB: 1500, grantedIsFloor: true, usage: usage({ eligibleDailyMB: 900, usedDailyMB: 800 }) }),
        ],
      }),
    );
    expect(text()).toContain("Compared across 3 Sentinel workspaces, 2 read.");
    const unread = [...document.querySelectorAll(".allowance-not-read")].map((e) => e.textContent);
    expect(unread).toEqual(["law-3: not read - read Usage: HTTP 403"]);
    // The id is shortened to the name; the full resource id is not the label.
    expect(text()).not.toContain(`${WS("law-3")}: `);
    expect(text()).toContain("granted at least 1.5 GB/day");
    expect(text()).toContain("eligible at least 0.9 GB/day, used at least 0.8 GB/day");
    expect(text()).not.toContain("headroom");
  });

  it("says no benefit was applied to these workspaces, not to this workspace", () => {
    renderCards(allowances({ grants: [], scope: { kind: "tenant", workspaces: [WS("a"), WS("b")], notRead: [] } }));
    expect(text()).toMatch(/no data allowance benefit applied to these workspaces/);
    expect(text()).not.toContain("this workspace");
    expect(document.querySelector(".allowance-not-read")).toBeNull();
  });

  it("grants [] with every workspace not read: says none was read, never that no benefit was applied", () => {
    renderCards(
      allowances({
        grants: [],
        eligibleKnown: false,
        sumsAreFloors: true,
        scope: {
          kind: "tenant",
          workspaces: [WS("a"), WS("b")],
          notRead: [
            { id: WS("a"), error: "HTTP 403" },
            { id: WS("b"), error: "HTTP 403" },
          ],
        },
      }),
    );
    expect(text()).toContain("No workspace was read");
    expect(text()).not.toContain("no data allowance benefit applied");
    expect(text()).not.toContain("no table a grant covers has billable volume");
  });

  it("grants [] with one workspace not read: limits the claim to the workspaces read", () => {
    renderCards(
      allowances({
        grants: [],
        sumsAreFloors: true,
        scope: { kind: "tenant", workspaces: [WS("a"), WS("b")], notRead: [{ id: WS("b"), error: "HTTP 403" }] },
      }),
    );
    expect(text()).toMatch(/applied to the 1 workspace\(s\) that were read/);
    expect(text()).not.toContain("applied to these workspaces");
  });

  it("renders the actions slot beside the cards", () => {
    render(
      <AllowanceCards
        allowances={allowances()}
        readAt="2026-11-03T10:00:00.000Z"
        actions={<button>Back to this workspace</button>}
      />,
    );
    expect(screen.getByText("Back to this workspace").closest(".panel-controls")).not.toBeNull();
  });
});

describe("AllowanceTagCell", () => {
  it("warns that rerouting a grant table to _CL forfeits its eligible volume", () => {
    render(
      <AllowanceTagCell
        table="SigninLogs"
        a={allowances({
          grants: [grantView({ eligibleTables: [{ table: "SigninLogs", eligibleDailyMB: 300, plan: null, criblWritable: "no" }] })],
        })}
      />,
    );
    expect(text()).toContain("E5 5 MB/user");
    expect(text()).toContain(
      "keeps its grant only if it still lands in SigninLogs; routing it to a _CL table forfeits up to 300.0 MB/day of coverage",
    );
  });
});
