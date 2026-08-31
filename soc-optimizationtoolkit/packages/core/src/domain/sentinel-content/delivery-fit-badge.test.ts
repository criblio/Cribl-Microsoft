/**
 * Pins for the delivery-fit badge derivation (DBT-15).
 *
 * The case that matters is the ABSENT one. Three tiers were already rendering
 * correctly; the defect was the fourth outcome having no representation at all,
 * so the pins that earn their keep are the ones that fail if `unmeasured` ever
 * goes back to being nothing, and the ones that fail if it is quietly promoted
 * to a measured verdict instead.
 */

import { describe, expect, it } from "vitest";
import {
  DELIVERY_FIT_UNMEASURED_LABEL,
  deliveryFitBadge,
} from "./delivery-fit-badge";
import { lookupSolutionIngestion } from "./ingestion-classification";
import { classifySolutionIngestion, ingestionTierLabel } from "./ingestion-class";

describe("deliveryFitBadge - the measured tiers", () => {
  it("labels a Push solution Recommended and explains the push ingress", () => {
    const badge = deliveryFitBadge({ tier: "recommended", kind: "Push" });
    expect(badge.state).toBe("recommended");
    expect(badge.label).toBe("Recommended");
    expect(badge.measured).toBe(true);
    expect(badge.reason.toLowerCase()).toContain("push");
  });

  it("labels a pull connector Supported and names the kind in the reason", () => {
    const badge = deliveryFitBadge({ tier: "supported", kind: "RestApiPoller" });
    expect(badge.state).toBe("supported");
    expect(badge.label).toBe("Supported");
    expect(badge.measured).toBe(true);
    expect(badge.reason).toContain("RestApiPoller");
  });

  it("labels an agent/Functions connector Legacy", () => {
    const badge = deliveryFitBadge({ tier: "legacy", kind: "" });
    expect(badge.state).toBe("legacy");
    expect(badge.label).toBe("Legacy");
    expect(badge.measured).toBe(true);
    expect(badge.reason).toMatch(/Agent, Azure Functions, or name-only/);
  });
});

describe("deliveryFitBadge - the absent case (the DBT-15 defect)", () => {
  it("returns a badge with a NON-EMPTY label for null", () => {
    // The whole card: a row with no shipped classification used to render
    // nothing. A label that is the empty string, or a null badge, is the bug.
    const badge = deliveryFitBadge(null);
    expect(badge.label).toBe(DELIVERY_FIT_UNMEASURED_LABEL);
    expect(badge.label.length).toBeGreaterThan(0);
    expect(badge.state).toBe("unmeasured");
  });

  it("treats undefined exactly as null - an optional field is still absent", () => {
    expect(deliveryFitBadge(undefined)).toEqual(deliveryFitBadge(null));
  });

  it("says NOT MEASURED, and does not claim the solution does not apply", () => {
    // Getting this backwards - a confident "no fit" about connectors nobody
    // read - is the same defect inverted, so the wording is pinned.
    const badge = deliveryFitBadge(null);
    expect(badge.measured).toBe(false);
    expect(badge.reason).toMatch(/not measured/i);
    expect(badge.reason).toMatch(/not the same as a poor fit or no fit/i);
    expect(badge.reason).not.toMatch(/does not apply/i);
  });

  it("does NOT reuse any of the three measured tier labels", () => {
    // classifySolutionIngestion([]) answers `legacy` for an empty connector
    // list, and borrowing it here would put a measured verdict on unread
    // evidence. Pinned as an inequality against the real labels so a future
    // "just default it to legacy" cannot pass.
    const absent = deliveryFitBadge(null);
    const measuredLabels = (["recommended", "supported", "legacy"] as const).map(
      (tier) => ingestionTierLabel(tier),
    );
    expect(measuredLabels).not.toContain(absent.label);
    expect(absent.label).not.toBe(
      ingestionTierLabel(classifySolutionIngestion([]).tier),
    );
  });

  it("is the answer for the three solutions the live report named", () => {
    // The shipped generator skips a solution with no parseable connector JSON,
    // so these three are genuinely absent from the map rather than misread.
    // If a regenerated map ever classifies one, this pin fails and the fixture
    // - not the assertion - is what should change.
    for (const name of [
      "Palo Alto Cortex XDR",
      "AbuseIPDB",
      "Acronis Cyber Protect Cloud",
    ]) {
      expect(lookupSolutionIngestion(name)).toBeNull();
      expect(deliveryFitBadge(lookupSolutionIngestion(name)).state).toBe(
        "unmeasured",
      );
    }
  });

  it("still measures the siblings that sat beside them in the list", () => {
    // Guards the pin above: a derivation that answered "unmeasured" for
    // everything would satisfy it while destroying the badge column.
    expect(deliveryFitBadge(lookupSolutionIngestion("AbnormalSecurity")).state).toBe(
      "recommended",
    );
    expect(deliveryFitBadge(lookupSolutionIngestion("1Password")).state).toBe(
      "supported",
    );
    expect(deliveryFitBadge(lookupSolutionIngestion("Agent 365")).state).toBe(
      "legacy",
    );
  });
});

describe("deliveryFitBadge - the invariant the browser relies on", () => {
  it("never returns an empty label, for any input including absence", () => {
    const inputs = [
      null,
      undefined,
      { tier: "recommended" as const, kind: "Push" },
      { tier: "supported" as const, kind: "" },
      { tier: "legacy" as const, kind: "APIPolling" },
    ];
    for (const input of inputs) {
      const badge = deliveryFitBadge(input);
      expect(badge.label).not.toBe("");
      expect(badge.reason).not.toBe("");
    }
  });
});
