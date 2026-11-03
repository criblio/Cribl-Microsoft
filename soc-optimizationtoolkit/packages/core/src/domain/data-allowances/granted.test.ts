import { describe, expect, it } from "vitest";
import { E5_QUALIFYING_SKUS, LICENSING_CSV_AS_OF } from "./allowance-catalog";
import { crossCheck, e5Granted, parseSubscribedSkus, serversGranted } from "./granted";
import type { ServersSubscriptionRow, SubscribedSku } from "./granted";

const byPart = (part: string) => {
  const found = E5_QUALIFYING_SKUS.find((s) => s.skuPartNumber === part);
  if (!found) throw new Error(`no catalog row ${part}`);
  return found;
};

function sku(over: Partial<SubscribedSku>): SubscribedSku {
  return {
    skuId: "00000000-0000-0000-0000-000000000000",
    skuPartNumber: "OTHER",
    capabilityStatus: "Enabled",
    enabled: 0,
    warning: 0,
    suspended: 0,
    lockedOut: 0,
    consumed: 0,
    appliesTo: "User",
    ...over,
  };
}

const E5 = sku({ skuId: byPart("SPE_E5").skuId, skuPartNumber: "SPE_E5", enabled: 2000, consumed: 1940 });
const SEC = sku({
  skuId: byPart("IDENTITY_THREAT_PROTECTION").skuId,
  skuPartNumber: "IDENTITY_THREAT_PROTECTION",
  enabled: 500,
  consumed: 460,
});
const E3 = sku({ skuId: "05e9a617-0261-4cee-bb44-138d3ef5d965", skuPartNumber: "SPE_E3", enabled: 800, consumed: 790 });

describe("parseSubscribedSkus", () => {
  it("reads the Graph shape and coerces missing values", () => {
    const out = parseSubscribedSkus({
      value: [
        {
          skuId: "a",
          skuPartNumber: "SPE_E5",
          capabilityStatus: "Enabled",
          appliesTo: "User",
          consumedUnits: 7,
          prepaidUnits: { enabled: 10, warning: 1, suspended: 2, lockedOut: 3 },
        },
        {},
      ],
    });
    expect(out[0]).toEqual({
      skuId: "a",
      skuPartNumber: "SPE_E5",
      capabilityStatus: "Enabled",
      appliesTo: "User",
      consumed: 7,
      enabled: 10,
      warning: 1,
      suspended: 2,
      lockedOut: 3,
    });
    expect(out[1]).toEqual({
      skuId: "",
      skuPartNumber: "",
      capabilityStatus: "",
      appliesTo: "",
      consumed: 0,
      enabled: 0,
      warning: 0,
      suspended: 0,
      lockedOut: 0,
    });
  });
  it("throws when value is not an array", () => {
    expect(() => parseSubscribedSkus({})).toThrow();
    expect(() => parseSubscribedSkus(null)).toThrow();
  });
});

describe("e5Granted", () => {
  it("totals qualifying seats only and explains the non-qualifying row", () => {
    const r = e5Granted([E3, SEC, E5]);
    expect(r.assigned).toBe(2400);
    expect(r.purchased).toBe(2500);
    expect(r.grantedMB).toEqual({ assigned: 12000, purchased: 12500 });
    expect(r.possiblyMissing).toBe(0);
    const e3 = r.rows.find((x) => x.skuPartNumber === "SPE_E3");
    expect(e3?.qualifies).toBe(false);
    expect(e3?.reason).toContain("not in the Microsoft 365 E5/A5/F5/G5/E7 offer");
    expect(r.rows.map((x) => x.skuPartNumber)).toEqual(["SPE_E5", "IDENTITY_THREAT_PROTECTION", "SPE_E3"]);
    expect(r.rows[0].family).toBe("E5");
    expect(r.rows[0].reason).toContain("E5");
  });

  it("keeps fully suspended qualifying seats as qualifying rows with none purchased", () => {
    const r = e5Granted([{ ...E5, enabled: 0, suspended: 2000 }]);
    expect(r.purchased).toBe(0);
    expect(r.suspended).toBe(2000);
    expect(r.rows[0].qualifies).toBe(true);
  });

  it("counts warning units as in grace", () => {
    expect(e5Granted([{ ...E5, warning: 12 }]).inGrace).toBe(12);
  });

  it("qualifies on skuId, not on the part number", () => {
    const renamed = e5Granted([{ ...E5, skuPartNumber: "RENAMED_BY_MICROSOFT" }]);
    expect(renamed.assigned).toBe(1940);
    expect(renamed.rows[0].qualifies).toBe(true);
    const lookalike = e5Granted([
      sku({ skuId: "ffffffff-0000-0000-0000-000000000000", skuPartNumber: "SPE_E5", consumed: 50 }),
    ]);
    expect(lookalike.assigned).toBe(0);
    expect(lookalike.rows[0].qualifies).toBe(false);
  });

  it("flags an unlisted E5-like SKU as may-qualify without granting it", () => {
    const gov = sku({ skuId: "11111111-0000-0000-0000-000000000000", skuPartNumber: "SPE_E5_USGOV_DOD", consumed: 300 });
    const r = e5Granted([E3, gov, E5]);
    expect(r.possiblyMissing).toBe(300);
    expect(r.assigned).toBe(1940);
    expect(r.grantedMB.assigned).toBe(9700);
    const row = r.rows.find((x) => x.skuPartNumber === "SPE_E5_USGOV_DOD");
    expect(row?.qualifies).toBe(false);
    expect(row?.family).toBeNull();
    expect(row?.reason.startsWith("may qualify")).toBe(true);
    expect(row?.reason).toContain(LICENSING_CSV_AS_OF);
    expect(r.rows.map((x) => x.skuPartNumber)).toEqual(["SPE_E5", "SPE_E5_USGOV_DOD", "SPE_E3"]);
  });
});

describe("e5Granted - SKU status and overlap (MIG-21)", () => {
  it("counts seats only on Enabled or Warning SKUs; a dead SKU stays in the table but grants nothing", () => {
    for (const status of ["Suspended", "LockedOut", "Deleted"]) {
      const r = e5Granted([E5, { ...SEC, capabilityStatus: status }]);
      expect(r.assigned).toBe(1940);
      expect(r.purchased).toBe(2000);
      expect(r.grantedMB).toEqual({ assigned: 9700, purchased: 10000 });
      const dead = r.rows.find((x) => x.skuPartNumber === "IDENTITY_THREAT_PROTECTION");
      expect(dead?.capabilityStatus).toBe(status);
      expect(dead?.qualifies).toBe(true);
      expect(dead?.reason).toBe(
        `Qualifies: Microsoft 365 E5 Security family, but the SKU is ${status}, so its seats are not counted`,
      );
    }
    const grace = e5Granted([{ ...E5, capabilityStatus: "Warning" }]);
    expect(grace.assigned).toBe(1940);
    expect(grace.purchased).toBe(2000);
  });

  it("flags assigned as possibly double-counted only when two live qualifying SKUs have seats", () => {
    expect(e5Granted([E5, SEC]).assignedMayDoubleCount).toBe(true);
    expect(e5Granted([E5]).assignedMayDoubleCount).toBe(false);
    expect(e5Granted([E5, { ...SEC, consumed: 0 }]).assignedMayDoubleCount).toBe(false);
    expect(e5Granted([E5, { ...SEC, capabilityStatus: "Suspended" }]).assignedMayDoubleCount).toBe(false);
    // A non-qualifying SKU with seats is not an overlap.
    expect(e5Granted([E5, E3]).assignedMayDoubleCount).toBe(false);
  });
});

describe("serversGranted", () => {
  const row = (
    plan: ServersSubscriptionRow["plan"],
    here: number,
    inSub: number | null = null,
  ): ServersSubscriptionRow => ({
    subscriptionId: `s-${plan}-${here}`,
    plan,
    machinesInSubscription: inSub,
    machinesReportingHere: here,
  });
  it("grants only P2 subscriptions, by machines reporting here", () => {
    const r = serversGranted([row("P2", 46, 80), row("P2", 14, 20), row("P1", 9, 9)], 0);
    expect(r.grantedMB.reportingHere).toBe(30000);
    expect(r.grantedMB.inSubscription).toBe(50000);
    expect(r.atLeast).toBe(false);
  });
  it("is a lower bound when a subscription was not read", () => {
    expect(serversGranted([row("P2", 46), row("not-read", 5)], 0).atLeast).toBe(true);
  });
  it("is null for in-subscription when a P2 count is unknown", () => {
    expect(serversGranted([row("P2", 46, null)], 0).grantedMB.inSubscription).toBeNull();
  });
  it("never lets unattributed machines change the granted figure", () => {
    const rows = [row("P2", 46), row("P2", 14)];
    expect(serversGranted(rows, 0)).toEqual(serversGranted(rows, 500));
  });
});

describe("crossCheck", () => {
  const bases = [
    { basis: "assigned", mb: 12000 },
    { basis: "purchased", mb: 12500 },
  ];
  it("matches the one basis the capped-day median lands on", () => {
    const r = crossCheck([{ usedMB: 11970 }, { usedMB: 12010 }, { usedMB: 12000 }], bases);
    expect(r).toEqual({ kind: "matched", basis: "assigned", medianMB: 12000 });
  });
  it("is unmatched when no basis is within tolerance, with the diffs", () => {
    const r = crossCheck([{ usedMB: 9000 }], bases);
    expect(r.kind).toBe("unmatched");
    if (r.kind === "unmatched") expect(r.diffs.map((d) => d.basis)).toEqual(["assigned", "purchased"]);
  });
  it("is unmatched when more than one basis is within tolerance", () => {
    expect(crossCheck([{ usedMB: 12250 }], bases, 0.03).kind).toBe("unmatched");
  });
  it("reports no capped day", () => {
    expect(crossCheck([], bases)).toEqual({ kind: "no-capped-day" });
  });
  it("is skipped when there is no basis to compare", () => {
    expect(crossCheck([{ usedMB: 1 }], []).kind).toBe("skipped");
  });
  it("pins both edges of the default 2% tolerance", () => {
    // 12200 is 1.67% from 12000 (inside) and 2.4% from 12500 (outside).
    expect(crossCheck([{ usedMB: 12200 }], bases)).toEqual({ kind: "matched", basis: "assigned", medianMB: 12200 });
    // 12300 is 2.5% from 12000: outside the default.
    expect(crossCheck([{ usedMB: 12300 }], [{ basis: "assigned", mb: 12000 }]).kind).toBe("unmatched");
  });
  it("uses the median of an even count", () => {
    expect(crossCheck([{ usedMB: 11900 }, { usedMB: 12100 }], bases)).toEqual({
      kind: "matched",
      basis: "assigned",
      medianMB: 12000,
    });
  });
});
