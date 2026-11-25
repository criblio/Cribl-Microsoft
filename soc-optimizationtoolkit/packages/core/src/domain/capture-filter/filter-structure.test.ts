/**
 * filter-structure pins (DBT-190): the boolean split a capture filter's
 * __inputId tests are read inside, and where it refuses to split.
 */

import { describe, expect, it } from "vitest";
import { namesInputIdField, readFilterStructure, structureNamesInputId } from "./filter-structure";

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

  it("drops comments, so an operator inside one is not read (DBT-190 review)", () => {
    expect(readFilterStructure("a /* || b */ && c // || d")).toEqual({
      kind: "and",
      items: [op("a"), op("c")],
    });
    // A quote inside a comment no longer opens a string that hides a real ||.
    expect(readFilterStructure("a /* don't */ || b")).toEqual({ kind: "or", items: [op("a"), op("b")] });
  });

  it("scans template substitutions as code (DBT-190 review)", () => {
    expect(readFilterStructure("f(`${'`'}`) || b")).toEqual({
      kind: "or",
      items: [op("f(`${'`'}`)"), op("b")],
    });
    expect(readFilterStructure("`${`a`}||b` && c")).toEqual({
      kind: "and",
      items: [op("`${`a`}||b`"), op("c")],
    });
    // __inputId read in a substitution marks the operand; as literal text it does not.
    expect(readFilterStructure("`${__inputId}` == 'x'")).toEqual(op("`${__inputId}` == 'x'", true));
    expect(readFilterStructure("`__inputId` == 'x'")).toEqual(op("`__inputId` == 'x'"));
  });

  it("names the field only as a name (structureNamesInputId)", () => {
    for (const filter of ["e.__inputId == 'x'", "_raw.includes('__inputId')", "/__inputId/.test(_raw)", "a /* __inputId */"]) {
      const tree = readFilterStructure(filter);
      expect(tree === null ? null : structureNamesInputId(tree)).toBe(false);
    }
    const tree = readFilterStructure("a && !(b || __inputId == 'x')");
    expect(tree === null ? null : structureNamesInputId(tree)).toBe(true);
  });

  it("has ONE definition of naming the field (namesInputIdField, second review)", () => {
    for (const code of [
      "__inputId",
      "typeof __inputId",
      "!__inputId",
      "(__inputId)",
      "__e.__inputId",
      "__e?.__inputId",
      "__e . __inputId",
      "__e['__inputId']",
      '__e[ "__inputId" ]',
    ]) {
      expect(namesInputIdField(code)).toBe(true);
    }
    for (const code of [
      "my__inputId",
      "__inputIds",
      "e.__inputId",
      "e. __inputId",
      "x.__e.__inputId",
      "my__e.__inputId",
      "'__inputId'",
      "e['__inputId']",
      "__e['__inputIdx']",
    ]) {
      expect(namesInputIdField(code)).toBe(false);
    }
    // The structure asks the same question of each operand's code.
    const tree = readFilterStructure("__e['__inputId'] == 'x'");
    expect(tree === null ? null : structureNamesInputId(tree)).toBe(true);
    expect(tree).toEqual(op("__inputId == 'x'", true));
  });

  it("refuses a / after postfix ++ or -- (second review)", () => {
    expect(readFilterStructure("n++ / 2 > 0 || a")).toBeNull();
    expect(readFilterStructure("n-- / 2 > 0 || a")).toBeNull();
  });

  it("tolerates an unclosed group as one opaque operand", () => {
    expect(readFilterStructure("a && ((((")).toEqual({ kind: "and", items: [op("a"), op("((((")] });
  });
});
