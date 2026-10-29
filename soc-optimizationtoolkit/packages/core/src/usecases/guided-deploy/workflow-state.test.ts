import { describe, expect, it } from "vitest";
import {
  canDeploy as integrateCanDeploy,
  type SectionInputs,
} from "../../domain/integrate-arc";
import {
  canDeployContentPathInMode,
  canDeployInMode,
  canWireSource,
  deployModeGating,
  deriveGuidedWorkflow,
  readinessPillsForMode,
  type DeployMode,
} from "./workflow-state";

const READY: SectionInputs = {
  solutionSelected: false,
  scopeCommitted: true,
  workerGroupSelected: true,
  packNameSet: true,
  deployCompleted: false,
  samplesProvided: false,
};

describe("deployModeGating (SentinelIntegration.tsx 920-921 verbatim)", () => {
  it("maps each mode to its skip flags", () => {
    expect(deployModeGating("full")).toEqual({ skipAzure: false, skipCribl: false });
    expect(deployModeGating("air-gapped")).toEqual({ skipAzure: true, skipCribl: true });
    expect(deployModeGating("azure-only")).toEqual({ skipAzure: false, skipCribl: true });
    expect(deployModeGating("cribl-only")).toEqual({ skipAzure: true, skipCribl: false });
  });
});

describe("canDeployInMode - additive, never weakens the native MVP rule", () => {
  it("mode 'full' is IDENTICAL to integrate-arc canDeploy (MVP-transition rule preserved)", () => {
    const cases: SectionInputs[] = [
      READY,
      { ...READY, scopeCommitted: false },
      { ...READY, workerGroupSelected: false },
      { ...READY, packNameSet: false },
      { ...READY, samplesProvided: true, solutionSelected: true },
    ];
    for (const inputs of cases) {
      expect(canDeployInMode(inputs, "full")).toBe(integrateCanDeploy(inputs));
    }
  });

  it("air-gapped relaxes BOTH sides: needs only a pack name", () => {
    const noConnections: SectionInputs = {
      ...READY,
      scopeCommitted: false,
      workerGroupSelected: false,
    };
    expect(canDeployInMode(noConnections, "air-gapped")).toBe(true);
    expect(canDeployInMode({ ...noConnections, packNameSet: false }, "air-gapped")).toBe(
      false,
    );
  });

  it("azure-only needs scope + pack (NOT a worker group)", () => {
    expect(
      canDeployInMode({ ...READY, workerGroupSelected: false }, "azure-only"),
    ).toBe(true);
    expect(
      canDeployInMode({ ...READY, scopeCommitted: false }, "azure-only"),
    ).toBe(false);
  });

  it("cribl-only needs a worker group + pack (NOT a committed scope)", () => {
    expect(
      canDeployInMode({ ...READY, scopeCommitted: false }, "cribl-only"),
    ).toBe(true);
    expect(
      canDeployInMode({ ...READY, workerGroupSelected: false }, "cribl-only"),
    ).toBe(false);
  });
});

describe("canDeployContentPathInMode", () => {
  it("adds mapping approval on top of the mode gate", () => {
    const approved = { ...READY, mappingsApproved: true };
    expect(canDeployContentPathInMode(approved, "full")).toBe(true);
    expect(canDeployContentPathInMode(READY, "full")).toBe(false);
    // Air-gapped content path: relaxed connections + approved mappings.
    const airgap = {
      ...READY,
      scopeCommitted: false,
      workerGroupSelected: false,
      mappingsApproved: true,
    };
    expect(canDeployContentPathInMode(airgap, "air-gapped")).toBe(true);
  });
});

describe("canWireSource", () => {
  it("unlocks after deploy completes, only when Cribl is not skipped", () => {
    expect(canWireSource(true, "full")).toBe(true);
    expect(canWireSource(true, "cribl-only")).toBe(true);
    expect(canWireSource(false, "full")).toBe(false);
    // Cribl skipped -> no source to wire.
    expect(canWireSource(true, "azure-only")).toBe(false);
    expect(canWireSource(true, "air-gapped")).toBe(false);
  });
});

describe("existing destination picked (GEN-21)", () => {
  const PICKED: SectionInputs = {
    ...READY,
    scopeCommitted: false,
    existingDestination: "PAN-CSL",
  };

  it("deploys without a committed scope in every mode that keeps Cribl", () => {
    expect(canDeployInMode(PICKED, "full")).toBe(true);
    expect(canDeployInMode(PICKED, "cribl-only")).toBe(true);
    // The pick does not stand in for a worker group or a pack name.
    expect(canDeployInMode({ ...PICKED, workerGroupSelected: false }, "full")).toBe(false);
    expect(canDeployInMode({ ...PICKED, packNameSet: false }, "cribl-only")).toBe(false);
  });

  it("keeps the scope requirement in azure-only: a Cribl destination is not a scope", () => {
    // azure-only skips Cribl, so the run is nothing but the Azure writes the
    // scope addresses; a stale pick must not unlock them without one.
    expect(canDeployInMode(PICKED, "azure-only")).toBe(false);
    expect(
      canDeployInMode({ ...PICKED, scopeCommitted: true }, "azure-only"),
    ).toBe(true);
  });

  it("keeps the content path a superset: approval still gates it", () => {
    expect(canDeployContentPathInMode(PICKED, "full")).toBe(false);
    expect(
      canDeployContentPathInMode({ ...PICKED, mappingsApproved: true }, "full"),
    ).toBe(true);
  });

  it("unlocks wiring from an installed pack with a picked destination, with no deploy run", () => {
    expect(canWireSource(false, "full", true)).toBe(true);
    expect(canWireSource(false, "cribl-only", true)).toBe(true);
    // Cribl skipped still means no source to wire.
    expect(canWireSource(false, "azure-only", true)).toBe(false);
    expect(canWireSource(false, "air-gapped", true)).toBe(false);
    // Neither driver: still locked.
    expect(canWireSource(false, "full", false)).toBe(false);
    expect(canWireSource(false, "full")).toBe(false);
  });

  it("keeps the Workspace pill in azure-only, where the pick does not lift the scope", () => {
    // Without this the footer showed no missing prerequisite while Deploy
    // stayed disabled for the scope.
    expect(readinessPillsForMode(PICKED, "azure-only").map((p) => [p.id, p.state])).toEqual([
      ["solution", readinessPillsForMode(READY, "azure-only")[0]?.state],
      ["samples", readinessPillsForMode(READY, "azure-only")[1]?.state],
      ["mappings", readinessPillsForMode(READY, "azure-only")[2]?.state],
      ["workspace", "missing"],
      ["pack-name", "ok"],
    ]);
    // Where Cribl is in the run the pick does replace the scope: no pill.
    expect(readinessPillsForMode(PICKED, "full").map((p) => p.id)).toEqual([
      "solution",
      "samples",
      "mappings",
      "worker-groups",
      "pack-name",
    ]);
  });

  it("deriveGuidedWorkflow counts an installed pack only when a destination is picked", () => {
    expect(deriveGuidedWorkflow(PICKED, "full", true).canWireSource).toBe(true);
    expect(deriveGuidedWorkflow(PICKED, "full").canWireSource).toBe(false);
    expect(deriveGuidedWorkflow(READY, "full", true).canWireSource).toBe(false);
  });
});

describe("readinessPillsForMode", () => {
  it("hides the Workspace pill when Azure is skipped and Worker Groups when Cribl is skipped", () => {
    const airgap = readinessPillsForMode(READY, "air-gapped").map((p) => p.id);
    expect(airgap).not.toContain("workspace");
    expect(airgap).not.toContain("worker-groups");
    expect(airgap).toContain("pack-name");

    const full = readinessPillsForMode(READY, "full").map((p) => p.id);
    expect(full).toContain("workspace");
    expect(full).toContain("worker-groups");
  });
});

describe("deriveGuidedWorkflow", () => {
  it("bundles the mode-aware gates and pills", () => {
    const modes: DeployMode[] = ["full", "azure-only", "cribl-only", "air-gapped"];
    for (const mode of modes) {
      const state = deriveGuidedWorkflow({ ...READY, deployCompleted: true }, mode);
      expect(state.mode).toBe(mode);
      expect(state.gating).toEqual(deployModeGating(mode));
      expect(state.canDeploy).toBe(canDeployInMode({ ...READY, deployCompleted: true }, mode));
      expect(state.canWireSource).toBe(canWireSource(true, mode));
    }
  });
});
