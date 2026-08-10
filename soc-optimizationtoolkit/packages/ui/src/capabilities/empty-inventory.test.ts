/**
 * Contract tests for empty-inventory messaging (docs/inventory-standard.md).
 *
 * The bug this prevents: with insufficient RBAC the app said "No workspaces
 * found - create one below", inviting the operator to create a workspace that
 * already existed and that they could not see.
 */
import { describe, expect, it } from "vitest";

import { emptyInventoryMessage } from "./empty-inventory";
import { emptyCapabilitySet } from "@soc/core";
import type { CapabilityContext, CapabilitySet } from "@soc/core";

const connected: CapabilityContext = { azureIdentityPresent: true, criblReachable: true };
const audited = (v: CapabilitySet["verdicts"]): CapabilitySet => ({
  verdicts: v, auditedAt: "2026-08-10T00:00:00Z", connectionId: "c1",
});
const msg = (set: CapabilitySet, ctx = connected) =>
  emptyInventoryMessage("workspaces", "workspace.read", set, ctx);

describe("only a MEASURED grant may claim a zero", () => {
  it("says 'none found' when the read was verified", () => {
    const m = msg(audited({ "workspace.read": "granted" }));
    expect(m.text).toBe("No workspaces found");
    expect(m.verified).toBe(true);
  });

  it("never claims a zero on a denial", () => {
    const m = msg(audited({ "workspace.read": "denied" }));
    expect(m.verified).toBe(false);
    expect(m.text).toContain("Cannot list");
    expect(m.text).not.toContain("No workspaces found");
  });

  it("never claims a zero when the check has not run", () => {
    // The common case - the audit runs on connection change, so plenty of
    // healthy connections are simply unaudited. It must hedge, not accuse.
    const m = msg(emptyCapabilitySet());
    expect(m.verified).toBe(false);
    expect(m.text).toContain("Cannot confirm");
    expect(m.text).not.toContain("does not have permission");
  });

  it("names the connection when there is none", () => {
    const m = msg(emptyCapabilitySet(), {
      azureIdentityPresent: false, criblReachable: true,
    });
    expect(m.verified).toBe(false);
    expect(m.text).toContain("no Azure connection");
  });
});

describe("wording", () => {
  it("interpolates the noun into every case", () => {
    for (const set of [
      audited({ "workspace.read": "granted" }),
      audited({ "workspace.read": "denied" }),
      emptyCapabilitySet(),
    ]) {
      expect(emptyInventoryMessage("data collection rules", "dcr.read", set, connected).text)
        .toContain("data collection rules");
    }
  });
});
