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
import { compareLogTypeCoverage, deriveExpectedLogTypes } from "@soc/core";
import type { ContentItem } from "@soc/core";
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

describe("deriveLogTypeRecommendation", () => {
  const threeTypes = 'T | where type in ("TRAFFIC","THREAT","CONFIG")';

  it("states what is needed and what is provided", () => {
    const rec = deriveLogTypeRecommendation(
      coverageFor([threeTypes], ["TRAFFIC", "THREAT"]),
      true,
    );

    expect(rec.status).toBe("partial");
    expect(rec.headline).toContain(
      "This solution's detections need CONFIG, THREAT and TRAFFIC.",
    );
    expect(rec.headline).toContain("You have provided THREAT and TRAFFIC.");
  });

  it("marks each expected type provided or not, keeping the core's ranking", () => {
    const rec = deriveLogTypeRecommendation(
      coverageFor(
        // TRAFFIC is referenced by two rules, so it outranks the others.
        ['T | where type == "TRAFFIC"', threeTypes],
        ["TRAFFIC"],
      ),
      true,
    );

    expect(rec.entries.map((e) => e.value)).toEqual([
      "TRAFFIC",
      "CONFIG",
      "THREAT",
    ]);
    expect(rec.entries.map((e) => e.provided)).toEqual([true, false, false]);
    expect(rec.entries[0].referenceCount).toBe(2);
    expect(rec.entries[0].field).toBe("type");
  });

  it("says NOTHING IS PROVIDED rather than showing an empty list", () => {
    const rec = deriveLogTypeRecommendation(coverageFor([threeTypes], []), true);

    expect(rec.status).toBe("none-provided");
    expect(rec.headline).toContain("You have provided none of them yet.");
    // The list is the recommendation - it must be present precisely when
    // nothing has been provided, which is when the operator needs it most.
    expect(rec.entries).toHaveLength(3);
    expect(rec.entries.every((e) => !e.provided)).toBe(true);
  });

  it("reports covered without implying the list is exhaustive", () => {
    const rec = deriveLogTypeRecommendation(
      coverageFor([threeTypes], ["TRAFFIC", "THREAT", "CONFIG"]),
      true,
    );

    expect(rec.status).toBe("covered");
    expect(rec.headline).toContain("You have provided all of them.");
  });

  it("distinguishes NOT-READ from READ-AND-DISCRIMINATES-ON-NOTHING", () => {
    // The false-ok this codebase refuses: an unread solution must not read as
    // "nothing needed", and neither state may produce an entry list.
    const unread = deriveLogTypeRecommendation(coverageFor([], ["traffic"]), false);
    expect(unread.status).toBe("unknown");
    expect(unread.headline).toContain("has not completed yet");
    expect(unread.entries).toEqual([]);

    const noSignal = deriveLogTypeRecommendation(
      coverageFor(["T | count"], ["traffic"]),
      true,
    );
    expect(noSignal.status).toBe("no-signal");
    expect(noSignal.headline).toContain("cannot say which log types it needs");
    expect(noSignal.entries).toEqual([]);
    expect(noSignal.headline).not.toContain("need TRAFFIC");
  });

  it("carries unreferenced provided types in EVERY state, never as a gap", () => {
    const covered = deriveLogTypeRecommendation(
      coverageFor(['T | where type == "traffic"'], ["traffic", "hipmatch"]),
      true,
    );
    expect(covered.status).toBe("covered");
    expect(covered.unreferenced).toEqual(["hipmatch"]);

    // Also surfaced before the content is read - the operator has provided it
    // either way, and hiding it would look like it had been dropped.
    const unread = deriveLogTypeRecommendation(
      coverageFor([], ["traffic", "hipmatch"]),
      false,
    );
    expect(unread.unreferenced).toEqual(["traffic", "hipmatch"]);
  });

  it("AGREES with the confirmation view - both read one coverage result", () => {
    // The two halves are shown on the same screen; a disagreement between them
    // is the failure this pins against.
    const coverage = coverageFor([threeTypes], ["TRAFFIC"]);
    const rec = deriveLogTypeRecommendation(coverage, true);
    const view = deriveSampleCoverageView(coverage, true, 1);

    const notProvided = rec.entries.filter((e) => !e.provided).map((e) => e.value);
    expect(notProvided).toEqual(view.missing);
    expect(rec.unreferenced).toEqual(view.unreferenced);
  });

  it("gates nothing: the confirmation owns the only acknowledgement", () => {
    const rec = deriveLogTypeRecommendation(coverageFor([threeTypes], []), true);
    // A structural claim, so it is asserted rather than assumed: the
    // recommendation model carries no gate, reason, or acknowledgement field.
    expect(Object.keys(rec).sort()).toEqual([
      "entries",
      "headline",
      "status",
      "unreferenced",
    ]);
  });
});

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
