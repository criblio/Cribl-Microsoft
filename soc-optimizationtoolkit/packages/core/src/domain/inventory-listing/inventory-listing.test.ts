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
import {
  filterListing,
  listingCount,
  listingRows,
  listingWasRead,
  toListing,
} from "./inventory-listing";

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

describe("filterListing - the only way to mint a VERIFIED none", () => {
  it("calls zero matches over a read that produced rows a real `none`", () => {
    // The listLabs case (DBT-64): forty resource groups were read and none is
    // a lab. "No running labs" is TRUE here and the operator should be told so
    // plainly rather than hedged at.
    const source = toListing(["rg-a", "rg-b"]);
    expect(filterListing(source, [])).toEqual({ kind: "none" });
  });

  it("PROPAGATES an unverified source - a filter cannot learn what the read did not", () => {
    // The half of the distinction that actually prevents the bug. If the
    // resource-group read itself came back empty, zero labs says nothing about
    // whether there are labs, so this must NOT become a `none`.
    expect(filterListing(toListing<string>([]), [])).toEqual({ kind: "empty" });
  });

  it("still refuses to conclude when an unverified source yields matches", () => {
    // Cannot actually happen - a filter over nothing yields nothing - but the
    // type does not know that, and the answer has to stay honest if it did.
    expect(filterListing(toListing<string>([]), ["x"])).toEqual({ kind: "empty" });
  });

  it("gives rows when the filter matched, and they are non-empty", () => {
    const l = filterListing(toListing(["a", "b"]), ["b"]);
    expect(l.kind).toBe("rows");
    expect(listingRows(l)).toEqual(["b"]);
  });

  it("can mint `none` from a `none` source - a filter over a measured zero is still measured", () => {
    expect(filterListing({ kind: "none" }, [])).toEqual({ kind: "none" });
  });
});

describe("listingCount with the third variant", () => {
  it("returns 0 for a VERIFIED none and IGNORES whenEmpty", () => {
    // Load-bearing: whenEmpty exists so an unverified caller has to state an
    // assumption. A measured zero has no assumption left, so passing -1 must
    // not turn a real 0 into a hedge.
    expect(listingCount({ kind: "none" }, -1)).toBe(0);
    expect(listingCount({ kind: "none" }, 99)).toBe(0);
  });

  it("still honours whenEmpty for the UNVERIFIED empty", () => {
    expect(listingCount(toListing<string>([]), -1)).toBe(-1);
  });
});

describe("listingWasRead", () => {
  it("is true for rows and for a measured none, false only for empty", () => {
    // The fact most likely to be got wrong from memory - `none` is a VERIFIED
    // state, so it groups with rows, not with empty.
    expect(listingWasRead(toListing(["a"]))).toBe(true);
    expect(listingWasRead({ kind: "none" })).toBe(true);
    expect(listingWasRead(toListing<string>([]))).toBe(false);
  });
});

describe("listingRows over all three variants", () => {
  it("gives an empty array for BOTH nothing-kinds", () => {
    expect(listingRows({ kind: "none" })).toEqual([]);
    expect(listingRows(toListing<string>([]))).toEqual([]);
  });
});
