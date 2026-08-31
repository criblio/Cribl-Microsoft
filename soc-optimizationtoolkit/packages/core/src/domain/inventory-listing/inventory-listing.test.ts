/**
 * Pins for the listing type (DBT-61).
 *
 * The real guard here is the COMPILER, not these tests - the whole point is
 * that `${listing.length}` and `listing.rows.length === 0` stop compiling. What
 * runtime tests can pin is the behaviour of the helpers, and above all that the
 * `rows` variant is never empty, since the type's promise - a count from it can
 * never be 0 - rests entirely on that.
 */

import { describe, expect, it } from "vitest";
import { listingCount, listingRows, toListing } from "./inventory-listing";

describe("toListing", () => {
  it("makes an EMPTY listing from no rows - no count to misread", () => {
    const l = toListing<string>([]);
    expect(l.kind).toBe("empty");
    // The empty variant carries no rows at all, so there is nothing to count.
    expect(l).toEqual({ kind: "empty" });
  });

  it("makes a ROWS listing that is never empty", () => {
    // Load-bearing: the type's whole promise is that a count taken from the
    // rows variant cannot be 0. If this could produce kind:"rows" with an
    // empty array, `Read ${l.rows.length}` would be the original bug again.
    const l = toListing(["a", "b"]);
    expect(l.kind).toBe("rows");
    if (l.kind !== "rows") throw new Error("unreachable");
    expect(l.rows.length).toBeGreaterThan(0);
  });

  it("preserves order and contents", () => {
    const l = toListing([3, 1, 2]);
    expect(listingRows(l)).toEqual([3, 1, 2]);
  });
});

describe("listingRows - the escape hatch", () => {
  it("gives the rows when there are any", () => {
    expect(listingRows(toListing(["x"]))).toEqual(["x"]);
  });

  it("gives an empty array for an empty listing", () => {
    expect(listingRows(toListing<string>([]))).toEqual([]);
  });
});

describe("listingCount", () => {
  it("counts the rows when there are any", () => {
    expect(listingCount(toListing(["a", "b"]), 0)).toBe(2);
  });

  it("RETURNS WHAT THE CALLER SAID EMPTY MEANS, not zero by assumption", () => {
    // The signature exists so the assumption is written at the call site. A
    // caller that has not earned "none" can pass something else - and more to
    // the point, has to look at the argument and decide.
    const empty = toListing<string>([]);
    expect(listingCount(empty, 0)).toBe(0);
    expect(listingCount(empty, -1)).toBe(-1);
  });
});
