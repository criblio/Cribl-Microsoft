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
    const value = override[field]?.trim() ?? "";
    if (value !== "") {
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
    const value = override[field]?.trim() ?? "";
    return value !== "" && value !== event[field];
  });
}
