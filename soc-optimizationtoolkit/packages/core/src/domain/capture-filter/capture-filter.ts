/**
 * Cribl capture FILTER composition (sample-acquisition plan Phase 4, ADR 0003).
 *
 * A capture request carries no source field - `CaptureParamsReq` is
 * `{filter, level, maxEvents, duration, ...}` and nothing names an input
 * (verified against the vendored spec 2026-08-19). The source is selected
 * INSIDE the filter, via the `__inputId` event field, which the spec's own
 * example demonstrates (`__inputId.startsWith("http:") && status >= 400`).
 *
 * So the filter conjoins two things the operator chose separately:
 *
 *     (__inputId === "in_syslog" || (typeof __inputId === "string" &&
 *       __inputId.split(":")[1] === "in_syslog")) && (<the log-type test>)
 *
 * (inputPredicate below explains the segment arm: the events carry
 * `<type>:<id>`, not the bare id.)
 *
 * FOUR CORRECTNESS RULES, every one learned rather than assumed - and note that
 * three of them are the SAME failure in different clothes: a filter that matches
 * nothing looks exactly like a source that carries nothing.
 *
 * 1. CASE-INSENSITIVE. PAN-OS emits `GLOBALPROTECT`, not `GlobalProtect`, so a
 *    case-sensitive test silently returns zero events - which reads as "this
 *    source does not carry that log type". An answer, not an error.
 *
 * 2. ANCHOR ON DELIMITERS, NOT BARE SUBSTRINGS. route-value-discriminator.ts
 *    already documents why: a bare value "matches anywhere in the event and
 *    would route unrelated traffic here - a false positive is worse than no
 *    fallback". `/traffic/i` matches a URL, a hostname, a user-agent.
 *
 * 3. ...BUT THE DELIMITER IS NOT ALWAYS A COMMA. The plan specifies
 *    `/,TRAFFIC,/i`, reasoning from PAN-OS being comma-delimited CSV. The
 *    operator picks a SOURCE, though, not a format - and a comma anchor against
 *    a pipe-delimited CEF vendor matches nothing. The anchor is the SET of
 *    delimiters the formats this app parses actually use. `/` is excluded ON
 *    PURPOSE, so a URL path like `/api/traffic/list` still does not match.
 *
 * 4. `_raw` IS NOT ALWAYS THERE (2026-08-20 bug-hunt). The test looked at `_raw`
 *    alone. Against an Event Hub, HEC or Kafka JSON source - all of which the
 *    picker offers - `_raw` is undefined, so the capture returned nothing and
 *    the operator was told their filter matched nothing. The structured
 *    discriminator fields are checked alongside it now.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

// The gap-analysis KQL parser already owns this. Importing rather than writing
// a second copy - the 2026-08-19 audit found five inline envelope readers and
// the same rule in two places is exactly what it flags.
import { escapeRegExp } from "../gap-analysis/kql-parser";
import {
  DISCRIMINATOR_FIELDS,
  HIGH_CONFIDENCE_DISCRIMINATOR_COUNT,
} from "../sample-parsing/discriminators";
import type { FilterNode } from "./filter-structure";
import { readFilterStructure } from "./filter-structure";
import type { InputIdRef, InputIdTest } from "./input-id";
import { inputIdValue, matchInputIdFilter, readInputIdTest } from "./input-id";

/**
 * The characters that may bound a log-type token, as a regex CHARACTER CLASS
 * body. `/` is excluded deliberately (rule 3). The doubled backslashes are
 * TypeScript's - `\\t` reaches the generated pattern as `\t`.
 */
const DELIMITERS = ",|\\t\"':= \\r\\n";

/**
 * Fields a capture filter checks BESIDES `_raw`, for structured sources.
 *
 * The HIGH-CONFIDENCE discriminators plus the two commonest structured-source
 * names. Deliberately not all sixteen: this filter is shown to the operator and
 * is meant to be edited, and the lower-confidence tail needs two distinct values
 * to even qualify as a discriminator - weaker evidence, more noise in a box
 * somebody has to read.
 */
const STRUCTURED_FIELDS: readonly string[] = Object.freeze([
  ...DISCRIMINATOR_FIELDS.slice(0, HIGH_CONFIDENCE_DISCRIMINATOR_COUNT),
  "category",
  "sourcetype",
]);

/**
 * The log-type test: the raw line OR any structured field carrying the value.
 *
 * BUILT WITH `new RegExp`, NOT A REGEX LITERAL, and that is a fix for a CLASS of
 * bug rather than one instance. A value embedded in a literal has to dodge every
 * character that can terminate one: `/` closed it early and emitted unparseable
 * JavaScript (found 2026-08-20 and patched by hand), and the line terminators
 * would have been next. Inside an ordinary string there is nothing to terminate,
 * and JSON.stringify escapes the pattern correctly by construction - so the
 * hand-rolled escape table that kept missing cases is gone entirely.
 *
 * EVERY FIELD ACCESS IS `typeof`-GUARDED, which is not defensive style but the
 * difference between working and breaking everything: a Cribl filter is
 * JavaScript, and referencing a bare name the event does not carry is a
 * ReferenceError that drops the event. `typeof` is the one operator safe on an
 * undeclared name, so a filter naming eight fields still runs against a source
 * that has none of them.
 *
 * ONE ALTERNATION over all the values rather than a clause per value, so the
 * filter is the same length whether one log type was ticked or six.
 */
export function logTypePredicate(values: readonly string[]): string {
  const wanted = values.map((v) => v.trim()).filter((v) => v !== "");
  if (wanted.length === 0) {
    return "";
  }
  const alt = wanted.map(escapeRegExp).join("|");
  const rawPattern = JSON.stringify(
    `(^|[${DELIMITERS}])(${alt})([${DELIMITERS}]|$)`,
  );
  const fieldPattern = JSON.stringify(`^(${alt})$`);

  // `_raw` IS GUARDED TOO (2026-08-20 audit). It was the one bare reference
  // left, which made this function contradict its own rule 4 in the worst
  // possible place: rule 4 exists BECAUSE `_raw` is absent on Event Hub, HEC and
  // Kafka JSON sources, and on exactly those sources the bare reference is the
  // ReferenceError that drops every event. The structured arms added to rescue
  // them could never run, because the expression threw before reaching them.
  const tests = [
    `(typeof _raw !== "undefined" && new RegExp(${rawPattern}, "i").test(String(_raw)))`,
    ...STRUCTURED_FIELDS.map(
      (field) =>
        `(typeof ${field} !== "undefined" && new RegExp(${fieldPattern}, "i").test(String(${field})))`,
    ),
  ];
  return tests.join(" || ");
}

/**
 * The source-selection clause: the input id as the SECOND colon segment.
 *
 * `__inputId` IS NOT THE BARE INPUT ID. It is `<type>:<id>`, optionally with
 * further segments after it. `/system/inputs` hands us only the bare `id`, so
 * `__inputId === "in_syslog"` matched NOTHING and every capture came back empty
 * - reported to the operator as an idle source.
 *
 * VERIFIED AGAINST THE PRODUCT (2026-08-21). Cribl's own capture dialog offers
 * an "Input Filters" list that it generates from the configured inputs, and it
 * shows both shapes plainly:
 *
 *   __inputId=='cribl_tcp:in_cribl_tcp'      two segments
 *   __inputId=='snmp:Cisco350_SNMP'          two segments
 *   __inputId=='collection:replay_pfsense'   two segments (a collection job)
 *   __inputId.startsWith('syslog:pfsense:')  THREE - note Cribl uses startsWith
 *   __inputId.startsWith('syslog:Corelight:')
 *   __inputId.startsWith('http:http:')
 *
 * THE SUFFIX MATCH THIS REPLACES WAS WRONG for the second shape, and wrong in
 * the worst place: `"syslog:pfsense:10.0.0.1".endsWith(":pfsense")` is false, so
 * a capture from any SYSLOG source still matched nothing - and syslog is the
 * transport for most of the vendors this toolkit onboards. The bug survived a
 * spec read and a full round of pins because the spec's examples happen to be
 * two-segment.
 *
 * Cribl solves it with `startsWith('<type>:<id>:')`, which needs the type. We
 * only have the id, so we take the SEGMENT instead: split on `:` and compare
 * position 1. That is exactly the id in every shape above, and it cannot
 * half-match the way a substring can - `syslog:other_pfsense:x` has
 * `other_pfsense` at position 1, not `pfsense`.
 *
 * The equality arm stays first so a deployment that hands back a bare id still
 * works, and the split is typeof-guarded because calling a method on an absent
 * field is a TypeError that drops every event.
 */
export function inputPredicate(inputId: string): string {
  const quoted = JSON.stringify(inputId);
  return `(__inputId === ${quoted} || (typeof __inputId === "string" && __inputId.split(":")[1] === ${quoted}))`;
}

/** Inputs to {@link buildCaptureFilter}. */
export interface CaptureFilterInput {
  /** The Cribl input id the operator selected. */
  inputId: string;
  /**
   * Log-type values to capture. EMPTY means "everything from this source",
   * which is a legitimate choice - not every vendor partitions its output, and
   * an operator who does not know yet should be able to look first.
   */
  logTypes?: readonly string[];
}

/**
 * Compose the capture filter: the source clause alone when no log type was
 * chosen, otherwise the source AND the log-type test, parenthesised so the
 * conjunction binds the way it reads.
 */
export function buildCaptureFilter(input: CaptureFilterInput): string {
  const source = inputPredicate(input.inputId);
  const body = logTypePredicate(input.logTypes ?? []);
  return body === "" ? source : `${source} && (${body})`;
}

/**
 * A problem with a filter the operator has edited, or null when it looks sound.
 *
 * ONE CHECK, and it is the one that fails silently. The plan lets the operator
 * edit any suggested filter, and the edit that costs them is dropping the
 * `__inputId` clause - the capture then runs against EVERY source in the worker
 * group, quietly returning a mixture they believe came from one place. A wrong
 * filter that errors is fine; this one succeeds and lies.
 *
 * DECIDED BY input-id.ts (DBT-169), the one answer every route reader shares:
 * the TYPED form the events carry (`<type>:<id>`) selects the source, the BARE
 * id (`legacy`) was verified to match nothing, and comparing whole literals
 * keeps the 2026-08-20 bug-hunt rule that `"in_syslog_prod"` does not name
 * `in_syslog`.
 *
 * ...AND BY THE STRUCTURE AROUND THE CLAUSES (DBT-190). filter-structure.ts
 * splits the filter on `&&`, `||` and `!`, each operand naming `__inputId` is
 * read as a test (readInputIdTest), and the tree is folded into whether events
 * from THIS source, and from OTHER sources, can pass ({@link Reach}). It is
 * silent only when no other source can and this one may. Before, each clause
 * was asked alone, so `!(<the right clause>)` and `<the right clause> ||
 * <another source>` were silent while the capture took a mixture.
 *
 * WHAT IT CANNOT READ, IT SAYS IT DID NOT CHECK. A structure the split would
 * misread (a ternary outside parentheses), or an `__inputId` test in a form
 * input-id.ts does not know, gets "not checked" rather than a guess - unless
 * the structure bounds it anyway (`<the right clause> && <anything>`).
 *
 * The type is OPTIONAL because a source listing may omit it. Without one only
 * what needs no type is decided - the segment clause inputPredicate writes,
 * the bare id, a value whose id segment is another source's - and anything
 * else says it cannot be, rather than guessing.
 *
 * Deliberately NOT a validator. Cribl evaluates the expression as JavaScript
 * and this app has no business deciding what is valid JS - a filter that fails
 * to compile comes back as an HTTP error carrying Cribl's own message, which is
 * more accurate than anything guessed here.
 */
export function captureFilterWarning(
  filter: string,
  inputId: string,
  inputType?: string,
): string | null {
  if (filter.trim() === "") {
    return "An empty filter captures every event from every source in the worker group.";
  }
  // Word-bounded: `my__inputId` is another name (DBT-190).
  if (!/(?<![\w$])__inputId(?![\w$])/.test(filter)) {
    return `This filter does not mention __inputId, so it captures from EVERY source in the worker group - not just "${inputId}". Add ${inputPredicate(inputId)} unless that is what you want.`;
  }
  const value = inputType === undefined ? undefined : inputIdValue({ type: inputType, id: inputId });
  const write =
    value === undefined
      ? `Write ${inputPredicate(inputId)}`
      : `Write __inputId === ${JSON.stringify(value)} || __inputId.startsWith(${JSON.stringify(`${value}:`)})`;
  const unchecked = `This filter's __inputId test is in a form this app does not read, so it was not checked against "${inputId}". ${write} if it should select only this source.`;
  const tree = readFilterStructure(filter);
  if (tree === null) {
    return unchecked;
  }
  const facts: Facts = {
    namesSelf: false,
    negatesSelf: false,
    otherNames: [],
    broad: false,
    suffix: false,
    typeUnknown: false,
    unread: false,
  };
  const ref: SelectedInput = { id: inputId, type: inputType };
  const r = reach(tree, ref, false, facts);
  if (r.others === "no" && (r.self === "yes" || r.self === "maybe")) {
    return null;
  }
  const mixed = r.others !== "no";
  if (facts.negatesSelf) {
    return `This filter negates its __inputId test for "${inputId}", so it captures from other sources rather than only this one. ${write} without the negation.`;
  }
  if (facts.typeUnknown) {
    return `The type of source "${inputId}" is unknown, so this filter's __inputId clause cannot be checked against it.`;
  }
  if (facts.unread) {
    return unchecked;
  }
  if (!facts.namesSelf) {
    return `This filter references __inputId but not "${inputId}", so it may capture from a different source than the one selected.`;
  }
  if (mixed && facts.otherNames.length > 0) {
    const names = facts.otherNames.map((n) => JSON.stringify(n)).join(", ");
    return `This filter's __inputId test names another source as well as "${inputId}" (${names}), so it may capture from more than the one selected. ${write} to select only this source.`;
  }
  // A PREFIX that stops short of `<type>:<id>:` (`startsWith('syslog:')`, or
  // `startsWith('syslog:in_syslog')`, which also takes in_syslog_prod) selects
  // this input AND others, the mixed capture this warning exists for.
  if (mixed && facts.broad) {
    return `This filter's __inputId.startsWith() prefix selects "${inputId}" but also any other source whose __inputId starts with it, so it may capture a mixture. ${write} to select only this source.`;
  }
  if (mixed && facts.suffix) {
    return `This filter's __inputId.endsWith() test selects "${inputId}" but also any other source whose __inputId ends the same way, and misses events whose __inputId carries a further segment after the id (syslog adds the sender). ${write} instead.`;
  }
  if (r.self === "legacy" && !mixed && value !== undefined) {
    return `This filter names the bare input id "${inputId}" (unconfirmed: events carry __inputId as ${JSON.stringify(value)}, and the bare form matched nothing when captured), so it will likely capture nothing. ${write} instead.`;
  }
  if (mixed) {
    return `This filter's __inputId test for "${inputId}" does not hold on every branch (an || or ! lets other events through), so it may capture from other sources too. ${write} and join any other test with &&.`;
  }
  return `This filter's __inputId tests cannot all hold for "${inputId}", so it will likely capture nothing. ${write} instead.`;
}

/**
 * Can an event pass a test? Ordered, so `&&` takes the lower answer and `||`
 * the higher: no < legacy < maybe < yes. `legacy` is "only by the bare id",
 * which was verified to match nothing in a capture.
 */
type Pass = "no" | "legacy" | "maybe" | "yes";

const RANK: Readonly<Record<Pass, number>> = { no: 0, legacy: 1, maybe: 2, yes: 3 };

/** Whether events from the selected source, and from any other, can pass. */
interface Reach {
  self: Pass;
  others: Pass;
}

const ANYTHING: Reach = { self: "maybe", others: "maybe" };

/** What the fold saw on the way, so the warning can say WHY. */
interface Facts {
  /** A test that selects this source, not under negation. */
  namesSelf: boolean;
  /** A test that selects this source under an odd number of negations. */
  negatesSelf: boolean;
  /** The values non-negated tests name for OTHER sources. */
  otherNames: string[];
  /** A non-negated startsWith() that takes this source and others. */
  broad: boolean;
  /** A non-negated endsWith() that takes this source. */
  suffix: boolean;
  /** A test that cannot be decided without the source's type. */
  typeUnknown: boolean;
  /** An operand that names __inputId in a form input-id.ts does not read. */
  unread: boolean;
}

interface SelectedInput {
  id: string;
  type: string | undefined;
}

function pick(a: Pass, b: Pass, higher: boolean): Pass {
  return RANK[a] >= RANK[b] === higher ? a : b;
}

function combine(parts: readonly Reach[], higher: boolean): Reach {
  return parts.reduce((acc, r) => ({
    self: pick(acc.self, r.self, higher),
    others: pick(acc.others, r.others, higher),
  }));
}

/**
 * `!` of an answer. The negation of `legacy` is `maybe`, not `yes`: the bare
 * form matching nothing is verified for one capture, not proven.
 */
function negate(p: Pass): Pass {
  return p === "yes" ? "no" : p === "no" ? "yes" : "maybe";
}

function reach(node: FilterNode, ref: SelectedInput, negated: boolean, facts: Facts): Reach {
  switch (node.kind) {
    case "and":
    case "or":
      return combine(
        node.items.map((item) => reach(item, ref, negated, facts)),
        node.kind === "or",
      );
    case "not": {
      const r = reach(node.item, ref, !negated, facts);
      return { self: negate(r.self), others: negate(r.others) };
    }
    case "operand": {
      if (!node.namesInputId) {
        return ANYTHING;
      }
      const test = readInputIdTest(node.text);
      if (test === null) {
        facts.unread = true;
        return ANYTHING;
      }
      return testReach(test, ref, negated, facts);
    }
  }
}

/** One `__inputId` test's answer, recording what it names. */
function testReach(test: InputIdTest, ref: SelectedInput, negated: boolean, facts: Facts): Reach {
  const own = test.kind === "clause" || test.kind === "segment" ? test.negated : false;
  const polarity = negated !== own;
  const named: string[] = [];
  const r = positiveReach(test, ref, named, facts, polarity);
  if (r.self === "yes" || r.self === "legacy") {
    if (polarity) {
      facts.negatesSelf = true;
    } else {
      facts.namesSelf = true;
    }
  }
  if (!polarity) {
    facts.otherNames.push(...named);
  }
  return own ? { self: negate(r.self), others: negate(r.others) } : r;
}

/**
 * A test's answer read without its own negation. `named` collects the values
 * it names for other sources; `polarity` true means it sits under negation,
 * where a broad prefix or a suffix EXCLUDES rather than takes a mixture.
 */
function positiveReach(
  test: InputIdTest,
  ref: SelectedInput,
  named: string[],
  facts: Facts,
  polarity: boolean,
): Reach {
  const other = (name: string): Reach => {
    named.push(name);
    return { self: "no", others: "yes" };
  };
  const unknown = (): Reach => {
    facts.typeUnknown = true;
    return ANYTHING;
  };
  switch (test.kind) {
    case "guard":
      return test.holds ? { self: "yes", others: "yes" } : { self: "no", others: "no" };
    case "segment":
      return test.id === ref.id ? { self: "yes", others: "no" } : other(test.id);
    case "suffix": {
      const takes =
        ref.type === undefined
          ? `:${ref.id}`.endsWith(test.value)
            ? true
            : undefined
          : inputIdValue({ type: ref.type, id: ref.id }).endsWith(test.value);
      if (takes === undefined) {
        return unknown();
      }
      if (!takes) {
        return other(test.value);
      }
      facts.suffix ||= !polarity;
      return { self: "yes", others: "yes" };
    }
    case "clause": {
      const clause = test.clause;
      if (clause.kind === "inputs") {
        // A list is the OR of one equality per id.
        return combine(
          clause.ids.map((v) => {
            if (v === ref.id) {
              return { self: "legacy", others: "no" };
            }
            if (ref.type === undefined) {
              return v.split(":")[1] === ref.id ? unknown() : other(v);
            }
            return matchInputIdFilter({ kind: "inputs", ids: [v] }, { type: ref.type, id: ref.id }) ===
              "match"
              ? { self: "yes", others: "no" }
              : other(v);
          }),
          true,
        );
      }
      if (clause.kind === "all") {
        return { self: "yes", others: "yes" };
      }
      if (ref.type === undefined) {
        return unknown();
      }
      const typed: InputIdRef = { type: ref.type, id: ref.id };
      const how = matchInputIdFilter(clause, typed);
      if (how === "legacy") {
        return { self: "legacy", others: "no" };
      }
      if (how === "none") {
        return other(clause.value);
      }
      if (clause.value.startsWith(`${inputIdValue(typed)}:`)) {
        return { self: "yes", others: "no" };
      }
      facts.broad ||= !polarity;
      return { self: "yes", others: "yes" };
    }
  }
}
