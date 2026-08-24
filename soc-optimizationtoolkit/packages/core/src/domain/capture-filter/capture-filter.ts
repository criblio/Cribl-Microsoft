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
 *     __inputId === "in_syslog" && (<the log-type test>)
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
 * MATCHED AS A QUOTED LITERAL (2026-08-20 bug-hunt). A bare substring test
 * accepted `__inputId === "in_syslog_prod"` as though it named `in_syslog`, so
 * the capture ran against a DIFFERENT source while the panel said otherwise -
 * the same succeeds-and-lies shape this function exists to catch.
 *
 * Deliberately NOT a validator. Cribl evaluates the expression as JavaScript
 * and this app has no business deciding what is valid JS - a filter that fails
 * to compile comes back as an HTTP error carrying Cribl's own message, which is
 * more accurate than anything guessed here.
 */
export function captureFilterWarning(
  filter: string,
  inputId: string,
): string | null {
  if (filter.trim() === "") {
    return "An empty filter captures every event from every source in the worker group.";
  }
  if (!filter.includes("__inputId")) {
    return `This filter does not mention __inputId, so it captures from EVERY source in the worker group - not just "${inputId}". Add ${inputPredicate(inputId)} unless that is what you want.`;
  }
  // The `:?` admits the SUFFIX form inputPredicate emits (`":in_syslog"`) as
  // well as the bare one, so an operator who trims the clause down to just the
  // endsWith arm is not warned about a filter that is still correct.
  const quoted = new RegExp(`["'\`]:?${escapeRegExp(inputId)}["'\`]`);
  if (!quoted.test(filter)) {
    return `This filter references __inputId but not "${inputId}", so it may capture from a different source than the one selected.`;
  }
  return null;
}
