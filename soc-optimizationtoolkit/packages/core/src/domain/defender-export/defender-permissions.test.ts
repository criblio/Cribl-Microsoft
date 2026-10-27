// Pins for the Defender export's stated permissions (AZR-3).
//
// The screen shows the lists as "needed, not yet measured". CAP-7a measures the
// subscription list through REQUIRED_ACTIONS['existing-subscription']; the
// namespace list waits for CAP-7b. What must hold: they never gate DCR deploy
// readiness (feature), they never ask for a pricings write, and each action
// sits in the list for the scope it is actually checked at.

import { describe, expect, it } from "vitest";

import { REQUIRED_ACTIONS } from "../azure-permissions/azure-permissions";
import {
  DEFENDER_ACTIONS_NOT_MEASURED,
  DEFENDER_NAMESPACE_ACTIONS,
  DEFENDER_SUBSCRIPTION_ACTIONS,
} from "./defender-permissions";

const ALL = [...DEFENDER_SUBSCRIPTION_ACTIONS, ...DEFENDER_NAMESPACE_ACTIONS];

describe("Defender required actions", () => {
  it("groups the actions by the scope they apply at", () => {
    expect(DEFENDER_SUBSCRIPTION_ACTIONS.map((a) => a.action)).toEqual([
      "Microsoft.Security/pricings/read",
      "Microsoft.Security/automations/read",
      "Microsoft.Security/automations/write",
    ]);
    expect(DEFENDER_NAMESPACE_ACTIONS.map((a) => a.action)).toEqual([
      "Microsoft.EventHub/namespaces/authorizationRules/listKeys/action",
    ]);
  });

  it("marks every action 'feature', explicitly", () => {
    // Explicit, not defaulted: a missing necessity defaults to core and would
    // make a Defender denial report the DCR path as not ready.
    expect(ALL.map((a) => a.necessity)).toEqual(ALL.map(() => "feature"));
  });

  it("never asks for a pricings write", () => {
    expect(ALL.filter((a) => /pricings\/(write|delete)/i.test(a.action))).toEqual([]);
  });

  it("gives every action a label", () => {
    expect(ALL.filter((a) => a.label.trim() === "")).toEqual([]);
  });

  // RE-PINNED 2026-10-27 (CAP-7a). This was "is not merged into
  // REQUIRED_ACTIONS, so deploy readiness is untouched". CAP-7a merges the
  // SUBSCRIPTION list on purpose, which is how it becomes measured, so the old
  // pin had to go. What it protected is kept and made narrower: the merge is
  // only onto the subscription-scope path, only as `feature` (so readiness is
  // still untouched - the necessity pin above, plus the Reader pin in
  // azure-permissions.test), and the namespace list stays out everywhere.
  it("merges the subscription list into existing-subscription only, unchanged", () => {
    const sub = new Set(DEFENDER_SUBSCRIPTION_ACTIONS.map((a) => a.action));
    expect(REQUIRED_ACTIONS["existing-subscription"].filter((a) => sub.has(a.action))).toEqual([
      ...DEFENDER_SUBSCRIPTION_ACTIONS,
    ]);
    for (const [path, list] of Object.entries(REQUIRED_ACTIONS)) {
      if (path === "existing-subscription") continue;
      expect(list.filter((a) => sub.has(a.action)), path).toEqual([]);
    }
  });

  it("keeps the namespace list out of REQUIRED_ACTIONS (CAP-7b, not subscription-scoped)", () => {
    const preflight = new Set(Object.values(REQUIRED_ACTIONS).flatMap((list) => list.map((a) => a.action)));
    expect(DEFENDER_NAMESPACE_ACTIONS.filter((a) => preflight.has(a.action))).toEqual([]);
  });

  it("states that the lists are not yet measured", () => {
    expect(DEFENDER_ACTIONS_NOT_MEASURED).toMatch(/^Needed, not yet measured\./);
  });
});
