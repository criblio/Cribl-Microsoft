import { describe, expect, it } from "vitest";
import {
  BENEFIT_QUERY,
  BENEFIT_TYPE_PATTERNS,
  eligibleDailyQuery,
  foldGrantUsage,
  parseBenefitRows,
} from "./benefit-usage";
import { WINDOW_FILTER } from "../workspace-inventory/workspace-inventory";

const SERVERS = "Defender for Servers P2";

describe("parseBenefitRows", () => {
  it("attributes per grant and converts GB to MB", () => {
    const r = parseBenefitRows([
      { Day: "2026-10-01", BenefitType: "Benefit type used: M365 Defender", BenefitUsedGB: 1.5 },
      { Day: "2026-10-01", BenefitType: SERVERS, BenefitUsedGB: 2 },
    ]);
    expect(r.attribution).toBe("per-grant");
    expect(r.days).toEqual([
      { day: "2026-10-01", grant: "e5", usedMB: 1500 },
      { day: "2026-10-01", grant: "servers-p2", usedMB: 2000 },
    ]);
    expect(r.unmatchedTypes).toEqual([]);
  });
  it("pools everything when one type is unrecognised", () => {
    const r = parseBenefitRows([
      { Day: "d1", BenefitType: "M365 Defender", BenefitUsedGB: 1 },
      { Day: "d1", BenefitType: "Mystery Plan", BenefitUsedGB: 1 },
    ]);
    expect(r.attribution).toBe("pooled");
    expect(r.days.map((d) => d.grant)).toEqual(["pooled", "pooled"]);
    expect(r.unmatchedTypes).toEqual(["Mystery Plan"]);
  });
  it("resolves a string matching both patterns to e5 (pattern order)", () => {
    expect(BENEFIT_TYPE_PATTERNS[0].grant).toBe("e5");
    const r = parseBenefitRows([
      { Day: "d1", BenefitType: "M365 Defender for Servers Security", BenefitUsedGB: 1 },
    ]);
    expect(r.days[0].grant).toBe("e5");
  });
});

describe("parseBenefitRows - unreadable amounts (MIG-21)", () => {
  it("drops a null, empty or non-numeric amount and counts it, never reading it as 0 MB", () => {
    const r = parseBenefitRows([
      { Day: "d1", BenefitType: "M365 E5", BenefitUsedGB: null },
      { Day: "d1", BenefitType: "M365 E5", BenefitUsedGB: "" },
      { Day: "d1", BenefitType: "M365 E5", BenefitUsedGB: "  " },
      { Day: "d1", BenefitType: "M365 E5", BenefitUsedGB: "n/a" },
      { Day: "d1", BenefitType: "M365 E5" },
      { Day: "", BenefitType: "M365 E5", BenefitUsedGB: 1 },
      { Day: "d2", BenefitType: "M365 E5", BenefitUsedGB: "1.5" },
      { Day: "d3", BenefitType: "M365 E5", BenefitUsedGB: 0 },
    ]);
    expect(r.unreadableRows).toBe(6);
    expect(r.days).toEqual([
      { day: "d2", grant: "e5", usedMB: 1500 },
      { day: "d3", grant: "e5", usedMB: 0 },
    ]);
  });
  it("adds the events the server-side sum() skipped (Unreadable) to the count", () => {
    const r = parseBenefitRows([
      { Day: "d1", BenefitType: "M365 E5", BenefitUsedGB: 2, Unreadable: 3 },
      { Day: "d2", BenefitType: "M365 E5", BenefitUsedGB: null, Unreadable: 4 },
      { Day: "d3", BenefitType: "M365 E5", BenefitUsedGB: 1, Unreadable: 0 },
    ]);
    expect(r.unreadableRows).toBe(7);
    expect(r.days.map((d) => d.usedMB)).toEqual([2000, 1000]);
  });
  it("counts nothing unreadable when every row reads", () => {
    expect(parseBenefitRows([{ Day: "d1", BenefitType: "M365 E5", BenefitUsedGB: 2 }]).unreadableRows).toBe(0);
  });
});

describe("foldGrantUsage", () => {
  it("computes over, capped days and max used", () => {
    const g = foldGrantUsage(
      new Map([
        ["d1", 14000],
        ["d2", 9000],
      ]),
      new Map([
        ["d1", 12000],
        ["d2", 9000],
      ]),
    );
    expect(g.overDailyMB).toBe(2000 / 30);
    expect(g.cappedDays).toEqual([{ day: "d1", usedMB: 12000 }]);
    expect(g.maxUsedDayMB).toBe(12000);
    expect(g.eligibleDailyMB).toBe(23000 / 30);
    expect(g.usedDailyMB).toBe(21000 / 30);
  });
  it("clamps over per day at zero", () => {
    const g = foldGrantUsage(new Map([["d1", 100]]), new Map([["d1", 500]]));
    expect(g.overDailyMB).toBe(0);
    expect(g.cappedDays).toEqual([]);
  });
  it("is all zero without NaN for empty input", () => {
    const g = foldGrantUsage(new Map(), new Map());
    expect(g.eligibleDailyMB).toBe(0);
    expect(g.usedDailyMB).toBe(0);
    expect(g.overDailyMB).toBe(0);
    expect(g.maxUsedDayMB).toBe(0);
    expect(g.cappedDays).toEqual([]);
  });
  it("returns copies of the caller's maps", () => {
    const e = new Map([["d1", 1]]);
    const g = foldGrantUsage(e, new Map());
    expect(g.eligibleByDay).not.toBe(e);
    expect(g.eligibleByDay.get("d1")).toBe(1);
  });
});

describe("queries", () => {
  it("rejects an empty table list", () => {
    expect(() => eligibleDailyQuery([])).toThrow();
  });
  it("filters billable usage in the inventory window", () => {
    const q = eligibleDailyQuery(["SigninLogs"]);
    expect(q).toContain("IsBillable == true");
    expect(q).toContain(WINDOW_FILTER);
    expect(q).toContain("'SigninLogs'");
  });
  it("benefit query uses the window and Detail filter", () => {
    expect(BENEFIT_QUERY).toContain(WINDOW_FILTER);
    expect(BENEFIT_QUERY).toContain('startswith "Benefit amount used"');
  });
});

describe("query column contracts (a renamed column must fail here, not read as 'no benefit')", () => {
  it("freezes BENEFIT_QUERY: it outputs Day, BenefitType, BenefitUsedGB and Unreadable, what parseBenefitRows reads", () => {
    expect(BENEFIT_QUERY).toBe(
      [
        "Operation",
        `| where ${WINDOW_FILTER}`,
        '| where Detail startswith "Benefit amount used"',
        "| extend BenefitType = replace_string(OperationKey, 'Benefit type used: ', ''),",
        "    BenefitUsedGB = todouble(extract(@'Benefit amount used: ([0-9.]+(?:[eE][-+]?[0-9]+)?)', 1, Detail))",
        "| summarize BenefitUsedGB = sum(BenefitUsedGB), Unreadable = countif(isnull(BenefitUsedGB))",
        "    by Day = format_datetime(startofday(TimeGenerated), 'yyyy-MM-dd'), BenefitType",
        "| order by Day asc",
      ].join("\n"),
    );
    const r = parseBenefitRows([{ Day: "2026-10-01", BenefitType: "M365 E5", BenefitUsedGB: 1 }]);
    expect(r.days).toEqual([{ day: "2026-10-01", grant: "e5", usedMB: 1000 }]);
  });

  it("freezes eligibleDailyQuery: it outputs Day, DataType and EligibleMB", () => {
    expect(eligibleDailyQuery(["SigninLogs", "AuditLogs"])).toBe(
      [
        "Usage",
        `| where ${WINDOW_FILTER} and DataType in ('SigninLogs', 'AuditLogs')`,
        "    and IsBillable == true",
        "| summarize EligibleMB = sum(Quantity)",
        "    by Day = format_datetime(startofday(TimeGenerated), 'yyyy-MM-dd'), DataType",
      ].join("\n"),
    );
  });

  it("reads an exponent in the benefit amount: '1E-05 GB' is 0.00001 GB, never 1 GB", () => {
    const pattern = /extract\(@'(.+?)', 1, Detail\)/.exec(BENEFIT_QUERY)![1]!;
    const amount = (detail: string) => new RegExp(pattern).exec(detail)?.[1];
    expect(Number(amount("Benefit amount used: 1E-05 GB"))).toBe(0.00001);
    expect(Number(amount("Benefit amount used: 2.5e+1 GB"))).toBe(25);
    expect(Number(amount("Benefit amount used: 0.123 GB"))).toBe(0.123);
  });
});
