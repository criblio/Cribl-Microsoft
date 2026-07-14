/**
 * The shared content-reference analyzer (porting-plan Unit 23 task items 1, 4,
 * 5). Pins the THREE-WAY classification (covered / missing-from-reduced-schema
 * / unknown), the case-insensitive availability match with rule-casing
 * preserved, coverage math, frequency ranking, the KEPT Unit 18
 * ruleReferencedFields contract (schema-resolvable only), and the NO-STALE-SKIP
 * behavior on an empty availability set. Alert rules and workbooks are shown
 * flowing through the SAME engine.
 */

import { describe, expect, it } from "vitest";

import {
  analyzeContentCoverage,
  shouldRerunCoverage,
} from "./analyze-coverage";
import type { ContentItem } from "./models";

const SCHEMA_UNION = [
  "SourceIP",
  "DestinationIP",
  "DeviceName",
  "IPAddress",
  "UserPrincipalName",
];

// availability carries a DIFFERENT CASING of SourceIP to prove the match is
// case-insensitive while the reported field keeps the rule's casing.
const AVAILABLE = ["sourceip", "DeviceName"];

const ruleA: ContentItem = {
  type: "alert-rule",
  id: "A",
  name: "Rule A",
  severity: "High",
  queries: ["T | project SourceIP, DestinationIP, IPAddress, MysteryField"],
};
const ruleB: ContentItem = {
  type: "alert-rule",
  id: "B",
  name: "Rule B",
  severity: "Medium",
  queries: ["T | project DestinationIP, DeviceName"],
};
const ruleC: ContentItem = {
  type: "alert-rule",
  id: "C",
  name: "Rule C",
  severity: "Low",
  queries: ["T | project SourceIP"],
};

describe("three-way per-item classification", () => {
  const report = analyzeContentCoverage({
    items: [ruleA, ruleB, ruleC],
    availableFields: AVAILABLE,
    schemaUnion: SCHEMA_UNION,
  });
  const a = report.items[0];

  it("covers an available field, casing PRESERVED from the rule", () => {
    expect(a.covered).toContain("SourceIP"); // not the available 'sourceip'
  });

  it("marks a schema column that is not available as missing-from-reduced-schema", () => {
    expect(a.missingFromReducedSchema).toContain("DestinationIP");
    expect(a.missingFromReducedSchema).toContain("IPAddress");
  });

  it("marks a non-schema field as unknown (SURFACED, not dropped)", () => {
    expect(a.unknown).toContain("MysteryField");
  });

  it("computes coverage as covered / (covered + missing), unknown excluded", () => {
    // A: covered {SourceIP}=1, missing {DestinationIP, IPAddress}=2 -> 1/3.
    expect(a.coverage).toBeCloseTo(1 / 3, 10);
  });
});

describe("summary aggregation", () => {
  const report = analyzeContentCoverage({
    items: [ruleA, ruleB, ruleC],
    availableFields: AVAILABLE,
    schemaUnion: SCHEMA_UNION,
  });

  it("counts fully vs partially covered items", () => {
    expect(report.summary.totalItems).toBe(3);
    expect(report.summary.fullyCovered).toBe(1); // Rule C
    expect(report.summary.partiallyCovered).toBe(2); // A and B
  });

  it("ranks missing fields by reference FREQUENCY (most-needed first)", () => {
    // DestinationIP missing in A and B (2); IPAddress missing in A only (1).
    expect(report.summary.missingFieldsAcrossRules).toEqual([
      "DestinationIP",
      "IPAddress",
    ]);
  });

  it("ruleReferencedFields holds only SCHEMA-RESOLVABLE fields (Unit 18 contract)", () => {
    // Union of covered+missing across items, sorted; NEVER an unknown field.
    expect(report.summary.ruleReferencedFields).toEqual([
      "DestinationIP",
      "DeviceName",
      "IPAddress",
      "SourceIP",
    ]);
    expect(report.summary.ruleReferencedFields).not.toContain("MysteryField");
  });
});

describe("entity extraFields participate in extraction", () => {
  it("unions entity columns into the referenced fields", () => {
    const rule: ContentItem = {
      type: "alert-rule",
      id: "E",
      name: "Rule E",
      queries: ["T | project SourceIP"],
      extraFields: ["UserPrincipalName"],
    };
    const report = analyzeContentCoverage({
      items: [rule],
      availableFields: [],
      schemaUnion: SCHEMA_UNION,
    });
    expect(report.items[0].referencedFields).toContain("UserPrincipalName");
    expect(report.items[0].missingFromReducedSchema).toContain(
      "UserPrincipalName",
    );
  });
});

describe("NO STALE-SKIP: runs on an empty availability set (Unit 23 item 5)", () => {
  it("classifies every schema field as missing when nothing is available", () => {
    const report = analyzeContentCoverage({
      items: [ruleB],
      availableFields: [], // legacy UI would have SKIPPED the re-run here
      schemaUnion: SCHEMA_UNION,
    });
    const b = report.items[0];
    expect(b.covered).toEqual([]);
    expect(b.missingFromReducedSchema).toEqual(["DestinationIP", "DeviceName"]);
    expect(b.coverage).toBe(0);
  });

  it("shouldRerunCoverage is unconditionally true", () => {
    expect(shouldRerunCoverage()).toBe(true);
  });
});

describe("workbooks flow through the SAME engine as rules", () => {
  const workbook: ContentItem = {
    type: "workbook",
    id: "wb-1",
    name: "WB One",
    queries: ["T | project SourceIP, DestinationIP"],
    unparseableQueryCount: 2,
  };

  it("classifies a workbook item identically and aggregates unparseable count", () => {
    const report = analyzeContentCoverage({
      items: [ruleC, workbook],
      availableFields: AVAILABLE,
      schemaUnion: SCHEMA_UNION,
    });
    const wb = report.items.find((i) => i.type === "workbook");
    expect(wb).toBeDefined();
    expect(wb?.covered).toContain("SourceIP");
    expect(wb?.missingFromReducedSchema).toContain("DestinationIP");
    expect(report.summary.unparseableQueryCount).toBe(2);
  });
});

describe("empty input is well-defined", () => {
  it("returns a zeroed report for no items", () => {
    const report = analyzeContentCoverage({
      items: [],
      availableFields: AVAILABLE,
      schemaUnion: SCHEMA_UNION,
    });
    expect(report.items).toEqual([]);
    expect(report.summary.totalItems).toBe(0);
    expect(report.summary.ruleReferencedFields).toEqual([]);
    expect(report.summary.missingFieldsAcrossRules).toEqual([]);
  });
});
