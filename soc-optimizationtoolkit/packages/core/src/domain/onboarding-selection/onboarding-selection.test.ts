// Pins for the additive-only contract (AZR-1, backlog.md#6h).
//
// The user decision these enforce is binding and was made on 2026-08-12: the
// onboarding checkboxes only ever deploy, and NO checkbox may ever destroy
// anything. The failure being prevented is not hypothetical-sounding: the
// natural implementation of a checkbox screen is a reconcile, and a reconcile
// here tears down a diagnostic setting the moment someone unticks a box to
// tidy the list.
//
// The first two tests are the contract. The rest keep the four states apart and
// keep the separate Remove action genuinely separate.

import { describe, expect, it } from "vitest";
import { deployPlan, itemState, removalPlan } from "./onboarding-selection";
import type { OnboardingItemId } from "./onboarding-selection";

/** Every subset of a 3-item universe, as an array of ids. */
function subsets(universe: readonly OnboardingItemId[]): OnboardingItemId[][] {
  const out: OnboardingItemId[][] = [];
  for (let mask = 0; mask < 1 << universe.length; mask++) {
    out.push(universe.filter((_, i) => (mask >> i) & 1));
  }
  return out;
}

const UNIVERSE = ["activity-log", "storage-diag", "xdr-export"] as const;

describe("deployPlan - the additive-only contract", () => {
  it("NEVER loses a deployed item, for any selection whatsoever", () => {
    // THE CONTRACT, stated as the property it really is. Exhaustive over the
    // 8x8 = 64 (desired, deployed) pairs of a 3-item universe, which for a
    // set-membership rule is a proof rather than a sample.
    //
    // "Not destroyed" is checked as: every id that was deployed going in is
    // still accounted for as deployed coming out - either `unchanged` (still
    // selected) or `leftInPlace` (unticked, and deliberately untouched).
    const cases = subsets(UNIVERSE).flatMap((desired) =>
      subsets(UNIVERSE).map((deployed) => ({ desired, deployed })),
    );
    expect(cases).toHaveLength(64);

    for (const { desired, deployed } of cases) {
      const plan = deployPlan(desired, deployed);
      const stillDeployed = [...plan.unchanged, ...plan.leftInPlace].sort();

      expect(stillDeployed, `desired=[${desired}] deployed=[${deployed}]`).toEqual(
        [...deployed].sort(),
      );
    }
  });

  it("cannot even EXPRESS a removal - the plan has no such field", () => {
    // The structural half of the contract. `DeployPlan` deliberately has no
    // removal field, so emitting one requires editing the type first, which is
    // visible in review. This pin fails the moment a fourth key appears,
    // whatever it is called - `remove`, `destroy`, `teardown`, `prune`.
    //
    // Verified 2026-08-28 by adding `remove:` to the returned literal: this pin
    // fails, AND `tsc` rejects it outright with TS2353 before the suite runs.
    // The pin is kept even though the compiler gets there first, because the
    // compiler only objects while the field is absent from the interface - one
    // edit to `DeployPlan` silences it, and this is what still speaks up.
    const plan = deployPlan(["activity-log"], ["storage-diag"]);

    expect(Object.keys(plan).sort()).toEqual(["add", "leftInPlace", "unchanged"]);
  });

  it("moves an unticked but deployed item to leftInPlace, not out of existence", () => {
    // The exact gesture the decision is about: the operator unticks a box.
    const plan = deployPlan([], ["activity-log"]);

    expect(plan.leftInPlace).toEqual(["activity-log"]);
    expect(plan.add).toEqual([]);
  });

  it("adds only what is selected and not already there", () => {
    const plan = deployPlan(["activity-log", "storage-diag"], ["storage-diag"]);

    expect(plan.add).toEqual(["activity-log"]);
    expect(plan.unchanged).toEqual(["storage-diag"]);
    expect(plan.leftInPlace).toEqual([]);
  });

  it("reports what is already in place rather than showing an empty plan", () => {
    // An empty `add` with no other signal reads as "nothing is deployed", which
    // is the opposite of the truth when everything already is.
    const plan = deployPlan(["activity-log"], ["activity-log"]);

    expect(plan.add).toEqual([]);
    expect(plan.unchanged).toEqual(["activity-log"]);
  });

  it("does not add the same item twice when the selection repeats it", () => {
    const plan = deployPlan(["activity-log", "activity-log"], []);

    expect(plan.add).toEqual(["activity-log"]);
  });

  it("keeps the selection's order, so the plan reads like the screen", () => {
    const plan = deployPlan(["xdr-export", "activity-log", "storage-diag"], []);

    expect(plan.add).toEqual(["xdr-export", "activity-log", "storage-diag"]);
  });
});

describe("itemState - selection and deployment are independent axes", () => {
  it("names all four states, and keeps the two 'off-looking' ones apart", () => {
    // Conflating these is the confident-wrong-answer shape: an operator who
    // reads `deployed-unselected` as `unselected` believes a thing is gone
    // while it is still emitting into their workspace.
    expect(itemState("a", [], [])).toBe("unselected");
    expect(itemState("a", ["a"], [])).toBe("pending");
    expect(itemState("a", ["a"], ["a"])).toBe("deployed");
    expect(itemState("a", [], ["a"])).toBe("deployed-unselected");
  });

  it("agrees with deployPlan about every item, across all 64 combinations", () => {
    // The two functions are separate derivations of the same two facts, so they
    // can drift. This is what catches it.
    for (const desired of subsets(UNIVERSE)) {
      for (const deployed of subsets(UNIVERSE)) {
        const plan = deployPlan(desired, deployed);
        for (const id of UNIVERSE) {
          const where =
            plan.add.includes(id) ? "pending"
            : plan.unchanged.includes(id) ? "deployed"
            : plan.leftInPlace.includes(id) ? "deployed-unselected"
            : "unselected";

          expect(itemState(id, desired, deployed), `${id} desired=[${desired}] deployed=[${deployed}]`).toBe(where);
        }
      }
    }
  });
});

describe("removalPlan - teardown is separate and confirmed", () => {
  it("removes nothing when the request is not confirmed", () => {
    const plan = removalPlan({ items: ["activity-log"], confirmed: false }, ["activity-log"]);

    expect(plan.remove).toEqual([]);
    expect(plan.refusedReason).toContain("not confirmed");
  });

  it("treats an EMPTY list as 'remove nothing', never as 'remove everything'", () => {
    // The classic shape of this bug: an empty selection read as a wildcard.
    const plan = removalPlan({ items: [], confirmed: true }, ["activity-log", "storage-diag"]);

    expect(plan.remove).toEqual([]);
    expect(plan.refusedReason).toContain("No items were named");
  });

  it("removes exactly what was named, once confirmed", () => {
    const plan = removalPlan({ items: ["activity-log"], confirmed: true }, [
      "activity-log",
      "storage-diag",
    ]);

    expect(plan.remove).toEqual(["activity-log"]);
    expect(plan.refusedReason).toBeNull();
  });

  it("reports a named item that is not deployed instead of silently dropping it", () => {
    // A request naming something that is not there means the caller's picture
    // disagrees with reality. Saying so is cheap; swallowing it is how a screen
    // reports success for a teardown that never had anything to tear down.
    const plan = removalPlan({ items: ["activity-log", "ghost"], confirmed: true }, [
      "activity-log",
    ]);

    expect(plan.remove).toEqual(["activity-log"]);
    expect(plan.notDeployed).toEqual(["ghost"]);
  });

  it("refuses when nothing named is deployed, and says so", () => {
    const plan = removalPlan({ items: ["ghost"], confirmed: true }, ["activity-log"]);

    expect(plan.remove).toEqual([]);
    expect(plan.notDeployed).toEqual(["ghost"]);
    expect(plan.refusedReason).toContain("None of the named items are deployed");
  });

  it("never removes something merely because it was unticked", () => {
    // The two paths meeting: deployPlan leaves an unticked item in place, and
    // reaching removal still takes an explicit, confirmed request naming it.
    // Nothing about the selection carries into the teardown.
    const unticked = deployPlan([], ["activity-log"]);
    expect(unticked.leftInPlace).toEqual(["activity-log"]);

    const notAsked = removalPlan({ items: [], confirmed: true }, ["activity-log"]);
    expect(notAsked.remove).toEqual([]);
  });
});
