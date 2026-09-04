/**
 * PLACEHOLDER ROUTE FILTERS - what a log type gets when nothing in the samples
 * can tell it apart from its siblings.
 *
 * There are three things a generator can do with an undiscriminable log type,
 * and two of them are bad:
 *
 *   MATCH-ALL (`true`) - what this used to emit. Every route is final, so the
 *   first match-all swallows every unmatched event and runs them through ITS
 *   pipeline: the wrong renames, and for CEF web logs no base64 decode. The
 *   data reaches Sentinel mis-shaped, nothing errors, and the only symptom is
 *   detections that quietly match nothing. Measured on Zscaler: 7 of 10 routes.
 *
 *   DROP THE LOG TYPE - honest, but it throws away a route and pipeline the
 *   operator may need. Zscaler firewall and DNS are exactly the log types a SOC
 *   cares most about; silently having no path for them is not better.
 *
 *   PLACEHOLDER - emit the full route and pipeline, with a filter that CANNOT
 *   match until a human edits it. The pack carries everything needed, nothing
 *   is mis-shaped, nothing is dropped by surprise, and the remaining work is
 *   visible in the app before the build and in route.yml after it.
 *
 * WHY IT MUST EVALUATE FALSE. `__UNSET__` is not a field any vendor sends, so
 * the comparison is `undefined === '<logType>'` - false, always. An inert route
 * cannot hijack a sibling's events, which is the failure mode being fixed; a
 * placeholder that accidentally matched would be worse than the match-all it
 * replaces. It is also a plain identifier-and-string expression: no comment
 * syntax, no regex, nothing for the Cribl loader or the YAML escaper to trip on.
 *
 * The log type is embedded so the operator reading route.yml knows what the
 * filter is supposed to select, not merely that it is unfinished.
 *
 * Generic, not per-vendor: any vendor whose log types share a schema and differ
 * by a value the samples do not cover lands here - Zscaler, Palo Alto,
 * Fortinet. See route-value-discriminator for the strategies tried first.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/** The sentinel field name. Never sent by a vendor, so comparisons are false. */
const UNSET_FIELD = "__UNSET__";

/** Escape a value for a single-quoted JS string literal. */
function jsString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The filter for a log type nothing could discriminate.
 *
 * Never matches, names the log type, and is recognisable by
 * {@link isPlaceholderFilter} so callers can report what still needs a human.
 */
export function placeholderRouteFilter(logType: string): string {
  return `${UNSET_FIELD} === ${jsString(logType)}`;
}

/**
 * Whether a route condition is one of ours awaiting an edit.
 *
 * Matched on the sentinel field alone: an operator who has replaced the filter
 * has removed `__UNSET__`, and the log type stops being reported. That is the
 * intended way for the warning to clear - by the work being done, not by a
 * separate flag someone has to remember to unset.
 */
export function isPlaceholderFilter(routeCondition: string): boolean {
  return routeCondition.includes(UNSET_FIELD);
}

/**
 * WHY a log type will need a hand-written route filter - and the reason a
 * COLUMN-ORDER format gets its own answer (HON-5).
 *
 *   evidence  the samples did not separate it from a sibling THIS TIME. More
 *             or better samples can fix it, and often do.
 *   format    it can NEVER be separated automatically. A column-order event
 *             carries values in position and no names: at route time the event
 *             is unparsed, the field name never appears in `_raw`, and both
 *             discriminators return null - see route-discriminator and
 *             route-value-discriminator, which each ask
 *             {@link formatCanDiscriminate} rather than restating the rule.
 *
 * Collapsing these into one warning is the failure this exists to avoid. Told
 * "no discriminator found", such an operator will go and collect more samples,
 * which cannot possibly help; told the truth, they write one filter and move
 * on. The generic placeholder message is right for every other format and
 * wrong for these.
 */
export type PlaceholderCause = "evidence" | "format";

/**
 * The formats whose events carry values in COLUMN ORDER and no field names.
 *
 * "csv" was only ever one half of this set, and the other half shipped without
 * it (GEN-6 taught the parser and the pipeline about whitespace-positional logs
 * and left the router believing they were routable).
 */
const POSITIONAL_FORMATS: ReadonlySet<string> = new Set(["csv", "positional"]);

/**
 * Whether this format can EVER route automatically.
 *
 * FALSE for the column-order formats. A route is evaluated BEFORE the pipeline
 * extracts, so the only things a filter can test are the raw text and whatever
 * the source already parsed - and neither carries a column-order format's field
 * names, because those names come from a column POSITION and are minted by the
 * extract step the route has not reached yet.
 *
 * MEASURED 2026-09-03 by parsing one event per format and asking which of the
 * field names the parser produced occur anywhere in the raw line:
 *
 *   positional, AWS VPC Flow v2      14 names, 14 absent (version, account_id,
 *                                    interface_id, srcaddr, dstaddr, ...)
 *   positional, unrecognised shape    6 names,  6 absent (field1..field6)
 *   csv, headerless PAN-OS            6 names,  6 absent (receive_time, serial,
 *                                    type, subtype, generated_time, src)
 *   json / ndjson / kv                0 absent - the name is IN the event text
 *
 * So on a two-log-type positional plan `deriveRouteDiscriminator` emitted
 * `interface_id !== undefined || (typeof _raw === 'string' &&
 * _raw.indexOf('interface_id=') !== -1) || ...` - every disjunct false for
 * every event, a route that DEAD-ENDS. That was worse than the CSV case sitting
 * next to it, because a filter WAS produced: the log type was therefore neither
 * a placeholder nor reported unreachable, and the pack previewed clean.
 *
 * Kept as a predicate over the format string rather than a list of formats
 * elsewhere, because both discriminators call THIS and a third opinion about
 * which formats are positional is how they drift apart.
 *
 * NOT THE ONLY FORMATS WHOSE NAMES ARE MINTED, and they are deliberately not
 * folded in here. The same measurement says:
 *
 *   syslog   EVERY name absent from the raw line - Timestamp, Hostname,
 *            Program, PID, Message, and for RFC 5424 also Priority, Version,
 *            AppName, ProcID, MsgID. A whole-format instance of this defect.
 *   cef      the 7 HEADER names are absent (CEFVersion, DeviceVendor,
 *   leef     DeviceProduct, DeviceVersion, DeviceEventClassID, Name, Severity;
 *            LEEF the same five plus EventID) while the extension pairs really
 *            are in the text. A per-FIELD instance, not a per-format one - and
 *            the length-first sort in route-discriminator PREFERS the long
 *            header names over a short real one.
 *   unknown  depends on the CONTENT, which a format string cannot see. The
 *            try-each fallback in parseByFormat settled on parseCsv for a
 *            PAN-OS line (12 names, 12 absent) and on parseSyslog for an RFC
 *            3164 line (6 names, 6 absent), and on parseJson/parseKv for
 *            content whose names ARE in the text. It cannot be answered here.
 *
 * None of these is folded into the set above. Their cause is different (a
 * regex capture or a fallback parser, not a column position), so each needs its
 * own operator wording rather than this one's; and a defect found in committed
 * code becomes a card before it is fixed rather than a drive-by widening of
 * somebody else's finding. Filed, not fixed - and this note is the loud part.
 */
export function formatCanDiscriminate(format: string): boolean {
  return !POSITIONAL_FORMATS.has(format.toLowerCase());
}

/**
 * The warning for a column-order log type that WILL placeholder, or null when
 * there is nothing to say.
 *
 * THE NAME IS NARROWER THAN THE FUNCTION as of 2026-09-03: it also answers for
 * "positional". Renaming it would edit the pipeline-generation barrel and the
 * samples screen, which are outside this change's scope, so the name is left
 * and the rename is a card. The behaviour is defined by
 * {@link formatCanDiscriminate}, not by this identifier.
 *
 * `siblingCount` is load-bearing and the reason this is not a one-line format
 * check. A single-log-type pack keeps its match-all and routes correctly -
 * plan.ts only runs the discriminator ladder `if (tables.length > 1)` - so
 * warning there would be crying wolf about a pack that works, which is the
 * failure mode this repo has already hit twice with over-eager reports.
 *
 * @param format       the log type's source format
 * @param siblingCount how many OTHER log types share the pack
 */
export function csvRoutingWarning(
  format: string,
  siblingCount: number,
): string | null {
  if (formatCanDiscriminate(format)) return null;
  if (siblingCount < 1) return null;
  // ONE MESSAGE FOR BOTH, and every clause has to be true of both. A CSV data
  // row and a whitespace-positional line differ only in their separator: each
  // carries values in column order, and the field names shown in the app were
  // worked out from those positions rather than read out of the event. Naming
  // CSV alone - which this did until positional joined the set - would have
  // sent a VPC Flow operator looking for a CSV bug they do not have.
  return (
    "Column-order log types (CSV rows, whitespace-positional lines) cannot be " +
    "routed automatically. Routes are evaluated before the pipeline extracts, " +
    "and at that point the event is still unparsed: it carries values in column " +
    "order, and the field names shown here were worked out from those positions " +
    "rather than read out of the event. So no filter can tell this log type " +
    "from the others in the pack - more samples will not change that. Its route " +
    "ships with a placeholder filter for you to complete."
  );
}
