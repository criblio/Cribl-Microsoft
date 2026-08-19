// @vitest-environment happy-dom
/**
 * DOM pins for the overflow triage block.
 *
 * THESE EXIST BECAUSE THE FIRST VERSION SHIPPED INVISIBLE. The "check the
 * sample is the right one for this table" recommendation was folded into the
 * count line's InfoTip: in the DOM, in `summary`, and unreadable without a
 * hover. Every core pin passed. The defect was purely about WHERE the sentence
 * rendered, which only a DOM pin can see.
 *
 * So the pins below assert placement, not just presence: the recommendation is
 * a visible paragraph, it is NOT inside the tooltip, and it is NOT hidden
 * behind a <details> the operator has to open.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { OverflowTriage } from "@soc/core";
import { OverflowTriageBlock } from "./overflow-triage-block";

afterEach(cleanup);

const NOTE = "Overflow fields are preserved in the catch-all column.";

const WARNING =
  "Most of this sample has no CrowdStrikeAlerts equivalent (161 of 161 " +
  "overflow fields). Check the sample is the right one for this table " +
  "before continuing.";

/** A near-total mismatch: the live ASim-sample-into-CrowdStrikeAlerts case. */
const MISMATCHED: OverflowTriage = {
  noEquivalentCount: 3,
  noEquivalent: ["aaaNope", "bbbNope", "cccNope"],
  outranked: [],
  pairingWarning: WARNING,
  summary: `3 of 3 overflow fields have no CrowdStrikeAlerts equivalent. ${WARNING}`,
};

/** Normal overflow: a curated table with no column for some vendor detail. */
const ORDINARY: OverflowTriage = {
  noEquivalentCount: 1,
  noEquivalent: ["vendorOnlyDetail"],
  outranked: [
    {
      sourceName: "upload_filename",
      column: "FileName",
      score: 60,
      claimedBy: "filename",
    },
  ],
  pairingWarning: "",
  summary: "1 of 2 overflow fields have no CommonSecurityLog equivalent.",
};

function renderBlock(triage: OverflowTriage, tableName = "CrowdStrikeAlerts") {
  render(
    <OverflowTriageBlock
      overflowCount={triage.noEquivalentCount + triage.outranked.length}
      tableName={tableName}
      triage={triage}
      coverageNote={NOTE}
    />,
  );
}

/**
 * Every rendering of the recommendation, and the subset an operator can read
 * WITHOUT hovering a tooltip or opening a disclosure.
 *
 * The text legitimately appears twice - the tooltip still carries the whole
 * summary - so a bare getByText would throw on the duplicate and tell us
 * nothing about placement. Splitting the matches is the assertion: the defect
 * was "every match is inside the tooltip", and that is exactly what an empty
 * `readable` means.
 */
function warningRenderings() {
  const all = screen.getAllByText(/Check the sample is the right one/);
  const readable = all.filter(
    (el) => el.closest('[role="tooltip"]') === null && el.closest("details") === null,
  );
  return { all, readable };
}

describe("OverflowTriageBlock - the recommendation is VISIBLE", () => {
  it("renders the pairing warning as its own paragraph", () => {
    renderBlock(MISMATCHED);
    const { readable } = warningRenderings();
    expect(readable).toHaveLength(1);
    expect(readable[0]!.tagName).toBe("P");
    expect(readable[0]!.className).toContain("gap-overflow-warning");
  });

  it("does not hide the recommendation inside the tooltip", () => {
    // THE EXACT DEFECT. The tooltip still carries the full summary - that is
    // fine - but the recommendation must ALSO stand on its own outside it.
    // Fold it back into the tip and `readable` empties while `all` does not.
    renderBlock(MISMATCHED);
    const { all, readable } = warningRenderings();
    expect(all.length).toBeGreaterThan(0);
    expect(readable.length).toBeGreaterThan(0);
  });

  it("does not bury the recommendation behind a disclosure", () => {
    // A <details> the operator never opens is the same failure in a different
    // element, so the readable set excludes those too.
    renderBlock(MISMATCHED);
    expect(warningRenderings().readable.length).toBeGreaterThan(0);
  });

  it("stays silent when the pairing looks fine", () => {
    // The threshold lives in triageOverflow; the block must not re-derive it,
    // so an empty pairingWarning renders nothing whatever the counts say.
    renderBlock(ORDINARY, "CommonSecurityLog");
    expect(screen.queryByText(/Check the sample is the right one/)).toBeNull();
  });
});

describe("OverflowTriageBlock - the field names", () => {
  it("lists the fields with no equivalent, by name", () => {
    renderBlock(MISMATCHED);
    expect(screen.getByText("aaaNope")).toBeTruthy();
    expect(screen.getByText("cccNope")).toBeTruthy();
  });

  it("counts them in the disclosure summary", () => {
    renderBlock(MISMATCHED);
    expect(
      screen.getByText(/Fields with no CrowdStrikeAlerts equivalent \(\s*3\s*\)/),
    ).toBeTruthy();
  });

  it("keeps the outranked list separate from the unmappable one", () => {
    // Two different findings with two different remedies; merging them was the
    // confusion the triage was built to end.
    renderBlock(ORDINARY, "CommonSecurityLog");
    expect(screen.getByText(/Fields with no CommonSecurityLog equivalent/)).toBeTruthy();
    expect(screen.getByText(/Overflow fields with a close-named column/)).toBeTruthy();
    expect(screen.getByText(/upload_filename.*FileName.*filename/)).toBeTruthy();
  });

  it("renders no triage chrome when there is no overflow", () => {
    const empty: OverflowTriage = {
      noEquivalentCount: 0,
      noEquivalent: [],
      outranked: [],
      pairingWarning: "",
      summary: "",
    };
    renderBlock(empty);
    expect(screen.queryByText(/preserved in the catch-all/)).toBeNull();
    expect(screen.queryByText(/Fields with no/)).toBeNull();
  });
});
