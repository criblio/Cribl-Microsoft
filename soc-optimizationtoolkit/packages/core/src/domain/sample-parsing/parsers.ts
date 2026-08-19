/**
 * Format-specific parsers - ported near-verbatim from the legacy
 * sample-parser.ts (IS/sample-parser.ts). Each turns raw text into an array of
 * record objects; field discovery and type inference happen in parse-sample.ts.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 *
 * ORIGINAL-LINE CAPTURE (2026-08-18): every LINE-ORIENTED parser takes an
 * optional `sourceLines` accumulator and pushes the input line that produced
 * each record, AT THE POINT the record is produced - so a parser that FILTERS a
 * line (parseCef skips lines without "CEF:", parseCsv drops single-field rows)
 * cannot drift the pairing. That is what lets parseSampleContent keep the raw
 * vendor bytes instead of a re-serialization; see its `rawEvents` note. JSON and
 * NDJSON deliberately do not participate: re-serializing a parsed JSON record
 * loses nothing a downstream pipeline can observe.
 *
 * `parseCsvWithHeaders` (external header resolution) is deliberately NOT here -
 * that is Unit 12 (headerless CSV + vendor feed-config resolution). This module
 * ports only the INTERNAL headerless parseCsv used by parseSampleContent's
 * dispatch (PAN-OS positional column naming).
 */

import type { SampleFormat } from "./models";
import { PANOS_CSV_HEADERS } from "./panos-dictionary";

// ---------------------------------------------------------------------------
// Syslog prefix stripping (shared by parseCsv and capture inner detection)
// ---------------------------------------------------------------------------

/**
 * Strip a syslog prefix from a line to reach the data content. Handles:
 * - RFC 5424: "<14>1 2024-01-01T12:00:00Z host app - - <data>"
 * - RFC 3164: "Jan  1 12:00:00 host <data>"
 * - PAN-OS simple: "Apr 08 12:45:16 PA-VM 1,2020/05/07,..." -> "1,2020/05/07,..."
 *
 * Ported verbatim from legacy stripSyslogPrefix. The PAN-OS branch is the
 * load-bearing one for the capture >=5-comma CSV threshold (a syslog-wrapped
 * PAN-OS CSV line must have its prefix removed before commas are counted).
 */
export function stripSyslogPrefix(line: string): string {
  const rfc5424 = line.match(/^<\d+>\d+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)/);
  if (rfc5424) {
    return rfc5424[1];
  }

  const rfc3164 = line.match(/^\w{3}\s+\d+\s+\d+:\d+:\d+\s+\S+\s+(.*)/);
  if (rfc3164) {
    return rfc3164[1];
  }

  // PAN-OS: strip everything before the "1,YYYY/MM/DD..." positional start.
  const panOs = line.match(/(\d+,\d{4}\/\d{2}\/\d{2}.*)/);
  if (panOs) {
    return panOs[1];
  }

  return line;
}

// ---------------------------------------------------------------------------
// PAN-OS positional column names (headerless CSV)
// ---------------------------------------------------------------------------
//
// Unit 11 kept a local TRAFFIC/THREAT column copy here as a stopgap; Unit 12
// deleted it and this headerless path now consumes the ONE canonical dictionary
// (see panos-dictionary.ts). The drifted index 20 therefore resolves to the
// canonical 'logset' (not the old 'log_action') - the conscious reconciliation
// is pinned by panos-dictionary.test.ts.

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Parse a JSON array or a single JSON object into record(s). */
export function parseJson(content: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(content.trim());
  if (Array.isArray(parsed)) {
    return parsed as Array<Record<string, unknown>>;
  }
  return [parsed as Record<string, unknown>];
}

/** Parse newline-delimited JSON (one object per line; bad lines skipped). */
export function parseNdjson(content: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim().startsWith("{")) {
      continue;
    }
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Skip malformed lines (legacy filtered them out silently).
    }
  }
  return records;
}

/**
 * Parse CSV. Detects whether the first line is a header (all identifier-like
 * fields) or headerless positional data (PAN-OS syslog). Ported verbatim from
 * legacy parseCsv.
 */
export function parseCsv(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const lines = content.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    return [];
  }

  const firstFields = lines[0]
    .split(",")
    .map((header) => header.trim().replace(/^"|"$/g, ""));
  const isHeader =
    firstFields.length > 2 &&
    firstFields.every((field) => /^[a-zA-Z_][a-zA-Z0-9_ ]*$/.test(field));

  if (isHeader && lines.length >= 2) {
    return lines.slice(1).map((line) => {
      const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
      const record: Record<string, unknown> = {};
      firstFields.forEach((header, i) => {
        record[header] = values[i] ?? "";
      });
      sourceLines?.push(line);
      return record;
    });
  }

  // Headerless: strip syslog prefix, detect PAN-OS TRAFFIC/THREAT by position 3.
  // A for-loop rather than map+filter so the source line is pushed only for
  // records that SURVIVE the >1-field filter - map+filter would push for the
  // dropped ones too and shift every later pairing by one.
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const stripped = stripSyslogPrefix(line);
    const values = stripped
      .split(",")
      .map((v) => v.trim().replace(/^"|"$/g, ""));
    const record: Record<string, unknown> = {};

    const logType = values[3];
    let colNames: readonly string[] | null = null;
    if (logType === "TRAFFIC") {
      colNames = PANOS_CSV_HEADERS.TRAFFIC;
    } else if (logType === "THREAT") {
      colNames = PANOS_CSV_HEADERS.THREAT;
    }

    if (colNames) {
      colNames.forEach((name, i) => {
        if (i < values.length && !name.startsWith("future_use")) {
          record[name] = values[i] ?? "";
        }
      });
    } else {
      values.forEach((value, i) => {
        record[`_${i}`] = value;
      });
    }
    if (Object.keys(record).length > 1) {
      out.push(record);
      sourceLines?.push(line);
    }
  }
  return out;
}

/**
 * Parse key=value lines (Palo Alto, FortiGate, ...). Verbatim from legacy.
 *
 * NOT the same function as `parseKvLine` in ./splitting, which became a sibling
 * when the splitter was rehomed here (ADR 0003). That one is a cheap probe used
 * only to find a DISCRIMINATOR field; this one is full field extraction and is
 * what feeds the schema. They are deliberately separate: merging them would put
 * the splitter's log-type naming - which is the tagged-sample store's KEY - on
 * this function's change budget, and re-keying an operator's stored samples is
 * silent. If you touch one, do not assume the other should follow.
 */
export function parseKv(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split("\n").filter(Boolean)) {
    const record: Record<string, unknown> = {};
    // key="quoted value" | key=bareValue (a comma only splits when not
    // followed by whitespace, so "a,b" stays one value but "a, b" does not).
    const regex = /(\w+)=(?:"([^"]*)"|((?:[^\s,]|,(?=\S))+))/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      record[match[1]] = match[2] ?? match[3] ?? "";
    }
    if (Object.keys(record).length === 0) {
      for (const pair of line.split(/\s+/)) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx > 0) {
          record[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
    }
    if (Object.keys(record).length > 0) {
      out.push(record);
      sourceLines?.push(line);
    }
  }
  return out;
}

/** Parse CEF (CEF:0|vendor|product|...|extension). Verbatim from legacy. */
export function parseCef(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split("\n")) {
    if (!line.includes("CEF:")) continue;
    {
      const cefStart = line.indexOf("CEF:");
      const cefPart = line.slice(cefStart);
      const parts = cefPart.split("|");
      const record: Record<string, unknown> = {};
      if (parts.length >= 7) {
        record["CEFVersion"] = parts[0].replace("CEF:", "");
        record["DeviceVendor"] = parts[1];
        record["DeviceProduct"] = parts[2];
        record["DeviceVersion"] = parts[3];
        record["DeviceEventClassID"] = parts[4];
        record["Name"] = parts[5];
        record["Severity"] = parts[6];
        if (parts.length > 7) {
          const extension = parts.slice(7).join("|");
          const kvRegex = /(\w+)=(.*?)(?=\s\w+=|$)/g;
          let match: RegExpExecArray | null;
          while ((match = kvRegex.exec(extension)) !== null) {
            record[match[1]] = match[2].trim();
          }
        }
      }
      if (cefStart > 0) {
        record["_syslogHeader"] = line.slice(0, cefStart).trim();
      }
      if (Object.keys(record).length > 0) {
        out.push(record);
        sourceLines?.push(line);
      }
    }
  }
  return out;
}

/** Parse LEEF (LEEF:ver|vendor|product|...|tab-delimited kvp). Verbatim. */
export function parseLeef(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split("\n")) {
    if (!line.includes("LEEF:")) continue;
    {
      const leefStart = line.indexOf("LEEF:");
      const parts = line.slice(leefStart).split("|");
      const record: Record<string, unknown> = {};
      if (parts.length >= 5) {
        record["LEEFVersion"] = parts[0].replace("LEEF:", "");
        record["DeviceVendor"] = parts[1];
        record["DeviceProduct"] = parts[2];
        record["DeviceVersion"] = parts[3];
        record["EventID"] = parts[4];
        if (parts.length > 5) {
          const ext = parts.slice(5).join("|");
          for (const pair of ext.split("\t")) {
            const eqIdx = pair.indexOf("=");
            if (eqIdx > 0) {
              record[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
            }
          }
        }
      }
      if (Object.keys(record).length > 0) {
        out.push(record);
        sourceLines?.push(line);
      }
    }
  }
  return out;
}

/** Parse RFC 3164 / RFC 5424 syslog lines. Verbatim from legacy. */
export function parseSyslog(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split("\n").filter(Boolean)) {
    {
      const record: Record<string, unknown> = { _raw: line };
      const rfc3164 = line.match(
        /^(?:<(\d+)>)?(\w{3}\s+\d+\s+\d+:\d+:\d+)\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s*(.*)/,
      );
      if (rfc3164) {
        if (rfc3164[1]) {
          record["Priority"] = parseInt(rfc3164[1], 10);
        }
        record["Timestamp"] = rfc3164[2];
        record["Hostname"] = rfc3164[3];
        record["Program"] = rfc3164[4];
        if (rfc3164[5]) {
          record["PID"] = parseInt(rfc3164[5], 10);
        }
        record["Message"] = rfc3164[6];
        if (rfc3164[1]) {
          const pri = parseInt(rfc3164[1], 10);
          record["Facility"] = Math.floor(pri / 8);
          record["Severity"] = pri % 8;
        }
      }
      const rfc5424 = line.match(
        /^<(\d+)>(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)/,
      );
      if (rfc5424 && !rfc3164) {
        record["Priority"] = parseInt(rfc5424[1], 10);
        record["Version"] = parseInt(rfc5424[2], 10);
        record["Timestamp"] = rfc5424[3];
        record["Hostname"] = rfc5424[4];
        record["AppName"] = rfc5424[5];
        record["ProcID"] = rfc5424[6];
        record["MsgID"] = rfc5424[7];
        record["Message"] = rfc5424[8];
      }
      if (Object.keys(record).length > 1) {
        out.push(record);
        sourceLines?.push(line);
      }
    }
  }
  return out;
}

/**
 * Dispatch to the parser for a known format, or - for 'unknown' - try each
 * parser in the legacy fallback order and return the first that yields records
 * with more than one field. Verbatim ordering from legacy parseContent.
 */
export function parseByFormat(
  content: string,
  format: SampleFormat,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  switch (format) {
    case "json":
      return parseJson(content);
    case "ndjson":
      return parseNdjson(content);
    case "csv":
      return parseCsv(content, sourceLines);
    case "kv":
      return parseKv(content, sourceLines);
    case "cef":
      return parseCef(content, sourceLines);
    case "leef":
      return parseLeef(content, sourceLines);
    case "syslog":
      return parseSyslog(content, sourceLines);
    default: {
      // Annotated so the JSON/NDJSON parsers (which take no accumulator and
      // never need one) sit in the same array as the line-oriented ones.
      const fallback: Array<
        (c: string, s?: string[]) => Array<Record<string, unknown>>
      > = [
        parseJson,
        parseNdjson,
        parseCef,
        parseLeef,
        parseKv,
        parseCsv,
        parseSyslog,
      ];
      for (const parser of fallback) {
        try {
          // Each attempt gets a FRESH accumulator: a parser that produces
          // unusable records still pushed lines into it, and those must not
          // survive into the attempt that wins.
          const attemptLines: string[] = [];
          const result = parser(content, attemptLines);
          if (result.length > 0 && Object.keys(result[0]).length > 1) {
            sourceLines?.push(...attemptLines);
            return result;
          }
        } catch {
          continue;
        }
      }
      return [];
    }
  }
}
