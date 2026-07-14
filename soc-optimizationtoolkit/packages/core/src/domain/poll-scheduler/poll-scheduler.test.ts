/**
 * Contract tests for the poll-scheduler pure core:
 *   - due calculation (never-run, interval elapsed/not, boundary, ordering)
 *   - budget window math (sliding 60s, expiry boundary, zero budget)
 *   - deferral order under budget pressure (lowest priority deferred first)
 *   - no starvation: high priority always wins its slot; low priority still
 *     runs once interval gating frees the budget (tick simulation)
 */
import { describe, expect, it } from "vitest";
import {
  BUDGET_WINDOW_MS,
  nextDue,
  planPolls,
  recordRun,
  remainingBudget,
} from "./index";
import type { PollBudget, PollRegistration } from "./index";

const reg = (
  id: string,
  intervalMs: number,
  priority: number,
): PollRegistration => ({ id, intervalMs, priority });

describe("nextDue", () => {
  it("treats never-run registrations as due", () => {
    expect(nextDue([reg("a", 30_000, 1)], {}, 1_000_000)).toEqual(["a"]);
  });

  it("is not due before the interval elapses", () => {
    expect(nextDue([reg("a", 30_000, 1)], { a: 1_000_000 }, 1_029_999)).toEqual(
      [],
    );
  });

  it("is due exactly when the interval elapses (>=, not >)", () => {
    expect(nextDue([reg("a", 30_000, 1)], { a: 1_000_000 }, 1_030_000)).toEqual(
      ["a"],
    );
  });

  it("treats non-positive intervals as due on every tick", () => {
    expect(nextDue([reg("a", 0, 1)], { a: 1_000_000 }, 1_000_000)).toEqual([
      "a",
    ]);
    expect(nextDue([reg("b", -5, 1)], { b: 1_000_000 }, 1_000_000)).toEqual([
      "b",
    ]);
  });

  it("orders due ids by priority descending", () => {
    const regs = [reg("low", 1_000, 1), reg("high", 1_000, 10), reg("mid", 1_000, 5)];
    expect(nextDue(regs, {}, 0)).toEqual(["high", "mid", "low"]);
  });

  it("tie-breaks equal priority by most overdue first", () => {
    const regs = [reg("fresh", 10_000, 5), reg("stale", 10_000, 5)];
    const last = { fresh: 90_000, stale: 50_000 }; // both due at now=100000
    expect(nextDue(regs, last, 100_000)).toEqual(["stale", "fresh"]);
  });

  it("treats never-run as maximally overdue within a priority band", () => {
    const regs = [reg("ran", 10_000, 5), reg("new", 10_000, 5)];
    expect(nextDue(regs, { ran: 0 }, 100_000)).toEqual(["new", "ran"]);
  });

  it("tie-breaks identical overdue-ness by id for determinism", () => {
    const regs = [reg("b", 10_000, 5), reg("a", 10_000, 5)];
    expect(nextDue(regs, {}, 0)).toEqual(["a", "b"]);
    expect(nextDue(regs, { a: 0, b: 0 }, 20_000)).toEqual(["a", "b"]);
  });

  it("returns empty for no registrations", () => {
    expect(nextDue([], {}, 0)).toEqual([]);
  });

  it("does not mutate the registrations array", () => {
    const regs = [reg("low", 1_000, 1), reg("high", 1_000, 10)];
    nextDue(regs, {}, 0);
    expect(regs.map((r) => r.id)).toEqual(["low", "high"]);
  });
});

describe("remainingBudget", () => {
  it("counts only runs inside the sliding window", () => {
    const budget: PollBudget = {
      maxPerMinute: 5,
      recentRunTimestamps: [
        100_000, // now - 60s exactly: expired
        100_001, // inside
        159_999, // inside
      ],
    };
    expect(remainingBudget(budget, 160_000)).toBe(3);
  });

  it("expires a run exactly one window old", () => {
    const budget: PollBudget = { maxPerMinute: 1, recentRunTimestamps: [0] };
    expect(remainingBudget(budget, BUDGET_WINDOW_MS - 1)).toBe(0);
    expect(remainingBudget(budget, BUDGET_WINDOW_MS)).toBe(1);
  });

  it("never goes negative when the window is over-full", () => {
    const budget: PollBudget = {
      maxPerMinute: 1,
      recentRunTimestamps: [1_000, 1_001, 1_002],
    };
    expect(remainingBudget(budget, 2_000)).toBe(0);
  });

  it("treats maxPerMinute <= 0 as no budget at all", () => {
    expect(
      remainingBudget({ maxPerMinute: 0, recentRunTimestamps: [] }, 0),
    ).toBe(0);
    expect(
      remainingBudget({ maxPerMinute: -3, recentRunTimestamps: [] }, 0),
    ).toBe(0);
  });
});

describe("recordRun", () => {
  it("appends the run and prunes expired entries", () => {
    const budget: PollBudget = {
      maxPerMinute: 10,
      recentRunTimestamps: [0, 50_000],
    };
    const next = recordRun(budget, 70_000);
    expect(next.recentRunTimestamps).toEqual([50_000, 70_000]);
    expect(next.maxPerMinute).toBe(10);
  });

  it("records multi-request runs via count", () => {
    const next = recordRun(
      { maxPerMinute: 10, recentRunTimestamps: [] },
      1_000,
      3,
    );
    expect(next.recentRunTimestamps).toEqual([1_000, 1_000, 1_000]);
  });

  it("does not mutate the input budget", () => {
    const budget: PollBudget = { maxPerMinute: 10, recentRunTimestamps: [] };
    recordRun(budget, 1_000);
    expect(budget.recentRunTimestamps).toEqual([]);
  });
});

describe("planPolls", () => {
  const regs = [
    reg("critical", 30_000, 10),
    reg("normal", 30_000, 5),
    reg("background", 30_000, 1),
  ];

  it("runs everything due when the budget allows", () => {
    const budget: PollBudget = { maxPerMinute: 10, recentRunTimestamps: [] };
    expect(planPolls(regs, {}, budget, 0)).toEqual({
      run: ["critical", "normal", "background"],
      deferred: [],
    });
  });

  it("defers the lowest-priority work first when the budget is tight", () => {
    const budget: PollBudget = { maxPerMinute: 2, recentRunTimestamps: [] };
    expect(planPolls(regs, {}, budget, 0)).toEqual({
      run: ["critical", "normal"],
      deferred: ["background"],
    });
  });

  it("defers everything due when the window is spent", () => {
    const budget: PollBudget = {
      maxPerMinute: 2,
      recentRunTimestamps: [1_000, 2_000],
    };
    expect(planPolls(regs, {}, budget, 10_000)).toEqual({
      run: [],
      deferred: ["critical", "normal", "background"],
    });
  });

  it("does not spend budget on polls that are not due", () => {
    const budget: PollBudget = { maxPerMinute: 1, recentRunTimestamps: [] };
    const last = { critical: 90_000, normal: 90_000 }; // both fresh
    expect(planPolls(regs, last, budget, 100_000)).toEqual({
      run: ["background"],
      deferred: [],
    });
  });

  it("never defers high priority while lower priority runs", () => {
    const budget: PollBudget = { maxPerMinute: 1, recentRunTimestamps: [] };
    const plan = planPolls(regs, {}, budget, 0);
    expect(plan.run).toEqual(["critical"]);
    expect(plan.deferred).toEqual(["normal", "background"]);
  });
});

describe("starvation behavior", () => {
  it("high priority runs at every due point under sustained pressure", () => {
    // Budget of 1/minute, both polls due every 60s: only one can run per
    // window. The high-priority poll must win EVERY window.
    const regs = [reg("high", 60_000, 10), reg("low", 60_000, 1)];
    let budget: PollBudget = { maxPerMinute: 1, recentRunTimestamps: [] };
    const lastRun: Record<string, number> = {};
    const highRuns: number[] = [];

    for (let now = 0; now <= 10 * 60_000; now += 5_000) {
      const plan = planPolls(regs, lastRun, budget, now);
      for (const id of plan.run) {
        lastRun[id] = now;
        budget = recordRun(budget, now);
        if (id === "high") highRuns.push(now);
      }
      // High priority is never deferred in favor of low.
      if (plan.deferred.includes("high")) {
        expect(plan.run).toEqual([]);
      }
    }

    // Due every 60s over 10 minutes with the budget winning-slot: ~1 run per
    // window, and high got every one of them.
    expect(highRuns.length).toBeGreaterThanOrEqual(9);
  });

  it("low priority is not starved when the aggregate rate fits the budget", () => {
    // 3 polls at 30s intervals = 6 runs/minute; budget 6/minute fits, so
    // even the lowest priority must keep running on cadence.
    const regs = [
      reg("critical", 30_000, 10),
      reg("normal", 30_000, 5),
      reg("background", 30_000, 1),
    ];
    let budget: PollBudget = { maxPerMinute: 6, recentRunTimestamps: [] };
    const lastRun: Record<string, number> = {};
    const runCounts: Record<string, number> = {
      critical: 0,
      normal: 0,
      background: 0,
    };

    for (let now = 0; now <= 5 * 60_000; now += 5_000) {
      const plan = planPolls(regs, lastRun, budget, now);
      for (const id of plan.run) {
        lastRun[id] = now;
        budget = recordRun(budget, now);
        runCounts[id] += 1;
      }
    }

    // 5 minutes at a 30s interval = up to 11 due points per poll.
    expect(runCounts.critical).toBeGreaterThanOrEqual(10);
    expect(runCounts.normal).toBeGreaterThanOrEqual(10);
    expect(runCounts.background).toBeGreaterThanOrEqual(10);
  });

  it("a deferred poll runs on a later tick once budget frees up", () => {
    const regs = [reg("high", 90_000, 10), reg("low", 60_000, 1)];
    let budget: PollBudget = { maxPerMinute: 1, recentRunTimestamps: [] };
    const lastRun: Record<string, number> = {};

    // Tick 1: both due, budget 1 -> high runs, low deferred.
    const first = planPolls(regs, lastRun, budget, 0);
    expect(first).toEqual({ run: ["high"], deferred: ["low"] });
    lastRun.high = 0;
    budget = recordRun(budget, 0);

    // Tick 2 (one window later): the tick-1 run has expired from the budget
    // window and high is interval-gated (90s), so low finally runs.
    const second = planPolls(regs, lastRun, budget, BUDGET_WINDOW_MS);
    expect(second).toEqual({ run: ["low"], deferred: [] });
  });
});
