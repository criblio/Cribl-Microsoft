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
  modeCards,
  normalizeLeaderBaseUrl,
  planReconnect,
  recommendMode,
  targetTradeoffs,
  WIZARD_PHASES,
  WIZARD_TARGETS,
  wizardProgress,
  wizardSteps,
} from "./first-run-wizard";
import type {
  LeaderProfileStore,
  StoredLeaderProfile,
  WizardStepId,
} from "./first-run-wizard";
import type { AppMode } from "../app-mode";

describe("mode auto-selection matrix", () => {
  const truthTable: {
    hasCribl: boolean;
    hasAzure: boolean;
    expected: AppMode;
  }[] = [
    { hasCribl: true, hasAzure: true, expected: "full" },
    { hasCribl: false, hasAzure: true, expected: "azure-only" },
    { hasCribl: true, hasAzure: false, expected: "cribl-only" },
    { hasCribl: false, hasAzure: false, expected: "air-gapped" },
  ];

  for (const row of truthTable) {
    it(`recommends ${row.expected} for cribl=${row.hasCribl} azure=${row.hasAzure}`, () => {
      expect(recommendMode(row)).toBe(row.expected);
    });
  }

  it("gates each mode card on its required links", () => {
    const cards = modeCards({ hasCribl: false, hasAzure: false });
    const byMode = Object.fromEntries(cards.map((c) => [c.mode, c]));
    // Only air-gapped is available with no links.
    expect(byMode["full"].available).toBe(false);
    expect(byMode["azure-only"].available).toBe(false);
    expect(byMode["cribl-only"].available).toBe(false);
    expect(byMode["air-gapped"].available).toBe(true);
  });

  it("makes full available only when both links are present", () => {
    expect(
      modeCards({ hasCribl: true, hasAzure: true }).find((c) => c.mode === "full")
        ?.available,
    ).toBe(true);
    expect(
      modeCards({ hasCribl: true, hasAzure: false }).find(
        (c) => c.mode === "full",
      )?.available,
    ).toBe(false);
  });

  it("marks exactly one card recommended, and it is always available", () => {
    for (const hasCribl of [true, false]) {
      for (const hasAzure of [true, false]) {
        const cards = modeCards({ hasCribl, hasAzure });
        const recommended = cards.filter((c) => c.recommended);
        expect(recommended).toHaveLength(1);
        expect(recommended[0].mode).toBe(recommendMode({ hasCribl, hasAzure }));
        // The recommended card is never a gated one.
        expect(recommended[0].available).toBe(true);
      }
    }
  });

  it("returns one card per mode in the canonical order", () => {
    const cards = modeCards({ hasCribl: true, hasAzure: true });
    expect(cards.map((c) => c.mode)).toEqual([
      "full",
      "azure-only",
      "cribl-only",
      "air-gapped",
    ]);
  });
});

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
  const stepIds = (target: "cribl-hosted" | "local", mode: AppMode | null) =>
    wizardSteps({ target, mode }).map((s) => s.id);

  it("shows both connect steps for full mode on the local target", () => {
    expect(stepIds("local", "full")).toEqual([
      "target",
      "leader-connect",
      "connect-azure",
      "mode",
    ]);
  });

  it("uses the upload walkthrough as the cribl step on the cribl-hosted target", () => {
    expect(stepIds("cribl-hosted", "full")).toEqual([
      "target",
      "upload-walkthrough",
      "connect-azure",
      "mode",
    ]);
  });

  it("drops the azure step for cribl-only and the cribl step for azure-only", () => {
    expect(stepIds("local", "cribl-only")).toEqual([
      "target",
      "leader-connect",
      "mode",
    ]);
    expect(stepIds("local", "azure-only")).toEqual([
      "target",
      "connect-azure",
      "mode",
    ]);
  });

  it("drops both connect steps for air-gapped", () => {
    expect(stepIds("local", "air-gapped")).toEqual(["target", "mode"]);
  });

  it("shows both connect steps while the mode is undecided", () => {
    expect(stepIds("local", null)).toEqual([
      "target",
      "leader-connect",
      "connect-azure",
      "mode",
    ]);
  });

  it("makes connect steps skippable but target and mode not", () => {
    const shape = { target: "local" as const, mode: "full" as AppMode };
    expect(isStepSkippable(shape, "target")).toBe(false);
    expect(isStepSkippable(shape, "leader-connect")).toBe(true);
    expect(isStepSkippable(shape, "connect-azure")).toBe(true);
    expect(isStepSkippable(shape, "mode")).toBe(false);
  });

  it("derives a stable 3-segment progress bar from the current step", () => {
    expect(WIZARD_PHASES).toEqual(["target", "connect", "mode"]);
    const statuses = (step: WizardStepId) =>
      wizardProgress(step).map((s) => s.status);
    expect(statuses("target")).toEqual(["current", "upcoming", "upcoming"]);
    expect(statuses("leader-connect")).toEqual([
      "complete",
      "current",
      "upcoming",
    ]);
    // A skip that advances from the cribl step to azure stays in the same phase.
    expect(statuses("connect-azure")).toEqual([
      "complete",
      "current",
      "upcoming",
    ]);
    expect(statuses("mode")).toEqual(["complete", "complete", "current"]);
  });
});
