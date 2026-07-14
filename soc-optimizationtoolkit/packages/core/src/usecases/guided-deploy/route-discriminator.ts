/**
 * Route-discriminator auto-detection - porting-plan Unit 20 task item 2.
 *
 * When a solution ships MORE THAN ONE log type, the guided deploy needs a
 * per-log-type route filter so each pipeline only processes its own events.
 * The legacy handleDeploy (SentinelIntegration.tsx 1050-1145) picked that filter
 * with a THREE-STRATEGY cascade over a fixed candidate field list. This is that
 * cascade, extracted as a pure function and characterized strategy by strategy
 * (the plan calls it out as "characterize each").
 *
 *   Strategy 1 - unique event field: the first candidate field that is PRESENT
 *     (non-empty after String().trim()) in every sample's first event AND whose
 *     values are ALL DISTINCT across the samples. Filter: `field=='value'`.
 *   Strategy 2 - partial event field: the first candidate field that is PRESENT
 *     (defined and non-null; note the WEAKER presence test - an empty string
 *     counts here but not in Strategy 1) in every sample, even when values
 *     collide. Filter: `field=='value'`. This is a conscious behavioral
 *     difference from Strategy 1, pinned by test.
 *   Strategy 3 - log-type fallback: no shared field exists, so route on the
 *     sourcetype matching the log-type NAME. Field is the sentinel "__logType";
 *     Filter: `sourcetype && sourcetype.match(/value/i)`.
 *
 * A single sample needs no discriminator: its filter is the literal `true`
 * (the pack still routes that one log type through unconditionally).
 *
 * The candidate list is the ONE reconciled DISCRIMINATOR_FIELDS from
 * sample-parsing (the union of the three drifted legacy copies - Unit 11 already
 * unified them; this deploy cascade reuses that single list rather than
 * reintroducing a fourth copy). Order is load-bearing: earlier fields win.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random. The caller
 * supplies each sample's first raw event as a JSON string (the same source the
 * legacy parsed with JSON.parse(sample.rawEvents[0])).
 */

import { DISCRIMINATOR_FIELDS } from "../../domain/sample-parsing";

/** One log type's sample input: its name and its raw events (JSON strings). */
export interface DiscriminatorSample {
  /** Log-type name (drives Strategy 3's regex value and the result keys). */
  logType: string;
  /** Raw event strings; only the FIRST is inspected (legacy behavior). */
  rawEvents: readonly string[];
}

/** Which strategy produced the discriminator (machine-readable). */
export type DiscriminatorStrategy =
  | "single-sample"
  | "unique-field"
  | "partial-field"
  | "logtype-fallback";

/** The sentinel field name Strategy 3 uses when no shared event field exists. */
export const LOGTYPE_FALLBACK_FIELD = "__logType";

/** The resolved discriminator plus the per-log-type route filters. */
export interface RouteDiscriminator {
  strategy: DiscriminatorStrategy;
  /**
   * The event field the routes key on: a DISCRIMINATOR_FIELDS entry (Strategy
   * 1/2), {@link LOGTYPE_FALLBACK_FIELD} (Strategy 3), or "" (single sample).
   */
  field: string;
  /** logType -> the value used to build its filter (empty for single-sample). */
  logTypeValues: Record<string, string>;
  /** logType -> the Cribl route filter expression for that log type. */
  filters: Record<string, string>;
}

/** Parse the first raw event of a sample, or null when absent/invalid. */
function firstEvent(sample: DiscriminatorSample): Record<string, unknown> | null {
  if (sample.rawEvents.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(sample.rawEvents[0] as string) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strategy 1: the first field present-and-non-empty in every sample with all
 * DISTINCT values. Returns the field + logType->value map, or null.
 */
function tryUniqueField(
  events: Array<{ logType: string; event: Record<string, unknown> | null }>,
): { field: string; values: Map<string, string> } | null {
  for (const field of DISCRIMINATOR_FIELDS) {
    const values = new Map<string, string>();
    let ok = true;
    for (const { logType, event } of events) {
      if (event === null) {
        ok = false;
        break;
      }
      const raw = event[field];
      if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
        values.set(logType, String(raw));
      } else {
        ok = false;
        break;
      }
    }
    if (ok && values.size === events.length) {
      const distinct = new Set(values.values());
      if (distinct.size === events.length) {
        return { field, values };
      }
    }
  }
  return null;
}

/**
 * Strategy 2: the first field present (defined, non-null) in every sample,
 * values need NOT be distinct. Weaker presence test than Strategy 1 (empty
 * string counts as present). Returns the field + map, or null.
 */
function tryPartialField(
  events: Array<{ logType: string; event: Record<string, unknown> | null }>,
): { field: string; values: Map<string, string> } | null {
  for (const field of DISCRIMINATOR_FIELDS) {
    const values = new Map<string, string>();
    let ok = true;
    for (const { logType, event } of events) {
      if (event === null) {
        ok = false;
        break;
      }
      const raw = event[field];
      if (raw !== undefined && raw !== null) {
        values.set(logType, String(raw));
      } else {
        ok = false;
        break;
      }
    }
    if (ok && values.size === events.length && values.size > 0) {
      return { field, values };
    }
  }
  return null;
}

/**
 * The Cribl route filter for one log type given the resolved field and value.
 * Mirrors the legacy per-sample filter construction (1121-1130): the
 * log-type-fallback field routes on a sourcetype regex; any real field routes
 * on an equality test.
 */
export function discriminatorFilter(field: string, value: string): string {
  if (field === LOGTYPE_FALLBACK_FIELD) {
    return `sourcetype && sourcetype.match(/${value}/i)`;
  }
  return `${field}=='${value}'`;
}

/**
 * Detect the route discriminator for a set of samples via the three-strategy
 * cascade. Never throws: unparseable events simply disqualify a field, and the
 * fallback always yields a filter.
 *
 * @param samples One entry per log type, in the order routes should be keyed.
 */
export function detectRouteDiscriminator(
  samples: readonly DiscriminatorSample[],
): RouteDiscriminator {
  const logTypeValues: Record<string, string> = {};
  const filters: Record<string, string> = {};

  // 0 or 1 sample: no discriminator needed - each log type routes on `true`.
  if (samples.length <= 1) {
    for (const sample of samples) {
      filters[sample.logType] = "true";
    }
    return { strategy: "single-sample", field: "", logTypeValues, filters };
  }

  const events = samples.map((sample) => ({
    logType: sample.logType,
    event: firstEvent(sample),
  }));

  let strategy: DiscriminatorStrategy;
  let field: string;
  let values: Map<string, string>;

  const unique = tryUniqueField(events);
  const partial = unique === null ? tryPartialField(events) : null;
  if (unique !== null) {
    strategy = "unique-field";
    field = unique.field;
    values = unique.values;
  } else if (partial !== null) {
    strategy = "partial-field";
    field = partial.field;
    values = partial.values;
  } else {
    strategy = "logtype-fallback";
    field = LOGTYPE_FALLBACK_FIELD;
    values = new Map(samples.map((s) => [s.logType, s.logType.toLowerCase()]));
  }

  for (const sample of samples) {
    const value = values.get(sample.logType);
    if (value === undefined) {
      // Only reachable if a duplicate logType collapsed a map entry; route it
      // unconditionally rather than emit a broken filter.
      filters[sample.logType] = "true";
      continue;
    }
    logTypeValues[sample.logType] = value;
    filters[sample.logType] = discriminatorFilter(field, value);
  }

  return { strategy, field, logTypeValues, filters };
}
