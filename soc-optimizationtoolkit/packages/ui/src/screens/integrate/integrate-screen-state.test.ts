/**
 * Tests for the Integrate screen's pure decisions. The section/pill/deploy
 * decisions themselves are pinned in @soc/core's integrate-arc tests; these
 * pin the BINDING layer this screen adds: raw-value -> SectionInputs
 * reduction, the pack-name prefill, and the deploy-disabled hint threaded to
 * the readiness footer.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CRIBL_OPTIONS, canDeploy } from "@soc/core";
import type { CriblOptions } from "@soc/core";
import {
  FALLBACK_PACK_NAME,
  INTEGRATE_DEFAULT_TABLE,
  defaultPackName,
  deployDisabledReason,
  deriveSectionInputs,
} from "./integrate-screen-state";

describe("deriveSectionInputs", () => {
  it("passes solution, scope and deploy flags through and reduces the text fields to booleans", () => {
    const inputs = deriveSectionInputs({
      solutionSelected: true,
      scopeCommitted: true,
      workerGroup: "prod",
      packName: "MyPack",
      deployCompleted: true,
      sampleCount: 2,
    });
    expect(inputs).toEqual({
      solutionSelected: true,
      scopeCommitted: true,
      workerGroupSelected: true,
      packNameSet: true,
      deployCompleted: true,
      samplesProvided: true,
    });
  });

  it("treats whitespace-only worker-group and pack-name as unset, and a zero sample count as no samples", () => {
    const inputs = deriveSectionInputs({
      solutionSelected: false,
      scopeCommitted: false,
      workerGroup: "   ",
      packName: "\t \n",
      deployCompleted: false,
      sampleCount: 0,
    });
    expect(inputs.solutionSelected).toBe(false);
    expect(inputs.workerGroupSelected).toBe(false);
    expect(inputs.packNameSet).toBe(false);
    expect(inputs.samplesProvided).toBe(false);
  });

  it("produces inputs that make canDeploy true only when all three built prerequisites are set - solution and samples never participate", () => {
    const base = {
      solutionSelected: false,
      scopeCommitted: true,
      workerGroup: "prod",
      packName: "Pack",
      deployCompleted: false,
      sampleCount: 0,
    };
    // canDeploy is true with zero samples (the native-table deploy rule) ...
    expect(canDeploy(deriveSectionInputs(base))).toBe(true);
    // ... and stays true with samples; samplesProvided does not gate deploy.
    expect(canDeploy(deriveSectionInputs({ ...base, sampleCount: 3 }))).toBe(true);
    expect(canDeploy(deriveSectionInputs({ ...base, scopeCommitted: false }))).toBe(
      false,
    );
    expect(canDeploy(deriveSectionInputs({ ...base, workerGroup: "" }))).toBe(false);
    expect(canDeploy(deriveSectionInputs({ ...base, packName: "  " }))).toBe(false);
  });
});

describe("defaultPackName", () => {
  it("trims the trailing separator from the persisted destination prefix", () => {
    expect(defaultPackName(DEFAULT_CRIBL_OPTIONS)).toBe("MS-Sentinel");
  });

  it("uses a custom prefix verbatim after trimming separators", () => {
    const cribl: CriblOptions = {
      destinationPrefix: "Acme-",
      destinationSuffix: "-dest",
      workerGroup: "",
    };
    expect(defaultPackName(cribl)).toBe("Acme");
  });

  it("falls back to a stable name when no prefix is configured", () => {
    const cribl: CriblOptions = {
      destinationPrefix: "  -_ ",
      destinationSuffix: "",
      workerGroup: "",
    };
    expect(defaultPackName(cribl)).toBe(FALLBACK_PACK_NAME);
    expect(defaultPackName(undefined)).toBe(FALLBACK_PACK_NAME);
  });

  it("never returns an empty string, so the pack-name prerequisite starts satisfied", () => {
    expect(defaultPackName(DEFAULT_CRIBL_OPTIONS).trim()).not.toBe("");
  });
});

describe("deployDisabledReason", () => {
  const set = {
    // Solution deliberately unselected: like samples, it never affects the
    // native-deploy gate.
    solutionSelected: false,
    scopeCommitted: true,
    workerGroupSelected: true,
    packNameSet: true,
    deployCompleted: false,
    // Samples deliberately absent: they never affect the native-deploy gate.
    samplesProvided: false,
  };

  it("is null when the operable deploy can run", () => {
    expect(deployDisabledReason(set)).toBeNull();
  });

  it("stays null after a completed run (deploy is re-runnable)", () => {
    expect(deployDisabledReason({ ...set, deployCompleted: true })).toBeNull();
  });

  it("names the single missing prerequisite in dependency order", () => {
    expect(deployDisabledReason({ ...set, scopeCommitted: false })).toMatch(
      /Azure target/i,
    );
    expect(
      deployDisabledReason({ ...set, scopeCommitted: false, workerGroupSelected: false }),
    ).toMatch(/Azure target/i);
    expect(deployDisabledReason({ ...set, workerGroupSelected: false })).toMatch(
      /worker group/i,
    );
    expect(deployDisabledReason({ ...set, packNameSet: false })).toMatch(/pack name/i);
  });
});

describe("INTEGRATE_DEFAULT_TABLE", () => {
  it("is the validated native table", () => {
    expect(INTEGRATE_DEFAULT_TABLE).toBe("SecurityEvent");
  });
});
