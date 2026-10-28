/**
 * filter-structure pins (DBT-190): the boolean split a capture filter's
 * __inputId tests are read inside, and where it refuses to split.
 */

import { describe, expect, it } from "vitest";
import { readFilterStructure } from "./filter-structure";

const op = (text: string, namesInputId = false) => ({ kind: "operand", text, namesInputId });

describe("readFilterStructure", () => {
  it("splits on || below && below !, with parentheses grouping", () => {
    expect(readFilterStructure("a && !b || (c || d) && e")).toEqual({
      kind: "or",
      items: [
        { kind: "and", items: [op("a"), { kind: "not", item: op("b") }] },
        { kind: "and", items: [{ kind: "or", items: [op("c"), op("d")] }, op("e")] },
      ],
    });
  });

  it("keeps a call, comparison or member access whole, and marks __inputId", () => {
    expect(readFilterStructure("__inputId.startsWith('x:') && obj.__inputId == 1")).toEqual({
      kind: "and",
      items: [op("__inputId.startsWith('x:')", true), op("obj.__inputId == 1")],
    });
    expect(readFilterStructure("(a).b == c")).toEqual(op("(a).b == c"));
  });

  it("does not split inside string, template and regex literals", () => {
    expect(readFilterStructure("_raw.includes(') || (') && /a&&b|(/.test(x) && `||`")).toEqual({
      kind: "and",
      items: [op("_raw.includes(') || (')"), op("/a&&b|(/.test(x)"), op("`||`")],
    });
    // After a name, `/` divides.
    expect(readFilterStructure("a / b || c / d")).toEqual({
      kind: "or",
      items: [op("a / b"), op("c / d")],
    });
  });

  it("keeps `!a == b` whole: the ! binds to a, not the comparison", () => {
    expect(readFilterStructure("!__inputId == 'x'")).toEqual(op("!__inputId == 'x'", true));
  });

  it("refuses a split that would misread the filter", () => {
    expect(readFilterStructure("a && b ? c : d")).toBeNull();
    expect(readFilterStructure("!a ? b : c")).toBeNull();
    expect(readFilterStructure("a, b || c")).toBeNull();
    expect(readFilterStructure("a) || (b")).toBeNull();
    // Alone, or parenthesised, a ternary is one test.
    expect(readFilterStructure("a ? b : c")).toEqual(op("a ? b : c"));
    expect(readFilterStructure("x && (a ? b : c)")).toEqual({
      kind: "and",
      items: [op("x"), op("a ? b : c")],
    });
  });

  it("tolerates an unclosed group as one opaque operand", () => {
    expect(readFilterStructure("a && ((((")).toEqual({ kind: "and", items: [op("a"), op("((((")] });
  });
});
