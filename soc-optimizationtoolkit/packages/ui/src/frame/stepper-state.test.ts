/**
 * Tests for the stepper's pure decisions (Unit 6.5). Stages come from the
 * REAL @soc/core deriveJourney so the binding rules are exercised against
 * the actual journey output, not hand-built stage shapes.
 */
import { describe, expect, it } from "vitest";
import { deriveJourney } from "@soc/core";
import type { JourneyFacts, JourneyStage } from "@soc/core";
import {
  SHARED_JOURNEY_LINKS,
  buildStepperItems,
  mergeJourneyLinks,
} from "./stepper-state";
import type { JourneyLinks } from "./stepper-state";

/** A green azure-only baseline; tests override the facts under exercise. */
function facts(overrides: Partial<JourneyFacts> = {}): JourneyFacts {
  return {
    accepted: true,
    mode: "azure-only",
    identityPresent: true,
    secretLive: "live",
    scopeCommitted: true,
    ...overrides,
  };
}

function stage(stages: readonly JourneyStage[], id: string): JourneyStage {
  const found = stages.find((s) => s.id === id);
  if (found === undefined) {
    throw new Error(`stage ${id} not in list`);
  }
  return found;
}

describe("buildStepperItems", () => {
  it("passes label and status through untouched with 1-based numbering", () => {
    const journey = deriveJourney(facts());
    const items = buildStepperItems(journey.firstRun, SHARED_JOURNEY_LINKS);
    expect(items.map((i) => i.id)).toEqual(journey.firstRun.map((s) => s.id));
    expect(items.map((i) => i.label)).toEqual(
      journey.firstRun.map((s) => s.label),
    );
    expect(items.map((i) => i.status)).toEqual(
      journey.firstRun.map((s) => s.status),
    );
    expect(items.map((i) => i.index)).toEqual(
      journey.firstRun.map((_, i) => i + 1),
    );
  });

  it("never routes a not-yet-available stage, even when a link binds one", () => {
    const journey = deriveJourney(facts());
    const validate = stage(journey.integrate, "validate");
    expect(validate.status).toBe("not-yet-available");
    const [item] = buildStepperItems([validate], {
      validate: { routeId: "somewhere" },
    });
    expect(item?.routeId).toBeNull();
  });

  it("renders the review stage unlinked (the standalone Review screen is retired)", () => {
    const journey = deriveJourney(facts());
    const review = stage(journey.integrate, "review");
    expect(review.status).toBe("available");
    const [item] = buildStepperItems([review], SHARED_JOURNEY_LINKS);
    expect(item?.routeId).toBeNull();
    expect(item?.hint).toBe(SHARED_JOURNEY_LINKS.review?.hint);
  });

  it("keeps the route on blocked stages (read-ahead: navigable, gated at commit)", () => {
    // Scope not committed: deploy is blocked but must stay navigable.
    const journey = deriveJourney(facts({ scopeCommitted: false }));
    const deploy = stage(journey.integrate, "deploy");
    expect(deploy.status).toBe("blocked");
    const [item] = buildStepperItems([deploy], SHARED_JOURNEY_LINKS);
    expect(item?.routeId).toBe("dcr-automation");
  });

  it("prefers blockedReason over the link hint, falls back to the link hint, else null", () => {
    const journey = deriveJourney(facts({ scopeCommitted: false }));
    const deploy = stage(journey.integrate, "deploy");
    const chooseContent = stage(journey.integrate, "choose-content");
    const accept = stage(journey.firstRun, "accept");
    const links: JourneyLinks = mergeJourneyLinks({
      deploy: { hint: "link hint that must lose" },
    });
    const [deployItem] = buildStepperItems([deploy], links);
    expect(deployItem?.hint).toBe(deploy.blockedReason);
    const [chooseItem] = buildStepperItems([chooseContent], links);
    expect(chooseItem?.hint).toBe(SHARED_JOURNEY_LINKS["choose-content"]?.hint);
    const [acceptItem] = buildStepperItems([accept], {});
    expect(acceptItem?.hint).toBeNull();
  });

  it("renders unlinked stages as non-clickable (routeId null)", () => {
    const journey = deriveJourney(facts());
    const items = buildStepperItems(journey.firstRun, {});
    for (const item of items) {
      expect(item.routeId).toBeNull();
    }
  });
});

describe("mergeJourneyLinks", () => {
  it("starts from the shared bindings when no overrides are given", () => {
    expect(mergeJourneyLinks()).toEqual(SHARED_JOURNEY_LINKS);
  });

  it("merges per stage: an override hint keeps the shared route", () => {
    const merged = mergeJourneyLinks({ target: { hint: "extra guidance" } });
    expect(merged.target?.routeId).toBe(
      SHARED_JOURNEY_LINKS.target?.routeId,
    );
    expect(merged.target?.hint).toBe("extra guidance");
  });

  it("adds shell-specific stages (connect differs per shell by design)", () => {
    const cloud = mergeJourneyLinks({
      connect: { routeId: "harness", hint: "Identity entry: Diagnostics panel 3." },
    });
    expect(cloud.connect).toEqual({
      routeId: "harness",
      hint: "Identity entry: Diagnostics panel 3.",
    });
    const local = mergeJourneyLinks({
      connect: { hint: "Edit config/local-config.json and restart the host." },
    });
    expect(local.connect?.routeId).toBeUndefined();
  });

  it("never mutates the shared bindings or the overrides", () => {
    const before = JSON.stringify(SHARED_JOURNEY_LINKS);
    const overrides: JourneyLinks = { target: { hint: "x" } };
    mergeJourneyLinks(overrides);
    expect(JSON.stringify(SHARED_JOURNEY_LINKS)).toBe(before);
    expect(overrides).toEqual({ target: { hint: "x" } });
  });
});

describe("SHARED_JOURNEY_LINKS", () => {
  it("binds only stage ids that exist in the journey model", () => {
    const journey = deriveJourney(facts());
    const known = new Set(
      [...journey.firstRun, ...journey.integrate].map((s) => s.id),
    );
    for (const id of Object.keys(SHARED_JOURNEY_LINKS)) {
      expect(known.has(id as never)).toBe(true);
    }
  });

  it("does not bind connect (shell-specific by design - props, not prose)", () => {
    expect(SHARED_JOURNEY_LINKS.connect).toBeUndefined();
  });
});
