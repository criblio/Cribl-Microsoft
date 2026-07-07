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
  GET_STARTED_MODE_UNAVAILABLE_REASON,
  GET_STARTED_NO_MODE_REASON,
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
  it("injects preflight + repositories before Mode for the local target (mode undecided)", () => {
    const shape: WizardShape = { target: "local", mode: null };
    expect(wizardViewIds(shape)).toEqual([
      "target",
      "leader-connect",
      "connect-azure",
      "preflight",
      "repositories",
      "mode",
    ]);
  });

  it("uses the upload walkthrough as the cribl-side step for the cribl-hosted target", () => {
    const shape: WizardShape = { target: "cribl-hosted", mode: null };
    expect(wizardViewIds(shape)).toEqual([
      "target",
      "upload-walkthrough",
      "connect-azure",
      "preflight",
      "repositories",
      "mode",
    ]);
  });

  it("drops the connect panels for a decided air-gapped re-run", () => {
    const shape: WizardShape = { target: "local", mode: "air-gapped" };
    // No live link -> core drops both connect steps, and the injected panels
    // are suppressed too: just target -> mode.
    expect(wizardViewIds(shape)).toEqual(["target", "mode"]);
  });

  it("keeps the connect panels for a decided azure-only re-run and drops the cribl step", () => {
    const shape: WizardShape = { target: "local", mode: "azure-only" };
    expect(wizardViewIds(shape)).toEqual([
      "target",
      "connect-azure",
      "preflight",
      "repositories",
      "mode",
    ]);
  });

  it("marks target and mode non-skippable and the middle screens skippable", () => {
    const views = wizardViews({ target: "local", mode: null });
    const byId = Object.fromEntries(views.map((v) => [v.id, v.skippable]));
    expect(byId["target"]).toBe(false);
    expect(byId["mode"]).toBe(false);
    expect(byId["leader-connect"]).toBe(true);
    expect(byId["connect-azure"]).toBe(true);
    expect(byId["preflight"]).toBe(true);
    expect(byId["repositories"]).toBe(true);
  });

  it("puts the injected panels in the connect phase", () => {
    const views = wizardViews({ target: "local", mode: null });
    const preflight = views.find((v) => v.id === "preflight");
    const repositories = views.find((v) => v.id === "repositories");
    expect(preflight?.phase).toBe("connect");
    expect(repositories?.phase).toBe("connect");
  });
});

describe("navigation", () => {
  const shape: WizardShape = { target: "local", mode: null };

  it("advances through the concrete list in order", () => {
    expect(nextViewId(shape, "target")).toBe("leader-connect");
    expect(nextViewId(shape, "connect-azure")).toBe("preflight");
    expect(nextViewId(shape, "preflight")).toBe("repositories");
    expect(nextViewId(shape, "repositories")).toBe("mode");
  });

  it("returns null past the final view and before the first", () => {
    expect(nextViewId(shape, "mode")).toBeNull();
    expect(previousViewId(shape, "target")).toBeNull();
  });

  it("steps backward through the list", () => {
    expect(previousViewId(shape, "mode")).toBe("repositories");
    expect(previousViewId(shape, "leader-connect")).toBe("target");
  });

  it("returns null for a view id that is not in the current list", () => {
    // upload-walkthrough belongs to the cribl-hosted target, not local.
    expect(nextViewId(shape, "upload-walkthrough")).toBeNull();
    expect(previousViewId(shape, "upload-walkthrough")).toBeNull();
  });

  it("marks the first and last views", () => {
    expect(isFirstView(shape, "target")).toBe(true);
    expect(isFirstView(shape, "leader-connect")).toBe(false);
    expect(isFinalView(shape, "mode")).toBe(true);
    expect(isFinalView(shape, "repositories")).toBe(false);
  });
});

describe("resolveCurrentViewId", () => {
  it("keeps a still-present view id", () => {
    const shape: WizardShape = { target: "local", mode: null };
    expect(resolveCurrentViewId(shape, "preflight")).toBe("preflight");
  });

  it("falls back to the first view when a target switch drops the current view", () => {
    // On cribl-hosted there is no leader-connect view; a cursor left there
    // clamps back to target rather than stranding on a missing screen.
    const shape: WizardShape = { target: "cribl-hosted", mode: null };
    expect(resolveCurrentViewId(shape, "leader-connect")).toBe("target");
  });
});

describe("wizardViewProgress", () => {
  it("lights the segments by phase, mapping the injected panels to Connect", () => {
    const at = (id: Parameters<typeof wizardViewProgress>[0]) =>
      wizardViewProgress(id).map((seg) => `${seg.phase}:${seg.status}`);
    expect(at("target")).toEqual([
      "target:current",
      "connect:upcoming",
      "mode:upcoming",
    ]);
    expect(at("preflight")).toEqual([
      "target:complete",
      "connect:current",
      "mode:upcoming",
    ]);
    expect(at("repositories")).toEqual([
      "target:complete",
      "connect:current",
      "mode:upcoming",
    ]);
    expect(at("mode")).toEqual([
      "target:complete",
      "connect:complete",
      "mode:current",
    ]);
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
  it("is blocked with a specific reason before the final view", () => {
    const gate = deriveGetStarted({
      isFinal: false,
      chosenMode: "full",
      modeAvailable: true,
    });
    expect(gate).toEqual({ ready: false, reason: GET_STARTED_NOT_FINAL_REASON });
  });

  it("is blocked on the final view until a mode is chosen", () => {
    const gate = deriveGetStarted({
      isFinal: true,
      chosenMode: null,
      modeAvailable: false,
    });
    expect(gate).toEqual({ ready: false, reason: GET_STARTED_NO_MODE_REASON });
  });

  it("is blocked when the chosen mode is not available", () => {
    const gate = deriveGetStarted({
      isFinal: true,
      chosenMode: "full",
      modeAvailable: false,
    });
    expect(gate).toEqual({
      ready: false,
      reason: GET_STARTED_MODE_UNAVAILABLE_REASON,
    });
  });

  it("is ready on the final view with an available chosen mode", () => {
    expect(
      deriveGetStarted({
        isFinal: true,
        chosenMode: "azure-only",
        modeAvailable: true,
      }),
    ).toEqual({ ready: true });
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
