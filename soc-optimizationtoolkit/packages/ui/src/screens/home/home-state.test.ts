/**
 * Tests for Home's pure decisions (Unit 6.5). The journey decisions
 * themselves are pinned in @soc/core's journey-state tests; these pin the
 * BINDING layer: nextAction mirrored exactly, route/hint joined from the
 * shell links and honest fallbacks.
 */
import { describe, expect, it } from "vitest";
import { nextAction } from "@soc/core";
import type { JourneyFacts } from "@soc/core";
import { SHARED_JOURNEY_LINKS, mergeJourneyLinks } from "../../frame/stepper-state";
import {
  NO_ACTION_FALLBACK,
  currentSetupSection,
  deriveNextActionView,
  journeySummary,
  runsSummary,
  sectionForStage,
  visibleSetupSections,
} from "./home-state";

/** A green azure-only baseline; tests override the facts under exercise. */
function facts(overrides: Partial<JourneyFacts> = {}): JourneyFacts {
  return {
    accepted: true,

    identityPresent: true,
    secretLive: "live",
    scopeCommitted: true,
    ...overrides,
  };
}

describe("deriveNextActionView", () => {
  it("mirrors the core nextAction stage, label, and description exactly", () => {
    const cases: JourneyFacts[] = [
      facts(),
      facts({ accepted: false }),
      facts({}),
      facts({ identityPresent: false }),
      facts({ secretLive: "unknown" }),
      facts({ secretLive: "missing" }),
      facts({ scopeCommitted: false }),
      facts({ criblReachable: false }),
    ];
    for (const f of cases) {
      const core = nextAction(f);
      const view = deriveNextActionView(f, SHARED_JOURNEY_LINKS);
      expect(core).not.toBeNull();
      expect(view).not.toBeNull();
      expect(view?.stageId).toBe(core?.stageId);
      expect(view?.label).toBe(core?.label);
      expect(view?.description).toBe(core?.description);
    }
  });

  it("joins the route and hint from the shell links", () => {
    const view = deriveNextActionView(
      facts({ scopeCommitted: false }),
      SHARED_JOURNEY_LINKS,
    );
    expect(view?.stageId).toBe("target");
    expect(view?.routeId).toBe("home");
    expect(view?.hint).toBe(SHARED_JOURNEY_LINKS.target?.hint);
  });

  it("renders no button when the stage has no route in this shell (local connect)", () => {
    const localLinks = mergeJourneyLinks({
      connect: { hint: "Edit config/local-config.json and restart the host." },
    });
    const view = deriveNextActionView(
      facts({ identityPresent: false, secretLive: "missing" }),
      localLinks,
    );
    expect(view?.stageId).toBe("connect");
    expect(view?.routeId).toBeNull();
    expect(view?.hint).toBe(
      "Edit config/local-config.json and restart the host.",
    );
  });

  it("carries the cloud connect cross-link route (the Setup page's connect section)", () => {
    const cloudLinks = mergeJourneyLinks({
      connect: {
        routeId: "home",
        hint: "Identity entry lives in the App registration and connect section of Setup.",
      },
    });
    const view = deriveNextActionView(
      facts({ secretLive: "unknown" }),
      cloudLinks,
    );
    expect(view?.stageId).toBe("connect");
    expect(view?.routeId).toBe("home");
  });

  it("always has an action now that modes cannot strand the journey", () => {
    // DELIBERATE CHANGE (capability-model-plan step 5). This pinned the opposite:
    // a green cribl-only journey had no shipped integrate surface, so the core
    // returned null and Home fell back. Modes no longer suppress the integrate
    // arc, so a green journey ends at "choose content" instead of nowhere.
    //
    // The null branch and NO_ACTION_FALLBACK are KEPT rather than deleted: the
    // return type still admits null, and a caller that drops the fallback would
    // render an empty card if a future fact ever reintroduces that state.
    const green = facts({ criblReachable: true });
    expect(nextAction(green)?.stageId).toBe("choose-content");
    expect(deriveNextActionView(green, SHARED_JOURNEY_LINKS)).not.toBeNull();
    expect(NO_ACTION_FALLBACK.trim()).not.toBe("");
  });
});


describe("Setup folding decisions (DBT-248)", () => {
  it("maps the stages that live on Setup to their section, and no others", () => {
    expect(sectionForStage("connect")).toBe("azure-connect");
    expect(sectionForStage("target")).toBe("azure-resources");
    expect(sectionForStage("github")).toBe("github-token");
    expect(sectionForStage("accept")).toBeUndefined();
    expect(sectionForStage("deploy")).toBeUndefined();
  });

  it("makes the section the Next action points at current", () => {
    const connect = deriveNextActionView(facts({ secretLive: "missing" }));
    expect(currentSetupSection(connect)).toBe("azure-connect");
    const target = deriveNextActionView(facts({ scopeCommitted: false }));
    expect(currentSetupSection(target)).toBe("azure-resources");
    const github = deriveNextActionView(facts({ tokenRequired: true, tokenPresent: false }));
    expect(currentSetupSection(github)).toBe("github-token");
    expect(currentSetupSection(deriveNextActionView(facts()))).toBeUndefined();
    expect(currentSetupSection(null)).toBeUndefined();
  });

  it("numbers only the sections the connectivity choice leaves on the page", () => {
    expect(visibleSetupSections(facts({ connectivity: "disconnected" }))).toEqual([
      "journey",
      "github-token",
      "sentinel-content",
      "schema-tables",
      "recent-runs",
    ]);
    expect(visibleSetupSections(facts({ connectivity: "partial" }))).toContain("azure-connectivity");
    expect(visibleSetupSections(facts({ connectivity: "full" }))).not.toContain("azure-connectivity");
  });

  it("summarises the journey as the current step, or complete", () => {
    expect(journeySummary(facts({ secretLive: "missing" }))).toMatch(/^Step \d of \d: Connect$/);
    expect(journeySummary(facts())).toBe("Setup complete");
  });

  it("words the run count", () => {
    expect(runsSummary(null)).toBeUndefined();
    expect(runsSummary(0)).toBe("No runs yet");
    expect(runsSummary(1)).toBe("1 run");
    expect(runsSummary(5)).toBe("5 runs");
  });
});
