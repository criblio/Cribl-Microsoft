/**
 * Contract tests for the first-run wizard rules:
 *   - the full mode auto-selection truth table (hasCribl x hasAzure) and the
 *     availability gating, with the recommended card always available;
 *   - target tradeoff data present and rendered as data;
 *   - base-URL derivation (cloud org, self-managed compose) including the
 *     /api/v1-suffix rejection carried from the host config validator;
 *   - dual-profile swap: a reconnect validates the override set and the stored
 *     secret as one unit - a divergent-override reconnect fails cleanly and
 *     never half-applies;
 *   - step/skip progression per target+mode and the stable 3-segment progress.
 */
import { describe, expect, it } from "vitest";
import {
  deriveCloudBaseUrl,
  deriveSelfManagedBaseUrl,
  isStepSkippable,
  normalizeLeaderBaseUrl,
  planReconnect,
  targetTradeoffs,
  WIZARD_PHASES,
  WIZARD_TARGETS,
  wizardPhasesFor,
  wizardProgress,
  wizardSteps,
} from "./first-run-wizard";
import type {
  LeaderProfileStore,
  StoredLeaderProfile,
  WizardShape,
  WizardStepId,
} from "./first-run-wizard";

// The "mode auto-selection matrix" block lived here. It pinned recommendMode
// (the richest mode both links allow) and modeCards (which cards are gated),
// both deleted with app modes in capability-model-plan step 5. Nothing replaces
// it: what an operator can do is now MEASURED by the capability audit rather
// than recommended from which links happen to be connected.

describe("target chooser tradeoff data", () => {
  it("provides both targets with non-empty can/cannot lists", () => {
    const list = targetTradeoffs();
    expect(list.map((t) => t.target)).toEqual([...WIZARD_TARGETS]);
    for (const t of list) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.summary.length).toBeGreaterThan(0);
      expect(t.can.length).toBeGreaterThan(0);
      expect(t.cannot.length).toBeGreaterThan(0);
    }
  });

  it("captures the defining tradeoff: only local reaches self-managed leaders", () => {
    const list = targetTradeoffs();
    const criblHosted = list.find((t) => t.target === "cribl-hosted");
    const local = list.find((t) => t.target === "local");
    expect(
      criblHosted?.cannot.some((s) => /self-managed/i.test(s)),
    ).toBe(true);
    expect(local?.can.some((s) => /self-managed/i.test(s))).toBe(true);
  });
});

describe("base-URL derivation", () => {
  it("derives the Cribl.Cloud workspace host from an org id", () => {
    expect(deriveCloudBaseUrl("acme")).toEqual({
      ok: true,
      baseUrl: "https://main-acme.cribl.cloud",
    });
  });

  it("rejects an empty or malformed org id", () => {
    expect(deriveCloudBaseUrl("  ").ok).toBe(false);
    expect(deriveCloudBaseUrl("bad org").ok).toBe(false);
    expect(deriveCloudBaseUrl("bad/org").ok).toBe(false);
  });

  it("composes a self-managed base URL from protocol + address + port", () => {
    expect(
      deriveSelfManagedBaseUrl({
        protocol: "https",
        address: "leader.internal",
        port: "9000",
      }),
    ).toEqual({ ok: true, baseUrl: "https://leader.internal:9000" });
  });

  it("omits the port when empty and trims trailing slashes", () => {
    expect(
      deriveSelfManagedBaseUrl({ protocol: "http", address: "10.0.0.5" }),
    ).toEqual({ ok: true, baseUrl: "http://10.0.0.5" });
  });

  it("treats an address with a scheme as a full URL (no double scheme)", () => {
    expect(
      deriveSelfManagedBaseUrl({
        protocol: "http",
        address: "https://leader.internal:9000",
        port: "1234",
      }),
    ).toEqual({ ok: true, baseUrl: "https://leader.internal:9000" });
  });

  it("rejects a base URL that ends with /api/v1 with the host's fix message", () => {
    const direct = normalizeLeaderBaseUrl("https://leader.internal:9000/api/v1");
    expect(direct.ok).toBe(false);
    expect(direct.ok === false && direct.error).toMatch(
      /must not end with \/api\/v1/,
    );
    // The rejection is unavoidable through derivation too.
    const derived = deriveSelfManagedBaseUrl({
      protocol: "https",
      address: "https://leader.internal:9000/api/v1/",
    });
    expect(derived.ok).toBe(false);
  });

  it("requires an http/https scheme", () => {
    expect(normalizeLeaderBaseUrl("leader.internal:9000").ok).toBe(false);
  });
});

describe("dual-profile swap - validates override set and stored secret together", () => {
  const cloudProfile: StoredLeaderProfile = {
    deploymentType: "cloud",
    clientId: "cloud-client",
    baseUrl: "https://main-acme.cribl.cloud",
    hasSecret: true,
    organizationId: "acme",
  };
  const selfManagedProfile: StoredLeaderProfile = {
    deploymentType: "self-managed",
    clientId: "sm-user",
    baseUrl: "https://leader.internal:9000",
    hasSecret: true,
  };

  it("reconnects cleanly when the requested profile exists with a secret", () => {
    const store: LeaderProfileStore = {
      cloud: cloudProfile,
      selfManaged: null,
    };
    const plan = planReconnect(store, { deploymentType: "cloud" });
    expect(plan).toEqual({
      ok: true,
      deploymentType: "cloud",
      clientId: "cloud-client",
      baseUrl: "https://main-acme.cribl.cloud",
      organizationId: "acme",
    });
  });

  it("fails cleanly on a divergent-type reconnect (no cross-profile fallback)", () => {
    // Only a self-managed secret is stored; the user reconnects AS cloud.
    // The legacy handler fell back to the self-managed profile and half-applied
    // the cloud overrides onto that secret. Here it must fail cleanly.
    const store: LeaderProfileStore = {
      cloud: null,
      selfManaged: selfManagedProfile,
    };
    const plan = planReconnect(store, {
      deploymentType: "cloud",
      organizationId: "acme",
      baseUrl: "https://main-acme.cribl.cloud",
      clientId: "cloud-client",
    });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.error).toMatch(/no saved cloud/i);
  });

  it("fails cleanly when the requested profile has no stored secret", () => {
    const store: LeaderProfileStore = {
      cloud: { ...cloudProfile, hasSecret: false },
      selfManaged: null,
    };
    const plan = planReconnect(store, { deploymentType: "cloud" });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.error).toMatch(/no stored secret/i);
  });

  it("rejects a cloud reconnect whose edited base URL disagrees with the org id", () => {
    const store: LeaderProfileStore = {
      cloud: cloudProfile,
      selfManaged: null,
    };
    const plan = planReconnect(store, {
      deploymentType: "cloud",
      organizationId: "acme",
      // A base URL for a DIFFERENT org - must not half-apply one over the other.
      baseUrl: "https://main-other.cribl.cloud",
    });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.error).toMatch(/disagree/i);
  });

  it("applies self-managed overrides as one validated unit", () => {
    const store: LeaderProfileStore = {
      cloud: null,
      selfManaged: selfManagedProfile,
    };
    const plan = planReconnect(store, {
      deploymentType: "self-managed",
      baseUrl: "https://leader.internal:8443",
      clientId: "sm-user-2",
    });
    expect(plan).toEqual({
      ok: true,
      deploymentType: "self-managed",
      clientId: "sm-user-2",
      baseUrl: "https://leader.internal:8443",
    });
  });

  it("rejects a self-managed reconnect whose edited base URL ends with /api/v1", () => {
    const store: LeaderProfileStore = {
      cloud: null,
      selfManaged: selfManagedProfile,
    };
    const plan = planReconnect(store, {
      deploymentType: "self-managed",
      baseUrl: "https://leader.internal:9000/api/v1",
    });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.error).toMatch(/\/api\/v1/);
  });
});

describe("wizard step / skip progression", () => {
  const stepIds = (target: "cribl-hosted" | "local") =>
    wizardSteps({ target }).map((s) => s.id);

  // DELIBERATE INVERSION (capability-model-plan step 5). Four pins here asserted
  // that mode PRUNED the wizard: cribl-only dropped the Azure step, azure-only
  // dropped the Cribl step, air-gapped dropped both leaving [target, mode].
  // Both connect steps now always show, and because each is skippable an
  // operator without one connection passes straight through.
  it("shows both connect steps on the local target", () => {
    expect(stepIds("local")).toEqual(["target", "leader-connect", "connect-azure"]);
  });

  it("uses the upload walkthrough as the cribl step on the cribl-hosted target", () => {
    expect(stepIds("cribl-hosted")).toEqual(["target", "upload-walkthrough", "connect-azure"]);
  });

  it("no longer ends on a mode step", () => {
    expect(stepIds("local")).not.toContain("mode");
    expect(stepIds("cribl-hosted")).not.toContain("mode");
  });

  it("makes connect steps skippable but target not", () => {
    const shape = { target: "local" as const };
    expect(isStepSkippable(shape, "target")).toBe(false);
    expect(isStepSkippable(shape, "leader-connect")).toBe(true);
    expect(isStepSkippable(shape, "connect-azure")).toBe(true);
  });

  it("derives a stable 2-segment progress bar from the current step", () => {
    // Was 3 segments ending in Mode; the bar is now Target -> Connect.
    expect(WIZARD_PHASES).toEqual(["target", "connect"]);
    const full: WizardShape = { target: "local" };
    const statuses = (step: WizardStepId) =>
      wizardProgress(full, step).map((s) => s.status);
    expect(statuses("target")).toEqual(["current", "upcoming"]);
    expect(statuses("leader-connect")).toEqual(["complete", "current"]);
    // A skip that advances from the cribl step to azure stays in the same phase.
    expect(statuses("connect-azure")).toEqual(["complete", "current"]);
  });

  it("drops the target step, the cribl-side step, and the Target segment when already installed", () => {
    // Running inside the leader answers "where should this run?" and "upload
    // the app" by construction (user report 2026-08-03), so neither step is
    // shown and the bar describes only the phases that remain.
    const shape: WizardShape = { target: "cribl-hosted", installedInLeader: true };
    expect(wizardSteps(shape).map((s) => s.id)).toEqual(["connect-azure"]);
    expect(wizardPhasesFor(shape)).toEqual(["connect"]);
    expect(wizardProgress(shape, "connect-azure").map((s) => s.status)).toEqual(["current"]);
  });

  it("leaves the local target untouched - it has a real leader to connect to", () => {
    const shape: WizardShape = { target: "local" };
    expect(wizardSteps(shape).map((s) => s.id)).toEqual([
      "target",
      "leader-connect",
      "connect-azure",
    ]);
    expect(wizardPhasesFor(shape)).toEqual(["target", "connect"]);
  });
});
