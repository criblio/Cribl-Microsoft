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

/** Every fact combination: 2 x 2 x 3 x 2 x 3 = 72 records. */
function everyFactCombination(): JourneyFacts[] {
  const combos: JourneyFacts[] = [];
  {
    for (const accepted of BOOLS) {
      for (const identityPresent of BOOLS) {
        for (const secretLive of SECRET_STATES) {
          for (const scopeCommitted of BOOLS) {
            for (const criblReachable of CRIBL_STATES) {
              combos.push({
                accepted,
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

describe("firstRunStageIds", () => {
  // DELIBERATE INVERSION (capability-model-plan step 5). These pins previously
  // asserted the opposite: cribl-only dropped 'target', air-gapped dropped
  // 'connect' AND 'target', so an operator was shown a shorter journey than the
  // product has. Modes are gone and the arc is never pruned - a stage that
  // cannot be completed says so through its own blockedReason instead. This is
  // the same annotate-don't-hide rule step 3 applied to the nav.
  it("is always the whole arc", () => {
    expect(firstRunStageIds()).toEqual(FIRST_RUN_ARC);
  });

  it("no longer carries a mode-selection stage", () => {
    expect(FIRST_RUN_ARC).not.toContain("choose-mode");
    expect(firstRunStageIds()).toEqual(["accept", "connect", "target", "ready"]);
  });
});

describe("deriveJourney invariants (full 360-combination fact matrix)", () => {
  it("emits CONSTANT stage lists - facts change statuses, never which stages exist", () => {
    for (const f of everyFactCombination()) {
      const journey = deriveJourney(f);
      expect(journey.firstRun.map((s) => s.id)).toEqual(firstRunStageIds());
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

  it("never marks connect complete unless the secret is live (unknown is honestly incomplete)", () => {
    for (const f of everyFactCombination()) {
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

  it("keeps choose-content, configure, and review navigable past the wall, whatever later stages need", () => {
    for (const f of everyFactCombination()) {
      if (!f.accepted) {
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
    // Acceptance record failed to parse (re-prompt), but identity, secret, and
    // scope persist: completed stages stay complete; nothing is available past
    // the wall; accept is the single current stage.
    const journey = deriveJourney(facts({ accepted: false }));
    expect(statusOf(journey, "accept")).toBe("current");
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

describe("acceptance is now the ONLY wall", () => {
  // DELIBERATE REMOVAL (capability-model-plan step 5). This block used to pin a
  // second wall: after acceptance, 'choose-mode' became current and every later
  // stage was blocked on picking a mode. Mode selection is gone, so acceptance
  // is the single full-app gate and connect follows it directly.
  it("makes connect current immediately after acceptance", () => {
    const journey = deriveJourney(freshFacts({ accepted: true }));
    expect(statusOf(journey, "accept")).toBe("complete");
    expect(statusOf(journey, "connect")).toBe("current");
  });

  it("blocks nothing on a mode choice any more", () => {
    const journey = deriveJourney(freshFacts({ accepted: true }));
    for (const stage of [...journey.firstRun, ...journey.integrate]) {
      expect(stage.blockedReason ?? "").not.toContain("operating mode");
    }
  });

  it("headlines the connection, not a mode choice, once accepted", () => {
    expect(nextAction(freshFacts({ accepted: true }))?.stageId).toBe("connect");
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

describe("Cribl participation in connect", () => {
  it("completes connect when the Azure side is green and Cribl reachability is unknown (an optional fact never blocks)", () => {
    const journey = deriveJourney(
      facts({ criblReachable: undefined }),
    );
    expect(statusOf(journey, "connect")).toBe("complete");
  });

  it("completes connect when Cribl is known reachable", () => {
    const journey = deriveJourney(
      facts({ criblReachable: true }),
    );
    expect(statusOf(journey, "connect")).toBe("complete");
  });

  it("holds connect open when Cribl is known unreachable, and names it as the next action", () => {
    const f = facts({ criblReachable: false });
    const journey = deriveJourney(f);
    expect(statusOf(journey, "connect")).toBe("current");
    const action = nextAction(f);
    expect(action?.stageId).toBe("connect");
    expect(action?.label).toBe("Restore the Cribl connection");
  });

  it("does not gate Deploy on Cribl reachability (no new gates beyond the existing Run gate)", () => {
    const journey = deriveJourney(
      facts({ criblReachable: false }),
    );
    expect(statusOf(journey, "deploy")).toBe("available");
  });
});

describe("Cribl reachability now has ONE rule", () => {
  // DELIBERATE INVERSION (capability-model-plan step 5). This block used to pin
  // the cribl-only mode's STRICTER rule: unknown reachability held connect open,
  // because in that mode the Cribl link was the only thing the stage proved.
  // With modes gone there is a single rule and it is the lenient one - only a
  // KNOWN failure blocks. Requiring proof would wall the arc on a fact the local
  // shell legitimately never establishes, and 'unknown' must not read as broken.
  it("treats unknown reachability as non-blocking", () => {
    const unknown = facts({ criblReachable: undefined });
    expect(statusOf(deriveJourney(unknown), "connect")).toBe("complete");
  });

  it("still blocks on a KNOWN failure, and names restoring it", () => {
    const down = facts({ criblReachable: false });
    expect(statusOf(deriveJourney(down), "connect")).toBe("current");
    expect(nextAction(down)?.label).toBe("Restore the Cribl connection");
  });

  it("no longer suppresses the integrate arc for a Cribl-less operator", () => {
    // Previously every integrate stage was forced 'not-yet-available' for
    // cribl-only and air-gapped. Suppressing a whole arc by mode was the same
    // hiding step 3 removed; the stages now stand on their own facts.
    const journey = deriveJourney(facts({ criblReachable: true }));
    const suppressed = journey.integrate.filter(
      (stage) => stage.status === "not-yet-available",
    );
    expect(suppressed.map((stage) => stage.id)).toEqual(["validate", "monitor"]);
  });
});

describe("unshipped integrate placeholders", () => {
  it("keeps validate and monitor not-yet-available even on a fully green full-mode journey", () => {
    const journey = deriveJourney(
      facts({ criblReachable: true }),
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
      facts({ criblReachable: true }),
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
    expect(statusOf(scopeMissing, "accept")).toBe(
      statusOf(scopeCommitted, "accept"),
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

  it("ALWAYS renders the three chips, whatever the connection state", () => {
    // DELIBERATE INVERSION (capability-model-plan step 5). Chips used to be
    // suppressed entirely for modes without a live Azure connection, on the
    // grounds that red chips would be meaningless. With modes gone they always
    // render and report honestly - an operator without Azure access is told
    // identity and scope are missing rather than being shown nothing at all.
    const none = readinessChips(
      facts({ identityPresent: false, secretLive: "missing", scopeCommitted: false }),
    );
    expect(none.map((chip) => chip.id)).toEqual(["identity", "secret", "scope"]);
    expect(none.every((chip) => chip.state === "missing")).toBe(true);
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
