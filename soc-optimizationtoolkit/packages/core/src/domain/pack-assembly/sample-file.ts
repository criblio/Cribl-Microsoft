/**
 * Pack sample-file generation - porting-plan Unit 19, task item 4, and section 3
 * contract 10 (sample-file envelope).
 *
 * Ported from legacy pack-builder.ts generateSampleFile (1215-1323) and
 * generateRawVendorEvent (1180-1209). A pack sample event is a Cribl capture
 * envelope wrapping ONE raw vendor log in `_raw`; the pipeline's serde re-parses
 * `_raw`, so the sample must mirror exactly what the Cribl source delivers -
 * ONLY the envelope keys plus `_raw`, never the exploded vendor fields (the
 * contract test `test-uat-pack-build` TEST 7 asserts precisely this).
 *
 * Preserved verbatim:
 *   - JSON-array event breaking (each element becomes its own event);
 *   - CEF reconstruction from a tag-roundtripped JSON object (tagSample re-parses
 *     CEF into JSON, so `_raw` here is rebuilt into a raw `CEF:...|...` line so
 *     the pipeline's CEF parser can process it), including the skip-field set;
 *   - the synthetic-event fallback when a table has no real uploaded samples.
 *
 * Determinism (Unit 19): the `_time` base is the fixed epoch constant the legacy
 * derived from `new Date('2025-06-15T14:30:00Z')`; the synthetic timestamp uses
 * a constant string; synthetic field values come from the seeded generator. No
 * Date/crypto/Math.random.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { generateFieldValue } from "./sample-values";

/** Seconds since epoch for 2025-06-15T14:30:00Z (legacy sample time base). */
export const SAMPLE_TIME_BASE_SEC = 1749997800;

/** The constant fallback timestamp (legacy new Date('2025-06-15T14:32:17Z')). */
const SYNTHETIC_TIME_GENERATED = "2025-06-15T14:32:17.000Z";

/** A tagged vendor sample as consumed by pack sample-file generation. */
export interface PackVendorSample {
  /** Destination Sentinel table this sample feeds. */
  tableName: string;
  /** Raw event lines (original vendor bytes, or tag-roundtripped JSON). */
  rawEvents: string[];
  /** The source label (often "vendor:logType"). */
  source: string;
  /** Per-logType label, when the table carries several log types. */
  logType?: string;
  /** Detected format, when known. */
  format?: string;
}

/** A minimal source-field descriptor for the synthetic-event fallback. */
export interface SampleSourceField {
  source?: string;
  target?: string;
  type: string;
}

/** The Cribl capture envelope (section 3 item 10: only these keys + _raw). */
export interface PackSampleEvent {
  _time: number;
  _raw: string;
  source: string;
  sourcetype: string;
  host: string;
  index: string;
}

/**
 * Reconstruct a raw `CEF:...` line from a tag-roundtripped CEF object. Returns
 * null when the object is not a CEF-tagged event. Verbatim field order and
 * skip-set from the legacy (pack-builder.ts 1269-1294).
 */
export function reconstructCefLine(evt: Record<string, unknown>): string | null {
  if (evt.CEFVersion === undefined || !evt.DeviceVendor) return null;
  const header = [
    `CEF:${evt.CEFVersion || "0"}`,
    evt.DeviceVendor || "",
    evt.DeviceProduct || "",
    evt.DeviceVersion || "",
    evt.DeviceEventClassID || "",
    evt.Name || evt.Activity || "",
    evt.Severity || evt.LogSeverity || "",
  ].join("|");
  const skipFields = new Set([
    "CEFVersion",
    "DeviceVendor",
    "DeviceProduct",
    "DeviceVersion",
    "DeviceEventClassID",
    "Name",
    "Activity",
    "Severity",
    "LogSeverity",
    "_syslogHeader",
  ]);
  const extParts: string[] = [];
  for (const [k, v] of Object.entries(evt)) {
    if (skipFields.has(k) || v === undefined || v === null || v === "") continue;
    extParts.push(`${k}=${String(v)}`);
  }
  return header + "|" + extParts.join(" ");
}

/** Generate one synthetic raw vendor event from source-field descriptors. */
export function generateRawVendorEvent(
  sourceFields: SampleSourceField[],
  seed: number,
): Record<string, unknown> {
  const event: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const field of sourceFields) {
    const name = field.source || field.target;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    event[name] = generateFieldValue(name, field.type, seed);
  }
  if (!event["TimeGenerated"] && !event["timestamp"] && !event["time"] && !event["EventTime"]) {
    event["TimeGenerated"] = SYNTHETIC_TIME_GENERATED;
  }
  return event;
}

/** Break a raw event string into events, splitting top-level JSON arrays. */
function expandRawEvent(rawStr: string, out: string[]): void {
  const trimmed = rawStr.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          out.push(typeof item === "string" ? item : JSON.stringify(item));
        }
        return;
      }
    } catch {
      // Starts with [ but is not valid JSON array - fall through, use as-is.
    }
  }
  out.push(rawStr);
}

/**
 * Generate the Cribl-format sample events for one table. When real uploaded
 * samples exist, ALL of their events are included (envelope + `_raw` only);
 * otherwise `eventCount` synthetic events are generated.
 */
export function generateSampleFile(
  solutionName: string,
  tableName: string,
  sourceFields: SampleSourceField[],
  vendorSamples: PackVendorSample[],
  eventCount: number,
  logType?: string,
): { events: PackSampleEvent[]; rawCount: number } {
  const events: PackSampleEvent[] = [];

  const tblTarget = tableName.toLowerCase().replace(/_cl$/i, "");
  const tableSamples = vendorSamples.filter((s) => {
    const tbl = s.tableName.toLowerCase();
    if (tbl === tableName.toLowerCase()) return true;
    if (tbl.includes(tblTarget)) return true;
    if (logType && s.source && s.source.toLowerCase().includes(logType.toLowerCase())) return true;
    return false;
  });

  const allRawEvents: string[] = [];
  for (const sample of tableSamples) {
    for (const rawStr of sample.rawEvents) {
      expandRawEvent(rawStr, allRawEvents);
    }
  }

  const sourceLabel = `${solutionName}:${logType || tableName}`;

  if (allRawEvents.length > 0) {
    for (let i = 0; i < allRawEvents.length; i++) {
      let rawValue = allRawEvents[i];
      if (rawValue.startsWith("{")) {
        try {
          const cef = reconstructCefLine(JSON.parse(rawValue));
          if (cef !== null) rawValue = cef;
        } catch {
          // Not JSON - leave as-is.
        }
      }
      events.push({
        _time: SAMPLE_TIME_BASE_SEC + i * 60,
        _raw: rawValue,
        source: sourceLabel,
        sourcetype: sourceLabel,
        host: "cribl-worker-01.contoso.com",
        index: tableName,
      });
    }
  } else {
    for (let i = 0; i < eventCount; i++) {
      const rawEvent = generateRawVendorEvent(sourceFields, i);
      events.push({
        _time: SAMPLE_TIME_BASE_SEC + i * 60,
        _raw: JSON.stringify(rawEvent),
        source: sourceLabel,
        sourcetype: sourceLabel,
        host: "cribl-worker-01.contoso.com",
        index: tableName,
      });
    }
  }

  return { events, rawCount: events.length };
}

/** One entry in the samples.yml registry. */
export interface SampleRegistryEntry {
  sampleId: string;
  sampleName: string;
  createdMs: number;
  size: number;
  numEvents: number;
}

/** Render one samples.yml registry block (legacy pack-builder.ts 1754-1761). */
export function renderSampleRegistryEntry(e: SampleRegistryEntry): string {
  return [
    `${e.sampleId}:`,
    `  sampleName: "${e.sampleName}"`,
    `  ttl: 0`,
    `  created: ${e.createdMs}`,
    `  size: ${e.size}`,
    `  numEvents: ${e.numEvents}`,
  ].join("\n");
}

/** Render the full samples.yml (legacy pack-builder.ts 1765-1767). */
export function generateSamplesYml(entries: SampleRegistryEntry[]): string {
  return entries.length > 0
    ? entries.map(renderSampleRegistryEntry).join("\n") + "\n"
    : "# No sample data generated\n";
}
