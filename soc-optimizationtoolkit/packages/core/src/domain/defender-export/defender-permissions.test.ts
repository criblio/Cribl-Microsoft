// Pins for the Defender export's stated permissions (AZR-3).
//
// The lists are shown as "needed, not yet measured" until CAP-7 measures them.
// What must hold meanwhile: they never gate DCR deploy readiness (feature, and
// kept out of REQUIRED_ACTIONS), they never ask for a pricings write, and each
// action sits in the list for the scope it is actually checked at.

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

  it("is not merged into REQUIRED_ACTIONS, so deploy readiness is untouched", () => {
    const preflight = new Set(Object.values(REQUIRED_ACTIONS).flatMap((list) => list.map((a) => a.action)));
    expect(ALL.filter((a) => preflight.has(a.action))).toEqual([]);
  });

  it("states that the lists are not yet measured", () => {
    expect(DEFENDER_ACTIONS_NOT_MEASURED).toMatch(/^Needed, not yet measured\./);
  });
});
