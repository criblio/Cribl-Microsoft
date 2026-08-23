/**
 * Tests for the Sample Data completeness confirmation (user request
 * 2026-08-04). The honesty rules being pinned:
 *   - "not analyzed yet" must never render as "covered";
 *   - a solution whose detections discriminate on nothing must say so rather
 *     than claim completeness;
 *   - the acknowledgement is required even when no gaps were found, because
 *     the derivation is a lower bound and only the operator knows the rest;
 *   - provided-but-unreferenced log types are never treated as a problem.
 */
import { describe, expect, it } from "vitest";
import {
  compareLogTypeCoverage,
  deriveExpectedLogTypes,
  documentedLogTypesForSolution,
  mergeLogTypeSources,
  rankUnreferencedByVolume,
} from "@soc/core";
import type { ContentItem, LogTypeVolume } from "@soc/core";
import {
  deriveLogTypeRecommendation,
  deriveSampleCoverageView,
  joinNames,
  packShapeSummary,
  sampleCoverageGateReason,
} from "./sample-coverage-state";

const rule = (name: string, query: string): ContentItem => ({
  type: "alert-rule",
  id: name,
  name,
  queries: [query],
});

const coverageFor = (queries: string[], provided: string[]) =>
  compareLogTypeCoverage(
    deriveExpectedLogTypes(queries.map((q, i) => rule(`R${i}`, q))),
    provided,
  );

describe("packShapeSummary", () => {
  it("states the concrete route and pipeline counts", () => {
    const out = packShapeSummary(3);
    expect(out).toContain("3 log types");
    expect(out).toContain("6 routes");
    expect(out).toContain("6 pipelines");
  });

  it("says the pack has nothing to route with no samples", () => {
    expect(packShapeSummary(0)).toContain("nothing to route");
  });

  it("uses the singular for one log type", () => {
    expect(packShapeSummary(1)).toContain("1 log type tagged");
  });
});

describe("deriveSampleCoverageView", () => {
  it("reads 'unknown' before content is analyzed, and needs no acknowledgement yet", () => {
    const view = deriveSampleCoverageView(coverageFor([], ["traffic"]), false, 1);
    expect(view.verdict).toBe("unknown");
    expect(view.requiresAck).toBe(false);
    // The load-bearing honesty: unanalyzed must not look covered.
    expect(view.headline).not.toContain("Every log type");
  });

  it("distinguishes 'no signal' from 'covered'", () => {
    const view = deriveSampleCoverageView(
      coverageFor(["T | count"], ["traffic"]),
      true,
      1,
    );
    expect(view.verdict).toBe("no-signal");
    expect(view.headline).toContain("nothing to compare against");
    // Still asks, because only the operator knows if more log types exist.
    expect(view.requiresAck).toBe(true);
  });

  it("reports gaps with the missing names and the route consequence", () => {
    const view = deriveSampleCoverageView(
      coverageFor(['T | where type in ("traffic","threat","system")'], ["traffic"]),
      true,
      1,
    );
    expect(view.verdict).toBe("gaps");
    expect(view.missing).toEqual(["system", "threat"]);
    expect(view.headline).toContain("never shaped");
    expect(view.requiresAck).toBe(true);
  });

  it("still requires acknowledgement when everything is covered", () => {
    const view = deriveSampleCoverageView(
      coverageFor(['T | where type == "traffic"'], ["traffic"]),
      true,
      1,
    );
    expect(view.verdict).toBe("covered");
    expect(view.requiresAck).toBe(true);
  });

  it("passes unreferenced log types through without calling them missing", () => {
    const view = deriveSampleCoverageView(
      coverageFor(['T | where type == "traffic"'], ["traffic", "hipmatch"]),
      true,
      2,
    );
    expect(view.verdict).toBe("covered");
    expect(view.missing).toEqual([]);
    expect(view.unreferenced).toEqual(["hipmatch"]);
  });

  it("does not ask for an acknowledgement with no samples and no signal", () => {
    const view = deriveSampleCoverageView(coverageFor(["T | count"], []), true, 0);
    expect(view.requiresAck).toBe(false);
  });
});

describe("joinNames", () => {
  it("reads as prose at one, two and three names", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["TRAFFIC"])).toBe("TRAFFIC");
    expect(joinNames(["TRAFFIC", "THREAT"])).toBe("TRAFFIC and THREAT");
    expect(joinNames(["TRAFFIC", "THREAT", "CONFIG"])).toBe(
      "TRAFFIC, THREAT and CONFIG",
    );
  });
});

/**
 * Build the recommendation the way integrate-screen does: derive the expected
 * log types from content, merge the vendor tier in, then project. Going through
 * mergeLogTypeSources rather than hand-building entries keeps these pins honest
 * about the real path.
 */
function recFor(
  queries: string[],
  provided: string[],
  opts: {
    solution?: string;
    contentLoaded?: boolean;
    /** Measured volumes, as a Lake query would supply them (plan Phase 5). */
    volumes?: LogTypeVolume[];
    window?: { earliest: string; latest: string };
  } = {},
) {
  const items = queries.map((q, i) => rule(`R${i}`, q));
  const expected = deriveExpectedLogTypes(items);
  const coverage = compareLogTypeCoverage(expected, provided);
  const volumes = opts.volumes ?? [];
  const merged = mergeLogTypeSources({
    expected,
    vendorLogTypes: documentedLogTypesForSolution(opts.solution ?? ""),
    provided,
    volumes,
  });
  return deriveLogTypeRecommendation(
    merged,
    rankUnreferencedByVolume(coverage.unreferenced, volumes),
    opts.contentLoaded ?? items.length > 0,
    opts.window,
  );
}

describe("deriveLogTypeRecommendation", () => {
  const threeTypes = 'T | where type in ("TRAFFIC","THREAT","CONFIG")';

  it("states what is needed and what is provided", () => {
    const rec = recFor([threeTypes], ["TRAFFIC", "THREAT"], { contentLoaded: true });

    expect(rec.status).toBe("partial");
    expect(rec.headline).toContain(
      "This solution's content needs CONFIG, THREAT and TRAFFIC.",
    );
    expect(rec.headline).toContain("You have provided THREAT and TRAFFIC.");
  });

  it("marks each expected type provided or not, keeping the core's ranking", () => {
    // TRAFFIC is referenced by two rules, so it outranks the others.
    const rec = recFor(['T | where type == "TRAFFIC"', threeTypes], ["TRAFFIC"], {
      contentLoaded: true,
    });

    expect(rec.entries.map((e) => e.value)).toEqual([
      "TRAFFIC",
      "CONFIG",
      "THREAT",
    ]);
    expect(rec.entries.map((e) => e.provided)).toEqual([true, false, false]);
    expect(rec.entries[0].referenceCount).toBe(2);
    expect(rec.entries[0].field).toBe("type");
    expect(rec.entries.every((e) => e.evidence === "detection")).toBe(true);
  });

  it("says NOTHING IS PROVIDED rather than showing an empty list", () => {
    const rec = recFor([threeTypes], [], { contentLoaded: true });

    expect(rec.status).toBe("none-provided");
    expect(rec.headline).toContain("You have provided none of them yet.");
    // The list is the recommendation - it must be present precisely when
    // nothing has been provided, which is when the operator needs it most.
    expect(rec.entries).toHaveLength(3);
    expect(rec.entries.every((e) => !e.provided)).toBe(true);
  });

  it("reports covered without implying the list is exhaustive", () => {
    const rec = recFor([threeTypes], ["TRAFFIC", "THREAT", "CONFIG"], { contentLoaded: true });

    expect(rec.status).toBe("covered");
    expect(rec.headline).toContain("You have provided all of them.");
  });

  it("distinguishes NOT-READ from READ-AND-DISCRIMINATES-ON-NOTHING", () => {
    // The false-ok this codebase refuses: an unread solution must not read as
    // "nothing needed", and neither state may produce an entry list.
    const unread = recFor([], ["traffic"], { contentLoaded: false });
    expect(unread.status).toBe("unknown");
    expect(unread.headline).toContain("has not completed yet");
    expect(unread.entries).toEqual([]);

    const noSignal = recFor(["T | count"], ["traffic"], { contentLoaded: true });
    expect(noSignal.status).toBe("no-signal");
    expect(noSignal.headline).toContain("cannot say which log types it needs");
    expect(noSignal.entries).toEqual([]);
    expect(noSignal.headline).not.toContain("need TRAFFIC");
  });

  it("carries unreferenced provided types in EVERY state, never as a gap", () => {
    const covered = recFor(['T | where type == "traffic"'], ["traffic", "hipmatch"], { contentLoaded: true });
    expect(covered.status).toBe("covered");
    expect(covered.unreferenced).toEqual([{ value: "hipmatch" }]);

    // Also surfaced before the content is read - the operator has provided it
    // either way, and hiding it would look like it had been dropped.
    const unread = recFor([], ["traffic", "hipmatch"], { contentLoaded: false });
    expect(unread.unreferenced).toEqual([
      { value: "traffic" },
      { value: "hipmatch" },
    ]);
    // UNMEASURED CARRIES NO COUNT. Not 0, not null - the key is absent, so
    // nothing downstream can render a volume nobody measured.
    expect(
      unread.unreferenced.every((u) => !("eventCount" in u)),
    ).toBe(true);
  });

  it("AGREES with the confirmation view on the CONTENT tier", () => {
    // The two halves are shown on the same screen; a disagreement between them
    // is the failure this pins against.
    //
    // Narrowed to the content tier on purpose (2026-08-19): the confirmation
    // gates the build on what the SOLUTION'S CONTENT requires, so a vendor-
    // documented feed nobody's rules mention must NOT become a missing item
    // there - that would gate a build on a catalog entry. The recommendation
    // still shows it; only the gate ignores it.
    const coverage = coverageFor([threeTypes], ["TRAFFIC"]);
    const rec = recFor([threeTypes], ["TRAFFIC"], {
      solution: "Palo Alto Networks",
      contentLoaded: true,
    });
    const view = deriveSampleCoverageView(coverage, true, 1);

    const contentNotProvided = rec.entries
      .filter((e) => e.evidence !== "vendor" && !e.provided)
      .map((e) => e.value);
    expect(contentNotProvided).toEqual(view.missing);
    // Compared by VALUE: the recommendation half now carries volumes and the
    // confirmation half deliberately does not, so the agreement being pinned
    // is about WHICH log types are unreferenced, not about the shape.
    expect(rec.unreferenced.map((u) => u.value)).toEqual(view.unreferenced);
    // And the vendor tier really is present, so this is a narrowing rather
    // than a test that passes because nothing was merged.
    expect(rec.entries.some((e) => e.evidence === "vendor")).toBe(true);
  });

  it("never reports a VERDICT while the content read is still in flight", () => {
    // 2026-08-20 audit. The vendor tier resolves from the solution NAME, which
    // is known the instant a solution is picked - before the content fetch
    // returns. The guard briefly allowed a vendor-only merge through, so a Palo
    // Alto solution announced "ships no detections that name a log type" before
    // a single rule had been read. Same race class as 1.11.14.
    const rec = recFor([], [], {
      solution: "Palo Alto Networks",
      contentLoaded: false,
    });

    expect(rec.status).toBe("unknown");
    // The vendor list is real and still shown - it is what the operator would
    // act on - but under a headline that says the read is unfinished.
    expect(rec.entries.length).toBeGreaterThan(0);
    expect(rec.entries.every((e) => e.evidence === "vendor")).toBe(true);
    expect(rec.headline).toContain("Still reading this solution's content");
    expect(rec.headline).toContain("not known yet");
    // The verdict sentences must NOT appear.
    expect(rec.headline).not.toContain("ships no detections");
    expect(rec.headline).not.toContain("content needs");
  });

  it("gates nothing: the confirmation owns the only acknowledgement", () => {
    const rec = recFor([threeTypes], [], { contentLoaded: true });
    // A structural claim, so it is asserted rather than assumed: the
    // recommendation model carries no gate, reason, or acknowledgement field.
    expect(Object.keys(rec).sort()).toEqual([
      "entries",
      "headline",
      "status",
      "unreferenced",
    ]);

    // And it stays gateless once volumes arrive - the ONLY key Phase 5 adds is
    // the window those volumes were measured over. Asserted against a fixed
    // allow-list so a future gate field cannot slip in behind a volume.
    const withVolumes = recFor([threeTypes], [], {
      contentLoaded: true,
      volumes: [{ logType: "TRAFFIC", eventCount: 5 }],
      window: { earliest: "-24h", latest: "now" },
    });
    expect(Object.keys(withVolumes).sort()).toEqual([
      "entries",
      "headline",
      "status",
      "unreferenced",
      "volumeWindow",
    ]);
  });
});

describe("measured volume on the recommendation (plan Phase 5)", () => {
  const threeTypes = 'T | where type in ("TRAFFIC","THREAT","CONFIG")';

  it("carries the count through to the entry the operator reads", () => {
    const rec = recFor([threeTypes], [], {
      contentLoaded: true,
      volumes: [
        { logType: "THREAT", eventCount: 890000 },
        { logType: "TRAFFIC", eventCount: 12 },
      ],
      window: { earliest: "-24h", latest: "now" },
    });

    const byValue = new Map(rec.entries.map((e) => [e.value, e]));
    expect(byValue.get("THREAT")?.eventCount).toBe(890000);
    expect(byValue.get("TRAFFIC")?.eventCount).toBe(12);
    // CONFIG was in the content but not in the dataset - unmeasured, and it
    // must not acquire a zero on the way through the projection.
    expect("eventCount" in (byValue.get("CONFIG") ?? {})).toBe(false);
  });

  it("ranks the busiest first, and says over what window", () => {
    const rec = recFor([threeTypes], [], {
      contentLoaded: true,
      volumes: [
        { logType: "CONFIG", eventCount: 1 },
        { logType: "THREAT", eventCount: 890000 },
      ],
      window: { earliest: "-24h", latest: "now" },
    });

    expect(rec.entries[0].value).toBe("THREAT");
    expect(rec.volumeWindow).toEqual({ earliest: "-24h", latest: "now" });
  });

  it("carries NO window when nothing was measured", () => {
    // A window with no counts under it would qualify a claim nobody made.
    const rec = recFor([threeTypes], [], { contentLoaded: true });

    expect(rec.volumeWindow).toBeUndefined();
    expect(rec.entries.every((e) => !("eventCount" in e))).toBe(true);
  });

  it("ranks the UNREFERENCED set by volume - the Phase 5 finding", () => {
    // "GLOBALPROTECT - 890K events, nothing consumes it" is the shape the plan
    // named. It arrives as ORDER plus a NUMBER, never as a flagged finding.
    const rec = recFor(['T | where type == "TRAFFIC"'], ["traffic", "hipmatch", "globalprotect"], {
      contentLoaded: true,
      volumes: [
        { logType: "hipmatch", eventCount: 12 },
        { logType: "globalprotect", eventCount: 890000 },
      ],
      window: { earliest: "-24h", latest: "now" },
    });

    expect(rec.unreferenced.map((u) => u.value)).toEqual([
      "globalprotect",
      "hipmatch",
    ]);
    expect(rec.unreferenced[0].eventCount).toBe(890000);
    // NEUTRAL STILL. A volume must not promote an unreferenced log type into a
    // gap, a warning, or the headline - it is a note that now has a number.
    expect(rec.status).toBe("covered");
    expect(rec.headline).not.toContain("globalprotect");
    expect(rec.headline).not.toContain("890");
  });

  it("shows volumes even while the content read is unfinished", () => {
    // The vendor tier renders during the read; a volume measured against the
    // operator's own dataset is no less true for the content being in flight.
    const rec = recFor([], [], {
      solution: "Palo Alto Networks",
      contentLoaded: false,
      volumes: [{ logType: rec0VendorValue(), eventCount: 77 }],
      window: { earliest: "-24h", latest: "now" },
    });

    expect(rec.status).toBe("unknown");
    expect(rec.entries.some((e) => e.eventCount === 77)).toBe(true);
    expect(rec.volumeWindow).toBeDefined();
  });
});

/** The first vendor-documented log type for the fixture solution. */
function rec0VendorValue(): string {
  const vendor = documentedLogTypesForSolution("Palo Alto Networks");
  expect(vendor.length).toBeGreaterThan(0);
  return vendor[0].value;
}

describe("sampleCoverageGateReason", () => {
  const gaps = deriveSampleCoverageView(
    coverageFor(['T | where type in ("traffic","threat")'], ["traffic"]),
    true,
    1,
  );
  const covered = deriveSampleCoverageView(
    coverageFor(['T | where type == "traffic"'], ["traffic"]),
    true,
    1,
  );

  it("blocks with a gap-specific reason until acknowledged", () => {
    expect(sampleCoverageGateReason(gaps, false)).toContain(
      "some referenced log types have no sample",
    );
    expect(sampleCoverageGateReason(gaps, true)).toBeNull();
  });

  it("blocks with the completeness question when nothing is missing", () => {
    expect(sampleCoverageGateReason(covered, false)).toContain(
      "no more unique log types",
    );
    expect(sampleCoverageGateReason(covered, true)).toBeNull();
  });

  it("never blocks before the content has been analyzed", () => {
    const unknown = deriveSampleCoverageView(coverageFor([], []), false, 0);
    expect(sampleCoverageGateReason(unknown, false)).toBeNull();
  });
});
