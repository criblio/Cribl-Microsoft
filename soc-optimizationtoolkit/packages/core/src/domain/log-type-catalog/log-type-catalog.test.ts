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
import {
  estimatedLogTypeBytes,
  evidenceCounts,
  mergeLogTypeSources,
  rankUnreferencedByVolume,
} from "./merge";
import type { LogTypeVolume } from "./merge";
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

// ---------------------------------------------------------------------------
// Measured volume (plan Phase 5)
// ---------------------------------------------------------------------------
//
// The rule these guard: a volume is ATTACHED and RANKED, never judged. No
// threshold, no flag, and above all no invented number - unmeasured must stay
// unmeasured all the way to the screen, because a zero here is a claim about
// the operator's data that nobody made.

describe("volume attachment", () => {
  const vol = (logType: string, eventCount?: number): LogTypeVolume =>
    eventCount === undefined ? { logType } : { logType, eventCount };

  it("attaches a measured count to the log type it belongs to", () => {
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: [],
      volumes: [vol("TRAFFIC", 890123)],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0].eventCount).toBe(890123);
  });

  it("matches a volume through separators and case, as every other join does", () => {
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: [],
      volumes: [vol("pan-traffic", 12)],
    });

    expect(merged[0].eventCount).toBe(12);
  });

  it("SUMS disjoint rows rather than picking one", () => {
    // The rows come from one summarize-by, so they partition the window and
    // adding them double-counts nothing. Picking the larger would under-report
    // a log type the dataset splits across two discriminator values.
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: [],
      volumes: [vol("pan-traffic", 100), vol("gp-traffic", 25)],
    });

    expect(merged[0].eventCount).toBe(125);
  });

  it("leaves an entry UNMEASURED when no row matched - never zero", () => {
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: [],
      volumes: [vol("THREAT", 5)],
    });

    expect(merged[0].eventCount).toBeUndefined();
    // The KEY is absent, not present-and-undefined: a renderer testing
    // for the property must see nothing to show.
    expect("eventCount" in merged[0]).toBe(false);
  });

  it("treats an unreadable count as unmeasured, not as zero", () => {
    // readCount returns undefined when the column is not recognised. Adopting
    // that as 0 would report a busy log type as silent.
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: [],
      volumes: [vol("TRAFFIC")],
    });

    expect("eventCount" in merged[0]).toBe(false);
  });

  it("carries a measured ZERO, which is a real answer", () => {
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: [],
      volumes: [vol("TRAFFIC", 0)],
    });

    expect(merged[0].eventCount).toBe(0);
  });

  it("RANKS BY VOLUME WITHIN A TIER", () => {
    const merged = mergeLogTypeSources({
      expected: [
        expected("QUIET", ["alert-rule"]),
        expected("BUSY", ["alert-rule"]),
      ],
      vendorLogTypes: [],
      provided: [],
      volumes: [vol("BUSY", 900000), vol("QUIET", 3)],
    });

    expect(merged.map((m) => m.value)).toEqual(["BUSY", "QUIET"]);
  });

  it("NEVER lets volume cross a tier boundary", () => {
    // THE pin of this group. A vendor-documented feed with 900K events must
    // stay below a detection-tier log type with three, because the tiers answer
    // "do you need this?" and the volume answers "how much is there?". Floating
    // the busy one would hand a catalog entry a requirement's authority - the
    // exact failure the tier split exists to prevent.
    const vendorLogTypes = documentedLogTypesForSolution("Palo Alto Networks");
    expect(vendorLogTypes.length).toBeGreaterThan(0);
    const busyVendor = vendorLogTypes[0].value;

    const merged = mergeLogTypeSources({
      expected: [expected("QUIET_BUT_NEEDED", ["alert-rule"])],
      vendorLogTypes,
      provided: [],
      volumes: [vol(busyVendor, 900000), vol("QUIET_BUT_NEEDED", 3)],
    });

    expect(merged[0].value).toBe("QUIET_BUT_NEEDED");
    expect(merged[0].evidence).toBe("detection");
    // And the busy vendor row really did get its volume, so this passes
    // because of the tier rule rather than because nothing was measured.
    const vendorIndex = merged.findIndex((m) => m.value === busyVendor);
    expect(vendorIndex).toBeGreaterThan(0);
    expect(merged[vendorIndex].eventCount).toBe(900000);
  });

  it("sorts unmeasured BELOW a measured zero, within its tier", () => {
    const merged = mergeLogTypeSources({
      expected: [
        expected("UNMEASURED", ["alert-rule"]),
        expected("ZERO", ["alert-rule"]),
      ],
      vendorLogTypes: [],
      provided: [],
      volumes: [vol("ZERO", 0)],
    });

    expect(merged.map((m) => m.value)).toEqual(["ZERO", "UNMEASURED"]);
  });

  it("changes nothing when no volumes are supplied", () => {
    // The state before any Lake query runs, which is most of the time.
    const input = {
      expected: [
        expected("B", ["alert-rule"], ["R1", "R2"]),
        expected("A", ["alert-rule"], ["R1"]),
      ],
      vendorLogTypes: [],
      provided: [],
    };
    const without = mergeLogTypeSources(input);
    const withEmpty = mergeLogTypeSources({ ...input, volumes: [] });

    expect(withEmpty).toEqual(without);
    // Reference count still decides, exactly as before Phase 5.
    expect(without.map((m) => m.value)).toEqual(["B", "A"]);
  });
});

describe("rankUnreferencedByVolume", () => {
  it("puts the busiest unreferenced log type first", () => {
    const ranked = rankUnreferencedByVolume(
      ["hipmatch", "globalprotect", "userid"],
      [
        { logType: "globalprotect", eventCount: 890000 },
        { logType: "hipmatch", eventCount: 12 },
      ],
    );

    expect(ranked.map((u) => u.value)).toEqual([
      "globalprotect",
      "hipmatch",
      "userid",
    ]);
    expect(ranked[0].eventCount).toBe(890000);
    // The unmeasured one carries no count rather than a zero.
    expect("eventCount" in ranked[2]).toBe(false);
  });

  it("PRESERVES INPUT ORDER when nothing has been measured", () => {
    // Re-alphabetizing an unmeasured list would be reordering on no evidence,
    // and would silently change what the operator sees before any query runs.
    const ranked = rankUnreferencedByVolume(["traffic", "hipmatch", "auth"]);

    expect(ranked.map((u) => u.value)).toEqual(["traffic", "hipmatch", "auth"]);
  });

  it("keeps input order among entries that tie on volume", () => {
    const ranked = rankUnreferencedByVolume(
      ["zebra", "alpha"],
      [
        { logType: "zebra", eventCount: 7 },
        { logType: "alpha", eventCount: 7 },
      ],
    );

    expect(ranked.map((u) => u.value)).toEqual(["zebra", "alpha"]);
  });

  it("never invents a count for a name that normalizes to nothing", () => {
    // An operator may tag a sample "-"; the shared empty-name guards must keep
    // it from matching every volume row.
    const ranked = rankUnreferencedByVolume(
      ["-"],
      [{ logType: "traffic", eventCount: 500 }],
    );

    expect(ranked).toEqual([{ value: "-" }]);
  });

  it("is empty for an empty set, and does not fail without volumes", () => {
    expect(rankUnreferencedByVolume([])).toEqual([]);
  });

  it("ranks a log type named after its DATASET on the same terms as any other", () => {
    // Since 2026-08-25 a Lake dataset that nothing splits is offered as ONE log
    // type carrying the DATASET'S name, with a volume from an ungrouped
    // `summarize count()`. Its row satisfies LogTypeVolume like any other, so
    // this needed no new shape - what it does need is to keep obeying the same
    // rules: the count is attached and ranked, nothing is flagged, and no
    // verdict is drawn from where the name came from. That provenance belongs
    // on the Lake panel, where the operator can act on it; here it is a
    // provided log type that no detection references, which is fine.
    const ranked = rankUnreferencedByVolume(
      ["winevt_dcronly", "traffic"],
      [
        { logType: "winevt_dcronly", eventCount: 1216 },
        { logType: "traffic", eventCount: 12 },
      ],
    );

    expect(ranked).toEqual([
      { value: "winevt_dcronly", eventCount: 1216 },
      { value: "traffic", eventCount: 12 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Events to BYTES (sample-acquisition plan Phase 5, last item)
// ---------------------------------------------------------------------------
//
// A count is hard to reason about against a Sentinel bill, which is charged by
// volume. These guard the conversion that answers it, and the rule is the same
// one the counts obey, one notch stricter: the estimate is ATTACHED and RANKED,
// never judged, and ABSENT whenever it cannot be computed. A defaulted zero here
// would under-report an ingest cost by however much was left out - and it would
// read as measured, because bytes look like a measurement.

describe("estimatedLogTypeBytes", () => {
  it("is the count times the mean, rounded to whole bytes", () => {
    expect(
      estimatedLogTypeBytes({
        logType: "TRAFFIC",
        eventCount: 890123,
        meanEventBytes: 620.4,
      }),
    ).toBe(Math.round(890123 * 620.4));
    // Spelled out, so the pin fails on a changed formula rather than agreeing
    // with whatever the code computes: 890,123 x 620.4 = 552,232,309.2, which
    // rounds DOWN to 552,232,309.
    expect(
      estimatedLogTypeBytes({
        logType: "TRAFFIC",
        eventCount: 890123,
        meanEventBytes: 620.4,
      }),
    ).toBe(552232309);
  });

  it("is UNDEFINED without a mean - the log type was never sampled", () => {
    // The skew case, and the common one: a dataset can count a minority log
    // type at dataset scale without any of its events reaching the sample.
    const bytes = estimatedLogTypeBytes({
      logType: "SECURITY",
      eventCount: 22792,
    });
    expect(bytes).toBeUndefined();
    expect(bytes).not.toBe(0);
  });

  it("is UNDEFINED without a count, however well the events were measured", () => {
    expect(
      estimatedLogTypeBytes({ logType: "TRAFFIC", meanEventBytes: 620 }),
    ).toBeUndefined();
  });

  it("refuses a ZERO mean rather than pricing a busy log type at 0 B", () => {
    // meanEventBytes already refuses to produce one; this is the second guard,
    // because the failure it prevents is "890,123 events, ~0 B estimated".
    const bytes = estimatedLogTypeBytes({
      logType: "TRAFFIC",
      eventCount: 890123,
      meanEventBytes: 0,
    });
    expect(bytes).toBeUndefined();
    expect(bytes).not.toBe(0);
  });

  it("refuses a non-finite figure rather than propagating NaN", () => {
    expect(
      estimatedLogTypeBytes({
        logType: "TRAFFIC",
        eventCount: 10,
        meanEventBytes: Number.NaN,
      }),
    ).toBeUndefined();
    expect(
      estimatedLogTypeBytes({
        logType: "TRAFFIC",
        eventCount: Number.POSITIVE_INFINITY,
        meanEventBytes: 620,
      }),
    ).toBeUndefined();
  });

  it("gives a MEASURED zero count zero bytes, which is a real answer", () => {
    // The distinction this module keeps everywhere: a measured zero is an
    // answer, an unmeasured value is not. Zero events genuinely is zero bytes.
    expect(
      estimatedLogTypeBytes({
        logType: "QUIET",
        eventCount: 0,
        meanEventBytes: 620,
      }),
    ).toBe(0);
  });
});

describe("byte-estimate attachment", () => {
  const sized = (
    logType: string,
    eventCount: number,
    meanEventBytes?: number,
  ): LogTypeVolume =>
    meanEventBytes === undefined
      ? { logType, eventCount }
      : { logType, eventCount, meanEventBytes };

  it("attaches the estimate beside the count it was derived from", () => {
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: [],
      volumes: [sized("TRAFFIC", 1000, 512)],
    });

    expect(merged[0].eventCount).toBe(1000);
    expect(merged[0].estimatedBytes).toBe(512000);
  });

  it("leaves an entry with a count but NO SAMPLE unestimated - never zero", () => {
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: [],
      volumes: [sized("TRAFFIC", 890123)],
    });

    expect(merged[0].eventCount).toBe(890123);
    // The KEY is absent, not present-and-undefined: a renderer testing for the
    // property must see nothing to show.
    expect("estimatedBytes" in merged[0]).toBe(false);
  });

  it("sums the estimate across disjoint rows, as it sums the counts", () => {
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: [],
      volumes: [sized("pan-traffic", 100, 500), sized("gp-traffic", 25, 200)],
    });

    expect(merged[0].eventCount).toBe(125);
    // 100 x 500 + 25 x 200 = 55,000. Each row keeps its OWN mean: reusing one
    // row's mean for the other would price GLOBALPROTECT with TRAFFIC's bytes.
    expect(merged[0].estimatedBytes).toBe(55000);
  });

  it("drops the estimate ENTIRELY when one summed row lacks a mean", () => {
    // ALL OR NOTHING. A partial sum would sit beside a count covering more
    // events than it does - "125 events, ~50 KB" where the 50 KB speaks for
    // 100 of them - and under-reporting a cost is the expensive direction.
    const merged = mergeLogTypeSources({
      expected: [expected("TRAFFIC", ["alert-rule"])],
      vendorLogTypes: [],
      provided: [],
      volumes: [sized("pan-traffic", 100, 500), sized("gp-traffic", 25)],
    });

    expect(merged[0].eventCount).toBe(125);
    expect("estimatedBytes" in merged[0]).toBe(false);
  });

  it("reaches a vendor entry through its ALIASES, as the count does", () => {
    const merged = mergeLogTypeSources({
      expected: [],
      vendorLogTypes: [
        {
          value: "ZIA Web",
          aliases: ["NSSWeblog"],
          vendor: "Zscaler",
          provenance: "test fixture",
        },
      ],
      provided: [],
      volumes: [sized("NSSWeblog", 40, 1024)],
    });

    expect(merged[0].eventCount).toBe(40);
    expect(merged[0].estimatedBytes).toBe(40960);
  });

  it("RANKS BY BYTES when every measured entry carries an estimate", () => {
    // The whole point of the conversion: 100 events at 10 KB outweighs 900 at
    // 200 B, and only the byte order says so. Same tier, so evidence does not
    // decide it.
    const merged = mergeLogTypeSources({
      expected: [
        expected("MANY_TINY", ["alert-rule"]),
        expected("FEW_HUGE", ["alert-rule"]),
      ],
      vendorLogTypes: [],
      provided: [],
      volumes: [sized("MANY_TINY", 900, 200), sized("FEW_HUGE", 100, 10240)],
    });

    expect(merged.map((m) => m.value)).toEqual(["FEW_HUGE", "MANY_TINY"]);
    expect(merged[0].estimatedBytes).toBe(1024000);
    expect(merged[1].estimatedBytes).toBe(180000);
    // And the count order really is the OPPOSITE one, so this pin fails if the
    // list quietly reverts to ranking by events.
    expect(merged[0].eventCount).toBe(100);
    expect(merged[1].eventCount).toBe(900);
  });

  it("falls back to the COUNT order when any measured entry lacks an estimate", () => {
    // Mixing the keys would compare 900 events against 1,024,000 bytes as if
    // they were one quantity, and promoting the estimated entries would rank on
    // how well we measured rather than on what we measured.
    const merged = mergeLogTypeSources({
      expected: [
        expected("MANY_TINY", ["alert-rule"]),
        expected("FEW_HUGE", ["alert-rule"]),
      ],
      vendorLogTypes: [],
      provided: [],
      volumes: [sized("MANY_TINY", 900), sized("FEW_HUGE", 100, 10240)],
    });

    expect(merged.map((m) => m.value)).toEqual(["MANY_TINY", "FEW_HUGE"]);
    expect(merged[0].eventCount).toBe(900);
    expect("estimatedBytes" in merged[0]).toBe(false);
    expect(merged[1].estimatedBytes).toBe(1024000);
  });

  it("still NEVER lets a byte estimate cross a tier boundary", () => {
    // The rule volume already obeys, restated for the new key: a busy feed the
    // vendor merely documents must not outrank a quiet one a shipped detection
    // depends on, however many bytes it weighs.
    const busyVendor = documentedLogTypesForSolution("Palo Alto Networks")[0]
      .value;
    const merged = mergeLogTypeSources({
      expected: [expected("QUIET_BUT_NEEDED", ["alert-rule"])],
      vendorLogTypes: documentedLogTypesForSolution("Palo Alto Networks"),
      provided: [],
      volumes: [sized(busyVendor, 900000, 2048), sized("QUIET_BUT_NEEDED", 3, 8)],
    });

    expect(merged[0].value).toBe("QUIET_BUT_NEEDED");
    expect(merged[0].evidence).toBe("detection");
    expect(merged[0].estimatedBytes).toBe(24);
    const vendorRow = merged.find((m) => m.value === busyVendor);
    expect(vendorRow?.estimatedBytes).toBe(1843200000);
  });

  it("ranks the UNREFERENCED set by bytes on the same all-or-nothing rule", () => {
    const ranked = rankUnreferencedByVolume(
      ["hipmatch", "globalprotect"],
      [
        sized("hipmatch", 900, 4096),
        sized("globalprotect", 890000, 200),
      ],
    );

    // 900 x 4096 = 3,686,400 against 890,000 x 200 = 178,000,000.
    expect(ranked.map((u) => u.value)).toEqual(["globalprotect", "hipmatch"]);
    expect(ranked[0].estimatedBytes).toBe(178000000);
    expect(ranked[1].estimatedBytes).toBe(3686400);
  });

  it("leaves the unreferenced set untouched when nothing was sampled", () => {
    // The state before any Lake query and after one that sampled nothing: the
    // count key still decides, and no entry gains a byte figure.
    const ranked = rankUnreferencedByVolume(
      ["hipmatch", "globalprotect"],
      [sized("globalprotect", 890000), sized("hipmatch", 12)],
    );

    expect(ranked.map((u) => u.value)).toEqual(["globalprotect", "hipmatch"]);
    expect(ranked.every((u) => !("estimatedBytes" in u))).toBe(true);
  });
});
