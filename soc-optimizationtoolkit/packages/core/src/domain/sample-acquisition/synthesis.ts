/**
 * Tier 3 synthesis (ENG-41) - porting-plan Unit 16. Generate synthetic vendor
 * events for a solution that has no real samples, so the pipeline/gap flow still
 * has data to analyze.
 *
 * Ported from legacy sample-resolver.ts `synthesizeSamples` / `serializeEvent`,
 * with two deliberate redesigns:
 *
 * 1. DETERMINISTIC values. The legacy generator used Math.random / Node crypto,
 *    making every synthesis non-reproducible. Here values come from the Unit 19
 *    seeded generator (pack-assembly `generateFieldValue`, a mulberry32 PRNG
 *    keyed by name:type:seed) - the SAME inputs always yield the SAME events. No
 *    Web Crypto, no Math.random, no Date anywhere (the plan's "Web Crypto instead
 *    of Node crypto" line is superseded by the stricter zero-entropy rule the
 *    task pins: reuse Unit 19, do not fork randomness).
 *
 * 2. SCHEMA-DRIVEN + degraded. The rich per-vendor field knowledge lives in
 *    Unit 15 (vendor-research), which is DEFERRED. Until it lands, the field set
 *    is driven by the destination table's SCHEMA COLUMNS plus any fields
 *    referenced in the solution's analytic-rule KQL, reverse-mapped to vendor
 *    names via {@link REVERSE_ALIAS} (Unit 13). The documented seam for U15 is
 *    {@link SynthesizeInput.vendorFields}: when a caller can supply richer vendor
 *    field knowledge, it is unioned in ahead of the schema/KQL fields.
 *
 * KQL-LITERAL REUSE is the correctness contract: synthetic events must satisfy
 * the analytic-rule where-clauses. When a field is compared to a literal in KQL
 * (`where F == "x"`, `where F in ("a","b")`, `where F has_any (...)`), that
 * literal is placed into the event (round-robin across events), so a rule that
 * gates on it still fires against the synthetic data.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { SampleFormat } from "../sample-parsing/models";
import { REVERSE_ALIAS } from "../field-matcher/index";
import { generateFieldValue, isoFromEpochMs } from "../pack-assembly/sample-values";

// ---------------------------------------------------------------------------
// KQL field + literal extraction
// ---------------------------------------------------------------------------

/** Fields referenced in analytic-rule KQL plus the literals they are gated on. */
export interface KqlExtraction {
  /** Distinct field names referenced across the queries. */
  fields: Set<string>;
  /** field -> literal values from where-clause comparisons (in first-seen order). */
  literals: Map<string, string[]>;
}

/**
 * Extract, from a set of analytic-rule KQL queries, the fields compared to
 * literals and those literal values. Verbatim regexes from legacy
 * `synthesizeSamples`: `where F == "v"`, `where F in ("a","b")`, and
 * `where F has_any ("a","b")`. Also collects each matched field into `fields`.
 * Optional `extraFields` (e.g. a rule's pre-extracted field list) are added to
 * `fields` without literals.
 */
export function extractKqlFieldsAndLiterals(
  queries: readonly string[],
  extraFields: readonly string[] = [],
): KqlExtraction {
  const fields = new Set<string>();
  const literals = new Map<string, string[]>();

  const addLiteral = (field: string, value: string): void => {
    fields.add(field);
    const vals = literals.get(field) ?? [];
    vals.push(value);
    literals.set(field, vals);
  };

  for (const f of extraFields) fields.add(f);

  for (const query of queries) {
    for (const m of query.matchAll(/where\s+(\w+)\s*==\s*"([^"]+)"/gi)) {
      addLiteral(m[1], m[2]);
    }
    for (const m of query.matchAll(/where\s+(\w+)\s+in\s*\(([^)]+)\)/gi)) {
      for (const v of m[2].matchAll(/"([^"]+)"/g)) addLiteral(m[1], v[1]);
    }
    for (const m of query.matchAll(/where\s+(\w+)\s+has_any\s*\(([^)]+)\)/gi)) {
      for (const v of m[2].matchAll(/"([^"]+)"/g)) addLiteral(m[1], v[1]);
    }
  }

  return { fields, literals };
}

// ---------------------------------------------------------------------------
// Serialization (deterministic, per format)
// ---------------------------------------------------------------------------

/** Fixed synthetic-timestamp base for the syslog header (Unit 19 base epoch). */
const SYSLOG_BASE_EPOCH_MS = 1749997800000;

/**
 * Serialize one synthetic event to a raw vendor line for the given format.
 * Ported verbatim from legacy `serializeEvent`, with the syslog header's
 * `new Date().toISOString()` replaced by a DETERMINISTIC per-event timestamp
 * (Unit 19 `isoFromEpochMs`), keeping the format shape identical.
 */
export function serializeEvent(
  fields: Record<string, string>,
  format: SampleFormat | string,
  eventIndex = 0,
): string {
  switch (format) {
    case "json":
      return JSON.stringify(fields);
    case "cef": {
      const ext = Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      return `CEF:0|Synthetic|Product|1.0|100|Synthetic Event|5|${ext}`;
    }
    case "kv":
      return Object.entries(fields)
        .map(([k, v]) => `${k}=${v.includes(" ") ? `"${v}"` : v}`)
        .join(" ");
    case "syslog": {
      const msg = Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      const ts = isoFromEpochMs(SYSLOG_BASE_EPOCH_MS + eventIndex * 30000);
      return `<134>1 ${ts} synthetic.host app - - - ${msg}`;
    }
    case "csv":
      return Object.values(fields).join(",");
    default:
      return JSON.stringify(fields);
  }
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/** A destination-schema column driving synthesis. */
export interface SynthesisField {
  /** Sentinel column name (also the KQL/reverse-alias lookup key). */
  name: string;
  /** Log Analytics type (datetime/int/real/boolean/dynamic/string/...). */
  type: string;
}

/** Inputs for {@link synthesizeEvents}. */
export interface SynthesizeInput {
  /**
   * Destination-schema columns to synthesize (the SCHEMA-DRIVEN field set). Each
   * is reverse-mapped to a vendor field name for the raw event.
   */
  fields: readonly SynthesisField[];
  /** Output vendor format. */
  format: SampleFormat | string;
  /** KQL literals per field (from {@link extractKqlFieldsAndLiterals}). */
  literals?: ReadonlyMap<string, readonly string[]>;
  /** How many events to generate (default {@link DEFAULT_SYNTH_COUNT}). */
  count?: number;
  /**
   * Reverse alias map (lowercased Sentinel field -> vendor names). Defaults to
   * the Unit 13 {@link REVERSE_ALIAS}. Injectable for tests.
   */
  reverseAlias?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * DEFERRED U15 SEAM: richer per-vendor fields to union in ahead of `fields`.
   * Empty until vendor-research (Unit 15) lands.
   */
  vendorFields?: readonly SynthesisField[];
}

/** Default synthetic event count (legacy NUM_EVENTS). */
export const DEFAULT_SYNTH_COUNT = 5;

/** Map a Sentinel field name to its first vendor alias, or itself when none. */
function toVendorFieldName(
  sentinelField: string,
  reverseAlias: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  const vendorNames = reverseAlias.get(sentinelField.toLowerCase());
  if (vendorNames) {
    for (const name of vendorNames) return name; // first, insertion order
  }
  return sentinelField;
}

/**
 * Synthesize `count` raw vendor event lines. For each event index i and each
 * field: reverse-map the Sentinel column to a vendor field name, then set its
 * value to the KQL literal (round-robin `literals[i % len]`) when one exists,
 * otherwise a DETERMINISTIC {@link generateFieldValue} keyed by the column name,
 * type, and i. The vendor fields (U15 seam) precede the schema/KQL fields.
 * Returns the serialized lines.
 */
export function synthesizeEvents(input: SynthesizeInput): string[] {
  const reverseAlias = input.reverseAlias ?? REVERSE_ALIAS;
  const count = input.count ?? DEFAULT_SYNTH_COUNT;
  const allFields = [...(input.vendorFields ?? []), ...input.fields];

  const events: string[] = [];
  for (let i = 0; i < count; i++) {
    const eventFields: Record<string, string> = {};
    for (const field of allFields) {
      const vendorName = toVendorFieldName(field.name, reverseAlias);
      const literalValues = input.literals?.get(field.name);
      let value: string;
      if (literalValues && literalValues.length > 0) {
        value = literalValues[i % literalValues.length];
      } else {
        value = String(generateFieldValue(field.name, field.type, i));
      }
      eventFields[vendorName] = value;
    }
    events.push(serializeEvent(eventFields, input.format, i));
  }
  return events;
}
