import { describe, expect, it } from "vitest";

import {
  matchSolutionName,
  normalizeSolutionKey,
  packAppliesToSolution,
} from "./solution-matching";

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

describe("packAppliesToSolution (THE one pack-vs-solution matcher)", () => {
  it("matches on lowercased keyword containment, not exact name", () => {
    const pack = { solutionKeywords: ["palo alto", "panos"] };
    expect(packAppliesToSolution("Palo Alto Networks", pack)).toBe(true);
    expect(packAppliesToSolution("  PANOS Firewall  ", pack)).toBe(true);
    expect(packAppliesToSolution("Okta", pack)).toBe(false);
  });

  it("never matches an empty or blank solution name", () => {
    // A blank name is "we do not know yet", never "everything applies".
    expect(packAppliesToSolution("", { solutionKeywords: ["zscaler"] })).toBe(false);
    expect(packAppliesToSolution("   ", { solutionKeywords: ["zscaler"] })).toBe(false);
  });

  it("never matches a pack with no keywords (the catalog-only case)", () => {
    // The CEF catalog pack declares none precisely so no runtime lookup feeds
    // it into Phase 0; that must stay true through the shared predicate.
    expect(packAppliesToSolution("Anything At All", { solutionKeywords: [] })).toBe(false);
  });

  it("lets excludeKeywords veto a keyword hit - the sibling-product rule", () => {
    // Substring containment cannot express "most specific wins": every
    // "Zscaler Private Access" name contains "zscaler". This veto is the ONLY
    // thing keeping a ZIA pack off a ZPA solution, and it is the rule one of
    // the two former copies of this function never learned.
    const zia = {
      solutionKeywords: ["zscaler"],
      excludeKeywords: ["private access", "zpa"],
    };
    expect(packAppliesToSolution("Zscaler Internet Access", zia)).toBe(true);
    expect(packAppliesToSolution("Zscaler Private Access", zia)).toBe(false);
    expect(packAppliesToSolution("Zscaler ZPA", zia)).toBe(false);
  });
});

describe("normalizeSolutionKey", () => {
  it("lowercases and strips every non-alphanumeric", () => {
    expect(normalizeSolutionKey("Palo Alto Networks")).toBe("paloaltonetworks");
    expect(normalizeSolutionKey("Cisco-ASA")).toBe("ciscoasa");
    expect(normalizeSolutionKey("Forescout (Legacy)")).toBe("forescoutlegacy");
  });
});
