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
 * A COLUMN-ORDER format (csv, positional) carries no field names in its events
 * at all - the names come from a column POSITION and are minted by an extract
 * step the route has not reached - so those formats yield no discriminator
 * (null). The caller then emits a PLACEHOLDER filter, not the match-all this
 * header claimed until 2026-09-03: a match-all is what made routes unreachable
 * in the first place, and plan.ts has emitted `placeholderRouteFilter` here
 * since. Match-all survives only for a SINGLE-log-type pack, which never
 * reaches the discriminator ladder (`if (tables.length > 1)`) and which
 * route-yml then orders last.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { fieldPresence } from "./route-value-discriminator";
import type { LogTypeFieldValues } from "./route-value-discriminator";
import { formatCanDiscriminate } from "./route-placeholder";

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
  // `not-in-evidence` PASSES here, and that is the one place this path differs
  // from the value discriminator. The names it judges come from the MAPPINGS,
  // not from the parsed records, so a field missing from the evidence may just
  // be one the parser normalised - and a caller that supplies no sample values
  // at all would otherwise lose routing entirely. `some-events` is the
  // rejection that matters: a per-event id lands there.
  return fieldPresence(ownValues, field) !== "some-events";
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
  // A COLUMN-ORDER format (csv, positional) is unroutable by construction: the
  // field name never appears in _raw, and route-time events are unparsed, so
  // BOTH terms this function emits are false for every event. Measured on a
  // two-log-type positional plan, the filter this returned before the predicate
  // was widened read `interface_id !== undefined || (typeof _raw === 'string'
  // && _raw.indexOf('interface_id=') !== -1) || ...` and matched nothing -
  // while the pack previewed CLEAN, because a filter had been produced and the
  // log type therefore counted as neither placeholdered nor unreachable.
  // Returning null hands it to the placeholder path, which is reported.
  //
  // ASKED, not restated (DBT-31). `formatCanDiscriminate` is the single
  // authority, because HON-5 tells the OPERATOR "more samples will not change
  // that" on the strength of it. Three copies of this rule could disagree, and
  // the copy that would end up lying is the one an operator reads.
  if (!formatCanDiscriminate(format)) {
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
