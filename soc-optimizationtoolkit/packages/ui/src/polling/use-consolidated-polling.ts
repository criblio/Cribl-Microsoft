/**
 * useConsolidatedPolling - the ONE budgeted status poller.
 *
 * The legacy app ran three independent setInterval pollers (AuthBar 30s,
 * Sidebar 30s, DataFlow 30/45/60s) with no shared accounting - fatal on the
 * cloud shell, where every poll is a proxied request against a ~100 req/min
 * budget. This hook is the consolidation point: every screen-level poll
 * registers here, and the pure @soc/core poll-scheduler decides per tick
 * which due polls fit the budget (highest priority kept, lowest deferred).
 *
 * Division of labor: @soc/core owns the DECISIONS (nextDue/planPolls/
 * recordRun - pure, clock-free); this HOOK owns the clock and the timers.
 * The hook may use Date; core may not. Shells can inject `now` for tests or
 * alternate clocks.
 *
 * For Unit 1 only the connection-status poll registers in each shell; the
 * architecture (single scheduler, budget, priorities) is what ships.
 */

import { useEffect, useRef } from "react";
import { planPolls, recordRun } from "@soc/core";
import type { PollBudget, PollRegistration } from "@soc/core";

/** A registration plus the effect to run when the scheduler picks it. */
export interface ConsolidatedPoll extends PollRegistration {
  /**
   * Perform the poll. Errors are the poll's own concern: surface them in
   * the poll's UI state; the scheduler treats a failed run as a run (the
   * request was still spent).
   */
  run: () => void | Promise<void>;
}

export interface ConsolidatedPollingOptions {
  /** Every poll this shell wants scheduled. */
  polls: readonly ConsolidatedPoll[];
  /** Max poll runs per sliding 60s window (the shared request budget). */
  maxPerMinute: number;
  /** How often the scheduler wakes to plan, in ms. Default 5000. */
  tickMs?: number;
  /** Master switch; false stops the ticker (e.g. before the frame mounts). */
  enabled?: boolean;
  /** Clock override for tests; defaults to Date.now (hook-side only). */
  now?: () => number;
}

export function useConsolidatedPolling(
  options: ConsolidatedPollingOptions,
): void {
  const { polls, maxPerMinute, tickMs = 5000, enabled = true } = options;
  const now = options.now ?? Date.now;

  // Scheduler state lives in refs: it must survive re-renders without
  // restarting the ticker, and updating it must not itself re-render.
  const lastRunRef = useRef<Record<string, number>>({});
  const budgetRef = useRef<PollBudget>({
    maxPerMinute,
    recentRunTimestamps: [],
  });

  // Latest inputs, adopted after every render so the ticker always plans
  // against current registrations and clock without re-arming the interval.
  const pollsRef = useRef(polls);
  const nowRef = useRef(now);
  useEffect(() => {
    pollsRef.current = polls;
    nowRef.current = now;
    budgetRef.current = { ...budgetRef.current, maxPerMinute };
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const tick = () => {
      const at = nowRef.current();
      const current = pollsRef.current;
      const plan = planPolls(current, lastRunRef.current, budgetRef.current, at);
      for (const id of plan.run) {
        lastRunRef.current = { ...lastRunRef.current, [id]: at };
        budgetRef.current = recordRun(budgetRef.current, at);
        const poll = current.find((candidate) => candidate.id === id);
        if (poll !== undefined) {
          // Fire-and-forget: a poll's failure is its own UI state, and one
          // failing poll must never stall the scheduler or its peers.
          void Promise.resolve()
            .then(() => poll.run())
            .catch(() => undefined);
        }
      }
    };
    // Run immediately so first statuses do not wait a full tick.
    tick();
    const timer = setInterval(tick, tickMs);
    return () => clearInterval(timer);
  }, [enabled, tickMs]);
}
