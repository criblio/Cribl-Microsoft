/**
 * ROUTE DISCRIMINATORS - per-log-type route filters for multi-log-type packs
 * (live flaw 2026-07-13: a Zscaler pack emitted BOTH routes with
 * filter: "true" and final: true, so the first route swallowed every event
 * and the firewall route was unreachable - Cribl flagged it with the
 * unreachable-route warning).
 *
 * When a plan carries several log types and no explicit routing condition
 * (event_simpleName lists etc.), the only evidence that separates the types
 * is their SAMPLE FIELD SETS. The discriminator picks source fields UNIQUE
 * to one log type among the plan's log types and emits a Cribl filter
 * expression that tests, per field:
 *   - parsed-field presence (`field !== undefined`) for sources/breakers
 *     that already parsed the event - only when the name is a valid bare
 *     JS identifier;
 *   - a raw-content token (`_raw.indexOf(...) !== -1`) shaped by the
 *     sample format: `"field"` (quoted key) for JSON, `field=` for
 *     key-value shapes (CEF/KV/LEEF).
 * CSV data rows carry no field names, so CSV yields no discriminator
 * (null) - the caller keeps the match-all filter and orders it last.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { LogTypeFieldValues } from "./route-value-discriminator";

/** A bare name usable as a JS identifier in a Cribl filter expression. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Escape a value for a single-quoted JS string literal. */
function jsString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The raw-content token that betrays a field's presence, by sample format. */
function rawToken(field: string, format: string): string {
  if (format === "json") {
    return `"${field}"`;
  }
  // Key-value shapes (cef, kv, leef, conf-style) carry `field=`.
  return `${field}=`;
}

/** How many unique fields one filter tests (redundancy tolerates variance). */
const DISCRIMINATOR_FIELD_CAP = 2;


/**
 * Whether a field is CHARACTERISTIC of its log type, rather than something one
 * event happened to carry.
 *
 * Uniqueness alone is not evidence. A field that exists in exactly one of a log
 * type's events is unique to that log type in the strongest possible sense and
 * tells you nothing - and per-event identifiers are unique by definition, so
 * they are the fields most likely to pass a uniqueness test.
 *
 * Measured live on PaloAlto-PAN-OS 2026-08-17. The Cortex XDR alert sample
 * carries per-event ids as COLUMN NAMES - base64 blobs like
 * `MTE5MDE2NDc3NjI4OTI4MjgwMw` (a numeric alert id) - one per event across 106
 * events and 326 fields. Each was unique to the log type, each was longer than
 * any real field name, and the length-first sort below preferred them. The
 * emitted route tested `MTE5MDE2NDc3NjI4OTI4MjgwMw !== undefined`, which
 * matches exactly the one sampled event and nothing in live traffic: the route
 * builds, validates, installs, and silently receives nothing.
 *
 * This is the same over-fitting the VALUE discriminator was hardened against
 * (its "constant within the log type" guard rejects per-event data outright).
 * The presence path had no equivalent, because it only ever saw field NAMES.
 * It now takes the same sample evidence and requires the field in EVERY event.
 *
 * Without evidence the check passes: a caller that supplies no sample values
 * gets the old behaviour rather than losing routing altogether. That is the
 * weaker path and it is the one to remove if this class of defect recurs.
 */
function isCharacteristic(
  field: string,
  ownValues: LogTypeFieldValues | undefined,
): boolean {
  if (ownValues === undefined || ownValues.eventCount === 0) {
    return true;
  }
  const seen = ownValues.values[field];
  if (seen === undefined) {
    // Not in the parsed evidence at all (a mapping-only field, or a name the
    // parser normalised). Nothing to judge it on, so it is not disqualified.
    return true;
  }
  return seen.length === ownValues.eventCount;
}

/**
 * Derive a route filter that matches THIS log type's events and not the
 * siblings', from the sample source-field sets. Returns null when the field
 * evidence cannot separate them (no unique fields, or a format whose raw
 * carries no field names and no identifier-safe field name exists).
 */
export function deriveRouteDiscriminator(
  ownSources: readonly string[],
  siblingSources: ReadonlyArray<ReadonlySet<string>>,
  format: string,
  ownValues?: LogTypeFieldValues,
): string | null {
  if (format === "csv") {
    // CSV data rows are positional: the field name never appears in _raw,
    // and route-time events are unparsed - a presence-only filter would
    // dead-end every event. No discriminator; the caller keeps "true".
    return null;
  }
  const unique = [...new Set(ownSources)].filter(
    (field) =>
      field !== "" &&
      !siblingSources.some((set) => set.has(field.toLowerCase())) &&
      isCharacteristic(field, ownValues),
  );
  if (unique.length === 0) {
    return null;
  }

  // Longer names first: a longer raw token has fewer substring false
  // positives. Alphabetical tiebreak keeps the pick deterministic.
  //
  // Safe only because isCharacteristic has already run. On its own this sort
  // is actively harmful - it is what picked a base64 event id over
  // `session_end_reason` on the live Palo Alto pack, an id being 26 characters
  // to the real field's 18.
  unique.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

  const terms: string[] = [];
  for (const field of unique.slice(0, DISCRIMINATOR_FIELD_CAP)) {
    if (IDENTIFIER.test(field)) {
      terms.push(`${field} !== undefined`);
    }
    terms.push(
      `(typeof _raw === 'string' && _raw.indexOf(${jsString(rawToken(field, format))}) !== -1)`,
    );
  }
  return terms.join(" || ");
}
