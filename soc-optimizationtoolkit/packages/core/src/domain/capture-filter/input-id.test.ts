/**
 * input-id pins (DBT-162): the `__inputId` value is `<type>:<id>`, a bare-id
 * selection is `legacy` and never `match`, and the typed form wins.
 */

import { describe, expect, it } from "vitest";
import {
  findInputIdClauses,
  inputIdValue,
  matchInputIdFilter,
  parseInputIdClause,
} from "./input-id";

const EH = { type: "eventhub", id: "hub" };

describe("inputIdValue", () => {
  it("is <type>:<id>", () => {
    expect(inputIdValue(EH)).toBe("eventhub:hub");
    expect(inputIdValue({ type: "collection", id: "job" })).toBe("collection:job");
  });
});

describe("matchInputIdFilter", () => {
  it("a catch-all is a match", () => {
    expect(matchInputIdFilter({ kind: "all" }, EH)).toBe("match");
  });

  it("an equality on the typed value is a match; on the bare id it is legacy", () => {
    expect(matchInputIdFilter({ kind: "inputs", ids: ["eventhub:hub"] }, EH)).toBe("match");
    expect(matchInputIdFilter({ kind: "inputs", ids: ["hub"] }, EH)).toBe("legacy");
  });

  it("the typed form wins when a list names both", () => {
    expect(matchInputIdFilter({ kind: "inputs", ids: ["hub", "eventhub:hub"] }, EH)).toBe("match");
  });

  it("another type with the same id is none, never legacy", () => {
    expect(matchInputIdFilter({ kind: "inputs", ids: ["azure_blob:hub"] }, EH)).toBe("none");
    expect(matchInputIdFilter({ kind: "inputs", ids: ["hub2", "eventhub:hub2"] }, EH)).toBe("none");
  });

  it("a prefix matches the typed value, including Cribl's trailing-colon form", () => {
    expect(matchInputIdFilter({ kind: "prefix", value: "eventhub:" }, EH)).toBe("match");
    expect(matchInputIdFilter({ kind: "prefix", value: "eventhub:hub:" }, EH)).toBe("match");
    expect(matchInputIdFilter({ kind: "prefix", value: "eventhub:hub2" }, EH)).toBe("none");
    expect(matchInputIdFilter({ kind: "prefix", value: "syslog:" }, EH)).toBe("none");
  });

  it("a prefix only the bare id satisfies is legacy", () => {
    expect(matchInputIdFilter({ kind: "prefix", value: "hu" }, EH)).toBe("legacy");
  });
});

/**
 * One clause grammar, two callers (DBT-169 review): the route parser anchors
 * it on the whole filter, the capture warning finds it inside a larger one.
 */
describe("parseInputIdClause / findInputIdClauses", () => {
  it("reads each form, in any quote", () => {
    expect(parseInputIdClause("__inputId=='syslog:a'")).toEqual({ kind: "inputs", ids: ["syslog:a"] });
    expect(parseInputIdClause(' __inputId === "a" ')).toEqual({ kind: "inputs", ids: ["a"] });
    expect(parseInputIdClause("__inputId==`a`")).toEqual({ kind: "inputs", ids: ["a"] });
    expect(parseInputIdClause("['a',\"b\"].includes(__inputId)")).toEqual({
      kind: "inputs",
      ids: ["a", "b"],
    });
    expect(parseInputIdClause("__inputId.startsWith( 'syslog:a:' )")).toEqual({
      kind: "prefix",
      value: "syslog:a:",
    });
  });

  it("parse is anchored; find is not", () => {
    const extended = "__inputId=='syslog:a' && status >= 400";
    expect(parseInputIdClause(extended)).toBeNull();
    expect(findInputIdClauses(extended)).toEqual([{ kind: "inputs", ids: ["syslog:a"] }]);
    expect(
      findInputIdClauses("__inputId.startsWith('x:') || ['a'].includes(__inputId) || __inputId=='b'"),
    ).toEqual([
      { kind: "inputs", ids: ["b"] },
      { kind: "prefix", value: "x:" },
      { kind: "inputs", ids: ["a"] },
    ]);
  });

  it("does not read a mismatched quote or an inequality as a clause", () => {
    expect(parseInputIdClause("__inputId=='a\"")).toBeNull();
    expect(findInputIdClauses("__inputId!='a'")).toEqual([]);
    expect(findInputIdClauses("__inputId !== 'a'")).toEqual([]);
  });
});
