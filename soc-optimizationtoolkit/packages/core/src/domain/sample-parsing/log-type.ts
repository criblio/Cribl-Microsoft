/**
 * Log-type and original-format heuristics extracted as PURE functions from the
 * legacy renderer (IS-R/pages/SentinelIntegration.tsx). In the Electron app
 * these lived inside the React component; here they are testable pure functions
 * (porting-plan Unit 11: "detectLogType/isHeaderlessCsv/original-format-
 * preservation heuristics from the renderer extracted as pure functions").
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { SampleFormat } from "./models";

/**
 * Guess a log-type label for an uploaded sample from its filename, falling back
 * to a `sourcetype` example value, then to a sanitized filename. Verbatim from
 * the legacy renderer `detectLogType`.
 */
export function detectLogType(input: {
  sourceName: string;
  fields?: ReadonlyArray<{ name: string; examples?: readonly string[] }>;
}): string {
  const fname = input.sourceName.replace(/\.[^.]+$/, "").toLowerCase();
  const typeKeywords = [
    "dns", "http", "waf", "traffic", "threat", "url", "system", "audit",
    "firewall", "auth", "utm",
  ];
  const found = typeKeywords.find((keyword) => fname.includes(keyword));
  if (found) {
    return found.charAt(0).toUpperCase() + found.slice(1);
  }
  if (input.fields) {
    const sourcetypeField = input.fields.find((f) => f.name === "sourcetype");
    const example = sourcetypeField?.examples?.[0];
    if (example) {
      const parts = example.split(":");
      const lt =
        parts.length > 1
          ? parts[parts.length - 1].replace(/[^a-zA-Z]/g, "")
          : parts[0];
      return lt.charAt(0).toUpperCase() + lt.slice(1);
    }
  }
  return input.sourceName
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * True when parsed fields look like headerless positional CSV: at least 3
 * fields, more than half of them named `_0`, `_1`, ... (the parseCsv generic
 * positional naming). Verbatim from the legacy renderer `isHeaderlessCsv`;
 * drives the CSV header-resolution dialog (Unit 12).
 */
export function isHeaderlessCsv(
  fields: ReadonlyArray<{ name: string }>,
): boolean {
  if (fields.length < 3) {
    return false;
  }
  const numericFields = fields.filter((f) => /^_\d+$/.test(f.name));
  return numericFields.length > fields.length * 0.5;
}

/**
 * Record the ORIGINAL vendor format per log type BEFORE the sample is tagged.
 * Tagging re-serializes events to NDJSON, which erases the fact that the source
 * was CEF/LEEF/KV/CSV/syslog; downstream pipeline generation needs the original
 * format to choose the right extraction. Only non-JSON formats are recorded
 * (JSON/NDJSON add nothing, matching the legacy `format !== 'ndjson' && !==
 * 'json'` gate). Keyed by LOWERCASE log type; merges over `base`.
 *
 * Verbatim behavior from the legacy renderer `originalSampleFormats` bookkeeping.
 */
export function recordOriginalFormats(
  samples: ReadonlyArray<{ logType: string; format: SampleFormat | string }>,
  base: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = { ...base };
  for (const sample of samples) {
    if (sample.format && sample.format !== "ndjson" && sample.format !== "json") {
      result[sample.logType.toLowerCase()] = sample.format;
    }
  }
  return result;
}

/**
 * Resolve the format to use for a log type: the preserved original format wins,
 * then the sample's own (possibly re-serialized) format, then "json". Verbatim
 * from the legacy renderer's `originalSampleFormats[lt.toLowerCase()] ||
 * s.format || 'json'` lookup.
 */
export function resolveOriginalFormat(
  logType: string,
  originalFormats: Record<string, string>,
  fallbackFormat?: string,
): string {
  return (
    originalFormats[logType.toLowerCase()] || fallbackFormat || "json"
  );
}
