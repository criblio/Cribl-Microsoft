/**
 * Name the fields that do not fit, and say when the PAIRING is the suspect
 * (user direction, 2026-08-18).
 *
 * The triage counted unmappable fields but never named them, and a count
 * cannot be acted on. The names are what tell an operator whether a sample
 * carries vendor detail the table has no column for, or whether the sample
 * does not belong to this table at all.
 *
 * Measured live: an ASim authentication sample pointed at CrowdStrikeAlerts
 * left 161 fields with no equivalent among 108 columns (both figures verified
 * against ARM). The useful next step there is not "add a column" - that table
 * is Microsoft-managed - it is to check the sample is the right one.
 */

import { describe, expect, it } from "vitest";
import { matchFields } from "./match-fields";
import { triageOverflow } from "./overflow-triage";
import type { DestField, SourceField } from "./models";

const DEST: DestField[] = [
  { name: "TimeGenerated", type: "datetime" },
  { name: "AlertId", type: "string" },
  { name: "AdditionalExtensions", type: "string" },
];

function triage(sourceNames: string[]) {
  const source: SourceField[] = sourceNames.map((name) => ({
    name,
    type: "string",
  }));
  const result = matchFields(source, DEST, undefined, "CrowdStrikeAlerts");
  return triageOverflow(result, DEST, "CrowdStrikeAlerts");
}

describe("overflow triage - names the fields that do not fit", () => {
  it("returns the NAMES, not only a count", () => {
    const t = triage(["zzzTotallyUnrelated", "qqqAlsoUnrelated", "AlertId"]);
    expect(t.noEquivalent).toContain("zzzTotallyUnrelated");
    expect(t.noEquivalent).toContain("qqqAlsoUnrelated");
    expect(t.noEquivalentCount).toBe(t.noEquivalent.length);
  });

  it("keeps the count and the names in agreement", () => {
    // They are two views of one fact; letting them drift would be the same
    // class of defect as any duplicated decision.
    const t = triage(["aaaNope", "bbbNope", "cccNope", "dddNope", "eeeNope"]);
    expect(t.noEquivalentCount).toBe(t.noEquivalent.length);
  });

  it("says the SAMPLE may be wrong when almost nothing fits", () => {
    // The live case: a large, near-total mismatch is a claim about the
    // pairing, not about the table's capacity.
    const t = triage([
      "aaaNope", "bbbNope", "cccNope", "dddNope", "eeeNope", "fffNope",
    ]);
    expect(t.summary).toContain("Check the sample is the right one");
  });

  it("exposes the recommendation as its OWN field, not only inside summary", () => {
    // The card renders a terse overflow line and keeps `summary` in a hover
    // tip. Shipped that way once and the recommendation was invisible unless
    // you hovered - the whole point was to TELL the operator. A discrete field
    // lets the UI render it visibly without re-deriving the threshold.
    const t = triage([
      "aaaNope", "bbbNope", "cccNope", "dddNope", "eeeNope", "fffNope",
    ]);
    expect(t.pairingWarning).toContain("Check the sample is the right one");
    expect(t.pairingWarning).toContain("CrowdStrikeAlerts");
  });

  it("keeps the visible warning and the hover summary the SAME sentence", () => {
    // Two renderings of one recommendation is exactly the duplicated-decision
    // failure the audit looks for; the summary appends it verbatim.
    const t = triage([
      "aaaNope", "bbbNope", "cccNope", "dddNope", "eeeNope", "fffNope",
    ]);
    expect(t.summary).toContain(t.pairingWarning);
  });

  it("does NOT accuse the operator over a couple of odd fields", () => {
    // A few unmappable fields is normal - vendors carry detail a curated
    // table has no column for. Crying wrong-table there would train people
    // to ignore the message.
    const t = triage(["AlertId", "TimeGenerated", "zzzOneOddField"]);
    expect(t.summary).not.toContain("Check the sample is the right one");
    expect(t.pairingWarning).toBe("");
  });

  it("is empty when there is no overflow at all", () => {
    const t = triage(["AlertId", "TimeGenerated"]);
    expect(t.noEquivalent).toEqual([]);
    expect(t.summary).toBe("");
    expect(t.pairingWarning).toBe("");
  });
});
