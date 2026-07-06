/**
 * reduction-rules KB + findReductionRules lookup semantics - Unit 17 (c).
 *
 * Characterizes the three-tier lookup INCLUDING the aggressive bidirectional
 * containment tier, and pins the suppress-honors-maxEvents fix through emission.
 */

import { describe, it, expect } from "vitest";
import {
  REDUCTION_RULES,
  findReductionRules,
  type TableReductionRules,
} from "./reduction-rules";
import { generatePipelineConf } from "./pipeline-conf";

describe("REDUCTION_RULES knowledge base", () => {
  it("ships eight distinct rule sets across twelve keys", () => {
    const distinct = new Set(Object.values(REDUCTION_RULES));
    expect(distinct.size).toBe(8);
    // SecurityEvent reuses the WindowsEvent rule set (same schema).
    expect(REDUCTION_RULES.SecurityEvent).toBe(REDUCTION_RULES.WindowsEvent);
    // Both Cloudflare keys share one set.
    expect(REDUCTION_RULES.CloudflareV2_CL).toBe(REDUCTION_RULES.Cloudflare);
  });

  it("every rule carries a human-readable reason (review UI display content)", () => {
    for (const rules of Object.values(REDUCTION_RULES)) {
      for (const r of [...rules.keep, ...rules.drop, ...rules.suppress]) {
        expect(r.reason.length).toBeGreaterThan(10);
      }
    }
  });

  it("filters use the null-safe (field || '') style on raw vendor names", () => {
    // Contract item 12: filters address RAW vendor field names, null-safe.
    expect(REDUCTION_RULES.CommonSecurityLog.keep[0].filter).toContain(
      "act || ''",
    );
  });
});

describe("findReductionRules three-tier lookup", () => {
  it("tier 1: exact table-name match", () => {
    expect(findReductionRules("CommonSecurityLog", "")).toBe(
      REDUCTION_RULES.CommonSecurityLog,
    );
  });

  it("tier 2: keyword match against `{table} {solution}`", () => {
    // 'Something_CL' has no exact/vendor entry, but the solution name carries the
    // vendor keyword.
    expect(findReductionRules("Something_CL", "Palo Alto NGFW")).toBe(
      REDUCTION_RULES["Palo Alto"],
    );
  });

  it("tier 3: aggressive containment where a KB key CONTAINS the stripped name", () => {
    // 'Fortin' is not exact, and no key appears in 'fortin '; only tier 3's
    // key.includes(stripped) direction catches it ('fortinet'.includes('fortin')).
    expect(findReductionRules("Fortin", "")).toBe(REDUCTION_RULES.Fortinet);
  });

  it("tier 3 is AGGRESSIVE: a 3-char table name grabs a longer KB key", () => {
    // Characterized, not fixed: 'Sys' -> 'syslog'.includes('sys') -> Syslog rules.
    expect(findReductionRules("Sys", "")).toBe(REDUCTION_RULES.Syslog);
  });

  it("strips _CL before the containment tier", () => {
    expect(findReductionRules("CrowdStrike_Events_CL", "")).toBe(
      REDUCTION_RULES.CrowdStrike,
    );
  });

  it("returns null when nothing matches", () => {
    expect(findReductionRules("Zzzqqq", "unrelated widget")).toBeNull();
  });
});

describe("suppress emission HONORS maxEvents (fix + pin)", () => {
  const withSuppress: TableReductionRules = {
    keep: [],
    drop: [],
    suppress: [
      {
        id: "agg5",
        description: "aggregate five",
        filter: "true",
        reason: "test",
        groupKey: "a + ':' + b",
        windowSec: 300,
        maxEvents: 5,
      },
      {
        id: "agg_default",
        description: "aggregate default",
        filter: "true",
        reason: "test",
        groupKey: "c",
        windowSec: 120,
        // maxEvents omitted -> defaults to 1
      },
    ],
  };

  it("emits allow: <maxEvents> not the legacy always-1", () => {
    const yaml = generatePipelineConf(
      "p",
      "AcmeSolution",
      "Acme_CL",
      [],
      undefined,
      "json",
      undefined,
      withSuppress,
    );
    expect(yaml).toContain("allow: 5");
    // The rule without maxEvents falls back to 1.
    expect(yaml).toContain("allow: 1");
    // Legacy bug would have emitted only allow: 1 for BOTH; assert 5 is present.
    expect(yaml).not.toMatch(/allow: 5[\s\S]*allow: 5/);
  });

  it("emits suppressPeriodSec and keyExpr from the rule", () => {
    const yaml = generatePipelineConf(
      "p",
      "AcmeSolution",
      "Acme_CL",
      [],
      undefined,
      "json",
      undefined,
      withSuppress,
    );
    expect(yaml).toContain("suppressPeriodSec: 300");
    expect(yaml).toContain(`keyExpr: "a + ':' + b"`);
  });
});
