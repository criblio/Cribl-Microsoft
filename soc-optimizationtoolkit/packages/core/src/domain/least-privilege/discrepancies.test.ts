/**
 * DISPOSITION PIN - every discrepancy the 2026-11-03 least-privilege audit
 * reported has a recorded outcome: a board card that works it, or the stated
 * reason it needs none.
 *
 * The AZR-61 card says the audit's discrepancies are "reported, not silently
 * fixed". Review found fourteen of the twenty-four with no card and no
 * disposition anywhere but the audit JSON, which no gate reads - so once
 * AZR-61 closed, the only record of them would have been a file nobody
 * opens. This pin is what makes "reported" checkable, the way NOT_REGISTERED
 * does for audit rows in operations.test.ts: a re-run audit with a new
 * discrepancy fails here until someone says what happens to it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Discrepancy {
  kind: string;
  item: string;
  severity: string;
}

const audit = JSON.parse(
  readFileSync(
    new URL("../../../../../docs/audit/2026-11-03-least-privilege-audit.json", import.meta.url),
    "utf8",
  ),
) as { comparison: { discrepancies: Discrepancy[] } };

const board = JSON.parse(
  readFileSync(new URL("../../../../../docs/board.json", import.meta.url), "utf8"),
) as { stories: { id: string }[]; features: { id: string }[] };

/** A card that works the discrepancy, or why none is needed. */
type Disposition = { card: string } | { reason: string };

/** By the discrepancy's 1-based position in comparison.discrepancies. */
const DISPOSITIONS: Readonly<Record<number, Disposition>> = {
  1: { card: "AZR-75" },
  2: { card: "AZR-76" },
  3: { card: "AZR-62" },
  4: { card: "AZR-77" },
  5: {
    reason:
      "kept deliberately and stated in REQUIRED_ACTIONS' header: deployments/write is called by nothing, but it is the only measure of the arm.deploy capability the Labs route is gated on, so it stays until that capability is measured another way",
  },
  6: { card: "AZR-78" },
  7: { card: "AZR-81" },
  8: { card: "AZR-79" },
  9: {
    reason:
      "kept deliberately and stated in REQUIRED_ACTIONS' header and pinned in azure-permissions.test.ts: the onboardingStates/write label names the role the ticket asks for, and changes when the narrower grant the audit calls untested is measured live",
  },
  10: { card: "AZR-82" },
  11: { card: "AZR-82" },
  12: { card: "AZR-83" },
  13: { card: "AZR-83" },
  14: { card: "AZR-83" },
  15: { card: "AZR-84" },
  16: { card: "AZR-85" },
  17: { card: "AZR-86" },
  18: { card: "AZR-86" },
  19: { card: "AZR-80" },
  20: { card: "AZR-80" },
  21: { card: "AZR-86" },
  22: { card: "AZR-87" },
  23: { card: "AZR-88" },
  24: { card: "AZR-89" },
};

const DISCREPANCIES = audit.comparison.discrepancies;
const CARD_IDS = new Set([...board.stories, ...board.features].map((c) => c.id));

describe("least-privilege audit discrepancies", () => {
  it("has a known number of discrepancies (a re-run audit is noticed, not silently re-read)", () => {
    expect(DISCREPANCIES).toHaveLength(24);
  });

  it("records an outcome for every discrepancy, and none for one that does not exist", () => {
    const positions = DISCREPANCIES.map((_, i) => i + 1);
    expect(Object.keys(DISPOSITIONS).map(Number).sort((a, b) => a - b)).toEqual(positions);
  });

  it("points every card disposition at a card on the board", () => {
    const missing = Object.entries(DISPOSITIONS)
      .filter(([, d]) => "card" in d && !CARD_IDS.has(d.card))
      .map(([i, d]) => `${i}: ${"card" in d ? d.card : ""}`);
    expect(missing).toEqual([]);
  });

  it("gives every reason disposition an argument, not a placeholder", () => {
    for (const [i, d] of Object.entries(DISPOSITIONS)) {
      if ("reason" in d) {
        expect(d.reason.length, `discrepancy ${i}`).toBeGreaterThan(80);
      }
    }
  });

  it("files a card for every high- or medium-severity discrepancy that is a defect", () => {
    // A reason is admissible only where the code keeps the behaviour on
    // purpose and says so; everything else of consequence gets a card.
    const reasoned = new Set([5, 9]);
    const uncarded = DISCREPANCIES.map((d, i) => ({ d, n: i + 1 }))
      .filter(({ d, n }) => d.severity !== "low" && !reasoned.has(n) && !("card" in (DISPOSITIONS[n] ?? {})))
      .map(({ n }) => n);
    expect(uncarded).toEqual([]);
  });
});
