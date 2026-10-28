/**
 * Test configuration for @soc/ui. Standalone on purpose: this package has no
 * Vite app config to inherit, and a test run should never pick up a dev
 * server's settings.
 *
 * The budgets are the suite-sized ones in src/test-budget.ts (DBT-156), where
 * the measurement behind them is written down. Environments stay per file
 * (`// @vitest-environment happy-dom`), as before.
 */
import { defineConfig } from "vitest/config";
import { TEST_TIMEOUT_MS } from "./src/test-budget";

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    setupFiles: ["./src/vitest.setup.ts"],
  },
});
