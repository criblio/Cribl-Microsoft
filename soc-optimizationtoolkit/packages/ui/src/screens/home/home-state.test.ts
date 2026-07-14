/**
 * Tests for Home's pure decisions (Unit 6.5). The journey decisions
 * themselves are pinned in @soc/core's journey-state tests; these pin the
 * BINDING layer: nextAction mirrored exactly, route/hint joined from the
 * shell links, honest fallbacks, and the one-source mode note.
 */
import { describe, expect, it } from "vitest";
import { APP_MODES, nextAction } from "@soc/core";
import type { JourneyFacts } from "@soc/core";
import { MODE_LABELS, MODE_OPTIONS } from "../../frame/frame-state";
import { SHARED_JOURNEY_LINKS, mergeJourneyLinks } from "../../frame/stepper-state";
import {
  NO_ACTION_FALLBACK,
  deriveNextActionView,
  modeNoteFor,
} from "./home-state";

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

describe("deriveNextActionView", () => {
  it("mirrors the core nextAction stage, label, and description exactly", () => {
    const cases: JourneyFacts[] = [
      facts(),
      facts({ accepted: false }),
      facts({ mode: null }),
      facts({ identityPresent: false }),
      facts({ secretLive: "unknown" }),
      facts({ secretLive: "missing" }),
      facts({ scopeCommitted: false }),
      facts({ mode: "full", criblReachable: false }),
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

  it("is null exactly when the core reports nothing actionable", () => {
    // cribl-only with a proven Cribl link: first-run arc green, integrate
    // surfaces unshipped -> the core returns null and Home falls back.
    const view = deriveNextActionView(
      facts({ mode: "cribl-only", criblReachable: true }),
      SHARED_JOURNEY_LINKS,
    );
    expect(
      nextAction(facts({ mode: "cribl-only", criblReachable: true })),
    ).toBeNull();
    expect(view).toBeNull();
    expect(NO_ACTION_FALLBACK.trim()).not.toBe("");
  });
});

describe("modeNoteFor", () => {
  it("reuses MODE_LABELS and the MODE_OPTIONS descriptions (one source)", () => {
    for (const mode of APP_MODES) {
      const option = MODE_OPTIONS.find((o) => o.mode === mode);
      expect(modeNoteFor(mode)).toBe(
        `${MODE_LABELS[mode]}: ${option?.description}`,
      );
    }
  });

  it("states a missing mode honestly", () => {
    expect(modeNoteFor(null)).toBe("No operating mode is chosen yet.");
  });
});
