/**
 * Contract tests for the pure decisions behind the workspace table listing.
 *
 * TRIMMED 2026-08-18 with the panel. `deriveTablePickerAccess` (the before-you-
 * load prediction), `filterTables` and `tableCountLabel` are gone - all three
 * served a browse list nobody selected from. Rules 1 and 2 did NOT go with them;
 * they moved to use-workspace-tables.dom.test.tsx, where they are now pins on
 * behaviour (the listing is attempted on the worst verdict available, and the
 * failure note offers a retry and nothing else) rather than on returned text.
 *
 * What remains here is rule 3, which is still a pure decision: an empty listing
 * is only a zero once the read was verified.
 */
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_STALE_NOTICE,
  emptyTableListMessage,
} from "./table-picker-state";
import { emptyCapabilitySet } from "@soc/core";
import type { CapabilityContext, CapabilitySet } from "@soc/core";

const connected: CapabilityContext = {
  azureIdentityPresent: true,
  criblReachable: true,
};
const audited = (v: CapabilitySet["verdicts"]): CapabilitySet => ({
  verdicts: v,
  auditedAt: "2026-08-10T00:00:00Z",
  connectionId: "c1",
});

describe("an empty listing (docs/inventory-standard.md)", () => {
  it("claims a zero ONLY on a measured table.read", () => {
    const m = emptyTableListMessage(audited({ "table.read": "granted" }), connected);
    expect(m.verified).toBe(true);
    expect(m.text).toBe("No tables found");
  });

  it("never reads as an empty workspace when the read was refused", () => {
    // listWorkspaceTables throws on a non-2xx, which covers explicit denial -
    // but an RBAC-filtered 200 [] arrives as a successful empty listing and
    // would otherwise look like a workspace with no tables in it.
    const m = emptyTableListMessage(audited({ "table.read": "denied" }), connected);
    expect(m.verified).toBe(false);
    expect(m.text).not.toContain("No tables found");
  });

  it("hedges when no audit has run", () => {
    const m = emptyTableListMessage(emptyCapabilitySet(), connected);
    expect(m.verified).toBe(false);
    expect(m.text).toContain("Cannot confirm");
  });
});

describe("stale notice", () => {
  it("says the results belong to the PREVIOUS table", () => {
    // Not merely "loading" - the decision is that old results stay visible while
    // the new run lands, so the text has to say what they are about.
    expect(ANALYSIS_STALE_NOTICE).toContain("previously selected table");
    expect(ANALYSIS_STALE_NOTICE).toContain("Re-running");
  });
});
