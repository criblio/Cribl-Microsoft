/**
 * Cribl capture FILTER composition (sample-acquisition plan Phase 4, ADR 0003).
 *
 * A capture request carries no source field - `CaptureParamsReq` is
 * `{filter, level, maxEvents, duration, ...}` and nothing names an input
 * (verified against the vendored spec 2026-08-19). The source is selected
 * INSIDE the filter, via the `__inputId` event field, which the spec's own
 * example demonstrates (`__inputId.startsWith("http:") && status >= 400`).
 *
 * So the filter this builds conjoins two things the operator chose separately:
 *
 *     __inputId === "in_syslog" && (<log-type predicate> || <log-type predicate>)
 *
 * THREE CORRECTNESS RULES, each learned rather than assumed:
 *
 * 1. CASE-INSENSITIVE, VIA REGEX - never toLowerCase(). PAN-OS emits
 *    `GLOBALPROTECT`, not `GlobalProtect`, so a case-sensitive test silently
 *    returns zero events, which reads as "this source does not carry that log
 *    type" - the worst possible failure for a capture filter, because it looks
 *    like an answer. `_raw.toLowerCase().includes(...)` would also allocate a
 *    lowercased copy of every event that passes.
 *
 * 2. ANCHOR ON DELIMITERS, NOT BARE SUBSTRINGS. route-value-discriminator.ts
 *    already documents why: a bare value "matches anywhere in the event and
 *    would route unrelated traffic here - a false positive is worse than no
 *    fallback". `/traffic/i` matches a URL, a hostname, a user-agent.
 *
 * 3. ...BUT THE DELIMITER CANNOT BE ASSUMED TO BE A COMMA. The plan specifies
 *    `/,TRAFFIC,/i`, reasoning from PAN-OS being comma-delimited CSV. The
 *    operator picks a SOURCE, though, not a format - and a comma anchor against
 *    a pipe-delimited CEF vendor matches nothing, which is failure mode 1 again
 *    wearing a different hat. So the anchor is the SET of delimiters the
 *    formats this app parses actually use: comma (CSV/PAN-OS), pipe (CEF/LEEF),
 *    quote and colon (JSON), equals (KV), tab (LEEF extension), whitespace, and
 *    the line ends. A URL path like `/api/traffic/list` still does not match,
 *    because `/` is deliberately NOT a delimiter here.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

// The gap-analysis KQL parser already owns this. Importing rather than writing
// a second copy - the 2026-08-19 audit found five inline envelope readers and
// the same rule in two places is exactly what it flags.
import { escapeRegExp } from "../gap-analysis/kql-parser";

/**
 * The characters that may bound a log-type token in the formats this app
 * parses. `/` is excluded ON PURPOSE - it is what makes a URL path containing
 * the word not match.
 */
const DELIMITERS = ",|\\t\"':= \\r\\n";

/**
 * The delimiter-anchored, case-insensitive test for one log-type value.
 *
 * Exported so the UI can show the operator exactly one predicate when
 * explaining the filter, rather than making them read the whole conjunction.
 */
export function logTypePredicate(value: string): string {
  const escaped = escapeRegExp(value.trim());
  return `/(^|[${DELIMITERS}])${escaped}([${DELIMITERS}]|$)/i.test(_raw)`;
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
 * Compose the capture filter. With no log types this is the source clause
 * alone; with several they are OR-ed inside parentheses so the conjunction
 * binds the way it reads.
 */
export function buildCaptureFilter(input: CaptureFilterInput): string {
  const source = inputPredicate(input.inputId);
  const values = (input.logTypes ?? [])
    .map((v) => v.trim())
    .filter((v) => v !== "");
  if (values.length === 0) {
    return source;
  }
  const predicates = values.map(logTypePredicate);
  const body =
    predicates.length === 1 ? predicates[0] : `(${predicates.join(" || ")})`;
  return `${source} && ${body}`;
}

/**
 * A problem with a filter the operator has edited, or null when it looks sound.
 *
 * ONE CHECK, and it is the one that fails silently. The plan lets the operator
 * edit any suggested filter, and the edit that costs them is deleting the
 * `__inputId` clause - the capture then runs against EVERY source in the worker
 * group, quietly returning a mixture the operator believes came from one place.
 * A wrong filter that errors is fine; this one succeeds and lies.
 *
 * Deliberately NOT a validator. Cribl evaluates the expression as JavaScript
 * and this app has no business deciding what is valid JS - a filter that fails
 * to compile comes back as an HTTP error with Cribl's own message, which is
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
  if (!filter.includes(JSON.stringify(inputId)) && !filter.includes(inputId)) {
    return `This filter references __inputId but not "${inputId}", so it may capture from a different source than the one selected.`;
  }
  return null;
}
