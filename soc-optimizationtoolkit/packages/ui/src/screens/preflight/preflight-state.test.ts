import { describe, expect, it } from "vitest";
import { CRIBL_CAPABILITY_PROBES, REQUIRED_ACTIONS } from "@soc/core";
import type {
  AzurePreflight,
  CriblPreflight,
  SetupPath,
} from "@soc/core";
import {
  PREFLIGHT_NO_SWITCH_REASON,
  PREFLIGHT_RUNNING_REASON,
  type AzureSideState,
  type CriblSideState,
  deriveAzureDots,
  deriveCriblDots,
  derivePreflightView,
  dotStatusLabel,
  dotToneClass,
  preflightActions,
} from "./preflight-state";

// --- Fixture builders ------------------------------------------------------

const SETUP_PATH: SetupPath = "existing-rg";

/**
 * A fully granted Azure preflight (permissions read, every required action
 * granted, every probe ok) - the "ready" baseline tests override from.
 */
function azureReady(overrides: Partial<AzurePreflight> = {}): AzurePreflight {
  return {
    configured: true,
    setupPath: SETUP_PATH,
    scopeKind: "resource-group",
    scope: "/subscriptions/s/resourceGroups/rg",
    permissionsFetched: true,
    checks: REQUIRED_ACTIONS[SETUP_PATH].map((req) => ({
      action: req.action,
      label: req.label,
      granted: true,
    })),
    probes: [
      { name: "dcr-list", label: "List Data Collection Rules", status: "ok", detail: "access confirmed" },
    ],
    hasRequiredAccess: true,
    error: "",
    ...overrides,
  };
}

/** A local Cribl preflight with all required probes granted. */
function criblReady(overrides: Partial<CriblPreflight> = {}): CriblPreflight {
  return {
    mode: "local",
    workerGroup: "default",
    probes: CRIBL_CAPABILITY_PROBES.map((spec) => ({
      capability: spec.capability,
      label: spec.label,
      required: spec.required,
      status: "granted",
      detail: "access confirmed",
    })),
    hasRequiredAccess: true,
    error: "",
    ...overrides,
  };
}

function azureState(
  phase: AzureSideState["phase"],
  result: AzurePreflight | null,
): AzureSideState {
  return { phase, result };
}

function criblState(
  phase: CriblSideState["phase"],
  result: CriblPreflight | null,
): CriblSideState {
  return { phase, result };
}

// --- dot tone / label ------------------------------------------------------

describe("dotToneClass / dotStatusLabel", () => {
  it("maps every status to a distinct tone class", () => {
    const tones = new Set([
      dotToneClass("granted"),
      dotToneClass("missing"),
      dotToneClass("unknown"),
      dotToneClass("pending"),
    ]);
    expect(tones.size).toBe(4);
  });

  it("renders 'checking' for a pending dot", () => {
    expect(dotStatusLabel("pending")).toBe("checking");
    expect(dotStatusLabel("granted")).toBe("granted");
    expect(dotStatusLabel("missing")).toBe("missing");
    expect(dotStatusLabel("unknown")).toBe("unknown");
  });
});

// --- Azure dots ------------------------------------------------------------

describe("deriveAzureDots", () => {
  it("shows the required actions as pending dots while the side is running", () => {
    const dots = deriveAzureDots(azureState("pending", null), SETUP_PATH);
    expect(dots).toHaveLength(REQUIRED_ACTIONS[SETUP_PATH].length);
    expect(dots.every((d) => d.status === "pending")).toBe(true);
    expect(dots.every((d) => d.required)).toBe(true);
  });

  it("marks granted required actions and ok probes as granted", () => {
    const dots = deriveAzureDots(azureState("done", azureReady()), SETUP_PATH);
    const required = dots.filter((d) => d.required);
    expect(required.every((d) => d.status === "granted")).toBe(true);
    const probe = dots.find((d) => d.key === "probe:dcr-list");
    expect(probe?.status).toBe("granted");
    expect(probe?.required).toBe(false);
  });

  it("marks an ungranted required action as missing (write is not implied by read)", () => {
    const checks = REQUIRED_ACTIONS[SETUP_PATH].map((req, i) => ({
      action: req.action,
      label: req.label,
      granted: i > 0, // first required action denied
    }));
    const dots = deriveAzureDots(
      azureState("done", azureReady({ checks, hasRequiredAccess: false })),
      SETUP_PATH,
    );
    expect(dots[0].status).toBe("missing");
  });

  it("marks required actions as UNKNOWN (never missing) when permissions could not be read", () => {
    const state = azureState(
      "done",
      azureReady({
        permissionsFetched: false,
        hasRequiredAccess: false,
        error: "fetch RBAC permissions: HTTP 500",
        checks: REQUIRED_ACTIONS[SETUP_PATH].map((req) => ({
          action: req.action,
          label: req.label,
          granted: false,
        })),
      }),
    );
    const dots = deriveAzureDots(state, SETUP_PATH);
    const required = dots.filter((d) => d.required);
    expect(required.every((d) => d.status === "unknown")).toBe(true);
    expect(required.every((d) => d.status !== "missing")).toBe(true);
  });

  it("maps a denied probe to missing and an indeterminate probe to unknown", () => {
    const state = azureState(
      "done",
      azureReady({
        probes: [
          { name: "dcr-list", label: "List DCRs", status: "denied", detail: "HTTP 403" },
          { name: "workspace-get", label: "Read workspace", status: "unknown", detail: "HTTP 404" },
        ],
      }),
    );
    const dots = deriveAzureDots(state, SETUP_PATH);
    expect(dots.find((d) => d.key === "probe:dcr-list")?.status).toBe("missing");
    expect(dots.find((d) => d.key === "probe:workspace-get")?.status).toBe("unknown");
  });
});

// --- Cribl dots ------------------------------------------------------------

describe("deriveCriblDots", () => {
  it("shows the capability catalog as pending dots while running", () => {
    const dots = deriveCriblDots(criblState("pending", null));
    expect(dots).toHaveLength(CRIBL_CAPABILITY_PROBES.length);
    expect(dots.every((d) => d.status === "pending")).toBe(true);
  });

  it("maps granted/denied/unknown probe statuses straight through", () => {
    const result = criblReady({
      probes: [
        { capability: "packs", label: "Manage packs", required: true, status: "granted", detail: "ok" },
        { capability: "outputs", label: "Manage destinations", required: true, status: "denied", detail: "HTTP 403" },
        { capability: "inputs", label: "Manage sources", required: false, status: "unknown", detail: "boom" },
      ],
      hasRequiredAccess: false,
    });
    const dots = deriveCriblDots(criblState("done", result));
    expect(dots.find((d) => d.key === "packs")?.status).toBe("granted");
    expect(dots.find((d) => d.key === "outputs")?.status).toBe("missing");
    expect(dots.find((d) => d.key === "inputs")?.status).toBe("unknown");
  });
});

// --- Actions ---------------------------------------------------------------

describe("preflightActions", () => {
  it("disables retry and switch while a check is in flight", () => {
    const actions = preflightActions(true, true);
    expect(actions.canRetry).toBe(false);
    expect(actions.retryReason).toBe(PREFLIGHT_RUNNING_REASON);
    expect(actions.canSwitchAccount).toBe(false);
    expect(actions.switchAccountReason).toBe(PREFLIGHT_RUNNING_REASON);
  });

  it("enables both when idle and a switcher is wired", () => {
    const actions = preflightActions(false, true);
    expect(actions.canRetry).toBe(true);
    expect(actions.retryReason).toBeNull();
    expect(actions.canSwitchAccount).toBe(true);
    expect(actions.switchAccountReason).toBeNull();
  });

  it("keeps retry enabled but switch disabled with a reason when no switcher is wired", () => {
    const actions = preflightActions(false, false);
    expect(actions.canRetry).toBe(true);
    expect(actions.canSwitchAccount).toBe(false);
    expect(actions.switchAccountReason).toBe(PREFLIGHT_NO_SWITCH_REASON);
  });
});

// --- Combined view ---------------------------------------------------------

describe("derivePreflightView", () => {
  it("renders the OTHER side even while one side is still pending (partial results)", () => {
    const view = derivePreflightView({
      setupPath: SETUP_PATH,
      azure: azureState("done", azureReady()),
      cribl: criblState("pending", null),
      switchAccountAvailable: true,
    });
    // Azure resolved and renders its granted dots...
    expect(view.azure.checking).toBe(false);
    expect(view.azure.hasRequiredAccess).toBe(true);
    // ...while Cribl still shows pending dots, not a blank.
    expect(view.cribl.checking).toBe(true);
    expect(view.cribl.dots.every((d) => d.status === "pending")).toBe(true);
    expect(view.anyPending).toBe(true);
    expect(view.bothDone).toBe(false);
    expect(view.hasRequiredAccess).toBe(false);
    expect(view.summary).toBe("Checking required access...");
  });

  it("reports ready only when BOTH sides are done and granted", () => {
    const view = derivePreflightView({
      setupPath: SETUP_PATH,
      azure: azureState("done", azureReady()),
      cribl: criblState("done", criblReady()),
      switchAccountAvailable: true,
    });
    expect(view.bothDone).toBe(true);
    expect(view.hasRequiredAccess).toBe(true);
    expect(view.summary).toBe("All required access verified.");
  });

  it("Reader-only (all reads pass, writes denied) is NOT ready", () => {
    // Every effective-action check denied, but the read probes all pass -
    // read does not imply write, so the side (and the whole report) is not ready.
    const readerAzure = azureReady({
      permissionsFetched: true,
      hasRequiredAccess: false,
      checks: REQUIRED_ACTIONS[SETUP_PATH].map((req) => ({
        action: req.action,
        label: req.label,
        granted: false,
      })),
      probes: [
        { name: "dcr-list", label: "List Data Collection Rules", status: "ok", detail: "access confirmed" },
      ],
    });
    const view = derivePreflightView({
      setupPath: SETUP_PATH,
      azure: azureState("done", readerAzure),
      cribl: criblState("done", criblReady()),
      switchAccountAvailable: false,
    });
    expect(view.azure.hasRequiredAccess).toBe(false);
    // The read probe still renders granted (truth), but readiness is false.
    expect(view.azure.dots.find((d) => d.key === "probe:dcr-list")?.status).toBe("granted");
    expect(view.hasRequiredAccess).toBe(false);
    expect(view.summary).toContain("Missing required access");
    expect(view.summary).toContain("Azure:");
  });

  it("surfaces a not-configured Azure side honestly without blanking Cribl", () => {
    const notConfigured = azureReady({
      configured: false,
      permissionsFetched: false,
      hasRequiredAccess: false,
      error: "No resource group configured",
      probes: [],
    });
    const view = derivePreflightView({
      setupPath: SETUP_PATH,
      azure: azureState("done", notConfigured),
      cribl: criblState("done", criblReady()),
      switchAccountAvailable: true,
    });
    expect(view.azure.note).toBe("No resource group configured");
    expect(view.cribl.hasRequiredAccess).toBe(true);
    expect(view.summary).toContain("Azure: No resource group configured");
  });

  it("carries the granted-roles decoration through per side", () => {
    const view = derivePreflightView({
      setupPath: SETUP_PATH,
      azure: azureState("done", azureReady()),
      cribl: criblState("done", criblReady()),
      switchAccountAvailable: true,
      grantedRoles: { azure: ["Monitoring Contributor"], cribl: ["admin"] },
    });
    expect(view.azure.grantedRoles).toEqual(["Monitoring Contributor"]);
    expect(view.cribl.grantedRoles).toEqual(["admin"]);
  });

  it("names the readiness field distinctly from canDeploy (never conflated)", () => {
    const view = derivePreflightView({
      setupPath: SETUP_PATH,
      azure: azureState("done", azureReady()),
      cribl: criblState("done", criblReady()),
      switchAccountAvailable: true,
    });
    // The verdict is exposed as hasRequiredAccess; there is no canDeploy here.
    expect(view).toHaveProperty("hasRequiredAccess");
    expect(view).not.toHaveProperty("canDeploy");
  });
});
