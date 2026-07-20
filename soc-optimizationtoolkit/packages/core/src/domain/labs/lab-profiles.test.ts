import { describe, expect, it } from "vitest";
import {
  LAB_PHASES,
  LAB_PROFILES,
  LAB_TYPES,
  isLabPhaseRequired,
  labDeploymentConfig,
  requiredLabPhases,
} from "./lab-profiles";

describe("labDeploymentConfig", () => {
  it("resolves every preset with its legacy ResourceGroupSuffix", () => {
    for (const type of LAB_TYPES) {
      const flags = labDeploymentConfig(type, "public");
      expect(flags.resourceGroupSuffix).toBe(type);
    }
  });

  it("CompleteLab deploys everything (legacy option 1)", () => {
    const flags = labDeploymentConfig("CompleteLab", "public");
    expect(flags.infrastructure).toEqual({
      deployVNet: true,
      deployNSGs: true,
      deployVPN: true,
    });
    expect(flags.storage.deploy).toBe(true);
    expect(flags.monitoring.deploySentinel).toBe(true);
    expect(flags.analytics.deployADX).toBe(true);
    expect(flags.virtualMachines.deployVMs).toBe(true);
    // Private endpoints follow the mode, not the preset.
    expect(flags.storage.deployPrivateEndpoints).toBe(false);
    expect(labDeploymentConfig("CompleteLab", "private").storage.deployPrivateEndpoints).toBe(true);
  });

  it("SentinelLab deploys networking only in private mode (legacy conditional)", () => {
    const publicLab = labDeploymentConfig("SentinelLab", "public");
    expect(publicLab.infrastructure.deployVNet).toBe(false);
    expect(publicLab.monitoring.deployLogAnalytics).toBe(true);
    expect(publicLab.monitoring.deployDCRs).toBe(true);

    const privateLab = labDeploymentConfig("SentinelLab", "private");
    expect(privateLab.infrastructure.deployVNet).toBe(true);
    expect(privateLab.infrastructure.deployVPN).toBe(true);
    expect(privateLab.monitoring.deployPrivateLink).toBe(true);
  });

  it("BlobCollectorLab keeps the legacy GenerateSampleData marker", () => {
    expect(
      labDeploymentConfig("BlobCollectorLab", "public").storage.generateSampleData,
    ).toBe(true);
  });

  it("BasicInfrastructure is networking only", () => {
    const flags = labDeploymentConfig("BasicInfrastructure", "public");
    expect(flags.infrastructure.deployVPN).toBe(true);
    expect(flags.storage.deploy).toBe(false);
    expect(flags.monitoring.deployLogAnalytics).toBe(false);
    expect(flags.analytics.deployEventHub).toBe(false);
  });
});

describe("LAB_PROFILES", () => {
  it("lists all 8 presets in legacy menu order", () => {
    expect(LAB_PROFILES.map((p) => p.id)).toEqual([...LAB_TYPES]);
  });
});

describe("isLabPhaseRequired (legacy Test-PhaseRequired)", () => {
  it("runs only the specific phase when one is requested", () => {
    const flags = labDeploymentConfig("CompleteLab", "public");
    expect(isLabPhaseRequired(4, flags, 4)).toBe(true);
    expect(isLabPhaseRequired(1, flags, 4)).toBe(false);
  });

  it("runs everything with null flags (non-interactive fallback)", () => {
    for (const phase of LAB_PHASES) {
      expect(isLabPhaseRequired(phase.number, null)).toBe(true);
    }
  });

  it("always runs phase 1 (Foundation)", () => {
    const flags = labDeploymentConfig("EventHubLab", "public");
    expect(isLabPhaseRequired(1, flags)).toBe(true);
  });

  it("gates phase 9 (Integration) on any resource deployment", () => {
    expect(isLabPhaseRequired(9, labDeploymentConfig("EventHubLab", "public"))).toBe(true);
    expect(isLabPhaseRequired(9, labDeploymentConfig("BasicInfrastructure", "public"))).toBe(false);
  });
});

describe("requiredLabPhases", () => {
  it("SentinelLab (public) runs Foundation, Monitoring, Data Collection, Integration", () => {
    const phases = requiredLabPhases(labDeploymentConfig("SentinelLab", "public"));
    expect(phases.map((p) => p.number)).toEqual([1, 4, 8, 9]);
  });

  it("CompleteLab (public) runs all ten phases", () => {
    const phases = requiredLabPhases(labDeploymentConfig("CompleteLab", "public"));
    expect(phases.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("BlobQueueLab (public) runs Foundation, Storage, Integration", () => {
    const phases = requiredLabPhases(labDeploymentConfig("BlobQueueLab", "public"));
    expect(phases.map((p) => p.number)).toEqual([1, 2, 9]);
  });

  it("preserves the legacy execution order: Storage (2) before Networking (3)", () => {
    const phases = requiredLabPhases(labDeploymentConfig("FlowLogLab", "public"));
    const storageIndex = phases.findIndex((p) => p.title === "Storage");
    const networkingIndex = phases.findIndex((p) => p.title === "Networking");
    expect(storageIndex).toBeGreaterThanOrEqual(0);
    expect(networkingIndex).toBeGreaterThan(storageIndex);
  });
});
