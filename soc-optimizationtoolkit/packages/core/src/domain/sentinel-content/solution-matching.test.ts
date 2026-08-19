import { describe, expect, it } from "vitest";

import { matchSolutionName, normalizeSolutionKey } from "./solution-matching";

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

describe("normalizeSolutionKey", () => {
  it("lowercases and strips every non-alphanumeric", () => {
    expect(normalizeSolutionKey("Palo Alto Networks")).toBe("paloaltonetworks");
    expect(normalizeSolutionKey("Cisco-ASA")).toBe("ciscoasa");
    expect(normalizeSolutionKey("Forescout (Legacy)")).toBe("forescoutlegacy");
  });
});
