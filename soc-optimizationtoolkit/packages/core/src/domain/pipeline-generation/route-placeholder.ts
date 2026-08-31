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
 * WHY a log type will need a hand-written route filter - and the reason CSV
 * gets its own answer (HON-5).
 *
 *   evidence  the samples did not separate it from a sibling THIS TIME. More
 *             or better samples can fix it, and often do.
 *   format    it can NEVER be separated automatically. CSV data rows are
 *             positional: at route time the event is unparsed, the field name
 *             never appears in `_raw`, and both discriminators return null by
 *             construction - see route-discriminator and
 *             route-value-discriminator, which each early-return on "csv".
 *
 * Collapsing these into one warning is the failure this exists to avoid. Told
 * "no discriminator found", a CSV operator will go and collect more samples,
 * which cannot possibly help; told the truth, they write one filter and move
 * on. The generic placeholder message is right for every other format and
 * wrong for this one.
 */
export type PlaceholderCause = "evidence" | "format";

/**
 * Whether this format can EVER route automatically.
 *
 * Kept as a predicate over the format string rather than a list of formats
 * elsewhere, because the two discriminators already branch on exactly this and
 * a third opinion about which formats are positional is how they drift apart.
 */
export function formatCanDiscriminate(format: string): boolean {
  return format.toLowerCase() !== "csv";
}

/**
 * The warning for a CSV log type that WILL placeholder, or null when there is
 * nothing to say.
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
  return (
    "CSV log types cannot be routed automatically. At route time the event is " +
    "still unparsed and a CSV row carries no field names, so no filter can tell " +
    "this log type from the others in the pack - more samples will not change " +
    "that. Its route ships with a placeholder filter for you to complete."
  );
}
