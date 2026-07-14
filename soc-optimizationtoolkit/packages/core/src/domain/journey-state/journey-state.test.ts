/**
 * Contract tests for the journey-state module (ux-flow-plan 4.1, Unit 6.5):
 *   - stage lists are fixed per mode (artifact modes skip live-connection
 *     stages entirely; facts never change which stages exist)
 *   - full fact-matrix invariants: at most one 'current' across both arcs,
 *     nextAction mirrors it exactly, blockedReason discipline
 *   - the azure-only status matrix row by row (literal expectations)
 *   - honesty: an 'unknown' secret never renders connect as complete, and
 *     the secret chip hedges instead of claiming ok
 *   - read-ahead: later blocked stages never hide or block earlier ones,
 *     and navigability never depends on later stages
 *   - next-action derivation follows the single-next-action hint cascade
 */
import { describe, expect, it } from "vitest";
import {
  APP_MODES,
  FIRST_RUN_ARC,
  INTEGRATE_ARC,
  JOURNEY_STAGE_LABELS,
  UNSHIPPED_INTEGRATE_STAGES,
  deriveJourney,
  firstRunStageIds,
  nextAction,
  readinessChips,
} from "../../index";
import type {
  AppMode,
  Journey,
  JourneyFacts,
  JourneyStage,
  JourneyStageId,
  SecretLiveness,
  StageStatus,
} from "../../index";

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

function allStages(journey: Journey): JourneyStage[] {
  return [...journey.firstRun, ...journey.integrate];
}

function stageOf(journey: Journey, id: JourneyStageId): JourneyStage {
  const found = allStages(journey).find((s) => s.id === id);
  if (found === undefined) {
    throw new Error(`stage ${id} not present in journey`);
  }
  return found;
}

function statusOf(journey: Journey, id: JourneyStageId): StageStatus {
  return stageOf(journey, id).status;
}

const SECRET_STATES: readonly SecretLiveness[] = ["live", "unknown", "missing"];
const CRIBL_STATES: readonly (boolean | undefined)[] = [true, false, undefined];
const BOOLS: readonly boolean[] = [true, false];

/** Every fact combination: 5 modes x 2 x 2 x 3 x 2 x 3 = 360 records. */
function everyFactCombination(): JourneyFacts[] {
  const combos: JourneyFacts[] = [];
  for (const mode of [null, ...APP_MODES] as (AppMode | null)[]) {
    for (const accepted of BOOLS) {
      for (const identityPresent of BOOLS) {
        for (const secretLive of SECRET_STATES) {
          for (const scopeCommitted of BOOLS) {
            for (const criblReachable of CRIBL_STATES) {
              combos.push({
                accepted,
                mode,
                identityPresent,
                secretLive,
                scopeCommitted,
                criblReachable,
              });
            }
          }
        }
      }
    }
  }
  return combos;
}

describe("arc constants", () => {
  it("fixes the first-run arc order", () => {
    expect(FIRST_RUN_ARC).toEqual([
      "accept",
      "choose-mode",
      "connect",
      "target",
      "ready",
    ]);
  });

  it("fixes the integrate arc order", () => {
    expect(INTEGRATE_ARC).toEqual([
      "choose-content",
      "configure",
      "review",
      "deploy",
      "validate",
      "monitor",
    ]);
  });

  it("labels every stage id", () => {
    for (const id of [...FIRST_RUN_ARC, ...INTEGRATE_ARC]) {
      expect(JOURNEY_STAGE_LABELS[id]).toBeTruthy();
    }
  });
});

describe("firstRunStageIds (mode filtering)", () => {
  it("gives full and azure-only modes the whole arc", () => {
    expect(firstRunStageIds("full")).toEqual(FIRST_RUN_ARC);
    expect(firstRunStageIds("azure-only")).toEqual(FIRST_RUN_ARC);
  });

  it("skips target for cribl-only (no Azure scope exists)", () => {
    expect(firstRunStageIds("cribl-only")).toEqual([
      "accept",
      "choose-mode",
      "connect",
      "ready",
    ]);
  });

  it("skips connect AND target for air-gapped (no live connections) rather than showing them locked", () => {
    expect(firstRunStageIds("air-gapped")).toEqual([
      "accept",
      "choose-mode",
      "ready",
    ]);
  });

  it("returns the generic arc while no mode is chosen", () => {
    expect(firstRunStageIds(null)).toEqual(FIRST_RUN_ARC);
  });
});

describe("deriveJourney invariants (full 360-combination fact matrix)", () => {
  it("derives stage lists from the mode alone - facts change statuses, never which stages exist", () => {
    for (const f of everyFactCombination()) {
      const journey = deriveJourney(f);
      expect(journey.firstRun.map((s) => s.id)).toEqual(
        firstRunStageIds(f.mode),
      );
      expect(journey.integrate.map((s) => s.id)).toEqual([...INTEGRATE_ARC]);
    }
  });

  it("emits at most one 'current' across both arcs, agreeing exactly with nextAction", () => {
    for (const f of everyFactCombination()) {
      const journey = deriveJourney(f);
      const currents = allStages(journey).filter(
        (s) => s.status === "current",
      );
      expect(currents.length).toBeLessThanOrEqual(1);
      const action = nextAction(f);
      if (action === null) {
        expect(currents).toHaveLength(0);
      } else {
        expect(currents).toHaveLength(1);
        expect(currents[0]?.id).toBe(action.stageId);
        expect(action.label).toBeTruthy();
        expect(action.description).toBeTruthy();
      }
    }
  });

  it("gives every blocked and not-yet-available stage a reason, and no other status one", () => {
    for (const f of everyFactCombination()) {
      for (const s of allStages(deriveJourney(f))) {
        if (s.status === "blocked" || s.status === "not-yet-available") {
          expect(s.blockedReason).toBeTruthy();
        } else {
          expect(s.blockedReason).toBeUndefined();
        }
      }
    }
  });

  it("never marks connect complete unless the secret is live (unknown is honestly incomplete) in Azure modes", () => {
    for (const f of everyFactCombination()) {
      if (f.mode !== "full" && f.mode !== "azure-only") {
        continue;
      }
      if (f.secretLive === "live" && f.identityPresent) {
        continue;
      }
      expect(statusOf(deriveJourney(f), "connect")).not.toBe("complete");
    }
  });

  it("keeps every first-run stage before the current one complete (no blocked stage precedes current)", () => {
    for (const f of everyFactCombination()) {
      const journey = deriveJourney(f);
      const currentIndex = journey.firstRun.findIndex(
        (s) => s.status === "current",
      );
      if (currentIndex === -1) {
        continue;
      }
      for (const earlier of journey.firstRun.slice(0, currentIndex)) {
        expect(earlier.status).toBe("complete");
      }
    }
  });

  it("keeps choose-content, configure, and review navigable in Azure modes past the walls, whatever later stages need", () => {
    for (const f of everyFactCombination()) {
      if (!f.accepted || (f.mode !== "full" && f.mode !== "azure-only")) {
        continue;
      }
      const journey = deriveJourney(f);
      expect(["available", "current"]).toContain(
        statusOf(journey, "choose-content"),
      );
      expect(statusOf(journey, "configure")).toBe("available");
      // Review is read-ahead by decision: never a hard gate on Deploy (the
      // acknowledge check arms only the Review screen's own handoff button).
      expect(statusOf(journey, "review")).toBe("available");
    }
  });
});

/** A fresh install: nothing accepted, chosen, entered, or committed. */
function freshFacts(overrides: Partial<JourneyFacts> = {}): JourneyFacts {
  return facts({
    accepted: false,
    mode: null,
    identityPresent: false,
    secretLive: "missing",
    scopeCommitted: false,
    ...overrides,
  });
}

describe("acceptance wall", () => {
  it("makes accept current on a fresh install and blocks every later stage with the single unlock condition", () => {
    const journey = deriveJourney(freshFacts());
    expect(statusOf(journey, "accept")).toBe("current");
    for (const s of allStages(journey)) {
      if (s.id === "accept") {
        continue;
      }
      if (s.status === "blocked") {
        expect(s.blockedReason).toContain("acceptable-use");
      } else {
        // Placeholder stages stay honestly not-yet-available even behind
        // the wall - capability absence outranks fact walls.
        expect(s.status).toBe("not-yet-available");
      }
    }
  });

  it("keeps persisted completion honest across an acceptance re-prompt (resume never lies that work is undone)", () => {
    // Acceptance record failed to parse (re-prompt), but mode, identity,
    // secret, and scope persist: completed stages stay complete; nothing
    // is available past the wall; accept is the single current stage.
    const journey = deriveJourney(facts({ accepted: false }));
    expect(statusOf(journey, "accept")).toBe("current");
    expect(statusOf(journey, "choose-mode")).toBe("complete");
    expect(statusOf(journey, "connect")).toBe("complete");
    expect(statusOf(journey, "target")).toBe("complete");
    const ready = stageOf(journey, "ready");
    expect(ready.status).toBe("blocked");
    expect(ready.blockedReason).toContain("acceptable-use");
    expect(statusOf(journey, "choose-content")).toBe("blocked");
    expect(statusOf(journey, "deploy")).toBe("blocked");
  });

  it("headlines acceptance as the next action", () => {
    expect(nextAction(freshFacts())?.stageId).toBe("accept");
    expect(nextAction(facts({ accepted: false }))?.stageId).toBe("accept");
  });
});

describe("mode wall", () => {
  it("makes choose-mode current after acceptance and blocks later stages on the mode choice", () => {
    const journey = deriveJourney(freshFacts({ accepted: true }));
    expect(statusOf(journey, "accept")).toBe("complete");
    expect(statusOf(journey, "choose-mode")).toBe("current");
    for (const id of ["connect", "target", "ready"] as const) {
      const s = stageOf(journey, id);
      expect(s.status).toBe("blocked");
      expect(s.blockedReason).toContain("operating mode");
    }
    expect(statusOf(journey, "choose-content")).toBe("blocked");
    expect(statusOf(journey, "deploy")).toBe("blocked");
  });

  it("headlines mode choice as the next action", () => {
    expect(nextAction(freshFacts({ accepted: true }))?.stageId).toBe(
      "choose-mode",
    );
    expect(nextAction(facts({ mode: null }))?.stageId).toBe("choose-mode");
  });
});

describe("azure-only status matrix (identity x secret x scope)", () => {
  // Each row: inputs, then literal expected statuses and the next stage.
  const rows: readonly [
    identityPresent: boolean,
    secretLive: SecretLiveness,
    scopeCommitted: boolean,
    connect: StageStatus,
    target: StageStatus,
    ready: StageStatus,
    deploy: StageStatus,
    chooseContent: StageStatus,
    next: JourneyStageId,
  ][] = [
    [true, "live", true, "complete", "complete", "complete", "available", "current", "choose-content"],
    [true, "live", false, "complete", "current", "available", "blocked", "available", "target"],
    [true, "unknown", true, "current", "complete", "available", "available", "available", "connect"],
    [true, "unknown", false, "current", "available", "available", "blocked", "available", "connect"],
    [true, "missing", true, "current", "complete", "available", "available", "available", "connect"],
    [true, "missing", false, "current", "available", "available", "blocked", "available", "connect"],
    [false, "live", true, "current", "complete", "available", "blocked", "available", "connect"],
    [false, "live", false, "current", "available", "available", "blocked", "available", "connect"],
    [false, "unknown", true, "current", "complete", "available", "blocked", "available", "connect"],
    [false, "unknown", false, "current", "available", "available", "blocked", "available", "connect"],
    [false, "missing", true, "current", "complete", "available", "blocked", "available", "connect"],
    [false, "missing", false, "current", "available", "available", "blocked", "available", "connect"],
  ];

  it.each(rows)(
    "identity=%s secret=%s scope=%s -> connect=%s target=%s ready=%s deploy=%s choose-content=%s next=%s",
    (
      identityPresent,
      secretLive,
      scopeCommitted,
      connect,
      target,
      ready,
      deploy,
      chooseContent,
      next,
    ) => {
      const f = facts({ identityPresent, secretLive, scopeCommitted });
      const journey = deriveJourney(f);
      expect(statusOf(journey, "accept")).toBe("complete");
      expect(statusOf(journey, "choose-mode")).toBe("complete");
      expect(statusOf(journey, "connect")).toBe(connect);
      expect(statusOf(journey, "target")).toBe(target);
      expect(statusOf(journey, "ready")).toBe(ready);
      expect(statusOf(journey, "deploy")).toBe(deploy);
      expect(statusOf(journey, "choose-content")).toBe(chooseContent);
      expect(nextAction(f)?.stageId).toBe(next);
    },
  );

  it("names exactly one missing thing on a blocked Deploy, identity before scope", () => {
    const identityFirst = stageOf(
      deriveJourney(facts({ identityPresent: false, scopeCommitted: false })),
      "deploy",
    );
    expect(identityFirst.blockedReason).toContain("tenant and client IDs");
    const scopeNext = stageOf(
      deriveJourney(facts({ scopeCommitted: false })),
      "deploy",
    );
    expect(scopeNext.blockedReason).toContain("Commit an Azure target");
  });
});

describe("full mode Cribl participation in connect", () => {
  it("completes connect when the Azure side is green and Cribl reachability is unknown (optional fact never blocks full mode)", () => {
    const journey = deriveJourney(
      facts({ mode: "full", criblReachable: undefined }),
    );
    expect(statusOf(journey, "connect")).toBe("complete");
  });

  it("completes connect when Cribl is known reachable", () => {
    const journey = deriveJourney(
      facts({ mode: "full", criblReachable: true }),
    );
    expect(statusOf(journey, "connect")).toBe("complete");
  });

  it("holds connect open when Cribl is known unreachable, and names it as the next action", () => {
    const f = facts({ mode: "full", criblReachable: false });
    const journey = deriveJourney(f);
    expect(statusOf(journey, "connect")).toBe("current");
    const action = nextAction(f);
    expect(action?.stageId).toBe("connect");
    expect(action?.label).toBe("Restore the Cribl connection");
  });

  it("does not gate Deploy on Cribl reachability (no new gates beyond the existing Run gate)", () => {
    const journey = deriveJourney(
      facts({ mode: "full", criblReachable: false }),
    );
    expect(statusOf(journey, "deploy")).toBe("available");
  });
});

describe("cribl-only mode", () => {
  it("completes connect only on known reachability - unknown honestly stays incomplete", () => {
    const green = facts({ mode: "cribl-only", criblReachable: true });
    expect(statusOf(deriveJourney(green), "connect")).toBe("complete");
    const unknown = facts({ mode: "cribl-only", criblReachable: undefined });
    expect(statusOf(deriveJourney(unknown), "connect")).toBe("current");
    expect(nextAction(unknown)?.label).toBe("Verify the Cribl connection");
    const down = facts({ mode: "cribl-only", criblReachable: false });
    expect(nextAction(down)?.label).toBe("Restore the Cribl connection");
  });

  it("marks every integrate stage not-yet-available with an honest reason", () => {
    const journey = deriveJourney(
      facts({ mode: "cribl-only", criblReachable: true }),
    );
    for (const s of journey.integrate) {
      expect(s.status).toBe("not-yet-available");
      expect(s.blockedReason).toBeTruthy();
    }
  });

  it("returns a null next action once its first-run arc is green (nothing actionable is never oversold)", () => {
    const f = facts({ mode: "cribl-only", criblReachable: true });
    expect(nextAction(f)).toBeNull();
    const currents = allStages(deriveJourney(f)).filter(
      (s) => s.status === "current",
    );
    expect(currents).toHaveLength(0);
  });
});

describe("air-gapped mode", () => {
  it("completes its whole first-run arc from acceptance plus mode choice alone", () => {
    const journey = deriveJourney(
      facts({
        mode: "air-gapped",
        identityPresent: false,
        secretLive: "missing",
        scopeCommitted: false,
      }),
    );
    for (const s of journey.firstRun) {
      expect(s.status).toBe("complete");
    }
  });

  it("marks every integrate stage not-yet-available (tightened copy until the guided deploy unit)", () => {
    const journey = deriveJourney(facts({ mode: "air-gapped" }));
    for (const s of journey.integrate) {
      expect(s.status).toBe("not-yet-available");
    }
    expect(stageOf(journey, "choose-content").blockedReason).toContain(
      "Air-gapped",
    );
  });

  it("returns a null next action rather than inventing one", () => {
    expect(nextAction(facts({ mode: "air-gapped" }))).toBeNull();
  });
});

describe("unshipped integrate placeholders", () => {
  it("keeps validate and monitor not-yet-available even on a fully green full-mode journey", () => {
    const journey = deriveJourney(
      facts({ mode: "full", criblReachable: true }),
    );
    for (const id of UNSHIPPED_INTEGRATE_STAGES) {
      const s = stageOf(journey, id);
      expect(s.status).toBe("not-yet-available");
      expect(s.blockedReason).toBeTruthy();
    }
  });

  it("lists exactly the stages still unshipped after Unit 7 shipped review", () => {
    expect(UNSHIPPED_INTEGRATE_STAGES).toEqual(["validate", "monitor"]);
  });

  it("ships review: available on a green Azure journey, never a placeholder", () => {
    const journey = deriveJourney(
      facts({ mode: "full", criblReachable: true }),
    );
    const review = stageOf(journey, "review");
    expect(review.status).toBe("available");
    expect(review.blockedReason).toBeUndefined();
  });
});

describe("read-ahead invariants", () => {
  it("keeps earlier integrate stages navigable while Deploy is blocked (a blocked later stage never hides an earlier one)", () => {
    const journey = deriveJourney(facts({ scopeCommitted: false }));
    expect(statusOf(journey, "deploy")).toBe("blocked");
    expect(statusOf(journey, "choose-content")).toBe("available");
    expect(statusOf(journey, "configure")).toBe("available");
  });

  it("keeps Target navigable (available, never blocked) while Connect is still current", () => {
    const journey = deriveJourney(
      facts({
        identityPresent: false,
        secretLive: "missing",
        scopeCommitted: false,
      }),
    );
    expect(statusOf(journey, "connect")).toBe("current");
    expect(statusOf(journey, "target")).toBe("available");
  });

  it("derives an earlier stage's status independent of later-stage facts", () => {
    const scopeMissing = deriveJourney(
      facts({ secretLive: "unknown", scopeCommitted: false }),
    );
    const scopeCommitted = deriveJourney(
      facts({ secretLive: "unknown", scopeCommitted: true }),
    );
    expect(statusOf(scopeMissing, "connect")).toBe("current");
    expect(statusOf(scopeCommitted, "connect")).toBe("current");
    expect(statusOf(scopeMissing, "choose-mode")).toBe(
      statusOf(scopeCommitted, "choose-mode"),
    );
  });
});

describe("readinessChips", () => {
  it("renders identity, secret, and scope in order, all ok on a green journey", () => {
    const chips = readinessChips(facts());
    expect(chips.map((c) => c.id)).toEqual(["identity", "secret", "scope"]);
    expect(chips.map((c) => c.state)).toEqual(["ok", "ok", "ok"]);
    for (const chip of chips) {
      expect(chip.label).toBeTruthy();
      expect(chip.hint).toBeTruthy();
    }
  });

  it("hedges the secret chip as unknown when a stored secret's liveness is session-only", () => {
    const chips = readinessChips(facts({ secretLive: "unknown" }));
    const secret = chips.find((c) => c.id === "secret");
    expect(secret?.state).toBe("unknown");
    expect(secret?.hint).toContain("session");
    expect(secret?.hint).toContain("may exist");
  });

  it("never reports unknown for identity or scope (they are known facts)", () => {
    for (const f of everyFactCombination()) {
      for (const chip of readinessChips(f)) {
        if (chip.id !== "secret") {
          expect(chip.state).not.toBe("unknown");
        }
      }
    }
  });

  it("marks each missing layer with an actionable hint", () => {
    const chips = readinessChips(
      facts({
        identityPresent: false,
        secretLive: "missing",
        scopeCommitted: false,
      }),
    );
    expect(chips.map((c) => c.state)).toEqual([
      "missing",
      "missing",
      "missing",
    ]);
    expect(chips[0]?.hint).toContain("Connect");
    expect(chips[2]?.hint).toContain("Azure Targeting");
  });

  it("returns no chips for modes without a live Azure connection, or before a mode is chosen", () => {
    expect(readinessChips(facts({ mode: "cribl-only" }))).toEqual([]);
    expect(readinessChips(facts({ mode: "air-gapped" }))).toEqual([]);
    expect(readinessChips(facts({ mode: null }))).toEqual([]);
  });
});

describe("nextAction hint cascade", () => {
  it("walks the connect cascade: identity, then secret entry, then secret verification", () => {
    expect(nextAction(facts({ identityPresent: false }))?.label).toBe(
      "Enter your Azure identity",
    );
    expect(nextAction(facts({ secretLive: "missing" }))?.label).toBe(
      "Connect the client secret",
    );
    expect(nextAction(facts({ secretLive: "unknown" }))?.label).toBe(
      "Verify the stored client secret",
    );
  });

  it("asks for the target commit once connect is green", () => {
    const action = nextAction(facts({ scopeCommitted: false }));
    expect(action?.stageId).toBe("target");
    expect(action?.label).toBe("Commit an Azure target");
    expect(action?.description).toContain("Use this target");
  });

  it("hands over to the integrate arc when the first-run arc is green", () => {
    const action = nextAction(facts());
    expect(action?.stageId).toBe("choose-content");
    expect(action?.label).toBe("Choose content to onboard");
  });

  it("keeps the unknown-secret description hedged, never confident", () => {
    const action = nextAction(facts({ secretLive: "unknown" }));
    expect(action?.description).toContain("may exist");
    expect(action?.description).toContain("session");
  });
});
