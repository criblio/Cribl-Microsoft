/**
 * Pins for the shipped ingestion-classification lookup (2026-07-15): the
 * generated map resolves known solutions and normalizes punctuation; unknown
 * names return null (caller falls back to the live classification).
 */

import { describe, expect, it } from "vitest";
import {
  SOLUTION_INGESTION_ENTRIES,
  ingestionTierReason,
  lookupSolutionIngestion,
} from "./ingestion-classification";

describe("lookupSolutionIngestion", () => {
  it("resolves a known CCF Push solution as recommended", () => {
    const hit = lookupSolutionIngestion("AbnormalSecurity");
    expect(hit).not.toBeNull();
    expect(hit?.tier).toBe("recommended");
    expect(hit?.kind).toBe("Push");
  });

  it("resolves a known RestApiPoller solution as supported", () => {
    expect(lookupSolutionIngestion("1Password")?.tier).toBe("supported");
  });

  it("matches by normalized name (punctuation/casing tolerant)", () => {
    // "1Password" stored; a punctuation/casing variant still resolves.
    expect(lookupSolutionIngestion("1password")?.tier).toBe("supported");
  });

  it("returns null for a solution not in the shipped map", () => {
    expect(lookupSolutionIngestion("No Such Solution ZZZ 9999")).toBeNull();
  });
});

describe("ingestionTierReason", () => {
  it("mentions the kind for a supported CCF pull connector", () => {
    expect(ingestionTierReason("supported", "RestApiPoller")).toContain("RestApiPoller");
  });

  it("gives a Push-specific reason for recommended", () => {
    expect(ingestionTierReason("recommended", "Push").toLowerCase()).toContain("push");
  });
});

describe("SOLUTION_INGESTION_ENTRIES (2026-07-29 offline enumeration)", () => {
  it("lists the shipped catalog sorted case-insensitively", () => {
    expect(SOLUTION_INGESTION_ENTRIES.length).toBeGreaterThanOrEqual(400);
    const names = SOLUTION_INGESTION_ENTRIES.map((e) => e.name.toLowerCase());
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it("carries tier and kind per entry", () => {
    const abnormal = SOLUTION_INGESTION_ENTRIES.find(
      (e) => e.name === "AbnormalSecurity",
    );
    expect(abnormal).toEqual({
      name: "AbnormalSecurity",
      tier: "recommended",
      kind: "Push",
    });
    for (const entry of SOLUTION_INGESTION_ENTRIES) {
      expect(["recommended", "supported", "legacy"]).toContain(entry.tier);
      expect(typeof entry.kind).toBe("string");
    }
  });
});
