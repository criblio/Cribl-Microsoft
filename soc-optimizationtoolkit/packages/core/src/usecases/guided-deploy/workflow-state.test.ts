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
