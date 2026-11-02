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
import type { AzureConnectivity, ScopeNeed } from "../azure-connectivity";
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

const CONNECTIVITIES: readonly (AzureConnectivity | undefined)[] = [
  undefined,
  "full",
  "partial",
  "disconnected",
];
const SCOPE_NEEDS: readonly (ScopeNeed | undefined)[] = [
  undefined,
  "none",
  "subscription",
  "full",
];
// The optional facts include undefined: absent is a real input (an older
// caller, or a token status still loading) and has its own meaning.
const OPTIONAL_BOOLS: readonly (boolean | undefined)[] = [true, false, undefined];

/**
 * Every fact combination: the base facts (2 accepted x 2 identity x 3 secret x
 * 2 scopeCommitted x 3 Cribl = 72) crossed with the FULL product of the
 * connectivity facts (4 connectivity x 4 scopeNeed x 3 subscriptionChosen x
 * 3 tokenRequired x 3 tokenPresent = 432) = 31104 records. The product is
 * cheap (pure derivation), so no pairwise subset is taken.
 */
function everyFactCombination(): JourneyFacts[] {
  const combos: JourneyFacts[] = [];
  for (const accepted of BOOLS) {
    for (const identityPresent of BOOLS) {
      for (const secretLive of SECRET_STATES) {
        for (const scopeCommitted of BOOLS) {
          for (const criblReachable of CRIBL_STATES) {
            for (const connectivity of CONNECTIVITIES) {
              for (const scopeNeed of SCOPE_NEEDS) {
                for (const subscriptionChosen of OPTIONAL_BOOLS) {
                  for (const tokenRequired of OPTIONAL_BOOLS) {
                    for (const tokenPresent of OPTIONAL_BOOLS) {
                      combos.push({
                        accepted,
                        identityPresent,
                        secretLive,
                        scopeCommitted,
                        criblReachable,
                        connectivity,
                        scopeNeed,
                        subscriptionChosen,
                        tokenRequired,
                        tokenPresent,
                      });
                    }
                  }
                }
              }
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
      "github",
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
    expect(firstRunStageIds()).toEqual([
      "accept",
      "github",
      "connect",
      "target",
      "ready",
    ]);
  });
});

// The matrix is 31104 fact records (DBT-246 crossed the connectivity facts
// into it). Each test walks all of them, which takes ~8-15 s on a slow Windows
// dev machine against vitest's 5 s default, so the timeout is stated here
// rather than letting a CPU-bound pin fail as if it had found something.
describe("deriveJourney invariants (full fact matrix)", { timeout: 60_000 }, () => {
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
        // A required token whose status is not yet known is the one stage
        // that may sit open before current: it is pending, not missing (M1).
        const pendingGithub =
          earlier.id === "github" &&
          f.tokenRequired === true &&
          f.tokenPresent === undefined;
        expect(
          pendingGithub ? ["available"] : ["complete", "not-needed"],
        ).toContain(earlier.status);
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
      if (s.id === "github") {
        // No token is required in these facts, so the stage is satisfied
        // independently of the wall (completion is never undone by it).
        expect(s.status).toBe("complete");
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

  it("lists exactly the stages still unshipped - review is RETIRED, not pending", () => {
    // Renamed 2026-09-01 (HON-8). This said "after Unit 7 shipped review",
    // which is false twice over: Unit 7 shipped the ENGINE, and the screen
    // that called it was deleted on 2026-08-24. Review is absent from this
    // list because it is retired, not because it shipped - a distinction the
    // old name erased, and the assertion never checked.
    expect(UNSHIPPED_INTEGRATE_STAGES).toEqual(["validate", "monitor"]);
  });

  it("leaves review AVAILABLE rather than a placeholder, because it is retired", () => {
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
    expect(chips[2]?.hint).toContain("Setup");
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
    expect(action?.description).toBe(
      "Pick a subscription, resource group and workspace on Setup.",
    );
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

describe("the journey follows the saved connectivity choice", () => {
  const disconnected = (o: Partial<JourneyFacts> = {}) =>
    facts({
      connectivity: "disconnected",
      identityPresent: false,
      secretLive: "missing",
      scopeCommitted: false,
      tokenPresent: true,
      ...o,
    });

  it("disconnected: skips connect and target and goes straight to content", () => {
    const f = disconnected();
    expect(nextAction(f)?.stageId).toBe("choose-content");
    const j = deriveJourney(f);
    expect(statusOf(j, "connect")).toBe("not-needed");
    expect(statusOf(j, "target")).toBe("not-needed");
    expect(statusOf(j, "ready")).toBe("complete");
    const current = allStages(j).filter((s) => s.status === "current");
    expect(current.map((s) => s.id)).toEqual(["choose-content"]);
    for (const s of allStages(j)) {
      expect(s.blockedReason !== undefined).toBe(
        s.status === "blocked" || s.status === "not-yet-available",
      );
    }
  });

  it("disconnected: identity, secret and scope chips are not-used", () => {
    expect(readinessChips(disconnected()).map((c) => c.state)).toEqual([
      "not-used",
      "not-used",
      "not-used",
    ]);
  });

  it("disconnected: Deploy points at the export, not the tenant", () => {
    const reason = stageOf(deriveJourney(disconnected()), "deploy").blockedReason;
    expect(reason).toContain("export");
    expect(reason).not.toContain("tenant");
  });

  it("partial with a subscription-level need: a chosen subscription completes target", () => {
    const j = deriveJourney(
      facts({
        connectivity: "partial",
        scopeNeed: "subscription",
        subscriptionChosen: true,
        scopeCommitted: false,
      }),
    );
    expect(statusOf(j, "target")).toBe("complete");
  });

  it("partial with no scope need: target is not-needed", () => {
    const j = deriveJourney(
      facts({ connectivity: "partial", scopeNeed: "none", scopeCommitted: false }),
    );
    expect(statusOf(j, "target")).toBe("not-needed");
  });

  it("asks for a GitHub token when one is required and missing", () => {
    expect(
      nextAction(facts({ tokenRequired: true, tokenPresent: false })),
    ).toEqual({
      stageId: "github",
      label: "Save a GitHub token",
      description: expect.any(String),
    });
  });

  it("never names the retired Azure Targeting route", () => {
    const all: JourneyFacts[] = [
      facts({ scopeCommitted: false }),
      facts({ identityPresent: false }),
      disconnected(),
      facts({ tokenRequired: true, tokenPresent: false }),
    ];
    for (const f of all) {
      const texts = [
        nextAction(f)?.description ?? "",
        ...readinessChips(f).map((c) => c.hint),
        ...allStages(deriveJourney(f)).map((s) => s.blockedReason ?? ""),
      ];
      for (const t of texts) {
        expect(t).not.toContain("Azure Targeting");
        expect(t).not.toContain("Use this target");
      }
    }
  });
});

describe("scope chip follows the target stage", () => {
  it("is not-used whenever the target stage is not needed", () => {
    for (const f of [
      facts({ connectivity: "disconnected", scopeCommitted: false }),
      facts({ connectivity: "partial", scopeNeed: "none", scopeCommitted: false }),
    ]) {
      expect(statusOf(deriveJourney(f), "target")).toBe("not-needed");
      const scope = readinessChips(f).find((c) => c.id === "scope");
      expect(scope?.state).toBe("not-used");
    }
  });

  it("says a subscription is chosen, not that a scope is committed", () => {
    const scope = readinessChips(
      facts({
        connectivity: "partial",
        scopeNeed: "subscription",
        subscriptionChosen: true,
        scopeCommitted: false,
      }),
    ).find((c) => c.id === "scope");
    expect(scope?.state).toBe("ok");
    expect(scope?.hint).toContain("subscription is chosen");
    expect(scope?.hint).not.toContain("committed");
  });
});

describe("scopeNeed shapes the journey only under partial (I2)", () => {
  // lab-new-rg's full plan has no resource-group entry, so scopeNeed is
  // "subscription" there - that must not relax a Fully Connected install.
  const fullLab = facts({
    connectivity: "full",
    scopeNeed: "subscription",
    subscriptionChosen: true,
    scopeCommitted: false,
  });

  it("full + subscription-only need + subscription chosen: target is not complete", () => {
    const j = deriveJourney(fullLab);
    expect(statusOf(j, "target")).toBe("current");
    expect(nextAction(fullLab)?.stageId).toBe("target");
  });

  it("full + subscription-only need: deploy is still scope-gated", () => {
    expect(stageOf(deriveJourney(fullLab), "deploy").blockedReason).toBe(
      "Commit an Azure target (subscription, resource group, and workspace) first.",
    );
  });

  it("full + a none need: target is still needed", () => {
    const f = facts({ connectivity: "full", scopeNeed: "none", scopeCommitted: false });
    expect(statusOf(deriveJourney(f), "target")).toBe("current");
    expect(readinessChips(f).find((c) => c.id === "scope")?.state).toBe("missing");
  });

  it("full: the scope chip asks for the whole target", () => {
    const scope = readinessChips(fullLab).find((c) => c.id === "scope");
    expect(scope?.state).toBe("missing");
    expect(scope?.hint).toBe(
      "Pick a subscription, resource group and workspace on Setup.",
    );
  });
});

describe("Deploy always needs the committed scope (I3)", () => {
  it("partial Reader + subscription only: deploy blocked with the scope reason", () => {
    const f = facts({
      connectivity: "partial",
      scopeNeed: "subscription",
      subscriptionChosen: true,
      scopeCommitted: false,
    });
    const deploy = stageOf(deriveJourney(f), "deploy");
    expect(deploy.status).toBe("blocked");
    expect(deploy.blockedReason).toBe(
      "Commit an Azure target (subscription, resource group, and workspace) first.",
    );
  });

  it("partial with no scope need: deploy still blocked until scope is committed", () => {
    const f = facts({ connectivity: "partial", scopeNeed: "none", scopeCommitted: false });
    expect(stageOf(deriveJourney(f), "deploy").blockedReason).toBe(
      "Commit an Azure target (subscription, resource group, and workspace) first.",
    );
  });

  it("disconnected keeps its export reason", () => {
    const f = facts({ connectivity: "disconnected", scopeCommitted: false });
    expect(stageOf(deriveJourney(f), "deploy").blockedReason).toBe(
      "Disconnected: export the ARM templates instead.",
    );
  });
});

describe("the subscription-only target asks only for a subscription (I5)", () => {
  const f = facts({
    connectivity: "partial",
    scopeNeed: "subscription",
    subscriptionChosen: false,
    scopeCommitted: false,
  });

  it("next action says pick a subscription", () => {
    expect(nextAction(f)?.description).toBe("Pick a subscription on Setup.");
  });

  it("the scope chip hint says pick a subscription", () => {
    expect(readinessChips(f).find((c) => c.id === "scope")?.hint).toBe(
      "Pick a subscription on Setup.",
    );
  });

  it("a full need keeps the whole-target copy", () => {
    const g = facts({ connectivity: "partial", scopeNeed: "full", scopeCommitted: false });
    expect(nextAction(g)?.description).toBe(
      "Pick a subscription, resource group and workspace on Setup.",
    );
  });
});

describe("an unknown token status is not-yet-known, not missing (M1)", () => {
  const pending = facts({ tokenRequired: true, tokenPresent: undefined });

  it("does not make github the next action", () => {
    expect(nextAction(pending)?.stageId).not.toBe("github");
    expect(nextAction(pending)?.stageId).toBe("choose-content");
  });

  it("shows the github stage available, not complete and not current", () => {
    expect(statusOf(deriveJourney(pending), "github")).toBe("available");
  });

  it("lets the next stage proceed", () => {
    const f = facts({
      tokenRequired: true,
      tokenPresent: undefined,
      secretLive: "missing",
    });
    expect(nextAction(f)?.stageId).toBe("connect");
    expect(statusOf(deriveJourney(f), "connect")).toBe("current");
  });

  it("a known-missing token still asks for one", () => {
    expect(
      nextAction(facts({ tokenRequired: true, tokenPresent: false }))?.stageId,
    ).toBe("github");
  });
});
