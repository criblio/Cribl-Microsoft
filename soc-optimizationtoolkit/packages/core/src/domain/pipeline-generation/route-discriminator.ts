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
 * Derive a route filter that matches THIS log type's events and not the
 * siblings', from the sample source-field sets. Returns null when the field
 * evidence cannot separate them (no unique fields, or a format whose raw
 * carries no field names and no identifier-safe field name exists).
 */
export function deriveRouteDiscriminator(
  ownSources: readonly string[],
  siblingSources: ReadonlyArray<ReadonlySet<string>>,
  format: string,
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
      !siblingSources.some((set) => set.has(field.toLowerCase())),
  );
  if (unique.length === 0) {
    return null;
  }

  // Longer names first: a longer raw token has fewer substring false
  // positives. Alphabetical tiebreak keeps the pick deterministic.
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
