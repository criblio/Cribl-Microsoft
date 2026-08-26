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
 * - The list is the UNION of all three, no member dropped. It was 16 at
 *   reconciliation; `msgid` (2026-08-21) and `data_source` (2026-08-25) were
 *   added later with their own justifications below, so it is 18 now.
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
  // NOT from any of the three legacy copies (added 2026-08-21). RFC 5424 gives
  // syslog a MSGID field whose stated purpose is to "identify the type of
  // message", so a compliant sender has already answered the question this list
  // asks - and Cribl's syslog source surfaces it without anyone parsing a
  // payload. Without this entry an RFC 5424 feed looks undiscriminated even
  // though the log type is sitting in a named field.
  //
  // LAST on purpose. Selection takes the first qualifying field in list order,
  // so a `type` recovered from the payload still wins: the envelope is what the
  // sender claims, the payload is what the device wrote.
  "msgid",
  // NOT from any of the three legacy copies (added 2026-08-25, from LIVE data).
  // Cribl's Windows Event source puts the Windows CHANNEL here - Security,
  // System, Application, Microsoft-Windows-DNS-Client/Operational - and the
  // channel IS the log type for Windows events. Same justification as `msgid`
  // directly above: the collector has already named the type in a field, so no
  // payload parsing is required to see it.
  //
  // Measured on a live Cribl Lake dataset 2026-08-25, which is why it is here
  // and why `datatype` and `schemaId` are NOT. Those appear on every Lake row
  // and looked like obvious additions, but each carried exactly ONE distinct
  // value in every dataset sampled - they describe the DATASET, not the event,
  // so they can never split one.
  //
  // `source` was measured the same way and is deliberately NOT ruled out: the
  // measurement holds for this lake, but the inference does not generalise -
  // on file and directory inputs Cribl sets `source` per event to the file
  // path. Re-measure before adding it; do not assume either way.
  // `data_source` did split, at scale:
  //   dataset="winevt_plwindows" | summarize count() by data_source
  //     Microsoft-Windows-DNS-Client/Operational   766,570
  //     Security                                    22,792
  // Without this entry that dataset reported NO log types at all, and the
  // operator was told to go capture from a live source instead - for data
  // already sitting in their lake, already split, already counted.
  //
  // In the LOW-CONFIDENCE tail on purpose: it needs >= 2 distinct values, so a
  // single-channel dataset still reports no discriminator rather than claiming
  // the whole dataset is one named type. That is the honest answer for it.
  //
  // AND IT IS NO LONGER A DEAD END (2026-08-25), which is what makes staying in
  // the tail affordable. "No discriminator" says only that nothing here splits
  // these events; queryLakeSamples answers it by offering the dataset as ONE
  // log type under THE DATASET'S OWN NAME, labelled as the dataset's. Promoting
  // `data_source` to the high-confidence prefix would instead name that log
  // type "Security" off a single observed value - a vendor log type asserted
  // from one row, which is precisely the claim this list must not make.
  "data_source",
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
