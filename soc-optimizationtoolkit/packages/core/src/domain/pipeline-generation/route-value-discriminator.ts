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
  /**
   * The log type this evidence belongs to, as tagged on the samples.
   *
   * Carried here because it is an INPUT to the decision, not a label
   * (2026-08-17 user decision): a field only counts as this log type's
   * discriminator when its value names the log type. See {@link namesLogType}.
   */
  logType: string;
  /** How many sample events this log type contributed. */
  eventCount: number;
  /** field name (as sent) -> values observed, one per event that carried it. */
  values: Readonly<Record<string, readonly string[]>>;
}

/**
 * Whether a field VALUE names the log type it was found in.
 *
 * The governing rule, from the user 2026-08-17: "each vendor log type can be
 * defined with the contents of the log itself". If that is true, the field
 * that defines a log type carries a value that NAMES it - `action` is
 * "Cautioned" in CAUTIONED, `event_type` is "dns" in dns. A field whose value
 * says nothing about the log type is not the defining field, however cleanly
 * it happens to partition three sample events.
 *
 * This replaced a purely statistical choice that ranked candidates by how few
 * distinct values they had. Measured live on the Zscaler pack, that heuristic
 * offered `client_tls_sig_pqc_offers === '1'` for ALLOWED and
 * `client_tls_keyex_hybrid_offers === '0'` for web-BLOCKED - TLS capability
 * flags, structurally perfect and semantically meaningless - while correctly
 * finding `action === 'Cautioned'` for CAUTIONED. Three of four offers were
 * wrong, and one click from being applied. Fewest-distinct-values actively
 * FAVOURS binary incidental flags: a two-valued flag scores better than the
 * real column, which takes a distinct value in every log type.
 *
 * CONTAINMENT EITHER WAY, case-insensitive, because log types are tagged from
 * the sample and the vendor's value is only part of that name: "Blocked"
 * defines both web-BLOCKED and firewall-BLOCKED, and "dns" defines both dns
 * and dns-http-endpoint. Exact match would placeholder all four.
 *
 * Deliberately NOT fuzzy. Token overlap or edit distance would re-admit the
 * plausible-but-wrong filters this exists to reject, and the fallback for a
 * near-miss is a placeholder the operator finishes - not a wrong route that
 * silently mis-maps their data.
 */
export function namesLogType(value: string, logType: string): boolean {
  const v = value.trim().toLowerCase();
  const t = logType.trim().toLowerCase();
  if (v === "" || t === "") {
    return false;
  }
  return v.includes(t) || t.includes(v);
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
  logType: string,
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
  return { logType, eventCount: records.length, values };
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
 * Returns null when nothing qualifies - the caller then emits a placeholder
 * filter for the operator to complete, which is the designed fallback and not
 * a failure.
 *
 * There used to be a second entry point, valueDiscriminatorFor, returning a
 * richer result: the filter when the corpus was thick enough, otherwise the
 * candidate it WOULD have chosen, as a suggestion for the operator to accept.
 * Both are gone with the evidence threshold (2026-08-17). A candidate either
 * names its log type - in which case it is applied, however few events back it
 * - or it does not, in which case there is nothing worth showing. The middle
 * answer existed only because corpus size was the deciding evidence.
 */
export function deriveValueDiscriminator(

  own: LogTypeFieldValues,
  siblings: readonly LogTypeFieldValues[],
  format: string,
): string | null {
  const none = null;
  if (format === "csv") {
    // CSV data rows are positional: at route time the event is unparsed and
    // the field name never appears in _raw, so neither test below can run.
    // Nothing to suggest either - the filter could not be written at all.
    return none;
  }
  // THE EVIDENCE THRESHOLD IS GONE (2026-08-17, user decision), and with it the
  // suggestion tier it produced.
  //
  // It existed for a good reason: no STRUCTURAL test can separate a real
  // discriminator from an incidental field on three events, because on three
  // events they look identical. That was measured, not assumed - the column
  // test was added expecting it to reject `client_tls_sig_pqc_offers === '1'`
  // on the Zscaler corpus, and it did not, because across 43 events that field
  // genuinely IS single-valued per log type with distinct values.
  //
  // The name-match guard answers the same question from a different direction,
  // and answers it better. Corpus size was only ever a proxy for "is this the
  // field that defines the log type"; the value naming the log type IS that
  // fact. One event of action="Cautioned" in CAUTIONED settles it, and no
  // number of events of client_tls_sig_pqc_offers="1" ever would.
  //
  // So thin corpora no longer yield nothing: the Zscaler set now gets applied
  // filters wherever the vendor labels its own logs, and placeholders
  // everywhere else. Both outcomes are honest, and neither is a guess.
  const candidates: Array<{
    field: string;
    value: string;
    spread: number;
  }> = [];
  for (const field of Object.keys(own.values)) {
    const value = constantValue(own, field);
    if (value === null) {
      continue;
    }
    // Guard 0, and the one that decides most cases: the value must NAME this
    // log type. Applied before the column test because it is the cheaper and
    // stronger signal - a field that does not name the log type is not its
    // defining field no matter how it partitions the corpus, and the samples
    // simply may not carry the field that does. Everything rejected here gets
    // a placeholder for the operator to finish, which is the designed fallback
    // rather than a loss.
    if (!namesLogType(value, own.logType)) {
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
    // required some log type to show the value repeating across events, which
    // the then-current evidence threshold guaranteed outright, so the check
    // could never fail. Second dead guard removed from this function; both
    // were found by mutating them and watching every test still pass, not by
    // reading the code. (The threshold itself is gone too, as of 2026-08-17.)
    candidates.push({ field, value, spread });
  }
  if (candidates.length === 0) {
    return none;
  }

  // Every survivor now names the log type, so the old "fewest distinct values
  // wins" ranking is gone - it is what chose the TLS flags, because a binary
  // flag has fewer distinct values than a real column by construction. Among
  // fields that all name the log type there is no quality ordering left worth
  // making, so this sorts on the widest evidence and then the field name,
  // purely so one corpus always yields one filter.
  candidates.sort(
    (a, b) => b.spread - a.spread || (a.field < b.field ? -1 : 1),
  );
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
  if (terms.length === 0) {
    return none;
  }
  // APPLIED, not offered (2026-08-17 user decision). The event-count threshold
  // no longer gates this, and the suggestion tier is gone with it.
  //
  // The threshold existed because no structural test could tell a real
  // discriminator from an incidental field on three events - true, and the
  // reason it was right to withhold. The name-match rule answers that question
  // from the value itself rather than from corpus size: one event showing
  // action="Cautioned" for log type CAUTIONED is not a small-sample
  // coincidence, it is the vendor labelling its own log. Conversely a thousand
  // events of client_tls_sig_pqc_offers="1" would still not make that field
  // the definition of ALLOWED.
  //
  // So the outcome is binary now - the value names the log type and the filter
  // applies, or it does not and the log type gets a placeholder. The middle
  // tier ("structurally valid, too thin to trust") was an artefact of judging
  // on evidence volume and has nothing left to hold.
  return terms.join(" || ");
}
