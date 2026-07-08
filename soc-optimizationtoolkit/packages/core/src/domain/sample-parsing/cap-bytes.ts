/**
 * Tagged-sample BYTE cap. The event-COUNT cap (RAW_EVENTS_CAP) is not enough:
 * the cloud shell stores each tagged sample as one KV entry, and the leader's
 * request-body limit is a BYTE budget. A log type whose 200 kept events are
 * large (verbose threat/CEF/JSON records) serializes past that limit and the
 * PUT fails with HTTP 413 (PayloadTooLargeError) - observed live for a "THREAT"
 * sample. A stored TaggedSample also carries the per-event data up to THREE
 * times (top-level rawEvents, parsed.rawEvents, and parsed.records), so the
 * serialized size grows fast.
 *
 * capTaggedSampleBytes trims the per-event arrays (never the discovered-field
 * schema, which the mapping needs and is small) to the largest event count that
 * fits the budget, keeping at least one event so field discovery still works.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random. TextEncoder is
 * the same pure encoding utility the tar builder uses.
 */

import type { TaggedSample } from "./models";

/**
 * The default serialized-byte budget for one stored tagged sample. The cloud
 * leader's real KV body limit is smaller than a full sample for some verbose
 * log types (PAN-OS TRAFFIC 413'd even under 512 KiB), so this is a conservative
 * STARTING point: the cloud adapter halves it and retries on a 413, adapting to
 * the actual limit. 256 KiB keeps a first-attempt write small while still
 * retaining plenty of events for field discovery.
 */
export const TAGGED_SAMPLE_MAX_BYTES = 256 * 1024;

const ENCODER = new TextEncoder();

/** Serialized UTF-8 byte length of a value (what the KV body limit measures). */
function jsonByteLength(value: unknown): number {
  return ENCODER.encode(JSON.stringify(value)).length;
}

/** Result of a byte-cap pass: the (possibly trimmed) sample + what it dropped. */
export interface CappedTaggedSample {
  sample: TaggedSample;
  keptEvents: number;
  droppedEvents: number;
  /** True when the sample was trimmed to fit the budget. */
  trimmed: boolean;
}

/** Rebuild a TaggedSample keeping only the first `n` events across all arrays. */
function keepFirst(sample: TaggedSample, n: number): TaggedSample {
  const records = sample.parsed.records.slice(0, n);
  return {
    ...sample,
    rawEvents: sample.rawEvents.slice(0, n),
    parsed: {
      ...sample.parsed,
      records,
      rawEvents: sample.parsed.rawEvents.slice(0, n),
      eventCount: records.length,
    },
  };
}

/**
 * Trim a tagged sample so its serialized JSON fits `maxBytes`. Binary-searches
 * the largest event count that fits (O(log N) serializations); keeps the full
 * discovered-field schema and at least one event. When even one event exceeds
 * the budget it keeps that single event anyway - a pathological giant event is
 * surfaced by `trimmed`, not silently dropped to zero.
 */
export function capTaggedSampleBytes(
  sample: TaggedSample,
  maxBytes: number = TAGGED_SAMPLE_MAX_BYTES,
): CappedTaggedSample {
  const totalEvents = Math.max(
    sample.rawEvents.length,
    sample.parsed.records.length,
    sample.parsed.rawEvents.length,
  );
  if (totalEvents === 0 || jsonByteLength(sample) <= maxBytes) {
    return { sample, keptEvents: totalEvents, droppedEvents: 0, trimmed: false };
  }

  // Largest n in [1, totalEvents] whose serialized sample fits the budget.
  let lo = 1;
  let hi = totalEvents;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (jsonByteLength(keepFirst(sample, mid)) <= maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const capped = keepFirst(sample, best);
  return {
    sample: capped,
    keptEvents: best,
    droppedEvents: totalEvents - best,
    trimmed: true,
  };
}
