/**
 * Pins for the log-type catalog and its tier merge (ADR 0003; user direction
 * 2026-08-19).
 *
 * THE CLAIM EACH TIER MAKES IS THE POINT. "A shipped detection filters on this"
 * and "your vendor documents this feed" are different assertions, and the second
 * wearing the first's authority is the failure these guard - it would tell an
 * operator their solution needs data it has never mentioned.
 */

import { describe, expect, it } from "vitest";

import {
  DOCUMENTED_LOG_TYPE_PACKS,
  documentedLogTypePacksForSolution,
  documentedLogTypesForSolution,
} from "./vendor-log-types";
import { evidenceCounts, mergeLogTypeSources } from "./merge";
import type { ExpectedLogType } from "../coverage-analysis/expected-log-types";
import { compareLogTypeCoverage } from "../coverage-analysis/expected-log-types";

const expected = (
  value: string,
  types: ExpectedLogType["referencedTypes"],
  refs = ["R1"],
): ExpectedLogType => ({
  value,
  field: "type",
  referencedBy: refs,
  referencedTypes: types,
});

describe("the documented catalog", () => {
  it("carries provenance on EVERY pack - an uncited entry is a guess", () => {
    expect(DOCUMENTED_LOG_TYPE_PACKS.length).toBeGreaterThan(0);
    for (const pack of DOCUMENTED_LOG_TYPE_PACKS) {
      expect(pack.provenance.length).toBeGreaterThan(0);
      expect(pack.logTypes.length).toBeGreaterThan(0);
      expect(pack.solutionKeywords.length).toBeGreaterThan(0);
    }
  });

  it("knows the Zscaler ZIA feeds by their documented names, HAND FIRST", () => {
    // Was an exact list of five (2026-08-20): that only held while the
    // generated tier was empty, and it is populated now - 157 packs / 647 log
    // types from the bulk miner. Exact equality here would have to be retyped
    // after every regeneration, which is how a pin stops meaning anything.
    //
    // What is actually being pinned survives: the five HAND-VERIFIED, cited
    // feed names are present and lead the list, because hand packs are declared
    // first and win the per-value dedupe. A generated feed displacing a curated
    // one is the regression this guards.
    const types = documentedLogTypesForSolution("Zscaler Internet Access");
    expect(types.slice(0, 5).map((t) => t.value)).toEqual([
      "ZIA Web",
      "ZIA Firewall",
      "ZIA DNS",
      "ZIA Tunnel",
      "ZIA Alerts",
    ]);
    expect(types[0].vendor).toBe("Zscaler");
    expect(types[0].docUrl).toContain("help.zscaler.com");
    expect(types[0].doc).toContain("Web transaction log");
  });

  it("knows the PAN-OS log types, matching the parser's own dictionary", () => {
    const types = documentedLogTypesForSolution("Palo Alto Networks");
    const values = types.map((t) => t.value);
    expect(values).toContain("TRAFFIC");
    expect(values).toContain("THREAT");
    expect(values).toContain("GLOBALPROTECT");
  });

  it("matches a solution by keyword, not by exact name", () => {
    expect(documentedLogTypePacksForSolution("PaloAlto-PAN-OS")).toHaveLength(1);
    expect(documentedLogTypePacksForSolution("Totally Unknown Vendor")).toEqual([]);
    expect(documentedLogTypePacksForSolution("")).toEqual([]);
  });

  it("does NOT recommend a SIBLING PRODUCT's feeds", () => {
    // Substring matching cannot express "most specific wins": every ZPA
    // solution name contains "zscaler". Sending a ZPA operator to collect
    // "ZIA Web" is worse than saying nothing - that feed does not exist in the
    // product they are onboarding.
    // Asserted as "no SIBLING pack", not as an exact list (2026-08-20). The
    // list was exact while the generated tier was empty; now that it is
    // populated, ZPA legitimately draws its own generated pack alongside its
    // hand one, and pinning the exact set would have to be retyped on every
    // regeneration. The claim that matters is which product's feeds appear.
    const zpa = documentedLogTypePacksForSolution("Zscaler Private Access");
    expect(zpa.map((p) => p.id)).toContain("zscaler-zpa");
    expect(zpa.map((p) => p.id)).not.toContain("zscaler-zia");
    expect(zpa.map((p) => p.id)).not.toContain("generated-zscaler_zia");
    expect(documentedLogTypesForSolution("Zscaler Private Access").map((t) => t.value))
      .toContain("User Activity");
    expect(documentedLogTypesForSolution("Zscaler Private Access").map((t) => t.value))
      .not.toContain("ZIA Web");

    // ZIA still resolves for its own solution - and does NOT draw ZPA's, which
    // is the same bleed in the other direction. The generated ZPA pack claims
    // bare "zscaler" too, so this arm is not symmetric for free.
    const zia = documentedLogTypePacksForSolution("Zscaler Internet Access");
    expect(zia.map((p) => p.id)).toContain("zscaler-zia");
    expect(zia.map((p) => p.id)).not.toContain("zscaler-zpa");
    expect(zia.map((p) => p.id)).not.toContain("generated-zscaler_zpa");
    expect(documentedLogTypesForSolution("Zscaler Internet Access").map((t) => t.value))
      .not.toContain("User Activity");

    // Same trap on the Palo Alto side: Cortex XDR is not the firewall.
    const cortex = documentedLogTypePacksForSolution("Palo Alto Networks Cortex XDR");
    expect(cortex.map((p) => p.id)).toContain("cortex-xdr");
    expect(cortex.map((p) => p.id)).not.toContain("paloalto-panos");
    expect(documentedLogTypesForSolution("Palo Alto Networks Cortex XDR").map((t) => t.value))
      .not.toContain("TRAFFIC");
  });

  it("covers the vendors this toolkit actually onboards", () => {
    // Breadth pin. The generated tier has been populated since 2026-08-20 (157
    // packs from the bulk miner), so these hand packs are no longer the WHOLE
    // vendor tier - but they are still the CITED, human-checked part of it, and
    // a regeneration must never drop one. A shrink here is a silent loss of the
    // only fallback thin solutions have, and the generated tier cannot replace
    // it: mined feed names are package stream ids like "user_activity", not the
    // documented names an operator would recognize.
    const ids = DOCUMENTED_LOG_TYPE_PACKS.map((p) => p.id);
    for (const id of [
      "zscaler-zia",
      "zscaler-zpa",
      "paloalto-panos",
      "cortex-xdr",
      "crowdstrike-fdr",
      "fortinet-fortigate",
      "cisco-asa",
      "checkpoint",
      "okta",
      "netskope",
      "sentinelone",
      "corelight-zeek",
      "pfsense",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("dedupes by value AND alias, so one feed never appears twice", () => {
    // A generated pack could name the same Zscaler feed "web"; the hand entry
    // lists it as an alias, so it must swallow it rather than sit beside it.
    const types = documentedLogTypesForSolution("Zscaler Internet Access");
    const normalized = types.map((t) => t.value.toLowerCase().replace(/[^a-z0-9]/g, ""));
    expect(new Set(normalized).size).toBe(normalized.length);
  });
});

describe("mergeLogTypeSources - tiers", () => {
  it("labels detection, workbook and vendor entries distinctly", () => {
    const merged = mergeLogTypeSources({
      expected: [
        expected("TRAFFIC", ["alert-rule"]),
        expected("CONFIG", ["workbook"]),
      ],
      vendorLogTypes: documentedLogTypesForSolution("Palo Alto Networks"),
      provided: [],
    });
    const byValue = Object.fromEntries(merged.map((m) => [m.value, m.evidence]));
    expect(byValue["TRAFFIC"]).toBe("detection");
    expect(byValue["CONFIG"]).toBe("workbook");
    expect(byValue["HIPMATCH"]).toBe("vendor");
  });

  it("ranks detections above workbooks above vendor entries", () => {
    const merged = mergeLogTypeSources({
      expected: [
        expected("ZZZ_WORKBOOK", ["workbook"]),
        expected("AAA_RULE", ["alert-rule"]),
      ],
      vendorLogTypes: documentedLogTypesForSolution("Palo Alto Networks"),
      provided: [],
    });
    expect(merged[0].value).toBe("AAA_RULE");
    expect(merged[1].value).toBe("ZZZ_WORKBOOK");
    expect(merged[2].evidence).toBe("vendor");
  });

  it("a value referenced by BOTH a rule and a workbook is a DETECTION", () => {
    // The strongest claim wins, same first-wins rule the mapping packs use.
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["workbook", "alert-rule"])],
      vendorLogTypes: [],
      provided: [],
    });
    expect(merged[0].evidence).toBe("detection");
  });

  it("content SUPPRESSES the vendor entry for the same log type", () => {
    // Showing "TRAFFIC (a rule needs it)" beside "TRAFFIC (Palo Alto documents
    // it)" asks the operator to reconcile two rows that mean one thing.
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: documentedLogTypesForSolution("Palo Alto Networks"),
      provided: [],
    });
    expect(merged.filter((m) => m.value.toUpperCase() === "TRAFFIC")).toHaveLength(1);
    expect(merged[0].evidence).toBe("detection");
  });

  it("suppresses via ALIAS too - one feed, two vocabularies", () => {
    // A Sentinel rule filtering on NSSWeblog and Zscaler's "ZIA Web" are the
    // same feed; the operator must be asked for it once.
    const merged = mergeLogTypeSources({
      expected: [expected("NSSWeblog", ["alert-rule"])],
      vendorLogTypes: documentedLogTypesForSolution("Zscaler"),
      provided: [],
    });
    const webish = merged.filter((m) => /web/i.test(m.value));
    expect(webish).toHaveLength(1);
    expect(webish[0].evidence).toBe("detection");
  });

  it("keeps the vendor tier when content names NOTHING - the whole point", () => {
    const merged = mergeLogTypeSources({
      expected: [],
      vendorLogTypes: documentedLogTypesForSolution("Zscaler"),
      provided: [],
    });
    // Not a fixed count (2026-08-20): the bare vendor name draws BOTH Zscaler
    // products, and the generated tier is populated now, so the number moves
    // with the asset. The claim is the one in the title - content named
    // nothing, and the operator is still given something to provide, all of it
    // labelled vendor so nothing masquerades as detection evidence.
    expect(merged.length).toBeGreaterThan(0);
    expect(merged.every((m) => m.evidence === "vendor")).toBe(true);
    expect(merged[0].docUrl).toContain("zscaler");
  });
});

describe("mergeLogTypeSources - provided matching", () => {
  it("matches a provided sample separator- and case-insensitively", () => {
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: ["panos-traffic"],
    });
    expect(merged[0].provided).toBe(true);
  });

  it("matches a vendor entry through its ALIASES", () => {
    // The operator tagged their sample "NSSWeblog"; the vendor entry is
    // "ZIA Web". Failing to connect them would ask for data already provided.
    const merged = mergeLogTypeSources({
      expected: [],
      vendorLogTypes: documentedLogTypesForSolution("Zscaler"),
      provided: ["NSSWeblog"],
    });
    const web = merged.find((m) => m.value === "ZIA Web");
    expect(web?.provided).toBe(true);
    expect(merged.find((m) => m.value === "ZIA DNS")?.provided).toBe(false);
  });

  it("does not count an unrelated sample as coverage", () => {
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: ["hipmatch"],
    });
    expect(merged[0].provided).toBe(false);
  });
});

describe("ONE answer to 'is this log type provided'", () => {
  // compareLogTypeCoverage (the Sample Data confirmation, which gates and arms
  // the pack build) and mergeLogTypeSources (the recommendation panel above it)
  // answer the SAME question about the SAME inputs and render on the SAME
  // screen. At the 2026-08-20 audit they were two implementations, and they had
  // already drifted. These pins state the invariant directly: for every log
  // type, "provided" and "not missing" are the same fact.
  const types = [
    expected("TRAFFIC", ["alert-rule"]),
    expected("THREAT", ["alert-rule"]),
    expected("CONFIG", ["alert-rule"]),
  ];

  const agreementOf = (provided: readonly string[]): boolean[] => {
    const coverage = compareLogTypeCoverage(types, provided);
    const merged = mergeLogTypeSources({
      expected: types,
      vendorLogTypes: [],
      provided,
    });
    expect(merged).toHaveLength(types.length);
    return merged.map((m) => {
      const isMissing = coverage.missing.some((x) => x.value === m.value);
      expect(m.provided, `${m.value}: provided vs !missing`).toBe(!isMissing);
      return m.provided;
    });
  };

  it("agrees that an empty-normalizing tag covers NOTHING", () => {
    // THE reproduction. "-" normalizes to "" and `"traffic".includes("")` is
    // true, so the drifted copy inside compareLogTypeCoverage matched every
    // expected log type while the merge - which filtered empties - matched
    // none. Two contradicting sentences, one screen, and the coverage side is
    // the one that arms the pack build.
    expect(agreementOf(["-"])).toEqual([false, false, false]);
  });

  it("agrees that a real tag covers exactly what it names", () => {
    // The other direction, so the pin cannot be satisfied by making both sides
    // answer "no" to everything.
    expect(agreementOf(["panos-traffic"])).toEqual([false, false, true]);
  });

  it("agrees when every log type has a sample", () => {
    expect(agreementOf(["TRAFFIC", "threat", "Config"])).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe("evidenceCounts", () => {
  it("counts each tier", () => {
    const vendorLogTypes = documentedLogTypesForSolution("Zscaler");
    const merged = mergeLogTypeSources({
      expected: [expected("A", ["alert-rule"]), expected("B", ["workbook"])],
      vendorLogTypes,
      provided: [],
    });
    const counts = evidenceCounts(merged);
    // detection and workbook come from this test's own fixture, so they stay
    // exact. The vendor count was 5 while the generated tier was empty; it is
    // asserted against the input now (2026-08-20), which is a STRONGER claim
    // than the number was - every vendor log type in, every one counted, none
    // silently dropped or double-counted - and it does not have to be retyped
    // when the miner runs again.
    expect(counts.detection).toBe(1);
    expect(counts.workbook).toBe(1);
    expect(counts.vendor).toBe(vendorLogTypes.length);
    expect(counts.vendor).toBeGreaterThan(0);
  });

  it("is all zeroes for an empty merge", () => {
    expect(evidenceCounts([])).toEqual({ detection: 0, workbook: 0, vendor: 0 });
  });
});
