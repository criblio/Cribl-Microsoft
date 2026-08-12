/**
 * CEF identity - overriding DeviceVendor and DeviceProduct.
 *
 * These two CEF header fields are what Sentinel content keys off. Analytic rules
 * filter on them by literal string (`DeviceVendor == "Palo Alto Networks"`,
 * `=~ "ZScaler"`), so a sample whose vendor string does not match what the rules
 * expect produces a deployment where the rules NEVER FIRE - with no error
 * anywhere, because nothing is broken. Everything ingests; nothing matches.
 *
 * THE SUGGESTION IS DERIVED, NOT TYPED. coverage-analysis already extracts the
 * literals a solution's rules compare against, so the app can say "your sample
 * says X, this solution's rules expect Y" rather than presenting a free-text box
 * and hoping. A typed value is still allowed - the operator may know something
 * the rules do not show - but it is the fallback, not the primary path.
 *
 * MATCHING IS CASE-INSENSITIVE, because the rules themselves are inconsistent:
 * the same corpus contains both `==` and `=~` against these fields. Reporting a
 * mismatch on casing alone would send operators chasing a difference that
 * `=~` does not care about, so casing differences are surfaced as a distinct
 * outcome rather than as a mismatch.
 *
 * Pure: no IO, no clock.
 */

import type { DiscriminatorValue } from "../coverage-analysis";

/** The two CEF header fields this module governs. */
export type CefIdentityField = "DeviceVendor" | "DeviceProduct";

/** Both fields, in CEF header order. */
export const CEF_IDENTITY_FIELDS: readonly CefIdentityField[] = [
  "DeviceVendor",
  "DeviceProduct",
];

/** An operator-supplied replacement. An absent/blank field means "leave it". */
export interface CefIdentityOverride {
  DeviceVendor?: string;
  DeviceProduct?: string;
}

/**
 * How a sample's value stands against what the selected content expects.
 *
 *   match         - the rules expect this value (case-insensitively).
 *   case-mismatch - the right value, different casing. `=~` rules do not care;
 *                   `==` rules do. Worth showing, but it is NOT the same
 *                   problem as the wrong vendor entirely.
 *   mismatch      - the rules expect something else, and it is named.
 *   unknown       - the rules never constrain this field, so there is nothing
 *                   to match against and no override is needed.
 *   absent        - the sample carries no value at all.
 */
export type CefIdentityStatus =
  | "match"
  | "case-mismatch"
  | "mismatch"
  | "unknown"
  | "absent";

/** What to show an operator for one field. */
export interface CefIdentityFinding {
  field: CefIdentityField;
  /** What the sample carries ("" when absent). */
  sampleValue: string;
  /** Distinct values the selected content's rules compare against, in order. */
  expected: string[];
  status: CefIdentityStatus;
  /**
   * The value to offer as the override, or null when there is nothing to
   * suggest. Only ever an expected value - this never invents one.
   */
  suggested: string | null;
}

/** Case-insensitive, whitespace-trimmed comparison key. */
function key(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The distinct literals the rules compare each identity field against, in first
 * -seen order.
 *
 * Order matters because the first is what gets suggested: rule corpora tend to
 * lead with the canonical vendor spelling, and a stable order keeps the
 * suggestion from changing between runs over the same content.
 */
export function expectedCefIdentity(
  discriminators: readonly DiscriminatorValue[],
): Record<CefIdentityField, string[]> {
  const out: Record<CefIdentityField, string[]> = {
    DeviceVendor: [],
    DeviceProduct: [],
  };
  for (const field of CEF_IDENTITY_FIELDS) {
    const seen = new Set<string>();
    for (const entry of discriminators) {
      if (key(entry.field) !== key(field)) {
        continue;
      }
      const value = entry.value.trim();
      if (value === "" || seen.has(key(value))) {
        continue;
      }
      seen.add(key(value));
      out[field].push(value);
    }
  }
  return out;
}

/** Classify one field's sample value against what the content expects. */
export function findCefIdentity(
  field: CefIdentityField,
  sampleValue: string,
  expected: readonly string[],
): CefIdentityFinding {
  const value = sampleValue.trim();
  const list = [...expected];
  const base = { field, sampleValue: value, expected: list };

  if (list.length === 0) {
    // The rules never constrain this field, so there is nothing to match and
    // nothing to fix. Suggesting a value here would invent a requirement.
    return { ...base, status: "unknown", suggested: null };
  }
  if (value === "") {
    return { ...base, status: "absent", suggested: list[0] ?? null };
  }
  const exact = list.find((candidate) => candidate === value);
  if (exact !== undefined) {
    return { ...base, status: "match", suggested: null };
  }
  const insensitive = list.find((candidate) => key(candidate) === key(value));
  if (insensitive !== undefined) {
    // Right vendor, wrong casing. `=~` rules match anyway; `==` rules do not.
    return { ...base, status: "case-mismatch", suggested: insensitive };
  }
  return { ...base, status: "mismatch", suggested: list[0] ?? null };
}

/** Classify both identity fields for a sample against a solution's rules. */
export function findCefIdentityAll(
  sample: Partial<Record<CefIdentityField, string>>,
  discriminators: readonly DiscriminatorValue[],
): CefIdentityFinding[] {
  const expected = expectedCefIdentity(discriminators);
  return CEF_IDENTITY_FIELDS.map((field) =>
    findCefIdentity(field, sample[field] ?? "", expected[field]),
  );
}

/**
 * The value an override supplies for one field, or null when it supplies none.
 *
 * THE ONE PLACE the "blank means leave it, never clear it" rule lives. It
 * matters because an empty DeviceVendor makes reconstructCefLine return null, so
 * a blank that reached the data would be a silent way to break the pack - and it
 * has to hold identically in the event path and in the emitted pipeline, or the
 * analysis and the deployed config would disagree about the same override.
 *
 * Architecture audit 2026-08-10: this guard had been written out three times,
 * once across a module boundary. Callers use this; none of them re-derive it.
 */
export function overrideValueFor(
  override: CefIdentityOverride,
  field: CefIdentityField,
): string | null {
  const value = override[field]?.trim() ?? "";
  return value === "" ? null : value;
}

/**
 * Apply an override to one event.
 *
 * Returns a NEW object; the input is never mutated. A blank or absent override
 * field leaves the event's value alone - "clear this field" is not a thing an
 * operator can express here, because an empty DeviceVendor makes CEF
 * reconstruction fail outright (see reconstructCefLine) and would be a silent
 * way to break the pack.
 */
export function applyCefIdentityOverride<T extends Record<string, unknown>>(
  event: T,
  override: CefIdentityOverride,
): T {
  const next = { ...event };
  for (const field of CEF_IDENTITY_FIELDS) {
    const value = overrideValueFor(override, field);
    if (value !== null) {
      (next as Record<string, unknown>)[field] = value;
    }
  }
  return next;
}

/** True when the override would actually change something on this event. */
export function overrideChangesEvent(
  event: Record<string, unknown>,
  override: CefIdentityOverride,
): boolean {
  return CEF_IDENTITY_FIELDS.some((field) => {
    const value = overrideValueFor(override, field);
    return value !== null && value !== event[field];
  });
}

/**
 * The DeviceVendor / DeviceProduct literals a KQL query compares against.
 *
 * THIS MODULE READS ITS OWN FIELDS. The first version borrowed
 * extractDiscriminatorValues from coverage-analysis, which was wrong in a way
 * that produced silence rather than an error: that function scans
 * DISCRIMINATOR_FIELDS - event_simpleName, DeviceEventClassID, Activity and
 * friends - because it answers "which LOG TYPES does this content reference".
 * DeviceVendor and DeviceProduct are not in that list and never should be, so
 * it returned nothing, every field resolved to `unknown`, and the advisory
 * correctly rendered nothing about a real mismatch. Found only by reading a
 * live rule (Zscaler's `where DeviceVendor =~ "ZScaler"`) after the screen
 * stayed blank.
 *
 * Matches the comparison forms a rule actually uses on these fields: `==`,
 * `=~`, and `in`/`in~` sets. Deliberately NOT `has`/`contains` - a substring
 * test does not name the value the field should hold, and offering one as a
 * replacement would be inventing an identity constant.
 */
export function extractCefIdentityValues(kql: string): DiscriminatorValue[] {
  // Comments can carry example queries; stripping them avoids expectations no
  // rule actually enforces.
  const cleaned = kql.replace(/\/\/.*$/gm, "");
  const out: DiscriminatorValue[] = [];
  const fields = CEF_IDENTITY_FIELDS.join("|");
  // Quote styles are matched separately rather than with a backreference: it
  // keeps every pattern here free of escapes that tooling mangles, and a rule
  // never mixes the two within one comparison anyway.
  const quoted = `(?:"([^"]*)"|'([^']*)')`;

  const scalar = new RegExp(
    String.raw`(?:^|[^A-Za-z])(${fields})\s*(?:==|=~)\s*${quoted}`,
    "gim",
  );
  for (const m of cleaned.matchAll(scalar)) {
    const value = m[2] ?? m[3];
    if (m[1] !== undefined && value !== undefined) {
      out.push({ field: m[1], value });
    }
  }

  const set = new RegExp(
    String.raw`(?:^|[^A-Za-z])(${fields})\s+in~?\s*\(([^)]*)\)`,
    "gim",
  );
  for (const m of cleaned.matchAll(set)) {
    const field = m[1];
    const body = m[2];
    if (field === undefined || body === undefined) continue;
    for (const lit of body.matchAll(new RegExp(quoted, "g"))) {
      const value = lit[1] ?? lit[2];
      if (value !== undefined) out.push({ field, value });
    }
  }
  return out;
}

/**
 * The identity findings for one sample against a solution's CONTENT.
 *
 * The step that was missing between the primitives above and any screen: the
 * expected values live in analytic-rule KQL, one query at a time, and nothing
 * turned a solution's rules into the literal set this module compares against.
 *
 * Takes the QUERIES, and extracts the literals itself. An earlier version
 * accepted an extractor so the caller could supply one - which is how it came
 * to be handed a function that reads different fields entirely, and how a test
 * that injected a plausible fake passed while the real screen showed nothing.
 */
export function cefIdentityFindings(
  sample: Partial<Record<CefIdentityField, string>>,
  queries: readonly string[],
): CefIdentityFinding[] {
  const discriminators: DiscriminatorValue[] = [];
  for (const query of queries) {
    discriminators.push(...extractCefIdentityValues(query));
  }
  return findCefIdentityAll(sample, discriminators);
}

/**
 * The findings worth showing an operator: a real disagreement with the content.
 *
 * `match` needs no action. `unknown` means the rules never constrain the field,
 * so there is nothing to disagree with - surfacing it would manufacture a
 * problem, which is the pin findCefIdentity already carries. What remains is
 * mismatch, case-mismatch and absent: the three that silently cost detections.
 */
export function actionableCefIdentity(
  findings: readonly CefIdentityFinding[],
): CefIdentityFinding[] {
  return findings.filter(
    (f) => f.status !== "match" && f.status !== "unknown" && f.suggested !== null,
  );
}

/** The slice of a gap-analysis mapping row this module reads. */
export interface CefIdentityMappingRow {
  /** Destination column the source field maps onto. */
  dest: string;
  /** The sample's example value for it, when the sample carried one. */
  sampleValue?: string;
}

/** The slice of an enrichment constant this module reads. */
export interface CefIdentityEnrichmentRow {
  field: string;
  value: string;
}

/**
 * What the rules will ACTUALLY see for each identity field on one log type.
 *
 * ENRICHMENT WINS, and that is the whole reason this is a function rather than
 * a field read. An enrichment constant is emitted as an Eval that overwrites
 * whatever the rename produced, so comparing the raw sample value against the
 * content would flag a mismatch the operator has already fixed - an advisory
 * that will not go away is how the real one gets ignored.
 *
 * Iterates CEF_IDENTITY_FIELDS rather than naming the pair. The screen used to
 * spell "DeviceVendor" and "DeviceProduct" out three times, which would have
 * silently skipped any field added to the header set later - the same
 * renders-nothing failure this feature already shipped once.
 */
export function effectiveCefIdentity(
  mappings: readonly CefIdentityMappingRow[],
  enrichments: readonly CefIdentityEnrichmentRow[],
): Partial<Record<CefIdentityField, string>> {
  const out: Partial<Record<CefIdentityField, string>> = {};
  for (const field of CEF_IDENTITY_FIELDS) {
    const mapped = mappings.find((m) => m.dest === field);
    if (mapped?.sampleValue !== undefined) {
      out[field] = mapped.sampleValue;
    }
    const enriched = enrichments.find((e) => e.field === field);
    if (enriched !== undefined) {
      out[field] = enriched.value;
    }
  }
  return out;
}
