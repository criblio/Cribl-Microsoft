/**
 * ONE format detector - the merge of the two drifted legacy detectors, with
 * their differences reified as explicit strict/lenient MODES (porting-plan
 * Unit 11: "ONE format detector merging the two legacy detectors ... with
 * explicit strict/lenient modes").
 *
 * The two legacy sources being reconciled:
 * - LENIENT (default) == legacy sample-parser.ts `detectFormat`: content-aware.
 *   Uses `includes('CEF:')` so a syslog-wrapped CEF line is still CEF; validates
 *   JSON with JSON.parse and distinguishes a single object (ndjson) from an
 *   array (json); has a full CSV heuristic; requires > 2 key=value pairs for kv.
 *   This is the mode parseSampleContent uses.
 * - STRICT == legacy sample-resolver.ts `detectSampleFormat`: prefix-only, fast.
 *   `startsWith('CEF:')` (a syslog header defeats it); any `{`/`[` is 'json'
 *   with no validation and never 'ndjson'; no CSV heuristic; a single leading
 *   `word=` is enough for kv. This is the mode used to classify an ALREADY
 *   single, already-split event (browse/capture preview) where speed matters
 *   and the content is known to be one record.
 *
 * The divergences (syslog-wrapped CEF, ndjson-vs-json, CSV, single-pair kv) are
 * characterized in format-detection.test.ts - they are the pinned contract.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { SampleFormat } from "./models";
import { stripSyslogPrefix } from "./parsers";

/** How the detector classifies content. See the module header. */
export type DetectMode = "strict" | "lenient";

/** Options for {@link detectSampleFormat}. */
export interface DetectOptions {
  /** Classification mode; defaults to "lenient". */
  mode?: DetectMode;
}

/**
 * Detect the format of `content`. Lenient by default (content-aware, used for
 * parsing); pass `{ mode: "strict" }` for the fast prefix-only classification
 * of a single already-split event.
 */
export function detectSampleFormat(
  content: string,
  options: DetectOptions = {},
): SampleFormat {
  return options.mode === "strict"
    ? detectStrict(content)
    : detectLenient(content);
}

/** Content-aware detection (legacy sample-parser detectFormat, xml dropped). */
function detectLenient(content: string): SampleFormat {
  const trimmed = content.trim();

  // JSON array.
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not a valid JSON array; keep probing.
    }
  }

  // Single JSON object / NDJSON stream (validate the first line only).
  if (trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed.split("\n")[0]);
      return "ndjson";
    } catch {
      // Not JSON; keep probing.
    }
  }

  if (trimmed.includes("CEF:")) {
    return "cef";
  }
  if (trimmed.includes("LEEF:")) {
    return "leef";
  }

  const firstLine = trimmed.split("\n")[0];

  // CSV: header-like first line with > 3 comma-separated identifier fields.
  if (
    firstLine.includes(",") &&
    !firstLine.includes("=") &&
    firstLine.split(",").length > 3
  ) {
    const fields = firstLine.split(",");
    if (fields.every((f) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.trim()))) {
      return "csv";
    }
  }

  // key=value: at least 3 space-separated pairs on the first line.
  if (
    /\w+=\S+/.test(firstLine) &&
    firstLine.split(" ").filter((p) => p.includes("=")).length > 2
  ) {
    return "kv";
  }

  // syslog: <priority> or an RFC 3164 month-day-time prefix.
  if (/^<\d+>/.test(trimmed) || /^\w{3}\s+\d+\s+\d+:\d+:\d+/.test(trimmed)) {
    return "syslog";
  }

  return "unknown";
}

/** Prefix-only detection (legacy sample-resolver detectSampleFormat). */
function detectStrict(content: string): SampleFormat {
  const trimmed = content.trim();
  if (trimmed.startsWith("CEF:")) {
    return "cef";
  }
  if (trimmed.startsWith("LEEF:")) {
    return "leef";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }
  if (trimmed.startsWith("<") && trimmed.includes(">")) {
    return "syslog";
  }
  if (/^\w+=/.test(trimmed)) {
    return "kv";
  }
  if (/^[A-Z][a-z]{2}\s+\d/.test(trimmed)) {
    return "syslog";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Cribl capture inner-_raw detection (ENG-15) - FIRST-CLASS
// ---------------------------------------------------------------------------

/**
 * Detect the vendor format INSIDE the `_raw` values of a Cribl capture. A Cribl
 * capture wraps each event as NDJSON/JSON with the real vendor log line in a
 * `_raw` field, so the true format is ALWAYS read from that inner content, not
 * from the (JSON) wrapper (user memory: "format is ALWAYS detected from
 * rawEvents content, never the declared format").
 *
 * Ported verbatim from legacy detectInnerRawFormat. The edge cases pinned by
 * capture.test.ts:
 * - CEF/LEEF are matched with `includes` across the first few samples (a
 *   syslog header before "CEF:" does not hide it).
 * - CSV is claimed at the >= 5-comma threshold, AFTER stripping any syslog
 *   prefix (so a syslog-wrapped PAN-OS CSV line is counted correctly).
 * - kv needs >= 3 space-separated pairs; syslog needs a priority/date prefix.
 */
export function detectCaptureInnerFormat(rawValues: string[]): SampleFormat {
  const samples = rawValues.slice(0, 5);

  for (const raw of samples) {
    if (raw.includes("CEF:")) {
      return "cef";
    }
    if (raw.includes("LEEF:")) {
      return "leef";
    }
  }

  const first = samples[0] ?? "";

  if (first.trim().startsWith("{")) {
    try {
      JSON.parse(first);
      return "ndjson";
    } catch {
      // Not JSON; keep probing.
    }
  }

  // CSV: >= 5 commas after removing any syslog / PAN-OS prefix.
  const csvCandidate = stripSyslogPrefix(first);
  const commaCount = (csvCandidate.match(/,/g) ?? []).length;
  if (commaCount >= 5) {
    return "csv";
  }

  const kvPairs = first.split(/\s+/).filter((p) => p.includes("="));
  if (kvPairs.length >= 3) {
    return "kv";
  }

  if (/^<\d+>/.test(first) || /^\w{3}\s+\d+\s+\d+:\d+:\d+/.test(first)) {
    return "syslog";
  }

  return "unknown";
}
