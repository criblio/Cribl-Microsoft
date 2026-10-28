/**
 * Wall-clock budgets for the ui test suite (DBT-156). Read by vitest.config.ts
 * (the per-test timeout) and vitest.setup.ts (the Testing Library wait), and
 * pinned by test-budget.dom.test.tsx. Test infrastructure only: nothing in the
 * shipped screens imports this.
 *
 * WHY NOT THE DEFAULTS. Vitest gives a test 5s and Testing Library gives a
 * waitFor / findBy 1s. Both are wall-clock budgets, and the screen-level DOM
 * tests here are CPU-bound - React development builds rendering a few
 * thousand happy-dom nodes per action - so their wall time scales with how
 * busy the machine is, not with anything the test does. Run alone they take
 * 1-3s; under a full-suite gate run (667 files across every core, often with
 * other suites running beside it) the same tests took 5-37s.
 *
 * MEASURED, 2026-10-27, the full packages/ui suite on a 22-thread Windows host
 * shared with other suites:
 *   - with the defaults, three runs failed 7, 39 and 72 of 2008 tests, every
 *     one a timeout: the test budget ran out, or a waitFor ran out and
 *     reported its last assertion ("expected 0 to be 2") - which reads as a
 *     miscount and is not one;
 *   - with these budgets lifted (test 120s, wait 60s) the same suite passed
 *     2008 of 2008 under the same kind of load, so no failure was a hang, a
 *     wrong value or leaked state that a longer wait was hiding;
 *   - in that run the slowest test took 36.6s (IntegrateScreen, the gap
 *     card's Remove) and the slowest single waitFor 6.6s.
 * The budgets below are those worsts with headroom: 60s is 1.6x the slowest
 * test, 15s is 2.3x the slowest wait.
 *
 * THE COST. A test that genuinely hangs now takes up to 60s to fail, and a
 * waitFor whose condition never comes true takes 15s. A wrong value still
 * fails - a longer wait only helps a condition that does become true.
 */

/** Per-test timeout for every ui test, in milliseconds. */
export const TEST_TIMEOUT_MS = 60_000;

/** Testing Library's waitFor / findBy timeout for every ui test, in milliseconds. */
export const WAIT_TIMEOUT_MS = 15_000;
