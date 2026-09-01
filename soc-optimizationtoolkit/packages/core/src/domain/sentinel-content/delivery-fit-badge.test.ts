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
  DELIVERY_FIT_MEASURING_LABEL,
  DELIVERY_FIT_NOT_FETCHED,
  DELIVERY_FIT_NO_CONNECTOR_LABEL,
  DELIVERY_FIT_UNMEASURED_LABEL,
  deliveryFitBadge,
} from "./delivery-fit-badge";
import type { DeliveryFitEvidence } from "./delivery-fit-badge";
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

/**
 * The states the SELECTED-SOLUTION CARD adds (review finding 2, 2026-09-01).
 * A row never fetches, so "not measured" is the whole story there. The card
 * fetches, and the first attempt handed it a row's badge - so with the fetch
 * COMPLETE and zero connector files found it said "Not measured" about a
 * measurement it had just taken, and offered a tooltip promising the
 * measurement would happen when the solution was selected. Each phase now has
 * its own answer, and each one is pinned.
 */
describe("deliveryFitBadge - the live fetch's four phases", () => {
  const fetched = (
    connectorCount: number,
    ingestion?: { tier: "recommended" | "supported" | "legacy"; kind: string } | null,
  ): DeliveryFitEvidence => ({ phase: "fetched", connectorCount, ingestion });

  it("reports a COMPLETED listing of zero connectors as MEASURED, not unknown", () => {
    // The finding itself. "Fetch complete, none found" is a zero we looked at:
    // the adapter rejects on 401/403 and returns [] only for a folder it read.
    // Calling it "Not measured" is the absent-versus-zero confusion inverted.
    const badge = deliveryFitBadge(null, fetched(0));
    expect(badge.state).toBe("no-connector");
    expect(badge.label).toBe(DELIVERY_FIT_NO_CONNECTOR_LABEL);
    expect(badge.measured).toBe(true);
    expect(badge.label).not.toBe(DELIVERY_FIT_UNMEASURED_LABEL);
    // The assertion is that this reads as something we CHECKED rather than
    // something unknown - "Checked:" replaced "Measured:" when review showed
    // the adapter also resolves [] for a folder it never opened, so claiming a
    // measurement of the folder was itself an overclaim. The PROPERTY the pin
    // exists for is unchanged: a completed listing of zero must not render as
    // "Not measured", which the second assertion nails down directly.
    expect(badge.reason).toMatch(/^Checked:/);
    expect(badge.reason).not.toMatch(/not measured/i);
    expect(badge.reason).not.toMatch(/not measured/i);
  });

  it("does not tell the card its connectors get classified on selection", () => {
    // The exact sentence the review caught: on the card the selection has
    // already happened, so a tooltip promising it as future work describes the
    // past. No phase the card can be in may carry that clause.
    for (const evidence of [
      fetched(0),
      fetched(3),
      fetched(2, { tier: "supported", kind: "RestApiPoller" }),
      { phase: "fetching" } as const,
      { phase: "fetch-failed" } as const,
    ]) {
      expect(deliveryFitBadge(null, evidence).reason).not.toMatch(
        /when the solution is selected/i,
      );
    }
    // ...and the browse row, which genuinely has not looked, still promises it.
    expect(deliveryFitBadge(null, DELIVERY_FIT_NOT_FETCHED).reason).toMatch(
      /when the solution is selected/i,
    );
  });

  it("says a measurement is UNDERWAY while the fetch is in flight", () => {
    const badge = deliveryFitBadge(null, { phase: "fetching" });
    expect(badge.state).toBe("measuring");
    expect(badge.label).toBe(DELIVERY_FIT_MEASURING_LABEL);
    // In flight is neither a measured verdict nor a settled absence of one.
    expect(badge.measured).toBe(false);
    expect(badge.label).not.toBe(DELIVERY_FIT_UNMEASURED_LABEL);
    expect(badge.label).not.toBe(DELIVERY_FIT_NO_CONNECTOR_LABEL);
  });

  it("reports a FAILED fetch as unmeasured, and does not send the operator in a loop", () => {
    const badge = deliveryFitBadge(null, { phase: "fetch-failed" });
    expect(badge.state).toBe("unmeasured");
    expect(badge.measured).toBe(false);
    expect(badge.reason).toMatch(/failed/i);
    expect(badge.reason).toMatch(/retry/i);
  });

  it("classifies LIVE when the fetch decoded connectors the shipped map lacks", () => {
    const badge = deliveryFitBadge(null, fetched(2, { tier: "recommended", kind: "Push" }));
    expect(badge.state).toBe("recommended");
    expect(badge.measured).toBe(true);
    // Says where the verdict came from - the shipped map did not supply it.
    expect(badge.reason).toMatch(/own connector files/i);
  });

  it("stays unmeasured when files were found but none could be read", () => {
    // connectorCount > 0 with no classification is the third fact a missing
    // map entry conflates: the files exist and are unreadable. Not a zero.
    const badge = deliveryFitBadge(null, fetched(4, null));
    expect(badge.state).toBe("unmeasured");
    expect(badge.measured).toBe(false);
    expect(badge.reason).toContain("4 data connector files");
    expect(badge.reason).toMatch(/none of the ones read/i);
    expect(badge.state).not.toBe("no-connector");
  });

  it("treats a cache entry with no ingestion field as unread, not as zero", () => {
    // SolutionDetail.ingestion is optional so entries cached before the field
    // existed still load; undefined there means "no classification stored",
    // which is not the same as "no connector".
    const badge = deliveryFitBadge(null, { phase: "fetched", connectorCount: 1 });
    expect(badge.state).toBe("unmeasured");
    expect(badge.reason).toContain("1 data connector file");
    expect(badge.reason).not.toContain("1 data connector files");
  });
});

describe("deliveryFitBadge - which source wins", () => {
  it("prefers the shipped tier over a live one (the live decode is capped)", () => {
    const badge = deliveryFitBadge(
      { tier: "recommended", kind: "Push" },
      { phase: "fetched", connectorCount: 9, ingestion: { tier: "legacy", kind: "" } },
    );
    expect(badge.state).toBe("recommended");
    expect(badge.reason).not.toMatch(/own connector files/i);
  });

  it("keeps the shipped tier while the live fetch is still running", () => {
    // No flicker from a known tier to "Measuring..." and back.
    expect(
      deliveryFitBadge({ tier: "supported", kind: "GCP" }, { phase: "fetching" }).state,
    ).toBe("supported");
    expect(
      deliveryFitBadge({ tier: "legacy", kind: "" }, { phase: "fetch-failed" }).state,
    ).toBe("legacy");
  });

  it("lets a completed EMPTY listing override the shipped tier", () => {
    // The shipped entry exists only because the generator read >= 1 connector
    // file for that name, so a completed listing of none falsifies its premise
    // - and the card prints "0 connector files" directly under the badge.
    const badge = deliveryFitBadge(
      { tier: "recommended", kind: "Push" },
      { phase: "fetched", connectorCount: 0 },
    );
    expect(badge.state).toBe("no-connector");
    expect(badge.measured).toBe(true);
  });
});

describe("deliveryFitBadge - the invariant the browser relies on", () => {
  it("never returns an empty label, for any input including absence", () => {
    const shippedInputs = [
      null,
      undefined,
      { tier: "recommended" as const, kind: "Push" },
      { tier: "supported" as const, kind: "" },
      { tier: "legacy" as const, kind: "APIPolling" },
    ];
    const evidenceInputs: DeliveryFitEvidence[] = [
      DELIVERY_FIT_NOT_FETCHED,
      { phase: "fetching" },
      { phase: "fetch-failed" },
      { phase: "fetched", connectorCount: 0 },
      { phase: "fetched", connectorCount: 3 },
      { phase: "fetched", connectorCount: 3, ingestion: null },
      { phase: "fetched", connectorCount: 3, ingestion: { tier: "legacy", kind: "" } },
    ];
    for (const shipped of shippedInputs) {
      for (const evidence of evidenceInputs) {
        const badge = deliveryFitBadge(shipped, evidence);
        expect(badge.label).not.toBe("");
        expect(badge.reason).not.toBe("");
        // `measured` and `state` may never disagree: the two unmeasured states
        // are exactly the two that report no look.
        expect(badge.measured).toBe(
          badge.state !== "unmeasured" && badge.state !== "measuring",
        );
      }
    }
  });

  it("defaults to the browse row's evidence when the caller passes none", () => {
    expect(deliveryFitBadge(null)).toEqual(
      deliveryFitBadge(null, DELIVERY_FIT_NOT_FETCHED),
    );
  });
});
