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

  const tests = [
    `new RegExp(${rawPattern}, "i").test(_raw)`,
    ...STRUCTURED_FIELDS.map(
      (field) =>
        `(typeof ${field} !== "undefined" && new RegExp(${fieldPattern}, "i").test(String(${field})))`,
    ),
  ];
  return tests.join(" || ");
}

/** The source-selection clause. */
export function inputPredicate(inputId: string): string {
  return `__inputId === ${JSON.stringify(inputId)}`;
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
  const quoted = new RegExp(`["'\`]${escapeRegExp(inputId)}["'\`]`);
  if (!quoted.test(filter)) {
    return `This filter references __inputId but not "${inputId}", so it may capture from a different source than the one selected.`;
  }
  return null;
}
