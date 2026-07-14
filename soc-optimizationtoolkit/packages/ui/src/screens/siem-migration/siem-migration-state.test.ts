/**
 * Pins for the SIEM Migration screen's pure projections (Unit 26): the five
 * legacy stat tiles, the mapped/unmapped split, confidence tones, and the
 * ~v1 persistence key contract.
 */

import { describe, expect, it } from "vitest";
import type { IdentifiedDataSource, MigrationPlan } from "@soc/core";
import {
  SIEM_MIGRATION_PLAN_KEY,
  confidenceTone,
  identifierSummary,
  mappedSources,
  migrationStatTiles,
  unmappedSources,
} from "./siem-migration-state";

function source(over: Partial<IdentifiedDataSource>): IdentifiedDataSource {
  return {
    id: "src",
    name: "src",
    platform: "splunk",
    platformIdentifiers: ["src"],
    ruleCount: 1,
    rules: ["r"],
    mitreTactics: [],
    mitreTechniques: [],
    sentinelSolution: "",
    sentinelTable: "",
    confidence: "none",
    sentinelAnalyticRules: [],
    ...over,
  };
}

const PLAN: MigrationPlan = {
  platform: "splunk",
  fileName: "x.json",
  totalRules: 5,
  enabledRules: 5,
  buildingBlocks: 0,
  dataSources: [
    source({ id: "a", sentinelSolution: "Okta Single Sign-On", confidence: "high" }),
    source({ id: "b" }),
  ],
  unmappedRules: [],
  mitreCoverage: [],
  totalSentinelRules: 3,
};

describe("siem-migration state", () => {
  it("keeps the persistence key stable (bounce-back contract)", () => {
    expect(SIEM_MIGRATION_PLAN_KEY).toBe("siem-migration-plan~v1");
  });

  it("derives the five legacy tiles with legacy tones", () => {
    const tiles = migrationStatTiles(PLAN);
    expect(tiles.map((t) => `${t.label}=${t.value}`)).toEqual([
      "Detection Rules=5",
      "Data Sources=2",
      "Mapped=1",
      "Unmapped=1",
      "Sentinel Rules=3",
    ]);
    expect(tiles.find((t) => t.key === "mapped")?.tone).toBe("ok");
    expect(tiles.find((t) => t.key === "unmapped")?.tone).toBe("warn");
  });

  it("splits mapped vs unmapped on the solution being present", () => {
    expect(mappedSources(PLAN).map((d) => d.id)).toEqual(["a"]);
    expect(unmappedSources(PLAN).map((d) => d.id)).toEqual(["b"]);
  });

  it("tones confidences like the legacy badges", () => {
    expect(confidenceTone("high")).toBe("ok");
    expect(confidenceTone("medium")).toBe("info");
    expect(confidenceTone("low")).toBe("warn");
    expect(confidenceTone("none")).toBe("neutral");
  });

  it("summarizes identifiers with a +N tail", () => {
    const ds = source({ platformIdentifiers: ["a", "b", "c", "d", "e"] });
    expect(identifierSummary(ds)).toBe("a, b, c +2");
    expect(identifierSummary(source({ platformIdentifiers: ["only"] }))).toBe("only");
  });
});
