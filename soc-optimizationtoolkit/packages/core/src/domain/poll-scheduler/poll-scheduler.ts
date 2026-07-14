/**
 * Poll scheduler - THE PURE CORE OF THE ONE BUDGETED STATUS POLLER.
 *
 * The legacy app ran three independent pollers (AuthBar every 30s, Sidebar
 * every 30s, DataFlow at 30/45/60s), each with its own setInterval and no
 * shared accounting. On the cloud shell every poll is a proxied request and
 * the proxy budget is ~100 requests/minute, so uncoordinated pollers are how
 * the budget dies on day one. This module centralizes the DECISIONS: which
 * registered polls are due, and which of the due polls fit the budget right
 * now, deferring the lowest-priority work first.
 *
 * Everything here is a pure function over explicit inputs. The SHELL owns the
 * clock and the timers: it ticks on whatever cadence it likes, passes `now`
 * (epoch ms) in, runs the ids this module returns, and records the run
 * timestamps back into the state it holds. Core never calls Date.
 *
 * Model:
 *   - {@link PollRegistration}: {id, intervalMs, priority}. Higher priority
 *     numbers are MORE important and are kept when the budget is tight.
 *   - {@link nextDue}: which registrations are due at `now`, ordered
 *     most-important-first.
 *   - {@link PollBudget} + {@link remainingBudget}: sliding 60s window over
 *     recent run timestamps against maxPerMinute.
 *   - {@link planPolls}: the one-call composition - due list split into
 *     {run, deferred} under the budget.
 *
 * Starvation: high-priority work never starves because the run set is always
 * the highest-priority prefix of the due list. Low-priority work does not
 * starve either, PROVIDED the aggregate registered rate fits the budget: once
 * a higher-priority poll runs, its interval gates it out of the due list,
 * leaving the next tick's budget to the deferred work. (A deferred poll only
 * becomes MORE overdue - it never leaves the due list until it runs.)
 *
 * Pure: no IO, no fetch, no React, no Date.
 */

/** A poll a shell wants run on a cadence. */
export interface PollRegistration {
  /** Stable identifier the shell dispatches on (e.g. "cribl-health"). */
  id: string;
  /**
   * Desired minimum gap between runs, in ms. A registration is due when it
   * has never run or when `now - lastRun >= intervalMs`. Non-positive
   * intervals are treated as "due on every tick".
   */
  intervalMs: number;
  /**
   * Importance under budget pressure: HIGHER numbers are kept, lower numbers
   * are deferred first. Equal priorities tie-break by most-overdue, then id.
   */
  priority: number;
}

/** The sliding-window request budget the shell tracks. */
export interface PollBudget {
  /**
   * Maximum runs allowed inside the {@link BUDGET_WINDOW_MS} window. Values
   * <= 0 mean "no budget": everything due is deferred.
   */
  maxPerMinute: number;
  /**
   * Epoch-ms timestamps of recent runs that count against the window. The
   * shell appends via {@link recordRun}; stale entries are pruned there and
   * ignored by {@link remainingBudget} regardless.
   */
  recentRunTimestamps: readonly number[];
}

/** The budget window: "per minute" measured over a sliding 60s. */
export const BUDGET_WINDOW_MS = 60_000;

/** Map of registration id -> epoch ms of its last completed run. */
export type LastRunTimes = Readonly<Record<string, number>>;

/** {@link planPolls} verdict: what to run this tick, what waits. */
export interface PollPlan {
  /** Due ids that fit the budget, most-important-first. Run these now. */
  run: string[];
  /**
   * Due ids deferred for budget reasons, in deferral order (least important
   * deferred first is the TAIL discipline: this array is the low-priority
   * tail of the due list). They stay due and compete again next tick.
   */
  deferred: string[];
}

/**
 * Which registrations are due at `now`, most-important-first.
 *
 * A registration is due when it has never run (no entry in `lastRunTimes`)
 * or when `now - lastRun >= intervalMs`. Ordering: priority descending, then
 * most-overdue first (never-run counts as infinitely overdue), then id
 * ascending for determinism. Duplicate ids are not defended against; the
 * shell owns registration uniqueness.
 */
export function nextDue(
  registrations: readonly PollRegistration[],
  lastRunTimes: LastRunTimes,
  now: number,
): string[] {
  const due = registrations.filter((reg) => {
    const last = lastRunTimes[reg.id];
    if (last === undefined) {
      return true;
    }
    return now - last >= reg.intervalMs;
  });

  const overdueBy = (reg: PollRegistration): number => {
    const last = lastRunTimes[reg.id];
    if (last === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    return now - last - reg.intervalMs;
  };

  return due
    .slice()
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      const overdueDelta = overdueBy(b) - overdueBy(a);
      if (overdueDelta !== 0 && !Number.isNaN(overdueDelta)) {
        return overdueDelta;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((reg) => reg.id);
}

/**
 * How many runs the budget still allows at `now`.
 *
 * Counts timestamps strictly inside the last {@link BUDGET_WINDOW_MS}
 * (`now - t < BUDGET_WINDOW_MS`); a run exactly one window old has expired.
 * Future timestamps (clock skew) still count - safer to under-spend.
 * Never negative.
 */
export function remainingBudget(budget: PollBudget, now: number): number {
  if (budget.maxPerMinute <= 0) {
    return 0;
  }
  const inWindow = budget.recentRunTimestamps.filter(
    (t) => now - t < BUDGET_WINDOW_MS,
  ).length;
  return Math.max(0, budget.maxPerMinute - inWindow);
}

/**
 * Record a completed run against the budget, returning a NEW budget whose
 * window has been pruned (entries older than {@link BUDGET_WINDOW_MS} drop,
 * bounding the array). `count` covers polls that spend multiple requests.
 */
export function recordRun(
  budget: PollBudget,
  now: number,
  count = 1,
): PollBudget {
  const kept = budget.recentRunTimestamps.filter(
    (t) => now - t < BUDGET_WINDOW_MS,
  );
  const added = new Array<number>(Math.max(0, count)).fill(now);
  return {
    maxPerMinute: budget.maxPerMinute,
    recentRunTimestamps: [...kept, ...added],
  };
}

/**
 * The one-call scheduling decision: split the due list into what runs now
 * and what defers, keeping the highest-priority work.
 *
 * The due list from {@link nextDue} is already most-important-first, so the
 * budget takes its prefix and defers its tail - which IS "defer the
 * lowest-priority work first". Deferred polls remain due (their lastRun is
 * unchanged) and only grow more overdue, so they win their priority band's
 * tie-break on a later tick.
 */
export function planPolls(
  registrations: readonly PollRegistration[],
  lastRunTimes: LastRunTimes,
  budget: PollBudget,
  now: number,
): PollPlan {
  const due = nextDue(registrations, lastRunTimes, now);
  const allowance = Math.min(due.length, remainingBudget(budget, now));
  return {
    run: due.slice(0, allowance),
    deferred: due.slice(allowance),
  };
}
