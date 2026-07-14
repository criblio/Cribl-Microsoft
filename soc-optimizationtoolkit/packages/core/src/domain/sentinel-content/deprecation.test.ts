/**
 * Solution deprecation heuristics - porting-plan Unit 14 (verbatim from
 * sentinel-repo.ts listSolutions). Pins the three layers, their early-return
 * precedence, and the load-bearing "ALL connectors deprecated" rule.
 */
import { describe, expect, it } from "vitest";
import {
  areAllConnectorsDeprecated,
  classifySolutionDeprecation,
  isDeprecatedByName,
  isDeprecatedBySolutionData,
} from "./deprecation";
import { SOLUTION_ARUBA } from "../../assets/sentinel-connectors";

// A connector body that "counts" (has a "title") and carries the [Deprecated] tag.
const deprecatedConn = '{ "title": "[Deprecated] Old Vendor", "id": "x" }';
// A live connector: counts, no [Deprecated] tag.
const liveConn = '{ "title": "New Vendor AMA", "id": "y" }';

describe("layer 1: directory name", () => {
  it("flags names containing legacy/deprecated (case-insensitive)", () => {
    expect(isDeprecatedByName("Forescout (Legacy)")).toBe(true);
    expect(isDeprecatedByName("Something DEPRECATED")).toBe(true);
    expect(isDeprecatedByName("CrowdStrike Falcon Endpoint Protection")).toBe(false);
  });
});

describe("layer 2: Solution_*.json body markers", () => {
  it("flags any of the four markers", () => {
    expect(isDeprecatedBySolutionData(["... [Deprecated] ..."])).toBe(true);
    expect(isDeprecatedBySolutionData(["about to be deprecated by Aug 31"])).toBe(true);
    expect(isDeprecatedBySolutionData(["This connector is No Longer Recommended"])).toBe(true);
    expect(isDeprecatedBySolutionData(["note: this is a legacy path"])).toBe(true);
    expect(isDeprecatedBySolutionData(["a perfectly current solution"])).toBe(false);
    expect(isDeprecatedBySolutionData([])).toBe(false);
  });
});

describe("layer 3: ALL connectors deprecated (the load-bearing rule)", () => {
  it("flags only when every counted connector is deprecated", () => {
    expect(areAllConnectorsDeprecated([deprecatedConn])).toBe(true);
    expect(areAllConnectorsDeprecated([deprecatedConn, deprecatedConn])).toBe(true);
  });

  it("does NOT flag when a live connector coexists with a deprecated one", () => {
    // "some solutions have both old and new" - a single deprecated among live
    // connectors must not deprecate the whole solution.
    expect(areAllConnectorsDeprecated([deprecatedConn, liveConn])).toBe(false);
  });

  it("does NOT flag with zero connectors", () => {
    expect(areAllConnectorsDeprecated([])).toBe(false);
    // A [Deprecated] body with no "title" is not counted as a connector.
    expect(areAllConnectorsDeprecated(['{ "note": "[Deprecated]" }'])).toBe(false);
  });
});

describe("classifySolutionDeprecation precedence + reason strings", () => {
  it("name beats data beats connectors", () => {
    expect(
      classifySolutionDeprecation({
        name: "Vendor (Legacy)",
        solutionDataContents: ["about to be deprecated"],
        connectorContents: [deprecatedConn],
      }),
    ).toEqual({ deprecated: true, reason: "Solution marked as legacy" });

    expect(
      classifySolutionDeprecation({
        name: "Vendor",
        solutionDataContents: ["about to be deprecated"],
        connectorContents: [liveConn],
      }),
    ).toEqual({ deprecated: true, reason: "Connector deprecated by Microsoft" });

    expect(
      classifySolutionDeprecation({
        name: "Vendor",
        solutionDataContents: ["current"],
        connectorContents: [deprecatedConn],
      }),
    ).toEqual({ deprecated: true, reason: "All connectors deprecated" });
  });

  it("returns not-deprecated when no layer fires", () => {
    expect(
      classifySolutionDeprecation({
        name: "CrowdStrike Falcon Endpoint Protection",
        solutionDataContents: ["current solution"],
        connectorContents: [liveConn],
      }),
    ).toEqual({ deprecated: false });
  });
});

describe("real fixture: Solution_Aruba.json (layer 2)", () => {
  it("Aruba ClearPass is flagged via its Solution_*.json body", () => {
    const body = JSON.stringify(SOLUTION_ARUBA);
    expect(body.toLowerCase()).toContain("about to be deprecated");
    expect(
      classifySolutionDeprecation({
        name: "Aruba ClearPass",
        solutionDataContents: [body],
      }),
    ).toEqual({ deprecated: true, reason: "Connector deprecated by Microsoft" });
  });
});
