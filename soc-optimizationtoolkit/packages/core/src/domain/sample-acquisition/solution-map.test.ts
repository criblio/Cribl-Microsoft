import { describe, expect, it } from "vitest";

import {
  SOLUTION_SAMPLE_MAP,
  lookupSolution,
  matchSolutionName,
  fuzzyMatchElasticPackage,
} from "./index";

describe("SOLUTION_SAMPLE_MAP (curated entries)", () => {
  it("carries the ~25 curated entries verbatim", () => {
    // A representative slice of the pinned curated knowledge.
    expect(SOLUTION_SAMPLE_MAP["Cisco ASA"]).toEqual({
      elasticPackage: "cisco_asa",
      elasticDataStreams: ["log"],
      criblPackRepo: "cribl-cisco-asa-cleanup",
      sentinelTable: "CommonSecurityLog",
      sourceFormat: "syslog",
    });
    expect(SOLUTION_SAMPLE_MAP["Palo Alto Networks"].elasticPackage).toBe("panw");
    expect(
      SOLUTION_SAMPLE_MAP["CrowdStrike Falcon Endpoint Protection"].criblPackRepo,
    ).toBe("cribl_crowdstrike");
    expect(Object.keys(SOLUTION_SAMPLE_MAP).length).toBeGreaterThanOrEqual(24);
  });
});

describe("lookupSolution (ONE consolidated 4-stage matcher)", () => {
  it("stage 1: exact key hit", () => {
    expect(lookupSolution("Cisco ASA")?.elasticPackage).toBe("cisco_asa");
  });

  it("stage 2: case-insensitive alnum-equal", () => {
    expect(lookupSolution("cisco-asa")?.elasticPackage).toBe("cisco_asa");
    expect(lookupSolution("CISCOASA")?.elasticPackage).toBe("cisco_asa");
  });

  it("stage 3: substring either direction", () => {
    // "Palo Alto" is a substring of the "Palo Alto Networks" key.
    expect(lookupSolution("Palo Alto")?.elasticPackage).toBe("panw");
  });

  it("stage 4: word overlap", () => {
    expect(lookupSolution("Fortinet Firewall")?.elasticPackage).toBe(
      "fortinet_fortigate",
    );
  });

  it("returns null when nothing matches", () => {
    expect(lookupSolution("Totally Unknown Vendor XYZ")).toBeNull();
  });
});

describe("matchSolutionName (the single reusable boolean matcher)", () => {
  it("is symmetric and covers exact / substring / word overlap", () => {
    expect(matchSolutionName("CrowdStrike Falcon", "CrowdStrike Falcon")).toBe(true);
    expect(matchSolutionName("Palo Alto", "Palo Alto Networks")).toBe(true);
    expect(matchSolutionName("Palo Alto Networks", "Palo Alto")).toBe(true);
    expect(matchSolutionName("Fortinet Firewall", "Fortinet FortiGate")).toBe(true);
  });

  it("rejects unrelated names", () => {
    expect(matchSolutionName("Okta", "CrowdStrike")).toBe(false);
  });
});

describe("fuzzyMatchElasticPackage", () => {
  const packages = ["cisco_asa", "crowdstrike", "fortinet_fortigate", "panw", "okta"];

  it("returns the exact normalized package", () => {
    expect(fuzzyMatchElasticPackage("crowdstrike", packages)).toBe("crowdstrike");
  });

  it("strips suffixes then matches (>= 6 score)", () => {
    expect(
      fuzzyMatchElasticPackage("CrowdStrike Endpoint Protection", packages),
    ).toBe("crowdstrike");
  });

  it("returns null below the minimum score", () => {
    expect(fuzzyMatchElasticPackage("Zz", packages)).toBeNull();
    expect(fuzzyMatchElasticPackage("Some Random Product", packages)).toBeNull();
  });
});
