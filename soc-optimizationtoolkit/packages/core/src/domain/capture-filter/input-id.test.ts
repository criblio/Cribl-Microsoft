/**
 * input-id pins (DBT-162): the `__inputId` value is `<type>:<id>`, a bare-id
 * selection is `legacy` and never `match`, and the typed form wins.
 */

import { describe, expect, it } from "vitest";
import {
  inputIdValue,
  inputRouteFilter,
  matchInputIdFilter,
  parseInputIdClause,
  readInputIdTest,
} from "./input-id";

const EH = { type: "eventhub", id: "hub" };

describe("inputIdValue", () => {
  it("is <type>:<id>", () => {
    expect(inputIdValue(EH)).toBe("eventhub:hub");
    expect(inputIdValue({ type: "collection", id: "job" })).toBe("collection:job");
  });
});

describe("inputRouteFilter (GEN-21)", () => {
  const SYSLOG = { type: "syslog", id: "in_syslog" };

  it("selects a syslog source by the prefix its events carry", () => {
    const filter = inputRouteFilter(SYSLOG);
    expect(filter).toBe("__inputId.startsWith('syslog:in_syslog:')");
    // The UAT's events read syslog:in_syslog:<sender>: the prefix selects that
    // value and not a neighbour whose id merely starts the same way.
    const prefix = /^__inputId\.startsWith\('(.*)'\)$/.exec(filter)?.[1] ?? "";
    expect("syslog:in_syslog:1.2.3.4".startsWith(prefix)).toBe(true);
    expect("syslog:in_syslog2:1.2.3.4".startsWith(prefix)).toBe(false);
    // And the app's own route readers draw it as routed, not legacy.
    const parsed = parseInputIdClause(filter);
    expect(parsed).toEqual({ kind: "prefix", value: "syslog:in_syslog:" });
    expect(matchInputIdFilter(parsed!, SYSLOG)).toBe("match");
    expect(matchInputIdFilter(parsed!, { type: "syslog", id: "in_syslog2" })).toBe("none");
  });

  it("selects a two-segment source by equality on <type>:<id>, never the bare id", () => {
    const filter = inputRouteFilter(EH);
    expect(filter).toBe("__inputId=='eventhub:hub'");
    const parsed = parseInputIdClause(filter);
    expect(parsed).toEqual({ kind: "inputs", ids: ["eventhub:hub"] });
    expect(matchInputIdFilter(parsed!, EH)).toBe("match");
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
 * One clause grammar, two callers (DBT-169 review): the route parser reads a
 * whole filter with it, the capture warning each operand filter-structure.ts
 * splits a capture filter into (DBT-190).
 */
describe("parseInputIdClause / readInputIdTest", () => {
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

  it("is anchored: an extended filter is not one clause", () => {
    expect(parseInputIdClause("__inputId=='syslog:a' && status >= 400")).toBeNull();
    expect(parseInputIdClause("my__inputId=='syslog:a'")).toBeNull();
    expect(readInputIdTest("__inputId=='syslog:a' && status >= 400")).toBeNull();
  });

  it("reads the reversed equality (DBT-190)", () => {
    expect(parseInputIdClause("'syslog:a' == __inputId")).toEqual({ kind: "inputs", ids: ["syslog:a"] });
    expect(parseInputIdClause('"a" === __inputId')).toEqual({ kind: "inputs", ids: ["a"] });
  });

  it("decodes escapes in a literal, and refuses a template substitution (DBT-190)", () => {
    expect(parseInputIdClause(String.raw`__inputId=="syslog:say \"hi\""`)).toEqual({
      kind: "inputs",
      ids: ['syslog:say "hi"'],
    });
    expect(parseInputIdClause(String.raw`__inputId=='a\\b\x41B\n'`)).toEqual({
      kind: "inputs",
      ids: ["a\\bAB\n"],
    });
    expect(parseInputIdClause(String.raw`['it\'s', "b"].includes(__inputId)`)).toEqual({
      kind: "inputs",
      ids: ["it's", "b"],
    });
    expect(parseInputIdClause("__inputId==`syslog:${x}`")).toBeNull();
  });

  it("reads an includes list only when it holds nothing but literals (DBT-190 review)", () => {
    // The list grammar kept the literals of `[...]` and dropped the rest, so a
    // list with a variable in it read as naming the literals alone.
    expect(parseInputIdClause("['syslog:a', other].includes(__inputId)")).toBeNull();
    expect(parseInputIdClause("['syslog:a', ...more].includes(__inputId)")).toBeNull();
    expect(parseInputIdClause("[].includes(__inputId)")).toBeNull();
    expect(parseInputIdClause("['syslog:a]b', 'c',].includes(__inputId)")).toEqual({
      kind: "inputs",
      ids: ["syslog:a]b", "c"],
    });
  });

  it("does not read a mismatched quote or an inequality as a clause", () => {
    expect(parseInputIdClause("__inputId=='a\"")).toBeNull();
    expect(parseInputIdClause("__inputId!='a'")).toBeNull();
    expect(parseInputIdClause("__inputId !== 'a'")).toBeNull();
  });

  it("reads the capture-only tests, each with its own negation", () => {
    expect(readInputIdTest("__inputId=='syslog:a'")).toEqual({
      kind: "clause",
      clause: { kind: "inputs", ids: ["syslog:a"] },
      negated: false,
    });
    expect(readInputIdTest("__inputId !== 'syslog:a'")).toEqual({
      kind: "clause",
      clause: { kind: "inputs", ids: ["syslog:a"] },
      negated: true,
    });
    expect(readInputIdTest("'syslog:a' != __inputId")).toEqual({
      kind: "clause",
      clause: { kind: "inputs", ids: ["syslog:a"] },
      negated: true,
    });
    expect(readInputIdTest("__inputId.endsWith(':a')")).toEqual({ kind: "suffix", value: ":a" });
    expect(readInputIdTest('__inputId.split(":")[1] === "a"')).toEqual({
      kind: "segment",
      id: "a",
      negated: false,
    });
    expect(readInputIdTest("__inputId.split(':')[1] != 'a'")).toEqual({
      kind: "segment",
      id: "a",
      negated: true,
    });
    expect(readInputIdTest('typeof __inputId === "string"')).toEqual({ kind: "guard", holds: true });
    expect(readInputIdTest("typeof __inputId !== 'undefined'")).toEqual({ kind: "guard", holds: true });
    expect(readInputIdTest("typeof __inputId === 'undefined'")).toEqual({ kind: "guard", holds: false });
    expect(readInputIdTest("typeof __inputId !== 'string'")).toEqual({ kind: "guard", holds: false });
    expect(readInputIdTest("__inputId.length > 3")).toBeNull();
  });
});
