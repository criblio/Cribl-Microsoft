// @vitest-environment happy-dom
/**
 * DBT-156: every ui test runs on the suite-sized budgets in test-budget.ts.
 *
 * These pins read the budgets back from where they are enforced - the
 * runner's own timeout on this test, and the waitFor / findBy timeout Testing
 * Library will use - so a config or setup file that stops applying them fails
 * here, rather than as a red gate run the next time the machine is busy.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getConfig } from "@testing-library/react";
import { TEST_TIMEOUT_MS, WAIT_TIMEOUT_MS } from "./test-budget";

const SRC = dirname(fileURLToPath(import.meta.url));

describe("the ui suite's time budgets (DBT-156)", () => {
  it("gives every test the measured budget, not the 5s default", ({ task }) => {
    expect(task.timeout).toBe(TEST_TIMEOUT_MS);
    expect(TEST_TIMEOUT_MS).toBe(60_000);
  });

  it("gives every waitFor and findBy the measured budget, not the 1s default", () => {
    expect(getConfig().asyncUtilTimeout).toBe(WAIT_TIMEOUT_MS);
    expect(WAIT_TIMEOUT_MS).toBe(15_000);
  });

  it("is not cut back below the budget by a waitFor of its own", () => {
    // A `{ timeout: N }` on one waitFor REPLACES the configured budget rather
    // than adding to it, so a 3000 written when the default was 1000 - three
    // of them, in integrate-screen and azure-targeting-screen - became the
    // shortest wait in the suite the day the budget went to 15s, and the next
    // one to time out under load. Literal numbers only: a wait sized from
    // WAIT_TIMEOUT_MS is not one this can misread.
    const short = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((f) => /\.test\.tsx?$/.test(f))
      .flatMap((f) =>
        [...readFileSync(join(SRC, f), "utf8").matchAll(/\btimeout:\s*([0-9][0-9_]*)/g)]
          .filter((m) => Number(m[1]!.replace(/_/g, "")) < WAIT_TIMEOUT_MS)
          .map((m) => `${f.replace(/\\/g, "/")}: timeout ${m[1]}`),
      );
    expect(short).toEqual([]);
  });
});
