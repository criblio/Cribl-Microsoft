import { describe, expect, it } from "vitest";

import { completeDays, grantWindowTotals, windowNet, windowSum, windowTotals } from "./window-totals";
import type { GrantWindowInput, GrantWindowTotals } from "./window-totals";

const FULL = completeDays([30, 4]);
const SHORT = completeDays([12, 5]);

function e5(partial: Partial<GrantWindowInput> = {}): GrantWindowInput {
  return {
    grant: "e5",
    perDayMB: 500, // 100 assigned seats x 5 MB
    perDayIsFloor: false,
    basis: "per-complete-day",
    licences: { kind: "seats", assigned: 100, purchased: 120, isFloor: false },
    eligibleMB: 9000,
    eligibleIsFloor: false,
    appliedMB: 7500,
    appliedIsFloor: false,
    ...partial,
  };
}

function servers(partial: Partial<GrantWindowInput> = {}): GrantWindowInput {
  return {
    grant: "servers-p2",
    perDayMB: 750, // 1.5 P2 machines a day on average x 500 MB
    perDayIsFloor: false,
    basis: "window-average",
    licences: { kind: "machines", dailyAverage: 1.5, isFloor: false },
    eligibleMB: 30000,
    eligibleIsFloor: false,
    appliedMB: 20000,
    appliedIsFloor: false,
    ...partial,
  };
}

describe("completeDays", () => {
  it("is the whole window, exact, when any table had data on every day", () => {
    expect(FULL).toEqual({ days: 30, windowDays: 30, isFloor: false });
  });

  it("is the most days any table had data when that is fewer, and then a lower bound", () => {
    expect(SHORT).toEqual({ days: 12, windowDays: 30, isFloor: true });
  });

  it("never exceeds the window, and no table rows leave the whole window", () => {
    expect(completeDays([45])).toEqual({ days: 30, windowDays: 30, isFloor: false });
    expect(completeDays([])).toEqual({ days: 30, windowDays: 30, isFloor: false });
    expect(completeDays([0, Number.NaN])).toEqual({ days: 30, windowDays: 30, isFloor: false });
  });
});

describe("grantWindowTotals", () => {
  it("E5: 100 seats x 5 MB x 30 complete days = 15,000 MB, exact", () => {
    const t = grantWindowTotals(e5(), FULL);
    expect(t.allowanceMB).toBe(15000);
    expect(t.multiplier).toBe(30);
    expect(t.perDayMB).toBe(500);
    expect(t.allowanceIsFloor).toBe(false);
    expect(t.unknown).toBeNull();
    expect(t.licences).toEqual({ kind: "seats", assigned: 100, purchased: 120, isFloor: false });
  });

  it("E5 over fewer complete days multiplies by the days with data and is a lower bound", () => {
    const t = grantWindowTotals(e5(), SHORT);
    expect(t.allowanceMB).toBe(6000); // 500 x 12
    expect(t.multiplier).toBe(12);
    expect(t.allowanceIsFloor).toBe(true);
  });

  it("E5 with a floored seat count (a possibly-qualifying SKU) is 'at least'", () => {
    const t = grantWindowTotals(e5({ perDayIsFloor: true }), FULL);
    expect(t.allowanceMB).toBe(15000);
    expect(t.allowanceIsFloor).toBe(true);
  });

  it("E5 with refused licence counts: allowance not known (never 0), the applied benefit still stands", () => {
    const t = grantWindowTotals(e5({ perDayMB: null, licences: { kind: "not-read" } }), FULL);
    expect(t.allowanceMB).toBeNull();
    expect(t.allowanceIsFloor).toBe(false);
    expect(t.unknown).toBe("licences-not-read");
    expect(t.appliedMB).toBe(7500);
  });

  it("Servers P2: the machine-day average x the window = machine-days x 500 MB, whatever the day count", () => {
    expect(grantWindowTotals(servers(), FULL).allowanceMB).toBe(22500); // 750 x 30
    const short = grantWindowTotals(servers(), SHORT);
    // A machine earns only on days it reported: the average already holds that.
    expect(short.allowanceMB).toBe(22500);
    expect(short.multiplier).toBe(30);
    expect(short.allowanceIsFloor).toBe(false);
  });

  it("Servers P2 with no granted figure is not known for its own reason", () => {
    const t = grantWindowTotals(servers({ perDayMB: null }), FULL);
    expect(t.allowanceMB).toBeNull();
    expect(t.unknown).toBe("granted-not-known");
  });
});

describe("windowNet", () => {
  it("exact over, under and even", () => {
    expect(windowNet(20000, false, 15000, false)).toEqual({ kind: "over", mb: 5000, bound: "exact" });
    expect(windowNet(6000, false, 15000, false)).toEqual({ kind: "under", mb: 9000, bound: "exact" });
    expect(windowNet(15000, false, 15000, false)).toEqual({ kind: "even", mb: 0, bound: "exact" });
  });

  it("a floored billable keeps an overage as 'at least' and cannot claim an underage", () => {
    expect(windowNet(20000, true, 15000, false)).toEqual({ kind: "over", mb: 5000, bound: "at-least" });
    expect(windowNet(6000, true, 15000, false)).toEqual({
      kind: "not-known",
      reason: "the billable total is a lower bound, so it may be over",
    });
  });

  it("a floored allowance keeps an underage as 'at least' and cannot claim an overage", () => {
    expect(windowNet(3000, false, 6000, true)).toEqual({ kind: "under", mb: 3000, bound: "at-least" });
    expect(windowNet(9000, false, 6000, true)).toEqual({
      kind: "not-known",
      reason: "the allowance is a lower bound, so it may be under",
    });
  });

  it("both floored, or an unknown allowance, has no direction", () => {
    expect(windowNet(9000, true, 6000, true).kind).toBe("not-known");
    expect(windowNet(9000, false, null, false)).toEqual({ kind: "not-known", reason: "the allowance is not known" });
  });
});

describe("windowTotals", () => {
  const both = (): GrantWindowTotals[] => [grantWindowTotals(e5(), FULL), grantWindowTotals(servers(), FULL)];

  it("sums the grants' allowances and nets them against billable", () => {
    const t = windowTotals({
      days: FULL,
      billableMB: 60000,
      billableIsFloor: false,
      appliedMB: 27500,
      appliedIsFloor: false,
      grants: both(),
      netWithheld: null,
    });
    expect(t.allowanceMB).toBe(37500); // 15,000 + 22,500
    expect(t.allowanceIsFloor).toBe(false);
    expect(t.allowanceUnknown).toBeNull();
    expect(t.appliedMB).toBe(27500);
    expect(t.net).toEqual({ kind: "over", mb: 22500, bound: "exact" });
  });

  it("one floored grant floors the sum; one unknown grant makes the sum unknown, naming it", () => {
    const floored = windowTotals({
      days: SHORT,
      billableMB: 3000,
      billableIsFloor: false,
      appliedMB: 0,
      appliedIsFloor: false,
      grants: [grantWindowTotals(e5(), SHORT), grantWindowTotals(servers(), SHORT)],
      netWithheld: null,
    });
    expect(floored.allowanceMB).toBe(28500); // 6,000 + 22,500
    expect(floored.allowanceIsFloor).toBe(true);
    expect(floored.net).toEqual({ kind: "under", mb: 25500, bound: "at-least" });

    const unknown = windowTotals({
      days: FULL,
      billableMB: 3000,
      billableIsFloor: false,
      appliedMB: 7500,
      appliedIsFloor: false,
      grants: [grantWindowTotals(e5({ perDayMB: null }), FULL), grantWindowTotals(servers(), FULL)],
      netWithheld: null,
    });
    expect(unknown.allowanceMB).toBeNull();
    expect(unknown.allowanceIsFloor).toBe(false);
    expect(unknown.allowanceUnknown).toEqual({ grant: "e5", why: "licences-not-read" });
    expect(unknown.appliedMB).toBe(7500);
    expect(unknown.net.kind).toBe("not-known");
  });

  it("no grant: no allowance figure and no net, never a 0 allowance", () => {
    const t = windowTotals({
      days: FULL,
      billableMB: 3000,
      billableIsFloor: false,
      appliedMB: 0,
      appliedIsFloor: false,
      grants: [],
      netWithheld: null,
    });
    expect(t.allowanceMB).toBeNull();
    expect(t.allowanceUnknown).toEqual({ grant: null, why: "no-grant" });
    expect(t.net).toEqual({ kind: "not-known", reason: "no grant covers a table with billable volume here" });
  });

  it("a withheld net states its reason in place of the figure", () => {
    const t = windowTotals({
      days: FULL,
      billableMB: 60000,
      billableIsFloor: false,
      appliedMB: 0,
      appliedIsFloor: false,
      grants: both(),
      netWithheld: "shared",
    });
    expect(t.allowanceMB).toBe(37500);
    expect(t.net).toEqual({ kind: "not-known", reason: "shared" });
  });
});

describe("windowSum", () => {
  it("adds every day: a window total, not an average", () => {
    expect(windowSum(new Map([["a", 100], ["b", 250.5]]))).toBe(350.5);
    expect(windowSum(new Map())).toBe(0);
  });
});
