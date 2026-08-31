/**
 * Contract tests for empty-inventory messaging (docs/inventory-standard.md).
 *
 * The bug this prevents: with insufficient RBAC the app said "No workspaces
 * found - create one below", inviting the operator to create a workspace that
 * already existed and that they could not see.
 */
import { describe, expect, it } from "vitest";

import {
  AUDITED_SCOPE,
  emptyInventoryMessage,
  unauditedScopeInventoryMessage,
  unmeasuredInventoryMessage,
} from "./empty-inventory";
import { emptyCapabilitySet } from "@soc/core";
import type { CapabilityContext, CapabilitySet } from "@soc/core";

const connected: CapabilityContext = { azureIdentityPresent: true, criblReachable: true };
const audited = (v: CapabilitySet["verdicts"]): CapabilitySet => ({
  verdicts: v, auditedAt: "2026-08-10T00:00:00Z", connectionId: "c1",
});
const msg = (set: CapabilitySet, ctx = connected) =>
  emptyInventoryMessage({
    noun: "workspaces",
    capability: "workspace.read",
    capabilities: set,
    context: ctx,
    scope: AUDITED_SCOPE,
  });

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

  it("names the CRIBL connection for a Cribl capability", () => {
    // Regression: the unreachable wording was hardcoded to Azure, so every
    // Cribl lister the standard also binds - packs, worker groups - would have
    // blamed a missing Azure connection for an unreachable leader.
    const m = emptyInventoryMessage({
      noun: "packs",
      capability: "pack.manage",
      capabilities: emptyCapabilitySet(),
      context: { azureIdentityPresent: true, criblReachable: false },
      scope: AUDITED_SCOPE,
    });
    expect(m.text).toContain("no Cribl connection");
    expect(m.text).not.toContain("Azure");
  });
});

describe("a verdict is evidence only about the scope it was measured at", () => {
  // runAzurePreflight evaluates ONE ARM scope built from the COMMITTED target,
  // and the targeting screen exists to browse OTHER subscriptions. Carrying the
  // committed scope's verdict across would reproduce the original bug one scope
  // over - with a permission check as cover, which is worse.
  const offScope = (set: CapabilitySet) =>
    emptyInventoryMessage({
      noun: "workspaces",
      capability: "workspace.read",
      capabilities: set,
      context: connected,
      scope: { matchesAudit: false, label: "subscription" },
    });

  it("refuses to claim a zero off-scope even when the capability is GRANTED", () => {
    const m = offScope(audited({ "workspace.read": "granted" }));
    expect(m.verified).toBe(false);
    expect(m.text).not.toContain("No workspaces found");
    expect(m.text).toContain("measured a different subscription");
  });

  it("refuses to claim a denial off-scope either", () => {
    // Symmetry: being refused in the committed subscription is no evidence
    // about this one, so an accusation would be as unfounded as a zero.
    const m = offScope(audited({ "workspace.read": "denied" }));
    expect(m.verified).toBe(false);
    expect(m.text).not.toContain("does not have permission");
    expect(m.text).toContain("Cannot confirm");
  });

  it("still reports a missing connection ahead of the scope mismatch", () => {
    const m = emptyInventoryMessage({
      noun: "workspaces",
      capability: "workspace.read",
      capabilities: emptyCapabilitySet(),
      context: { azureIdentityPresent: false, criblReachable: true },
      scope: { matchesAudit: false, label: "subscription" },
    });
    expect(m.text).toContain("no Azure connection");
  });
});

/**
 * The `unreachable` answer, which NO shipping caller can currently produce
 * (DBT-57, 2026-08-31 - the note in empty-inventory.ts works out why, and why
 * the branch is kept rather than deleted).
 *
 * That is exactly why these pins assert the WORDING against the other four
 * answers instead of settling for non-emptiness. Nothing in the running app
 * would notice if this branch were collapsed into the "run the permission
 * check" hedge, and that is the specific wrong answer for an operator with no
 * connection: it sends them to a check they have nothing to run against, and
 * they will read whatever comes back as confirmation. A degrade the standard
 * calls binding has to be held up by its tests while no caller holds it up.
 */
describe("no connection is its own answer, not a hedge", () => {
  const unreachable = msg(emptyCapabilitySet(), {
    azureIdentityPresent: false,
    criblReachable: true,
  });

  it("states the missing connection instead of pointing at the check", () => {
    expect(unreachable.text).toBe("Cannot list workspaces - no Azure connection");
    expect(unreachable.verified).toBe(false);
  });

  it("never sends them to a check, and never accuses the identity", () => {
    // The two ways this collapses into a neighbour. Kept apart from the exact
    // wording above so a collapse fails HERE too, and says which one it was.
    expect(unreachable.text).not.toContain("permission check");
    expect(unreachable.text).not.toContain("does not have permission");
  });

  it("is a fifth distinct answer, not a synonym of any other", () => {
    const answers = [
      msg(audited({ "workspace.read": "granted" })).text,
      msg(audited({ "workspace.read": "denied" })).text,
      msg(emptyCapabilitySet()).text,
      emptyInventoryMessage({
        noun: "workspaces",
        capability: "workspace.read",
        capabilities: audited({ "workspace.read": "granted" }),
        context: connected,
        scope: { matchesAudit: false, label: "subscription" },
      }).text,
      unreachable.text,
    ];
    expect(new Set(answers).size).toBe(5);
  });
});

describe("lists no capability covers", () => {
  it("hedges WITHOUT sending the operator to a check that cannot settle it", () => {
    const m = unmeasuredInventoryMessage("resource groups");
    expect(m.verified).toBe(false);
    expect(m.text).toContain("Cannot confirm there are no resource groups");
    expect(m.text).not.toContain("run the permission check");
  });
});

describe("wording", () => {
  it("interpolates the noun into every case", () => {
    for (const set of [
      audited({ "dcr.read": "granted" }),
      audited({ "dcr.read": "denied" }),
      emptyCapabilitySet(),
    ]) {
      expect(
        emptyInventoryMessage({
          noun: "data collection rules",
          capability: "dcr.read",
          capabilities: set,
          context: connected,
          scope: AUDITED_SCOPE,
        }).text,
      ).toContain("data collection rules");
    }
  });
});

/**
 * The three hedges are NOT synonyms (HON-2). Each states a different fact, and
 * an operator reading one while in the situation of another is the bug this
 * module exists to prevent - so the pins hold them APART, not merely non-empty.
 */
describe("the three hedges say different things", () => {
  const offScope = emptyInventoryMessage({
    noun: "workspaces",
    capability: "workspace.read",
    capabilities: audited({ "workspace.read": "granted" }),
    context: connected,
    scope: { matchesAudit: false, label: "subscription" },
  });
  const unaudited = unauditedScopeInventoryMessage("workspaces", "subscription");
  const uncovered = unmeasuredInventoryMessage("resource groups");

  it("off-scope says a check ran SOMEWHERE ELSE", () => {
    expect(offScope.text).toBe(
      "Cannot confirm there are no workspaces in this subscription - " +
        "the permission check measured a different subscription",
    );
  });

  it("unaudited says NO check has run here - not that one ran elsewhere", () => {
    expect(unaudited.text).toBe(
      "Cannot confirm there are no workspaces in this subscription - " +
        "no permission check has measured it",
    );
    // The distinction, asserted rather than described: the setup wizard runs
    // before any audit, so claiming a different subscription was measured
    // describes a check the operator has not run.
    expect(unaudited.text).not.toContain("a different subscription");
  });

  it("uncovered says no capability exists, and never points at the check", () => {
    expect(uncovered.text).toBe(
      "Cannot confirm there are no resource groups - no permission check covers this list",
    );
    // Sending an operator to a check that cannot settle the question is worse
    // than the hedge: they will read its result as confirmation.
    expect(uncovered.text).not.toMatch(/run the permission check/);
  });

  it("all three refuse the zero and refuse the accusation", () => {
    for (const m of [offScope, unaudited, uncovered]) {
      expect(m.verified).toBe(false);
      expect(m.text).not.toMatch(/^No /);
      expect(m.text).not.toContain("does not have permission");
    }
  });

  it("no two of them are the same string", () => {
    const texts = [offScope.text, unaudited.text, uncovered.text];
    expect(new Set(texts).size).toBe(3);
  });
});
