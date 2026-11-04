/**
 * Pins for which worker group the onboarding screen creates in and watches
 * (AZR-64, ADR 0009 decision 5): the tenant's mapped group; the group chosen
 * on the screen ONLY when the mapping is unset, and said so; and nothing at all
 * while the mapping is unread or unreadable - an unknown mapping is never
 * treated as unset.
 */

import { describe, expect, it } from "vitest";
import { onboardingGroupChoice, onboardingGroupResolution } from "./group-choice";

describe("onboardingGroupChoice", () => {
  it("a mapped group wins over the screen's choice, hides the picker, and says where it came from", () => {
    const c = onboardingGroupChoice({ kind: "mapped", groupId: "g-tenant", mode: "per-tenant" }, "g-screen");
    expect(c.groupId).toBe("g-tenant");
    expect(c.source).toBe("mapping");
    expect(c.pickerShown).toBe(false);
    expect(c.blockedReason).toBeNull();
    expect(c.message).toEqual({
      tone: "info",
      text: "Worker group g-tenant: this tenant's own group, from the tenant to Cribl mapping on Setup.",
    });
  });

  it("the shared mode names itself", () => {
    const c = onboardingGroupChoice({ kind: "mapped", groupId: "g-all", mode: "shared" }, "");
    expect(c.groupId).toBe("g-all");
    expect(c.message?.text).toBe(
      "Worker group g-all: the one group for every tenant, from the tenant to Cribl mapping on Setup.",
    );
  });

  it.each([
    ["no-mode", "No tenant to Cribl mapping is set up yet."],
    ["no-shared-group", "The tenant to Cribl mapping says one worker group for every tenant, but no group is chosen yet."],
    ["no-tenant-group", "The tenant to Cribl mapping gives each tenant its own worker group, but none is chosen for this tenant yet."],
  ] as const)("unset (%s) falls back to the screen's group and says so, as info: unset is the documented default", (why, lead) => {
    const c = onboardingGroupChoice({ kind: "unset", why }, "g-screen");
    expect(c.groupId).toBe("g-screen");
    expect(c.source).toBe("screen");
    expect(c.pickerShown).toBe(true);
    expect(c.blockedReason).toBeNull();
    expect(c.message).toEqual({
      tone: "info",
      text: `${lead} The worker group chosen here is used; the mapping on Setup can set one per tenant.`,
    });
  });

  it("an UNKNOWN mapping never falls back: no group, the picker hidden, and the reason shown", () => {
    const c = onboardingGroupChoice({ kind: "unknown", reason: "HTTP 503" }, "g-screen");
    expect(c.groupId).toBe("");
    expect(c.source).toBe("blocked");
    expect(c.pickerShown).toBe(false);
    expect(c.message?.tone).toBe("error");
    expect(c.message?.text).toContain("HTTP 503");
    expect(c.blockedReason).toBe("The worker group for this tenant is unknown: HTTP 503.");
  });

  it("an unknown blocked reason names the real cause, such as a missing tenant id", () => {
    const reason = "the active connection has no tenant id, so there is no tenant to look up";
    const c = onboardingGroupChoice({ kind: "unknown", reason }, "g-screen");
    expect(c.blockedReason).toBe(`The worker group for this tenant is unknown: ${reason}.`);
    expect(c.blockedReason).not.toMatch(/Reading/);
  });

  it("while the mapping is still loading, nothing is created or read", () => {
    const c = onboardingGroupChoice("loading", "g-screen");
    expect(c.groupId).toBe("");
    expect(c.source).toBe("blocked");
    expect(c.pickerShown).toBe(false);
    expect(c.blockedReason).toBe("Reading the tenant to Cribl mapping...");
  });
});

describe("onboardingGroupResolution", () => {
  const MAPPING_READ = {
    kind: "read",
    stored: true,
    mapping: { mode: "shared", sharedGroup: "g-all", groups: {} },
  } as const;

  it("with no tenant id it is UNKNOWN for that reason at once - never 'loading', since no read is made", () => {
    for (const tenant of ["", "   "]) {
      expect(onboardingGroupResolution("loading", tenant)).toEqual({
        kind: "unknown",
        reason: "the active connection has no tenant id, so there is no tenant to look up",
      });
      // A mapping read for an earlier tenant does not leak into a blank one.
      const r = onboardingGroupResolution(MAPPING_READ, tenant);
      expect(r !== "loading" && r.kind).toBe("unknown");
    }
  });

  it("with a tenant id it is loading until the read lands, then the tenant's resolution", () => {
    expect(onboardingGroupResolution("loading", "t-1")).toBe("loading");
    expect(onboardingGroupResolution(MAPPING_READ, "t-1")).toEqual({ kind: "mapped", groupId: "g-all", mode: "shared" });
  });
});
