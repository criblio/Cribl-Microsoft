/**
 * The real timer the SHELL supplies to core's attempt-bounded loops.
 *
 * Core reads no clock, so every usecase that paces retries or polls takes an
 * INJECTED `sleep` and calls it as `await config.sleep?.(ms)`. The optional call
 * is what makes core testable without fake timers - and it is also why a missing
 * injection fails SILENTLY: `undefined?.(500)` is a no-op, so the loop still
 * runs, still terminates, and simply never waits.
 *
 * That is not hypothetical. The Cribl Lake query shipped without this, so its
 * twenty status polls fired within milliseconds of each other and every Lake
 * query in the product reported the search job as still running. Confirmed
 * against a live workspace on 2026-08-24, against a job that completed on its
 * first poll a second later.
 *
 * Live here rather than in each screen because there were three hand-rolled
 * copies of the same two lines and the one place it was missing is the one that
 * broke. A named import is harder to forget than a lambda.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
