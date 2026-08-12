/**
 * Contract tests for the table picker's pure decisions.
 *
 * This is the first feature to exercise the capability model outside the nav, so
 * the pins are the model's rules restated at feature level: a denied read
 * annotates but never blocks, and there is no fallback artifact to offer.
 */
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_STALE_NOTICE,
  deriveTablePickerAccess,
  emptyTableListMessage,
  filterTables,
  tableCountLabel,
} from "./table-picker-state";
import { emptyCapabilitySet } from "@soc/core";
import type { CapabilityContext, CapabilitySet, WorkspaceTable } from "@soc/core";

const connected: CapabilityContext = {
  azureIdentityPresent: true,
  criblReachable: true,
};
const audited = (v: CapabilitySet["verdicts"]): CapabilitySet => ({
  verdicts: v,
  auditedAt: "2026-08-10T00:00:00Z",
  connectionId: "c1",
});
const table = (name: string): WorkspaceTable => ({
  name,
  kind: name.endsWith("_CL") ? "custom" : "native",
  retentionInDays: null,
  plan: "Analytics",
});

describe("access annotation", () => {
  it("is loadable even when the read is DENIED", () => {
    // Rule 3 at feature level: the audit informs and offers, Azure's 403 is the
    // real gate, and a stale audit must not cost the operator the attempt.
    const access = deriveTablePickerAccess(
      audited({ "table.read": "denied" }),
      connected,
    );
    expect(access.loadable).toBe(true);
    expect(access.expectedToWork).toBe(false);
    expect(access.note).toContain("cannot do this");
  });

  it("is loadable with no connection at all", () => {
    expect(deriveTablePickerAccess(emptyCapabilitySet(), {
      azureIdentityPresent: false,
      criblReachable: false,
    }).loadable).toBe(true);
  });

  it("says nothing when the read is granted", () => {
    const access = deriveTablePickerAccess(
      audited({ "table.read": "granted" }),
      connected,
    );
    expect(access.expectedToWork).toBe(true);
    expect(access.note).toBeNull();
  });

  it("reports unmeasured as unchecked, never as refused", () => {
    const access = deriveTablePickerAccess(emptyCapabilitySet(), connected);
    expect(access.note).toContain("Not checked yet");
    expect(access.note).not.toContain("cannot");
  });
});

describe("filterTables", () => {
  const tables = [table("App_CL"), table("SecurityEvent"), table("Syslog")];

  it("matches case-insensitively on a substring", () => {
    expect(filterTables(tables, "sec").map((t) => t.name)).toEqual([
      "SecurityEvent",
    ]);
  });

  it("returns everything for a blank query", () => {
    expect(filterTables(tables, "   ")).toHaveLength(3);
  });

  it("preserves the listing order it was given", () => {
    expect(filterTables(tables, "s").map((t) => t.name)).toEqual([
      "SecurityEvent",
      "Syslog",
    ]);
  });
});

describe("tableCountLabel", () => {
  it("distinguishes 'nothing loaded' from 'nothing matched'", () => {
    // An empty list after a filter is a different fact from never having
    // loaded, and reading the same would look like a broken load.
    expect(tableCountLabel(0, 0)).toContain("No tables loaded");
    expect(tableCountLabel(12, 0)).toBe("0 of 12 tables");
  });

  it("states the filter rather than hiding it", () => {
    expect(tableCountLabel(12, 12)).toBe("12 tables");
    expect(tableCountLabel(12, 3)).toBe("3 of 12 tables");
  });
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
