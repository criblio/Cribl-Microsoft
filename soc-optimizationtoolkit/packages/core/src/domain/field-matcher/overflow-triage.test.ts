/**
 * Pins for the overflow triage (user request 2026-07-12): the report must
 * distinguish UNMAPPABLE overflow (no destination column exists) from
 * OUTRANKED (closest column claimed by a better field). There is no "missed"
 * category by construction - the matcher's accept threshold equals the
 * ladder's minimum nonzero score and global assignment gives a losing source
 * its next-best column, so a close-named column is never left unclaimed
 * while a scoring source overflows.
 */

import { describe, expect, it } from "vitest";
import { matchFields } from "./match-fields";
import { EMPTY_OVERFLOW_TRIAGE, triageOverflow } from "./overflow-triage";

const CSL_SLICE = [
  { name: "FileName", type: "string" },
  { name: "Reason", type: "string" },
  { name: "SourceIP", type: "string" },
  { name: "AdditionalExtensions", type: "string" },
];

function analyze(sourceNames: string[]) {
  return matchFields(
    sourceNames.map((name) => ({ name, type: "string" })),
    CSL_SLICE,
    undefined,
    "CommonSecurityLog",
  );
}

describe("triageOverflow", () => {
  it("splits overflow into no-equivalent and outranked (the Zscaler shape)", () => {
    // filename claims FileName exactly, so upload_filename overflows with
    // FileName as its closest column - OUTRANKED, claimant named. The
    // zpa_app_seg_name field scores 0 against every column - NO EQUIVALENT.
    const result = analyze(["filename", "upload_filename", "zpa_app_seg_name"]);
    const triage = triageOverflow(result, CSL_SLICE, "CommonSecurityLog");

    expect(triage.noEquivalentCount).toBe(1);
    expect(triage.outranked).toEqual([
      {
        sourceName: "upload_filename",
        column: "FileName",
        score: expect.any(Number),
        claimedBy: "filename",
      },
    ]);
    expect(triage.summary).toBe(
      "1 of 2 overflow fields have no CommonSecurityLog equivalent (checked " +
        "against all 4 destination columns). 1 outranked: the closest column " +
        "is already claimed by a better source field.",
    );
  });

  it("omits the outranked sentence when every overflow field is unmappable", () => {
    const result = analyze(["zpa_app_seg_name", "eedone"]);
    const triage = triageOverflow(result, CSL_SLICE, "CommonSecurityLog");
    expect(triage.noEquivalentCount).toBe(2);
    expect(triage.outranked).toEqual([]);
    expect(triage.summary).toBe(
      "2 of 2 overflow fields have no CommonSecurityLog equivalent (checked " +
        "against all 4 destination columns).",
    );
  });

  it("never proposes the catch-all column as an equivalent", () => {
    // Force an overflow row whose only similar column is the catch-all: the
    // matcher itself would claim AdditionalExtensions when it is free, so
    // pin the triage guard directly with a synthetic result.
    const result = analyze(["zpa_app_seg_name"]);
    const forced = {
      ...result,
      overflow: [
        {
          ...result.overflow[0],
          sourceName: "additionalextension",
        },
      ],
    };
    const triage = triageOverflow(forced, CSL_SLICE, "CommonSecurityLog");
    expect(triage.outranked).toEqual([]);
    expect(triage.noEquivalentCount).toBe(1);
  });

  it("is empty (blank summary) when nothing overflows or schema is empty", () => {
    const clean = analyze(["filename"]);
    expect(triageOverflow(clean, CSL_SLICE, "CommonSecurityLog")).toEqual(
      EMPTY_OVERFLOW_TRIAGE,
    );
    const overflowing = analyze(["zpa_app_seg_name"]);
    expect(triageOverflow(overflowing, [], "CommonSecurityLog")).toEqual(
      EMPTY_OVERFLOW_TRIAGE,
    );
  });
});
