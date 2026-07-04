/**
 * ONE unified discriminator list - reconciles the THREE drifted legacy copies
 * (porting-plan Unit 11: "ONE unified DISCRIMINATOR_FIELDS list (legacy had
 * three drifted copies - reconcile, cite each source, pin the union)").
 *
 * The three sources being unified (each cited on its members below):
 *   A = IS/sample-parser.ts, `samples:auto-detect-types` `discriminators`
 *       [event_simpleName, type, Type, subtype, eventType, EventType, log_type,
 *        logType, category, sourcetype, action, Activity, DeviceEventClassID,
 *        dataset]
 *   B = IS/sample-resolver.ts, `DISCRIMINATOR_FIELDS`
 *       [event_simpleName, type, subtype, DeviceEventClassID, Activity,
 *        eventType, EventType, log_type, logType, category, dataset, sourcetype,
 *        action]  (its first 6 were the high-confidence, single-value-OK prefix)
 *   C = IS-R/pages/SentinelIntegration.tsx, deploy `discriminatorFields`
 *       [sourcetype, type, subtype, log_type, logType, category, event_type,
 *        eventType, dataset, action, DeviceEventClassID, Activity, module]
 *
 * Reconciliation decisions (pinned by discriminators.test.ts):
 * - The list is the UNION of all three (16 fields), no member dropped.
 * - Order = B's authoritative ordering, because B alone encoded a semantic in
 *   its order (index < 6 => a single distinct value still selects the field).
 *   B's high-confidence six lead; the remaining union members follow.
 * - Single-value acceptance uses B's index < HIGH_CONFIDENCE rule (principled:
 *   only strong type fields self-select on one value), superseding A's looser
 *   "fields.length > 5" gate and C's "must be unique per sample" gate.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { ParsedSample } from "./models";

/** The one reconciled discriminator list (union of the three legacy copies). */
export const DISCRIMINATOR_FIELDS: readonly string[] = Object.freeze([
  // High-confidence prefix (B's first six): a single distinct value selects it.
  "event_simpleName", // A,B - CrowdStrike FDR
  "type", // A,B,C - PAN-OS / generic primary
  "subtype", // A,B,C - PAN-OS secondary
  "DeviceEventClassID", // A,B,C - CEF standard
  "Activity", // A,B,C - CEF / Sentinel
  "eventType", // A,B,C - Okta / generic
  // Lower-confidence tail (needs >= 2 distinct values to select).
  "EventType", // A,B - Azure
  "event_type", // C only - snake_case variant
  "Type", // A only - capitalized variant
  "log_type", // A,B,C - Fortinet
  "logType", // A,B,C - generic camelCase
  "category", // A,B,C - Cloudflare / generic
  "dataset", // A,B,C - Cloudflare Logpush
  "sourcetype", // A,B,C - Splunk-style
  "action", // A,B,C - firewall
  "module", // C only - Okta / generic module
]);

/**
 * Fields at index < this in {@link DISCRIMINATOR_FIELDS} are strong enough that
 * a SINGLE distinct value across all records still selects them. (Legacy B's
 * `DISCRIMINATOR_FIELDS.indexOf(field) < 6` rule.)
 */
export const HIGH_CONFIDENCE_DISCRIMINATOR_COUNT = 6;

/**
 * Pick the best discriminator field for splitting `records` into log types, or
 * undefined when none qualifies. A field qualifies when it has >= 2 distinct
 * non-empty values, or exactly one distinct value while sitting in the
 * high-confidence prefix. The first qualifying field in list order wins.
 */
export function selectDiscriminatorField(
  records: ReadonlyArray<Record<string, unknown>>,
): string | undefined {
  for (let i = 0; i < DISCRIMINATOR_FIELDS.length; i += 1) {
    const field = DISCRIMINATOR_FIELDS[i];
    const values = new Set<string>();
    for (const record of records) {
      const value = record[field];
      if (value !== undefined && value !== null && value !== "") {
        values.add(String(value));
      }
    }
    if (values.size >= 2 || (values.size === 1 && i < HIGH_CONFIDENCE_DISCRIMINATOR_COUNT)) {
      return field;
    }
  }
  return undefined;
}

/** One detected log-type group from {@link autoDetectLogTypes}. */
export interface AutoDetectedLogType {
  /** Sanitized log-type name (non-alphanumerics collapsed to "_"). */
  name: string;
  /** How many records fell into this group. */
  eventCount: number;
  /** The discriminator field this group came from ("" when defaulted). */
  discriminator: string;
  /** The raw discriminator value for this group ("" when defaulted). */
  value: string;
}

/** The result of {@link autoDetectLogTypes}. */
export interface AutoDetectResult {
  /** The chosen discriminator field, or undefined when none was found. */
  discriminatorField?: string;
  /** The detected log-type groups (a single "default" group when none found). */
  logTypes: AutoDetectedLogType[];
}

/**
 * Split a parsed sample into log-type groups using the unified discriminator
 * list. When no discriminator qualifies, all records collapse into one
 * "default" group. This is the pure form of the legacy `samples:auto-detect-
 * types` handler.
 *
 * FIX vs legacy A: the legacy handler iterated a field's CAPPED example values
 * (at most 3), so it silently found at most three log types. This works over
 * the full records, so every distinct value becomes a group.
 */
export function autoDetectLogTypes(sample: ParsedSample): AutoDetectResult {
  const records = sample.records;
  const field = selectDiscriminatorField(records);

  if (field === undefined) {
    return {
      logTypes: [
        {
          name: "default",
          eventCount: records.length,
          discriminator: "",
          value: "",
        },
      ],
    };
  }

  const groups = new Map<string, number>();
  for (const record of records) {
    const value = record[field];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const key = String(value);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  const logTypes: AutoDetectedLogType[] = [];
  for (const [value, eventCount] of groups.entries()) {
    logTypes.push({
      name: value.replace(/[^a-zA-Z0-9_]/g, "_"),
      eventCount,
      discriminator: field,
      value,
    });
  }

  return { discriminatorField: field, logTypes };
}
