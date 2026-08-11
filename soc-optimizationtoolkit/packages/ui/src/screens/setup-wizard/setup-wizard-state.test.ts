/**
 * Tests for the Setup wizard's pure UI-side decisions. The abstract rules
 * (mode matrix, tradeoff table, base-URL derivation, dual-profile reconnect,
 * abstract step list + progress) are pinned in @soc/core's first-run-wizard
 * tests; these pin the BINDING layer this assembly adds: the concrete screen
 * list (with the injected preflight + repositories panels), Back/Next
 * navigation over it, the 3-segment progress mapping, the footer status
 * derivation, the Get Started gate, and the leader base-URL dispatch.
 */
import { describe, expect, it } from "vitest";
import type { WizardShape } from "@soc/core";
import {
  GET_STARTED_NOT_FINAL_REASON,
  deriveFooterStatus,
  deriveGetStarted,
  deriveLeaderBaseUrl,
  isFinalView,
  isFirstView,
  nextViewId,
  previousViewId,
  resolveCurrentViewId,
  wizardViewIds,
  wizardViewProgress,
  wizardViews,
} from "./setup-wizard-state";

describe("wizardViews", () => {
  it("leads the Connect phase with repositories and trails Azure with preflight (local, mode undecided)", () => {
    // ORDER CONTRACT (user direction 2026-08-03): GitHub first, because it is
    // the connection a customer can make without a change request; the
    // preflight must still follow connect-azure, since it verifies the
    // identity that step configures.
    const shape: WizardShape = { target: "local" };
    expect(wizardViewIds(shape)).toEqual([
      "target",
      "repositories",
      "leader-connect",
      "connect-azure",
      "preflight",
    ]);
  });

  it("uses the upload walkthrough as the cribl-side step for the cribl-hosted target", () => {
    const shape: WizardShape = { target: "cribl-hosted" };
    expect(wizardViewIds(shape)).toEqual([
      "target",
      "repositories",
      "upload-walkthrough",
      "connect-azure",
      "preflight",
    ]);
  });

  it("never places repositories after connect-azure in any shape that has both", () => {
    // The point of the reorder: a customer blocked on Azure credentials must
    // reach the GitHub step first, in every shape that offers both.
    for (const target of ["local", "cribl-hosted"] as const) {
      {
        const ids = wizardViewIds({ target });
        const repos = ids.indexOf("repositories");
        const azure = ids.indexOf("connect-azure");
        if (repos !== -1 && azure !== -1) {
          expect(repos).toBeLessThan(azure);
        }
      }
    }
  });

  // DELIBERATE INVERSION (capability-model-plan step 5). Two pins here asserted
  // that a "decided" re-run PRUNED the wizard: air-gapped dropped both connect
  // panels leaving just [target, mode], and azure-only dropped the Cribl step.
  // There is no decided mode to prune with any more, and the panels are
  // skippable, so the list is the same for every run.
  it("shows the same concrete list for every run", () => {
    expect(wizardViewIds({ target: "local" })).toEqual([
      "target",
      "repositories",
      "leader-connect",
      "connect-azure",
      "preflight",
    ]);
  });

  it("marks target non-skippable and the middle screens skippable", () => {
    const views = wizardViews({ target: "local" });
    const byId = Object.fromEntries(views.map((v) => [v.id, v.skippable]));
    expect(byId["target"]).toBe(false);
    expect(byId["leader-connect"]).toBe(true);
    expect(byId["connect-azure"]).toBe(true);
    expect(byId["preflight"]).toBe(true);
    expect(byId["repositories"]).toBe(true);
  });

  it("puts the injected panels in the connect phase", () => {
    const views = wizardViews({ target: "local" });
    const preflight = views.find((v) => v.id === "preflight");
    const repositories = views.find((v) => v.id === "repositories");
    expect(preflight?.phase).toBe("connect");
    expect(repositories?.phase).toBe("connect");
  });
});

describe("navigation", () => {
  const shape: WizardShape = { target: "local" };

  it("advances through the concrete list in order", () => {
    expect(nextViewId(shape, "target")).toBe("repositories");
    expect(nextViewId(shape, "repositories")).toBe("leader-connect");
    expect(nextViewId(shape, "connect-azure")).toBe("preflight");
  });

  it("returns null past the final view and before the first", () => {
    expect(nextViewId(shape, "preflight")).toBeNull();
    expect(previousViewId(shape, "target")).toBeNull();
  });

  it("steps backward through the list", () => {
    expect(previousViewId(shape, "preflight")).toBe("connect-azure");
    expect(previousViewId(shape, "leader-connect")).toBe("repositories");
    expect(previousViewId(shape, "repositories")).toBe("target");
  });

  it("returns null for a view id that is not in the current list", () => {
    // upload-walkthrough belongs to the cribl-hosted target, not local.
    expect(nextViewId(shape, "upload-walkthrough")).toBeNull();
    expect(previousViewId(shape, "upload-walkthrough")).toBeNull();
  });

  it("marks the first and last views", () => {
    expect(isFirstView(shape, "target")).toBe(true);
    expect(isFirstView(shape, "leader-connect")).toBe(false);
    expect(isFinalView(shape, "preflight")).toBe(true);
    expect(isFinalView(shape, "repositories")).toBe(false);
  });
});

describe("resolveCurrentViewId", () => {
  it("keeps a still-present view id", () => {
    const shape: WizardShape = { target: "local" };
    expect(resolveCurrentViewId(shape, "preflight")).toBe("preflight");
  });

  it("falls back to the first view when a target switch drops the current view", () => {
    // On cribl-hosted there is no leader-connect view; a cursor left there
    // clamps back to target rather than stranding on a missing screen.
    const shape: WizardShape = { target: "cribl-hosted" };
    expect(resolveCurrentViewId(shape, "leader-connect")).toBe("target");
  });
});

describe("wizardViewProgress", () => {
  it("lights the segments by phase, mapping the injected panels to Connect", () => {
    const shape: WizardShape = { target: "local" };
    const at = (id: Parameters<typeof wizardViewProgress>[1]) =>
      wizardViewProgress(shape, id).map((seg) => `${seg.phase}:${seg.status}`);
    // Two segments now, not three: the Mode phase went with mode selection
    // (capability-model-plan step 5).
    expect(at("target")).toEqual(["target:current", "connect:upcoming"]);
    expect(at("repositories")).toEqual(["target:complete", "connect:current"]);
    expect(at("preflight")).toEqual(["target:complete", "connect:current"]);
  });

  it("drops the Target segment entirely when already installed in the leader", () => {
    // The bar must describe the steps this run will actually show; an empty
    // Target segment would promise a step that never arrives.
    const shape: WizardShape = {
      target: "cribl-hosted",
      installedInLeader: true,
    };
    const at = (id: Parameters<typeof wizardViewProgress>[1]) =>
      wizardViewProgress(shape, id).map((seg) => `${seg.phase}:${seg.status}`);
    expect(at("repositories")).toEqual(["connect:current"]);
    expect(at("preflight")).toEqual(["connect:current"]);
  });
});

describe("installed-in-leader shape", () => {
  it("drops both the target step and the cribl-side install step", () => {
    // Running inside the leader answers both questions by construction: there
    // is one possible target, and nothing left to upload (user report
    // 2026-08-03).
    const shape: WizardShape = {
      target: "cribl-hosted",
      installedInLeader: true,
    };
    expect(wizardViewIds(shape)).toEqual([
      "repositories",
      "connect-azure",
      "preflight",
    ]);
  });

  it("still leads with repositories and ends on mode", () => {
    const shape: WizardShape = {
      target: "cribl-hosted",
      installedInLeader: true,
    };
    expect(isFirstView(shape, "repositories")).toBe(true);
    expect(isFinalView(shape, "preflight")).toBe(true);
    // A cursor left on the dropped target view clamps to the first real view
    // instead of stranding the wizard on a blank screen.
    expect(resolveCurrentViewId(shape, "target")).toBe("repositories");
  });
});

describe("deriveFooterStatus", () => {
  const base = {
    criblConnected: false,
    criblChecked: false,
    azureConnected: false,
    azureChecked: false,
    repositoriesReachable: false,
    repositoriesChecked: false,
  };

  it("reports the cribl-hosted Cribl link ready-by-platform without a connect attempt", () => {
    const status = deriveFooterStatus({ ...base, target: "cribl-hosted" });
    const cribl = status.connections.find((c) => c.id === "cribl");
    expect(cribl?.tone).toBe("ready");
    expect(cribl?.detail).toContain("platform");
  });

  it("is pending before any attempt and attention after a failed one (local)", () => {
    const pending = deriveFooterStatus({ ...base, target: "local" });
    expect(pending.connections.find((c) => c.id === "cribl")?.tone).toBe(
      "pending",
    );
    expect(pending.repositories.tone).toBe("pending");

    const attention = deriveFooterStatus({
      ...base,
      target: "local",
      criblChecked: true,
      azureChecked: true,
      repositoriesChecked: true,
    });
    expect(attention.connections.find((c) => c.id === "cribl")?.tone).toBe(
      "attention",
    );
    expect(attention.connections.find((c) => c.id === "azure")?.tone).toBe(
      "attention",
    );
    expect(attention.repositories.tone).toBe("attention");
  });

  it("reports ready once a connection is established", () => {
    const status = deriveFooterStatus({
      ...base,
      target: "local",
      criblConnected: true,
      azureConnected: true,
      repositoriesReachable: true,
    });
    expect(status.connections.find((c) => c.id === "cribl")?.tone).toBe("ready");
    expect(status.connections.find((c) => c.id === "azure")?.tone).toBe("ready");
    expect(status.repositories.tone).toBe("ready");
  });
});

describe("deriveGetStarted", () => {
  // DELIBERATE SIMPLIFICATION (capability-model-plan step 5). Two of the four
  // pins here asserted mode conditions: blocked until a mode was chosen, and
  // blocked when the chosen mode was not "available" for the connections
  // established. Finishing no longer depends on either - what an operator can
  // do is MEASURED by the capability audit afterwards rather than declared
  // here - so reaching the last view is the whole gate.
  it("is blocked with a specific reason before the final view", () => {
    expect(deriveGetStarted({ isFinal: false })).toEqual({
      ready: false,
      reason: GET_STARTED_NOT_FINAL_REASON,
    });
  });

  it("is ready on the final view, with no mode to choose", () => {
    expect(deriveGetStarted({ isFinal: true })).toEqual({ ready: true });
  });
});

describe("deriveLeaderBaseUrl", () => {
  const form = {
    organizationId: "",
    protocol: "https" as const,
    address: "",
    port: "",
  };

  it("derives the cloud workspace host from the org id", () => {
    const result = deriveLeaderBaseUrl({
      ...form,
      deploymentType: "cloud",
      organizationId: "acme",
    });
    expect(result).toEqual({ ok: true, baseUrl: "https://main-acme.cribl.cloud" });
  });

  it("composes the self-managed URL from protocol/address/port", () => {
    const result = deriveLeaderBaseUrl({
      ...form,
      deploymentType: "self-managed",
      address: "leader.example.com",
      port: "9000",
    });
    expect(result).toEqual({
      ok: true,
      baseUrl: "https://leader.example.com:9000",
    });
  });

  it("surfaces the /api/v1 fix message for a pasted self-managed URL", () => {
    const result = deriveLeaderBaseUrl({
      ...form,
      deploymentType: "self-managed",
      address: "https://leader.example.com/api/v1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("/api/v1");
    }
  });
});
