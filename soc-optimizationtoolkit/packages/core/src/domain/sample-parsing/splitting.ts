/**
 * Log-type splitting, self-describing-field detection, PAN-OS load-time
 * conversion, and the STABLE split id.
 *
 * REHOMED 2026-08-18 (ADR 0003, sample-browser removal). This module used to
 * live in domain/sample-acquisition, whose only caller (precedence.ts) was on
 * the browse path - so deleting "the sample-acquisition domain" as a unit would
 * have taken the splitter with it. It is load-bearing for what REPLACES the
 * browser: a Cribl capture arrives as one mixed stream and has to be separated
 * by discriminator before it can be tagged per log type, and a mixed upload has
 * exactly the same problem. Its dependencies (the unified discriminator
 * selector, the PAN-OS dictionary) all live here, so here is where it belongs.
 *
 * DETERMINISM still matters, for a new reason. The old contract was that browse
 * and load had to produce byte-identical ids or the operator's selection broke.
 * There is no browse/load pair any more, but a split is still what names a log
 * type, and a log type is the tagged-sample store's KEY - so a nondeterministic
 * split (a different discriminator, a different value-cleanup, a reordered
 * group) silently re-keys the operator's samples. Group iteration stays
 * insertion-ordered and the discriminator stays the ONE unified selector rather
 * than a local fork.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { SampleFormat, SplitSample } from "./models";
import { selectDiscriminatorField } from "./discriminators";
import {
  PANOS_LOG_TYPES,
  isPanosFormat,
  convertPanosToJson,
} from "./panos-dictionary";

/**
 * Quick KV parser for discriminator detection (NOT full field parsing). Ported
 * verbatim from legacy `parseKvLine`: strips a syslog priority prefix, then
 * pulls `key=value` and `key="quoted value"` pairs.
 *
 * Sibling to `parseKv` in ./parsers since the rehome (ADR 0003), and kept
 * separate on purpose - see that function's note.
 *
 * THEY DISAGREE, as of DBT-79, and this is the place someone checking the
 * divergence looks - so it is written here rather than only on `parseKv`. That
 * function's key class was widened to the whole token before the `=`; this one
 * still truncates on `\w+`. Measured:
 *
 *   "src-ip=1.1.1.1 action=A"
 *     parseKv     -> ["src-ip", "action"]
 *     parseKvLine -> ["ip",     "action"]
 *
 * THE TRUNCATION IS LOAD-BEARING HERE, which is why it was not fixed at the same
 * time. This function exists to find a DISCRIMINATOR, and `DISCRIMINATOR_FIELDS`
 * holds word-only spellings (`type`, `subtype`, `action`, `category`,
 * `logType`, ...) that hyphenated vendor keys truncate straight INTO. Measured:
 *
 *   "log-type=TRAFFIC src-ip=1.1.1.1 action=A"
 *     parseKvLine -> ["type", "ip", "action"]
 *
 * `type` is the second entry in the list and in its high-confidence prefix, so
 * a single distinct value selects it - today's split works BY ACCIDENT. Give
 * this function the correct key `log-type`, which is in no list, and the field
 * stops matching, the split falls back, and every stored sample is re-keyed
 * (a log type is the tagged-sample store's KEY, see the DETERMINISM note above).
 *
 * So the ORDER of the eventual fix is fixed: teach `DISCRIMINATOR_FIELDS` the
 * hyphenated aliases FIRST, then widen the key here - never the reverse. That
 * sequencing is on the card requested with DBT-79, not a drive-by.
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
 * SELECTION delegated to the unified {@link selectDiscriminatorField}.
 * Behavior preserved:
 * - Events are parsed as JSON, then KV (>= 3 pairs) as a fallback.
 * - When nothing parses but the lines look like CSV, PAN-OS CSV grouping by the
 *   position-3 type field applies.
 * - DeviceEventClassID numeric ids map to PAN-OS names; values are sanitized;
 *   group logType names are UPPERCASED.
 * - Group iteration is insertion order (first-seen), so ids are deterministic.
 *
 * A single returned group named `fallbackLogType` means NO discriminator was
 * found. Callers must say so rather than presenting it as one real log type -
 * see {@link splitFoundNoDiscriminator}.
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
 * Whether a split found NO discriminator - i.e. every event fell into one group
 * still carrying the caller's `fallbackLogType`.
 *
 * Worth naming (ADR 0003 / plan Phase 4): the undifferentiated result is
 * indistinguishable from a genuine single-log-type stream by shape alone, and
 * silently presenting it as one real log type is the same failure
 * route-value-discriminator.ts already refuses one step later - it emits a
 * placeholder and TELLS the operator rather than a match-all that swallows
 * every route. This surfaces the same fact earlier, at acquisition time.
 */
export function splitFoundNoDiscriminator(
  splits: readonly SplitSample[],
  fallbackLogType: string,
): boolean {
  return splits.length === 1 && splits[0]?.logType === fallbackLogType;
}

/**
 * The STABLE id for a split: `${source}:${logType}`.
 *
 * Renamed from `browseSampleId` on 2026-08-18: identical behavior, but the
 * concept it was named for (a browse list whose ids had to survive a round trip
 * to a load call) no longer exists. It had no callers outside the deleted
 * modules, so the rename costs nothing and stops "browse" outliving the browser.
 */
export function splitSampleId(source: string, logType: string): string {
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
 * Convert a split's PAN-OS syslog+CSV events into named-field JSON, so field
 * mapping sees real column names rather than positional `_0,_1,_2`. When
 * {@link isPanosFormat} holds the events become JSON and the format becomes
 * "json"; otherwise they pass through unchanged.
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
