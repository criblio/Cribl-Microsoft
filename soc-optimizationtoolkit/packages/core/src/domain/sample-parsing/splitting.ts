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
import { positionalHasNamedFields } from "./positional";
import {
  PANOS_LOG_TYPES,
  isPanosFormat,
  convertPanosToJson,
} from "./panos-dictionary";

/**
 * Quick KV parser for discriminator detection (NOT full field parsing). Ported
 * from legacy `parseKvLine`: strips a syslog priority prefix, then pulls
 * `key=value` and `key="quoted value"` pairs.
 *
 * Sibling to `parseKv` in ./parsers since the rehome (ADR 0003), and kept
 * separate on purpose - see that function's note. As of DBT-84 the two AGREE
 * ON ORDINARY VENDOR KEYS - word characters, hyphens and dots, read whole - but
 * NOT on parseKv's full key class, and that difference is deliberate:
 *
 *   KEY CLASS `[\w.-]+`, LEFT BOUNDARY "not preceded by one of those". parseKv
 *   reads a body whose header was already split off; this probe sees the RAW
 *   line, CEF/LEEF `|` header, `prog:` tag, `[timestamp]` and all. The first cut
 *   of DBT-84 copied parseKv's `[^\s=,"]+` and glued the header onto the first
 *   key (`...|5|cat=X` -> `CEF:0|...|5|cat`), so a capture whose discriminator
 *   was the first extension key fell back to one group - a regression on lines
 *   `\w+` had always split correctly (review finding, 2026-10-02). With this
 *   class any other punctuation is a boundary, exactly as it was under `\w+`,
 *   and the only thing that changed is that `-` and `.` no longer cut a key.
 *   The lookbehind keeps the scan linear (see parseKv's timing note).
 *
 * The VALUE handling stays this probe's own (whitespace-terminated, or a quoted
 * run), because a discriminator value never needs parseKv's comma-tolerant
 * value class.
 *
 * WHY THIS USED TO TRUNCATE, AND WHAT REPLACED THE TRUNCATION. Until DBT-84 the
 * key class was `\w+`, which cut `src-ip` to `ip` and `log-type` to `type`. Half
 * of that was load-bearing by accident - `type` is on DISCRIMINATOR_FIELDS, so a
 * PAN-OS-style `log-type=TRAFFIC` selected through it - and half was harm:
 * truncated keys COLLIDED, last one winning. Measured before the fix:
 *
 *   "log-type=TRAFFIC sub-type=end src-ip=1 dst-ip=2"
 *     parseKvLine -> { type: "end", ip: "2" }
 *
 * So the SUBTYPE overwrote the log type (and which one won depended on pair
 * order), and four real pairs counted as two, failing the splitter's >= 3 gate
 * and dropping the whole sample into the fallback group. The load-bearing half
 * now lives in {@link SPLITTER_DISCRIMINATOR_ALIASES}, applied by the splitter
 * after this returns; this function only reports what the line says.
 *
 * Dotted keys are read whole for the same reason (`src.ip`/`dst.ip` collided
 * onto `ip`), and are NOT aliased: `event.type` used to truncate into `type`
 * and no longer does, a regroup the release notes name.
 */
export function parseKvLine(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const cleaned = line.replace(/^<\d+>/, "");
  // Key: a whole run of word characters, `-` and `.`, starting where the
  // previous character is NOT one of those - so `|`, `:`, `]`, `[`, `"` and
  // whitespace all end a header and begin a key (DBT-84 review), while
  // `src-ip` and `event.type` stay whole.
  const re = /(?<![\w.-])([\w.-]+)=(?:"([^"]*)"|(\S*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    fields[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return fields;
}

/**
 * Vendor key spellings the splitter reads AS a DISCRIMINATOR_FIELDS entry
 * (DBT-84). Each maps a full key to the spelling `\w+` used to truncate it to,
 * or to the list entry it plainly means, so a sample that was split correctly
 * before keys were widened keeps its log-type names - a log type is the
 * tagged-sample store's KEY (see the DETERMINISM note above).
 *
 * SPLITTER-LOCAL ON PURPOSE. DISCRIMINATOR_FIELDS is shared: query-lake-samples
 * interpolates its entries unquoted into KQL as plain identifiers (a hyphenated
 * `isnotempty(log-type)` parses as a subtraction), and route-discriminator,
 * capture-filter and expected-log-types read it too. Adding `log-type` there
 * would change Lake queries, routes and capture filters through a back door.
 * Every TARGET here must be a member of that list; a test holds it.
 *
 * An alias never overwrites an exact key: a line carrying both `type=` and
 * `log-type=` selects on `type` (operator decision on DBT-84, 2026-10-02).
 */
export const SPLITTER_DISCRIMINATOR_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    "log-type": "type", // PAN-OS / generic primary
    "sub-type": "subtype", // PAN-OS secondary
    "event-type": "eventType", // generic; `\w+` used to cut it to `type`
  });

/**
 * The record the discriminator selector sees for one KV line: every real pair,
 * plus each aliased spelling the line does NOT already carry exactly.
 */
function withDiscriminatorAliases(
  fields: Record<string, string>,
): Record<string, string> {
  const record: Record<string, string> = { ...fields };
  for (const [from, to] of Object.entries(SPLITTER_DISCRIMINATOR_ALIASES)) {
    if (from in fields && !(to in fields)) record[to] = fields[from];
  }
  return record;
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
        // The gate counts the line's REAL pairs, before aliasing adds any
        // (DBT-84) - an alias is a second name for a pair, not another pair.
        if (Object.keys(kvFields).length >= 3) {
          eventObjects.push(withDiscriminatorAliases(kvFields));
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
 *
 * POSITIONAL (DBT-117, added after the port - legacy had no positional format,
 * so the DBT-77 member fell off the end to `false` even for a VPC Flow v2
 * capture parsePositional names). It qualifies exactly when parsePositional
 * would name the columns, via the shared `positionalHasNamedFields`: blank
 * lines dropped, then EVERY line checked, unlike the first-line rules above.
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

  if (format === "positional") return positionalHasNamedFields(rawEvents);

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
