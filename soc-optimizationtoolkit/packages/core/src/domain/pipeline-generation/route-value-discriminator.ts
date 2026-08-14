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
 * Events a log type must contribute before its "constant" fields are believed.
 *
 * Three, because that is where a constant stops being an accident worth
 * betting a route on. At one event every field is constant; at two, any field
 * with a low-cardinality value space repeats by chance. Three is not a
 * guarantee - it is the point where the inference is worth making at all,
 * given the alternative (a placeholder the operator fills in) is safe.
 *
 * Deliberately NOT tuned to make the Zscaler corpus produce filters. That
 * corpus has 1-3 events per log type, so it produces none, and that is the
 * correct reading of evidence that thin.
 */
const MIN_EVENTS_FOR_VALUE_FILTER = 3;

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
 * Build the value evidence for one log type from its PARSED sample records.
 *
 * Records, not DiscoveredField.examples: `examples` keeps only a few DISTINCT
 * values and drops how often each occurred, which is precisely the evidence
 * the guards above run on. A field seen once and a field seen identically in
 * fifty events look the same through `examples`, so an id would pass the
 * repetition guard. GapFieldMapping.sampleValue is worse still - one value,
 * no counts at all.
 *
 * Only SCALAR values are kept. A nested object or array cannot be compared in
 * a route filter, and stringifying one would invent a value the event never
 * carried.
 */
export function fieldValuesFromRecords(
  records: ReadonlyArray<Record<string, unknown>>,
): LogTypeFieldValues {
  const values: Record<string, string[]> = {};
  for (const record of records) {
    for (const [field, raw] of Object.entries(record)) {
      if (raw === null || raw === undefined) continue;
      const t = typeof raw;
      if (t !== "string" && t !== "number" && t !== "boolean") continue;
      (values[field] ??= []).push(String(raw));
    }
  }
  return { eventCount: records.length, values };
}

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
  // EVIDENCE THRESHOLD (2026-08-14). No structural test can separate a real
  // discriminator from an incidental field on a handful of events, because on
  // a handful of events they look identical.
  //
  // Measured: the column test was added expecting it to reject
  // `client_tls_sig_pqc_offers === '1'` on the Zscaler corpus. It did not, and
  // it was right not to - across 43 events in 10 log types that field IS
  // single-valued per log type with distinct values. It satisfies every
  // structural property of a discriminator column. The problem was never the
  // rule; it was that 1-3 events per log type cannot tell the two apart.
  //
  // So the corpus has to earn the inference. A log type with fewer than
  // MIN_EVENTS_FOR_VALUE_FILTER events has not demonstrated that ANY of its
  // fields is constant - one event makes every field trivially "constant" -
  // and a sibling below the threshold has not demonstrated that it is
  // single-valued either, so the column shape cannot be verified against it.
  //
  // The cost is real and deliberate: thin curated corpora now yield no value
  // filters at all. That is the honest answer, and it is not a dead end - the
  // log type gets a placeholder saying a filter is needed, and more sample
  // events make the inference available. Guessing well on thin evidence is the
  // failure this module exists to prevent.
  if (own.eventCount < MIN_EVENTS_FOR_VALUE_FILTER) {
    return null;
  }
  const candidates: Array<{ field: string; value: string; spread: number }> = [];
  for (const field of Object.keys(own.values)) {
    const value = constantValue(own, field);
    if (value === null) {
      continue;
    }
    // Guard 3: it must behave like a COLUMN across the whole corpus - every log
    // type that carries the field is single-valued on it, and those values are
    // pairwise distinct.
    //
    // Tightened 2026-08-13 (user decision) from "no sibling sends this value".
    // The looser test let incidental fields through: on the real Zscaler
    // corpus it picked `client_tls_sig_pqc_offers === '1'` and
    // `cltsslsessreuse === 'No'` - TLS/session details that happened to
    // partition three sample events and would not survive live traffic. A
    // filter that is precise on the samples and wrong in production is the
    // failure mode this module exists to avoid, and it is invisible.
    //
    // Requiring the column shape rejects them: a real discriminator (an action,
    // a type, a subtype) takes one value per log type BY CONSTRUCTION, while an
    // incidental field varies inside at least one sibling or repeats a value
    // across two. A log type that does not carry the field at all is no
    // obstacle - it simply will not match, which is correct.
    //
    // Rejecting is now cheap: the log type gets a placeholder filter and is
    // reported as needing one, rather than a dead route. That is what made this
    // tightening worth doing.
    const lowered = value.toLowerCase();
    let isColumn = true;
    for (const sib of siblings) {
      const seen = sib.values[field] ?? [];
      if (seen.length === 0) {
        continue; // Sibling does not carry it; nothing to clash with.
      }
      // A sibling too thin to have demonstrated single-valued-ness cannot
      // confirm the column shape, so the field is not usable - its events
      // might carry our value in the traffic we never sampled.
      if (sib.eventCount < MIN_EVENTS_FOR_VALUE_FILTER) {
        isColumn = false;
        break;
      }
      const distinct = new Set(seen.map((v) => v.toLowerCase()));
      // Single-valued, and a DIFFERENT value from ours. Case-insensitive
      // because "ALLOWED" and "Allowed" are one log type to a vendor.
      if (distinct.size !== 1 || distinct.has(lowered)) {
        isColumn = false;
        break;
      }
    }
    if (!isColumn) {
      continue;
    }
    // The corpus-cardinality budget that used to live here is GONE (2026-08-13).
    // The column test above makes it unreachable: every log type contributes at
    // most one distinct value, so the spread can never exceed the number of log
    // types, and the budget allowed more than that. Keeping a guard no input
    // can trip reads as protection that is not there.
    const corpus = [own, ...siblings];
    const spread = new Set(
      corpus.flatMap((lt) => (lt.values[field] ?? []).map((v) => v.toLowerCase())),
    ).size;
    // The repetition guard that used to sit here is GONE (2026-08-14). It
    // required some log type to show the value repeating across events - which
    // the evidence threshold now guarantees outright, since `own` must clear
    // MIN_EVENTS_FOR_VALUE_FILTER and be single-valued over all of them. That
    // IS repetition, so the check could never fail. Second dead guard removed
    // from this function; both were found by mutating them and watching every
    // test still pass, not by reading the code.
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
