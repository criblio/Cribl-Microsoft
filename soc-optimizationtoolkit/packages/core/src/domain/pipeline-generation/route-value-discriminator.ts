/**
 * VALUE-BASED ROUTE DISCRIMINATORS - the second strategy for separating log
 * types, and the one that handles the case field presence cannot.
 *
 * deriveRouteDiscriminator (route-discriminator.ts) separates log types by
 * WHICH FIELDS EXIST. That works when the shapes differ, and fails completely
 * when they do not: a vendor that sends every log type through one schema and
 * distinguishes them with a field VALUE - Zscaler action ALLOWED / BLOCKED /
 * CAUTIONED, Palo Alto type TRAFFIC / THREAT, Fortinet subtype - yields no
 * unique fields at all, every log type falls back to match-all, and because
 * routes are final:true only the FIRST one ever receives events. Measured on
 * the Zscaler pack: 7 of 10 enabled routes dead, their events silently
 * processed by the firewall pipeline with the wrong renames.
 *
 * WHAT A DISCRIMINATOR COLUMN LOOKS LIKE, and why that definition is the whole
 * design: it is a field that is CONSTANT within a log type and DISJOINT across
 * them. Stating it that way does the hard work for free - per-event data
 * (source IP, bytes, URL, timestamp) varies within a log type, so it can never
 * satisfy "constant" and can never be picked, no matter how neatly a handful of
 * sample events happen to partition.
 *
 * THE FAILURE THIS MUST NOT INTRODUCE. Sample sets here are tiny (one Zscaler
 * log type had a single event). A filter over-fitted to them would match the
 * samples, pass every test, deploy clean, and then silently drop live events
 * that differ - trading a visible dead route for an invisible one, which is
 * strictly worse. Hence three guards, all of them about evidence rather than
 * cleverness:
 *
 *   1. PRESENT IN EVERY OWN EVENT. A field that is only sometimes there yields
 *      a filter that misses the events lacking it.
 *   2. EXACTLY ONE OWN VALUE. Constant, i.e. categorical. This is what excludes
 *      per-event data.
 *   3. CATEGORICAL ACROSS THE CORPUS. The field's total distinct values must
 *      stay near the number of log types. An id-like field can be constant
 *      within each tiny sample by accident; a real category cannot explode.
 *
 * When no field clears all three the answer is null, and the caller keeps the
 * match-all and reports it as unreachable. An honest dead route the operator
 * is told about beats a confident filter built on one event.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/** A bare name usable as a JS identifier in a Cribl filter expression. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The observed values of one log type's fields: field name -> the value of
 * that field in each event, in event order. Absent fields are simply missing
 * from the array, so length is how the "present in every event" guard is
 * checked against the event count.
 */
export interface LogTypeFieldValues {
  /** How many sample events this log type contributed. */
  eventCount: number;
  /** field name (as sent) -> values observed, one per event that carried it. */
  values: Readonly<Record<string, readonly string[]>>;
}

/**
 * How far a field's corpus-wide distinct-value count may exceed the number of
 * log types before it stops looking like a category.
 *
 * A true discriminator has roughly one value per log type. The slack absorbs
 * legitimate variance - a vendor spelling an action two ways, a log type that
 * carries two subtypes - without admitting fields whose values are per-event.
 */
const CATEGORICAL_SLACK = 2;

/** Escape a value for a single-quoted JS string literal. */
function jsString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The single value this log type always carries for `field`, else null. */
function constantValue(own: LogTypeFieldValues, field: string): string | null {
  const observed = own.values[field];
  if (observed === undefined || observed.length === 0) {
    return null;
  }
  // Guard 1: present in EVERY event, not merely in some.
  if (observed.length !== own.eventCount) {
    return null;
  }
  // Guard 2: exactly one distinct value - constant, therefore categorical.
  const distinct = new Set(observed);
  if (distinct.size !== 1) {
    return null;
  }
  const [value] = [...distinct];
  return value === "" ? null : value;
}

/**
 * Derive a route filter that matches THIS log type by a field value.
 *
 * Returns null when no field clears the three guards - the caller then keeps
 * the match-all filter and reports the log type as unreachable rather than
 * guessing.
 */
export function deriveValueDiscriminator(
  own: LogTypeFieldValues,
  siblings: readonly LogTypeFieldValues[],
  format: string,
): string | null {
  if (format === "csv") {
    // CSV data rows are positional: at route time the event is unparsed and
    // the field name never appears in _raw, so neither test below can run.
    return null;
  }
  const logTypeCount = siblings.length + 1;
  const budget = logTypeCount + CATEGORICAL_SLACK;

  const candidates: Array<{ field: string; value: string; spread: number }> = [];
  for (const field of Object.keys(own.values)) {
    const value = constantValue(own, field);
    if (value === null) {
      continue;
    }
    // Disjoint: no sibling ever carries this value for this field. Compared
    // case-insensitively because a filter that matches "ALLOWED" but not
    // "Allowed" would split one log type across two routes.
    const lowered = value.toLowerCase();
    const clashes = siblings.some((sib) =>
      (sib.values[field] ?? []).some((v) => v.toLowerCase() === lowered),
    );
    if (clashes) {
      continue;
    }
    // Guard 3: categorical across the corpus, not id-like.
    const corpus = [own, ...siblings];
    const spread = new Set(
      corpus.flatMap((lt) => (lt.values[field] ?? []).map((v) => v.toLowerCase())),
    ).size;
    if (spread > budget) {
      continue;
    }
    // Guard 3b: SOME log type must show the value repeating across events.
    // Without this, a corpus of one-event log types makes every field
    // trivially "constant" and a session id looks exactly like a category -
    // the filter would then route on an identifier that never recurs, which
    // matches the sample and drops all live traffic. Repetition is the only
    // evidence that a field's values are drawn from a small set; a corpus too
    // thin to show it is a corpus we decline to guess from.
    const repeats = corpus.some((lt) => {
      const seen = lt.values[field] ?? [];
      return seen.length >= 2 && new Set(seen.map((v) => v.toLowerCase())).size === 1;
    });
    if (!repeats) {
      continue;
    }
    candidates.push({ field, value, spread });
  }
  if (candidates.length === 0) {
    return null;
  }

  // Fewest distinct values wins: that is the most category-like field, and the
  // least likely to be a coincidence of small samples. Field name breaks ties
  // so the same corpus always produces the same filter.
  candidates.sort((a, b) => a.spread - b.spread || (a.field < b.field ? -1 : 1));
  const { field, value } = candidates[0];

  const terms: string[] = [];
  if (IDENTIFIER.test(field)) {
    terms.push(`${field} === ${jsString(value)}`);
  }
  // Raw fallback, for events that reach the route unparsed. Only for shapes
  // that carry `field=value` in the raw text; a JSON document would need the
  // bare value as a token, which matches anywhere in the event and would route
  // unrelated traffic here - a false positive is worse than no fallback, so
  // JSON relies on the parsed test alone.
  if (format !== "json" && format !== "ndjson") {
    terms.push(
      `(typeof _raw === 'string' && _raw.indexOf(${jsString(`${field}=${value}`)}) !== -1)`,
    );
  }
  return terms.length === 0 ? null : terms.join(" || ");
}
