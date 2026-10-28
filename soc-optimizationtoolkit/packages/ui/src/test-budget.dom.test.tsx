// @vitest-environment happy-dom
/**
 * DBT-156: every ui test runs on the suite-sized budgets in test-budget.ts.
 *
 * These pins read the budgets back from where they are enforced - the
 * runner's own timeout on this test, and the waitFor / findBy timeout Testing
 * Library will use - so a config or setup file that stops applying them fails
 * here, rather than as a red gate run the next time the machine is busy.
 */

import { describe, expect, it } from "vitest";
import { getConfig } from "@testing-library/react";
import { TEST_TIMEOUT_MS, WAIT_TIMEOUT_MS } from "./test-budget";

describe("the ui suite's time budgets (DBT-156)", () => {
  it("gives every test the measured budget, not the 5s default", ({ task }) => {
    expect(task.timeout).toBe(TEST_TIMEOUT_MS);
    expect(TEST_TIMEOUT_MS).toBe(60_000);
  });

  it("gives every waitFor and findBy the measured budget, not the 1s default", () => {
    expect(getConfig().asyncUtilTimeout).toBe(WAIT_TIMEOUT_MS);
    expect(WAIT_TIMEOUT_MS).toBe(15_000);
  });
});
