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
  sectionSummary,
} from "./integrate-screen-state";
import type { SectionSummaryFacts } from "./integrate-screen-state";

describe("deriveSectionInputs", () => {
  it("passes solution, scope and deploy flags through and reduces the text fields to booleans", () => {
    const inputs = deriveSectionInputs({
      solutionSelected: true,
      scopeCommitted: true,
      workerGroup: "prod",
      packName: "MyPack",
      deployCompleted: true,
      sampleCount: 2,
      mappingsApproved: true,
    });
    expect(inputs).toEqual({
      solutionSelected: true,
      scopeCommitted: true,
      workerGroupSelected: true,
      packNameSet: true,
      deployCompleted: true,
      samplesProvided: true,
      mappingsApproved: true,
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
      mappingsApproved: false,
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
      mappingsApproved: false,
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

  it("NARROWS the prefix by the selected solution", () => {
    // The 2026-08-11 report: one prefix meant one pack name for every
    // solution, so a second solution's build landed on the first one's pack.
    expect(defaultPackName(DEFAULT_CRIBL_OPTIONS, "Gigamon Connector")).toBe(
      "MS-Sentinel-Gigamon",
    );
    expect(defaultPackName(DEFAULT_CRIBL_OPTIONS, "Cloudflare")).toBe(
      "MS-Sentinel-Cloudflare",
    );
  });

  it("gives two solutions two names, from the same prefix", () => {
    // Stated as the property rather than as two literals: the point is that
    // they DIFFER, and a future change to the vendor shortener must not be
    // able to collapse them while still matching a hard-coded pair.
    const a = defaultPackName(DEFAULT_CRIBL_OPTIONS, "Gigamon Connector");
    const b = defaultPackName(DEFAULT_CRIBL_OPTIONS, "Cloudflare");
    expect(a).not.toBe(b);
  });

  it("is unchanged when no solution is selected yet", () => {
    // The prefill must stay non-empty before a solution is chosen - the
    // pack-name prerequisite is satisfied by default, and that still holds.
    expect(defaultPackName(DEFAULT_CRIBL_OPTIONS)).toBe("MS-Sentinel");
    expect(defaultPackName(DEFAULT_CRIBL_OPTIONS, "")).toBe("MS-Sentinel");
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

describe("sectionSummary (DBT-127)", () => {
  const facts: SectionSummaryFacts = {
    solutionName: "PaloAlto-PAN-OS",
    sampleLogTypes: ["THREAT", "TRAFFIC"],
    analyzedLogTypes: 2,
    mappingsApproved: false,
    scopeCommitted: true,
    workspaceName: "law-jpederson-eastus",
    workerGroup: "default",
    packName: "MS-Sentinel-PaloAlto-PAN",
    deployCompleted: false,
  };

  it("says what was chosen in each section, in a few words", () => {
    expect(
      Object.fromEntries(
        (
          [
            "solution",
            "sample-data",
            "gap-analysis",
            "azure-resources",
            "cribl-config",
            "deploy",
          ] as const
        ).map((id) => [id, sectionSummary(id, facts)]),
      ),
    ).toEqual({
      solution: "PaloAlto-PAN-OS",
      "sample-data": "2 samples: THREAT, TRAFFIC",
      "gap-analysis": "2 log types analyzed - not yet approved",
      "azure-resources": "law-jpederson-eastus",
      "cribl-config": "MS-Sentinel-PaloAlto-PAN in default",
      deploy: "not deployed yet",
    });
  });

  it("states the unfinished case rather than going blank", () => {
    const empty: SectionSummaryFacts = {
      solutionName: "",
      sampleLogTypes: [],
      analyzedLogTypes: 0,
      mappingsApproved: false,
      scopeCommitted: false,
      workspaceName: "",
      workerGroup: "",
      packName: "",
      deployCompleted: false,
    };
    expect(sectionSummary("solution", empty)).toBe("no solution selected");
    expect(sectionSummary("sample-data", empty)).toBe("no samples");
    expect(sectionSummary("gap-analysis", empty)).toBe("not analyzed");
    expect(sectionSummary("azure-resources", empty)).toBe("no target committed");
    expect(sectionSummary("cribl-config", empty)).toBe("not configured");
  });

  it("caps a long sample list instead of running off the line", () => {
    const many = { ...facts, sampleLogTypes: ["a", "b", "c", "d", "e"] };
    expect(sectionSummary("sample-data", many)).toBe("5 samples: a, b, c and 2 more");
    expect(sectionSummary("sample-data", { ...facts, sampleLogTypes: ["a"] })).toBe(
      "1 sample: a",
    );
  });

  it("reads approved and deployed once they are", () => {
    const done = { ...facts, mappingsApproved: true, deployCompleted: true };
    expect(sectionSummary("gap-analysis", done)).toBe("2 log types analyzed - approved");
    expect(sectionSummary("deploy", done)).toBe("deployed");
  });

  it("has nothing to summarize for the read-only coverage and content sections", () => {
    expect(sectionSummary("rule-coverage", facts)).toBe("");
    expect(sectionSummary("workbook-coverage", facts)).toBe("");
    expect(sectionSummary("enable-content", facts)).toBe("");
  });
});
