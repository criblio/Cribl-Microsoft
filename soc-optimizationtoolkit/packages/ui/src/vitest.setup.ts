/**
 * Runs before every @soc/ui test file (vitest.config.ts). Gives Testing
 * Library's waitFor / findBy the suite-sized budget from test-budget.ts
 * (DBT-156).
 *
 * Only DOM files get it, and only DOM files load Testing Library for it: most
 * of the suite is pure-logic files in the node environment, and importing
 * React and Testing Library into each of them would add load to the very
 * gate run this budget exists for.
 */
import { WAIT_TIMEOUT_MS } from "./test-budget";

if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/react");
  configure({ asyncUtilTimeout: WAIT_TIMEOUT_MS });
}
