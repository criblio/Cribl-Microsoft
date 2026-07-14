/**
 * DROP SAVINGS estimator (user request 2026-07-12): when the reviewer drops
 * fields, show what it is worth - the byte size of the original events vs
 * the size after removing the dropped fields, as a percentage.
 *
 * Measured against the ACTUAL sample events, not schema guesses:
 *  - JSON events: a dropped field's cost is its serialized key + value +
 *    quoting/colon/comma overhead, computed per event via JSON.stringify.
 *  - Non-JSON events (CEF/syslog/KV): a dropped field's cost is its
 *    `key=value` token (up to the next delimiter) plus its separator.
 *  - A dropped field absent from an event costs that event nothing.
 *
 * This is an ESTIMATE of the payload reduction the generated pipeline's
 * drops produce - transport framing and the serializer's exact output can
 * differ by a few bytes per event; callers should label it "estimated".
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** One log type's estimated savings. */
export interface DropSavings {
  /** Events measured (unparseable lines still count toward size). */
  events: number;
  /** Total bytes of the original raw events. */
  originalBytes: number;
  /** Estimated bytes removed by dropping the fields. */
  droppedBytes: number;
}

/** An empty savings value. */
export const NO_DROP_SAVINGS: DropSavings = {
  events: 0,
  originalBytes: 0,
  droppedBytes: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Serialized JSON cost of one key/value pair incl. colon + comma. */
function jsonPairBytes(key: string, value: unknown): number {
  const valueJson = JSON.stringify(value);
  if (valueJson === undefined) return 0;
  return JSON.stringify(key).length + 1 + valueJson.length + 1;
}

/**
 * Estimate the byte savings of dropping `droppedFields` from `rawEvents`.
 * Field names match case-insensitively (the matcher's convention).
 */
export function estimateDropSavings(
  rawEvents: readonly string[],
  droppedFields: readonly string[],
): DropSavings {
  if (rawEvents.length === 0) return NO_DROP_SAVINGS;
  const dropped = new Set(droppedFields.map((f) => f.toLowerCase()));
  let originalBytes = 0;
  let droppedBytes = 0;

  for (const raw of rawEvents) {
    originalBytes += raw.length;
    if (dropped.size === 0) continue;

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (isRecord(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (dropped.has(key.toLowerCase())) {
          droppedBytes += jsonPairBytes(key, value);
        }
      }
      continue;
    }

    // Non-JSON: charge each dropped field its key=value token + separator.
    for (const field of dropped) {
      const pattern = new RegExp(
        `(?:^|[|;,\\s])${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^|;,\\s]*)`,
        "i",
      );
      const match = raw.match(pattern);
      if (match !== null) {
        droppedBytes += field.length + 1 + match[1].length + 1;
      }
    }
  }

  return { events: rawEvents.length, originalBytes, droppedBytes };
}

/** Merge per-table savings into one aggregate. */
export function mergeDropSavings(
  parts: readonly DropSavings[],
): DropSavings {
  let events = 0;
  let originalBytes = 0;
  let droppedBytes = 0;
  for (const part of parts) {
    events += part.events;
    originalBytes += part.originalBytes;
    droppedBytes += part.droppedBytes;
  }
  return { events, originalBytes, droppedBytes };
}

/** Whole-percent reduction (0 when nothing measured or nothing dropped). */
export function dropSavingsPercent(savings: DropSavings): number {
  if (savings.originalBytes === 0 || savings.droppedBytes === 0) return 0;
  return Math.round((savings.droppedBytes / savings.originalBytes) * 100);
}

/**
 * The human line: "estimated 34% smaller (avg event 1,240 B -> 815 B across
 * 50 sampled events)". Empty when nothing is dropped or measured.
 */
export function dropSavingsLine(savings: DropSavings): string {
  if (
    savings.events === 0 ||
    savings.originalBytes === 0 ||
    savings.droppedBytes === 0
  ) {
    return "";
  }
  const avgBefore = Math.round(savings.originalBytes / savings.events);
  const avgAfter = Math.round(
    (savings.originalBytes - savings.droppedBytes) / savings.events,
  );
  const percent = dropSavingsPercent(savings);
  return (
    `estimated ${percent}% smaller (avg event ` +
    `${avgBefore.toLocaleString("en-US")} B -> ` +
    `${avgAfter.toLocaleString("en-US")} B across ` +
    `${savings.events.toLocaleString("en-US")} sampled event(s))`
  );
}
