/**
 * Log-type splitting, self-describing-field detection, PAN-OS load-time
 * conversion, and the STABLE browse/load id - porting-plan Unit 16 (ENG-19).
 *
 * THE TOP FOOTGUN (plan Unit 16): browse and load must produce byte-identical
 * selection ids. Both call {@link splitSamplesByLogType} over the SAME raw
 * events, and both build the id with {@link browseSampleId}
 * (`${source}:${logType}`). Any nondeterminism in the split - a different
 * discriminator, a different value-cleanup, a reordered group - changes a
 * logType and silently breaks the user's selection. This module is the single
 * source for both, and it reuses the Unit 11 unified discriminator selector
 * ({@link selectDiscriminatorField}) rather than forking a fourth copy.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { SampleFormat } from "../sample-parsing/models";
import {
  selectDiscriminatorField,
  PANOS_LOG_TYPES,
  isPanosFormat,
  convertPanosToJson,
} from "../sample-parsing/index";
import type { SplitSample } from "./models";

/**
 * Quick KV parser for discriminator detection (NOT full field parsing). Ported
 * verbatim from legacy `parseKvLine`: strips a syslog priority prefix, then
 * pulls `key=value` and `key="quoted value"` pairs.
 */
export function parseKvLine(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const cleaned = line.replace(/^<\d+>/, "");
  const re = /(\w+)=(?:"([^"]*)"|(\S*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    fields[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return fields;
}

/** Sanitize a discriminator value into a log-type name (legacy cleanup). */
function cleanLogTypeValue(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_\- ]/g, "")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "") || "default"
  );
}

/**
 * Split raw events into per-log-type groups by the best discriminator field.
 * Ported verbatim from legacy `splitSamplesByLogType`, with the discriminator
 * SELECTION delegated to the Unit 11 unified {@link selectDiscriminatorField}
 * (the legacy inline copy is retired). Behavior preserved:
 * - Events are parsed as JSON, then KV (>= 3 pairs) as a fallback.
 * - When nothing parses but the lines look like CSV, PAN-OS CSV grouping by the
 *   position-3 type field applies.
 * - DeviceEventClassID numeric ids map to PAN-OS names; values are sanitized;
 *   group logType names are UPPERCASED.
 * - Group iteration is insertion order (first-seen), so ids are deterministic.
 */
export function splitSamplesByLogType(
  rawEvents: readonly string[],
  fallbackLogType: string,
  format: SampleFormat,
): SplitSample[] {
  const eventObjects: Array<Record<string, unknown>> = [];
  for (const raw of rawEvents) {
    try {
      eventObjects.push(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      if (/\w+=/.test(raw)) {
        const kvFields = parseKvLine(raw);
        if (Object.keys(kvFields).length >= 3) {
          eventObjects.push(kvFields);
        }
      }
    }
  }

  // CSV fallback (PAN-OS headerless CSV): nothing parsed, lines look like CSV.
  if (eventObjects.length === 0 && rawEvents.length > 0) {
    const firstLine = rawEvents[0];
    if (firstLine.includes(",") && !firstLine.startsWith("{")) {
      const groups = new Map<string, string[]>();
      for (const line of rawEvents) {
        const fields = line.split(",");
        let logType = (fields[3] || "").trim().toUpperCase();
        if (!logType || logType.length > 30) logType = fallbackLogType;
        if (!groups.has(logType)) groups.set(logType, []);
        groups.get(logType)!.push(line);
      }
      if (groups.size > 1 || (groups.size === 1 && !groups.has(fallbackLogType))) {
        return [...groups.entries()].map(([logType, events]) => ({
          logType,
          rawEvents: events,
          format,
          eventCount: events.length,
        }));
      }
    }
    return [
      { logType: fallbackLogType, rawEvents: [...rawEvents], format, eventCount: rawEvents.length },
    ];
  }

  if (eventObjects.length === 0) {
    return [
      { logType: fallbackLogType, rawEvents: [...rawEvents], format, eventCount: rawEvents.length },
    ];
  }

  const discriminator = selectDiscriminatorField(eventObjects);
  if (!discriminator) {
    return [
      { logType: fallbackLogType, rawEvents: [...rawEvents], format, eventCount: rawEvents.length },
    ];
  }

  const groups = new Map<string, string[]>();
  for (let i = 0; i < eventObjects.length; i++) {
    let val = String(eventObjects[i][discriminator] ?? "unknown");
    if (discriminator === "DeviceEventClassID" && PANOS_LOG_TYPES[val]) {
      val = PANOS_LOG_TYPES[val];
    }
    val = cleanLogTypeValue(val);
    if (!groups.has(val)) groups.set(val, []);
    groups.get(val)!.push(rawEvents[i] ?? JSON.stringify(eventObjects[i]));
  }

  return [...groups.entries()].map(([logType, events]) => ({
    logType: logType.toUpperCase(),
    rawEvents: events,
    format,
    eventCount: events.length,
  }));
}

/**
 * The STABLE selection id for a split sample: `${source}:${logType}`. Browse and
 * load MUST both build ids with this function so selection round-trips.
 */
export function browseSampleId(source: string, logType: string): string {
  return `${source}:${logType}`;
}

/**
 * True when raw events carry self-describing field NAMES (so field mapping sees
 * real names, not `_0,_1,_2`). Ported verbatim from legacy `hasNamedFields`:
 * CEF/LEEF/KV always qualify; JSON/NDJSON qualify unless > half the keys are
 * numeric indices; CSV qualifies when the first line is mostly identifiers;
 * syslog qualifies for PAN-OS CSV, embedded `key=value`, or embedded CEF.
 */
export function hasNamedFields(
  rawEvents: readonly string[],
  format: SampleFormat,
): boolean {
  if (format === "cef" || format === "leef") return true;
  if (format === "kv") return true;

  if (format === "json" || format === "ndjson") {
    const first = rawEvents.find((e) => e.trim());
    if (!first) return false;
    try {
      const obj = JSON.parse(first);
      if (typeof obj !== "object" || obj === null) return false;
      const keys = Object.keys(obj as Record<string, unknown>);
      const numericKeys = keys.filter((k) => /^_?\d+$/.test(k));
      return numericKeys.length < keys.length * 0.5;
    } catch {
      return false;
    }
  }

  if (format === "csv") {
    const first = rawEvents.find((e) => e.trim());
    if (!first) return false;
    const fields = first.split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));
    const alphaFields = fields.filter((f) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f));
    return alphaFields.length >= fields.length * 0.5;
  }

  if (format === "syslog" || format === "unknown") {
    const first = rawEvents.find((e) => e.trim()) || "";
    if (isPanosFormat(rawEvents)) return true;
    if (/\w+=\S/.test(first)) return true;
    if (first.includes("CEF:")) return true;
    return false;
  }

  return false;
}

/**
 * Convert a split's PAN-OS syslog+CSV events into named-field JSON at LOAD time
 * (never at browse time - browse keeps the raw preview). Ported from the legacy
 * `loadSelectedSamples` branch: when {@link isPanosFormat} holds, the events
 * become JSON and the format becomes "json"; otherwise they pass through. Reuses
 * the Unit 11/12 PAN-OS dictionary via {@link convertPanosToJson}.
 */
export function convertPanosSplitAtLoad(
  rawEvents: readonly string[],
  format: SampleFormat,
): { rawEvents: string[]; format: SampleFormat } {
  if (isPanosFormat(rawEvents)) {
    const converted = convertPanosToJson(rawEvents);
    return { rawEvents: converted.events, format: "json" };
  }
  return { rawEvents: [...rawEvents], format };
}
