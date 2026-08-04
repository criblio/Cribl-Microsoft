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
  deriveSampleCoverageView,
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
