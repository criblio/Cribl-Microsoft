/**
 * Contract tests for fallback routing (capability-model-plan step 4).
 *
 * The pin that matters most is the forced/offered split, because it is where the
 * plan's own words pull in two directions: "force it from a permission verdict"
 * versus "the audit informs and offers, it never forbids". Unreachable forces
 * (there is nowhere to send the request); denied only offers (the live attempt
 * survives, and Azure's 403 is the real gate).
 */
import { describe, expect, it } from "vitest";

import {
  artifactsToOffer,
  mustProduceArtifacts,
  routeCapability,
} from "./fallback-routing";
import { emptyCapabilitySet } from "./capabilities";
import type { CapabilityContext, CapabilitySet } from "./capabilities";

const connected: CapabilityContext = {
  azureIdentityPresent: true,
  criblReachable: true,
};
const noCribl: CapabilityContext = {
  azureIdentityPresent: true,
  criblReachable: false,
};

const audited = (verdicts: CapabilitySet["verdicts"]): CapabilitySet => ({
  verdicts,
  auditedAt: "2026-08-06T00:00:00Z",
  connectionId: "conn-1",
});

describe("routeCapability", () => {
  it("routes a granted capability live, with no artifact", () => {
    const routed = routeCapability("dcr.write", audited({ "dcr.write": "granted" }), connected);
    expect(routed.routing).toBe("live");
    expect(routed.fallback).toBeNull();
  });

  it("routes an UNKNOWN capability live", () => {
    // Not having measured is not a reason to degrade someone's output. The whole
    // point of the model is that a stale or absent audit costs an annotation,
    // never the ability to work.
    const routed = routeCapability("dcr.write", emptyCapabilitySet(), connected);
    expect(routed.routing).toBe("live");
    expect(routed.fallback).toBeNull();
  });

  it("OFFERS on a measured denial - it does not force", () => {
    // Rule 3. The live attempt survives a denial; the artifact comes with it.
    const routed = routeCapability("dcr.write", audited({ "dcr.write": "denied" }), connected);
    expect(routed.routing).toBe("offer");
    expect(routed.fallback?.kind).toBe("dcr-arm-bodies");
  });

  it("FORCES the artifact when there is nowhere to send the request", () => {
    const routed = routeCapability("pack.manage", emptyCapabilitySet(), noCribl);
    expect(routed.routing).toBe("artifact");
    expect(routed.fallback?.kind).toBe("cribl-pack");
  });

  it("offers nothing for a blocked READ, honestly", () => {
    const routed = routeCapability(
      "workspace.read",
      audited({ "workspace.read": "denied" }),
      connected,
    );
    expect(routed.routing).toBe("offer");
    expect(routed.fallback).toBeNull();
  });
});

describe("mustProduceArtifacts", () => {
  it("is true when a required capability is unreachable", () => {
    // Preserves what the old mode check did: !hasCribl(mode) meant no live Cribl
    // connection, which is destination.manage unreachable.
    expect(
      mustProduceArtifacts(["dcr.write", "destination.manage"], emptyCapabilitySet(), noCribl),
    ).toBe(true);
  });

  it("is FALSE for a denied capability", () => {
    // The load-bearing difference. Forcing here would forbid the live attempt
    // and contradict rule 3 - a stale audit would silently downgrade a deploy.
    expect(
      mustProduceArtifacts(
        ["dcr.write"],
        audited({ "dcr.write": "denied" }),
        connected,
      ),
    ).toBe(false);
  });

  it("is false when everything is granted or merely unmeasured", () => {
    expect(mustProduceArtifacts(["dcr.write"], emptyCapabilitySet(), connected)).toBe(false);
    expect(
      mustProduceArtifacts(["dcr.write"], audited({ "dcr.write": "granted" }), connected),
    ).toBe(false);
  });

  it("is false for an empty requirement list", () => {
    expect(mustProduceArtifacts([], emptyCapabilitySet(), noCribl)).toBe(false);
  });
});

describe("artifactsToOffer", () => {
  it("de-duplicates by kind", () => {
    // The three Cribl management capabilities share the pack; a run must not
    // offer the same download three times.
    const offers = artifactsToOffer(
      ["pack.manage", "destination.manage", "source.manage"],
      emptyCapabilitySet(),
      noCribl,
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]!.kind).toBe("cribl-pack");
  });

  it("keeps distinct artifacts, in the caller's order", () => {
    const offers = artifactsToOffer(
      ["table.write", "dcr.write"],
      audited({ "table.write": "denied", "dcr.write": "denied" }),
      connected,
    );
    expect(offers.map((offer) => offer.kind)).toEqual([
      "table-arm-bodies",
      "dcr-arm-bodies",
    ]);
  });

  it("offers nothing when everything is workable", () => {
    expect(
      artifactsToOffer(["dcr.write"], audited({ "dcr.write": "granted" }), connected),
    ).toEqual([]);
  });
});
