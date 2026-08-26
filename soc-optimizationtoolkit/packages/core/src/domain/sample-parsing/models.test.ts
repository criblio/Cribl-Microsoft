import { describe, expect, it } from "vitest";

import { parseCsvWithHeaders } from "./csv-headers";
import {
  isOverflowFieldName,
  isPositionalFieldName,
  overflowFieldName,
  positionalFieldName,
} from "./models";

/**
 * THE TWO NAMES FOR A COLUMN THE OPERATOR DID NOT NAME, and why they are not
 * one name.
 *
 * `_N` says NOBODY NAMED THIS COLUMN. `_extra_N` says THE DEFINITION WAS SHORT
 * - a value beyond the headers that were supplied. Different facts about
 * different problems, which is why models.ts keeps them apart rather than
 * folding the second into the first.
 *
 * These are pinned together because each is a PRODUCER paired with a
 * RECOGNISER, and every time that pair has been split in this codebase the two
 * halves drifted: `parseCsv` said `_0` while `parsePanosLine` said `field_0`,
 * and `isHeaderlessCsv` could only see one of them, so PAN-OS log types with no
 * column order were invisible to the app's own naming dialog.
 *
 * `overflowFieldName` was promoted into models.ts on 2026-08-26 for the same
 * reason, from a private const in the UI's csv-resolution-state. That copy was
 * the more dangerous kind: its only reader recognises samples an OLDER build
 * left behind, and the app no longer produces such samples, so no test creates
 * one - a rename of the producer would have left the recogniser matching
 * nothing, silently, with a green suite.
 */
describe("positional and overflow column names", () => {
  it("round-trips each producer through its own recogniser", () => {
    expect(positionalFieldName(0)).toBe("_0");
    expect(positionalFieldName(12)).toBe("_12");
    expect(isPositionalFieldName(positionalFieldName(12))).toBe(true);

    expect(overflowFieldName(12)).toBe("_extra_12");
    expect(isOverflowFieldName(overflowFieldName(12))).toBe(true);
  });

  it("keeps the two kinds of unnamed APART", () => {
    // The distinction is the whole reason there are two: neither recogniser may
    // claim the other's names, or the caller loses "your definition was short".
    expect(isPositionalFieldName("_extra_12")).toBe(false);
    expect(isOverflowFieldName("_12")).toBe(false);
  });

  it("rejects names that merely start the same way", () => {
    // Prefix matching is what the UI used to do (`name.startsWith("_extra_")`),
    // and it would claim a real column called `_extra_notes`.
    expect(isOverflowFieldName("_extra_notes")).toBe(false);
    expect(isOverflowFieldName("_extra_")).toBe(false);
    expect(isPositionalFieldName("_dst")).toBe(false);
    expect(isPositionalFieldName("_")).toBe(false);
  });

  it("is the SAME spelling parseCsvWithHeaders actually parks a value at", () => {
    // The pin that makes the promotion worth anything: producer and recogniser
    // are checked against the real parser, not against each other. Three values,
    // two headers - so index 2 overflows.
    const parsed = parseCsvWithHeaders("a,b,c", ["one", "two"]);
    const keys = Object.keys(parsed.records[0]);
    expect(keys).toContain(overflowFieldName(2));
    expect(keys.filter(isOverflowFieldName)).toEqual([overflowFieldName(2)]);
  });
});
