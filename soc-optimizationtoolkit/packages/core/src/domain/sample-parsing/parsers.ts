/**
 * Format-specific parsers - ported near-verbatim from the legacy
 * sample-parser.ts (IS/sample-parser.ts). Each turns raw text into an array of
 * record objects; field discovery and type inference happen in parse-sample.ts.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 *
 * `parseCsvWithHeaders` (external header resolution) is deliberately NOT here -
 * that is Unit 12 (headerless CSV + vendor feed-config resolution). This module
 * ports only the INTERNAL headerless parseCsv used by parseSampleContent's
 * dispatch (PAN-OS positional column naming).
 */

import type { SampleFormat } from "./models";

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

/**
 * PAN-OS TRAFFIC log positional columns. NOTE: index 20 is 'log_action' here -
 * this is one of the three drifted PAN-OS dictionaries the porting plan flags
 * (Unit 12 owns the canonical reconciliation of parser 'log_action' vs resolver
 * 'logset'). Kept verbatim so parseSampleContent's headerless path matches
 * legacy output; Unit 12 supersedes it.
 */
const PANOS_TRAFFIC_COLS: readonly string[] = [
  "future_use1", "receive_time", "serial", "type", "subtype", "future_use2",
  "generated_time", "src", "dst", "natsrc", "natdst", "rule", "srcuser",
  "dstuser", "app", "vsys", "from", "to", "inbound_if", "outbound_if",
  "log_action", "future_use3", "sessionid", "repeatcnt", "sport", "dport",
  "natsport", "natdport", "flags", "proto", "action", "bytes", "bytes_sent",
  "bytes_received", "packets", "start", "elapsed", "category", "future_use4",
  "seqno", "actionflags", "srcloc", "dstloc", "future_use5", "pkts_sent",
  "pkts_received", "session_end_reason",
];

/** PAN-OS THREAT log positional columns (verbatim from legacy). */
const PANOS_THREAT_COLS: readonly string[] = [
  "future_use1", "receive_time", "serial", "type", "subtype", "future_use2",
  "generated_time", "src", "dst", "natsrc", "natdst", "rule", "srcuser",
  "dstuser", "app", "vsys", "from", "to", "inbound_if", "outbound_if",
  "log_action", "future_use3", "sessionid", "repeatcnt", "sport", "dport",
  "natsport", "natdport", "flags", "proto", "action", "misc", "threatid",
  "category", "severity", "direction", "seqno", "actionflags", "srcloc",
  "dstloc", "future_use4", "contenttype", "pcap_id", "filedigest", "cloud",
  "url_idx", "user_agent", "filetype", "xff", "referer", "sender", "subject",
  "recipient", "reportid",
];

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
export function parseCsv(content: string): Array<Record<string, unknown>> {
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
      return record;
    });
  }

  // Headerless: strip syslog prefix, detect PAN-OS TRAFFIC/THREAT by position 3.
  return lines
    .map((line) => {
      const stripped = stripSyslogPrefix(line);
      const values = stripped
        .split(",")
        .map((v) => v.trim().replace(/^"|"$/g, ""));
      const record: Record<string, unknown> = {};

      const logType = values[3];
      let colNames: readonly string[] | null = null;
      if (logType === "TRAFFIC") {
        colNames = PANOS_TRAFFIC_COLS;
      } else if (logType === "THREAT") {
        colNames = PANOS_THREAT_COLS;
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
      return record;
    })
    .filter((record) => Object.keys(record).length > 1);
}

/** Parse key=value lines (Palo Alto, FortiGate, ...). Verbatim from legacy. */
export function parseKv(content: string): Array<Record<string, unknown>> {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
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
      return record;
    })
    .filter((record) => Object.keys(record).length > 0);
}

/** Parse CEF (CEF:0|vendor|product|...|extension). Verbatim from legacy. */
export function parseCef(content: string): Array<Record<string, unknown>> {
  return content
    .trim()
    .split("\n")
    .filter((line) => line.includes("CEF:"))
    .map((line) => {
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
      return record;
    })
    .filter((record) => Object.keys(record).length > 0);
}

/** Parse LEEF (LEEF:ver|vendor|product|...|tab-delimited kvp). Verbatim. */
export function parseLeef(content: string): Array<Record<string, unknown>> {
  return content
    .trim()
    .split("\n")
    .filter((line) => line.includes("LEEF:"))
    .map((line) => {
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
      return record;
    })
    .filter((record) => Object.keys(record).length > 0);
}

/** Parse RFC 3164 / RFC 5424 syslog lines. Verbatim from legacy. */
export function parseSyslog(content: string): Array<Record<string, unknown>> {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
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
      return record;
    })
    .filter((record) => Object.keys(record).length > 1);
}

/**
 * Dispatch to the parser for a known format, or - for 'unknown' - try each
 * parser in the legacy fallback order and return the first that yields records
 * with more than one field. Verbatim ordering from legacy parseContent.
 */
export function parseByFormat(
  content: string,
  format: SampleFormat,
): Array<Record<string, unknown>> {
  switch (format) {
    case "json":
      return parseJson(content);
    case "ndjson":
      return parseNdjson(content);
    case "csv":
      return parseCsv(content);
    case "kv":
      return parseKv(content);
    case "cef":
      return parseCef(content);
    case "leef":
      return parseLeef(content);
    case "syslog":
      return parseSyslog(content);
    default: {
      const fallback = [
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
          const result = parser(content);
          if (result.length > 0 && Object.keys(result[0]).length > 1) {
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
