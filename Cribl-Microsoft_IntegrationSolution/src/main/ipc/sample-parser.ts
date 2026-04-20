// Sample Parser Module
// Accepts user-provided log files (drag/drop, browse, or paste) and extracts
// field names, types, and sample values to inform pack pipeline generation.
//
// Supports: JSON, JSON array, NDJSON, CSV, key=value (syslog/CEF/LEEF),
// XML, and raw syslog formats.
//
// Also parses vendor output feed configuration text (e.g., Palo Alto syslog
// forwarding config, Cloudflare Logpush job config) to determine expected
// log format and fields.

import { IpcMain, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredField {
  name: string;
  type: string;         // Inferred: string, int, real, boolean, datetime, dynamic
  sampleValues: string[];
  occurrence: number;   // How many events contained this field
  required: boolean;    // Present in >90% of events
}

export interface ParsedSample {
  format: 'json' | 'ndjson' | 'csv' | 'kv' | 'cef' | 'leef' | 'xml' | 'syslog' | 'unknown';
  eventCount: number;
  fields: DiscoveredField[];
  rawEvents: string[];   // First N raw events for pack sample data
  sourceName: string;    // Filename or "pasted"
  timestampField: string; // Best guess at timestamp field
  errors: string[];
}

export interface VendorFeedConfig {
  vendor: string;
  feedType: string;       // e.g., "syslog_forwarding", "logpush", "event_stream"
  format: string;         // Expected log format
  fields: string[];       // Field names from the config
  transportProtocol: string;
  port: number;
  rawConfig: string;
}

// ---------------------------------------------------------------------------
// Format Detection
// ---------------------------------------------------------------------------

function detectFormat(content: string): ParsedSample['format'] {
  const trimmed = content.trim();

  // JSON array
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try { JSON.parse(trimmed); return 'json'; } catch { /* not valid JSON array */ }
  }

  // Single JSON object
  if (trimmed.startsWith('{')) {
    try { JSON.parse(trimmed.split('\n')[0]); return 'ndjson'; } catch { /* not JSON */ }
  }

  // CEF format: CEF:0|vendor|product|...
  if (trimmed.includes('CEF:')) return 'cef';

  // LEEF format: LEEF:1.0|vendor|product|...
  if (trimmed.includes('LEEF:')) return 'leef';

  // XML
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
    if (trimmed.includes('</') || trimmed.includes('/>')) return 'xml';
  }

  // CSV (first line has commas and looks like a header)
  const firstLine = trimmed.split('\n')[0];
  if (firstLine.includes(',') && !firstLine.includes('=') && firstLine.split(',').length > 3) {
    const fields = firstLine.split(',');
    if (fields.every((f) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.trim()))) return 'csv';
  }

  // Key=value pairs (Palo Alto, FortiGate, etc.)
  if (/\w+=\S+/.test(firstLine) && firstLine.split(' ').filter((p) => p.includes('=')).length > 2) {
    return 'kv';
  }

  // Syslog format: starts with timestamp or <priority>
  if (/^<\d+>/.test(trimmed) || /^\w{3}\s+\d+\s+\d+:\d+:\d+/.test(trimmed)) {
    return 'syslog';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function inferType(value: unknown): string {
  if (value === null || value === undefined) return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int' : 'real';
  }
  if (typeof value === 'object') return 'dynamic';
  const str = String(value);
  if (str === 'true' || str === 'false') return 'boolean';
  if (/^\d+$/.test(str) && str.length < 16) return 'int';
  if (/^\d+\.\d+$/.test(str)) return 'real';
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(str)) return 'datetime';
  if (/^\w{3}\s+\d+\s+\d+:\d+:\d+/.test(str)) return 'datetime';
  return 'string';
}

function mergeType(existing: string, newType: string): string {
  if (existing === newType) return existing;
  if (existing === 'string' || newType === 'string') return 'string';
  if ((existing === 'int' && newType === 'real') || (existing === 'real' && newType === 'int')) return 'real';
  return 'string';
}

function collectFields(
  events: Array<Record<string, unknown>>,
  maxSamples: number = 3,
): DiscoveredField[] {
  const fieldMap = new Map<string, {
    types: string[];
    samples: Set<string>;
    count: number;
  }>();

  for (const event of events) {
    for (const [key, value] of Object.entries(event)) {
      if (!fieldMap.has(key)) {
        fieldMap.set(key, { types: [], samples: new Set(), count: 0 });
      }
      const field = fieldMap.get(key)!;
      field.types.push(inferType(value));
      field.count++;
      if (field.samples.size < maxSamples && value !== null && value !== undefined) {
        const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (str.length < 200) field.samples.add(str);
      }
    }
  }

  return Array.from(fieldMap.entries()).map(([name, data]) => {
    let type = data.types[0] || 'string';
    for (const t of data.types) type = mergeType(type, t);
    return {
      name,
      type,
      sampleValues: Array.from(data.samples),
      occurrence: data.count,
      required: data.count >= events.length * 0.9,
    };
  });
}

function guessTimestampField(fields: DiscoveredField[]): string {
  const candidates = [
    'timestamp', 'Timestamp', 'time', 'Time', 'datetime', 'DateTime',
    'EventTime', 'eventTime', 'TimeGenerated', 'created_at', 'createdAt',
    'date', 'Date', 'EdgeStartTimestamp', 'Datetime', 'start_time',
    'event_time', 'log_time', 'receive_time', '_time',
  ];
  for (const c of candidates) {
    if (fields.some((f) => f.name === c)) return c;
  }
  const dtField = fields.find((f) => f.type === 'datetime');
  if (dtField) return dtField.name;
  const timeish = fields.find((f) => f.name.toLowerCase().includes('time'));
  if (timeish) return timeish.name;
  return '';
}

// Parse JSON array or single JSON object
function parseJson(content: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(content.trim());
  if (Array.isArray(parsed)) return parsed;
  return [parsed];
}

// Parse newline-delimited JSON
function parseNdjson(content: string): Array<Record<string, unknown>> {
  return content.trim().split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean) as Array<Record<string, unknown>>;
}

// Parse CSV -- detects whether first line is a header or data.
// If first line has all-alphabetic fields, treats as header row.
// Otherwise, treats as headerless (positional) CSV with syslog prefix stripping.
function parseCsv(content: string): Array<Record<string, unknown>> {
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return [];

  // Check if first line looks like a header (all fields match identifier pattern)
  const firstFields = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const isHeader = firstFields.length > 2 && firstFields.every((f) => /^[a-zA-Z_][a-zA-Z0-9_ ]*$/.test(f));

  if (isHeader && lines.length >= 2) {
    // Standard CSV with header row
    return lines.slice(1).map((line) => {
      const values = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      const obj: Record<string, unknown> = {};
      firstFields.forEach((h, i) => { obj[h] = values[i] ?? ''; });
      return obj;
    });
  }

  // Headerless CSV (PAN-OS syslog, etc.) -- strip syslog prefix, use positional names.
  // Also try to detect PAN-OS format and assign meaningful field names.
  const PANOS_TRAFFIC_COLS = [
    'future_use1', 'receive_time', 'serial', 'type', 'subtype', 'future_use2',
    'generated_time', 'src', 'dst', 'natsrc', 'natdst', 'rule', 'srcuser',
    'dstuser', 'app', 'vsys', 'from', 'to', 'inbound_if', 'outbound_if',
    'log_action', 'future_use3', 'sessionid', 'repeatcnt', 'sport', 'dport',
    'natsport', 'natdport', 'flags', 'proto', 'action', 'bytes', 'bytes_sent',
    'bytes_received', 'packets', 'start', 'elapsed', 'category', 'future_use4',
    'seqno', 'actionflags', 'srcloc', 'dstloc', 'future_use5', 'pkts_sent',
    'pkts_received', 'session_end_reason',
  ];
  const PANOS_THREAT_COLS = [
    'future_use1', 'receive_time', 'serial', 'type', 'subtype', 'future_use2',
    'generated_time', 'src', 'dst', 'natsrc', 'natdst', 'rule', 'srcuser',
    'dstuser', 'app', 'vsys', 'from', 'to', 'inbound_if', 'outbound_if',
    'log_action', 'future_use3', 'sessionid', 'repeatcnt', 'sport', 'dport',
    'natsport', 'natdport', 'flags', 'proto', 'action', 'misc', 'threatid',
    'category', 'severity', 'direction', 'seqno', 'actionflags', 'srcloc',
    'dstloc', 'future_use4', 'contenttype', 'pcap_id', 'filedigest', 'cloud',
    'url_idx', 'user_agent', 'filetype', 'xff', 'referer', 'sender', 'subject',
    'recipient', 'reportid',
  ];

  return lines.map((line) => {
    // Strip syslog prefix if present
    const stripped = stripSyslogPrefix(line);
    const values = stripped.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
    const obj: Record<string, unknown> = {};

    // Detect PAN-OS by checking position 3 (type field)
    const logType = values[3];
    let colNames: string[] | null = null;
    if (logType === 'TRAFFIC') colNames = PANOS_TRAFFIC_COLS;
    else if (logType === 'THREAT') colNames = PANOS_THREAT_COLS;

    if (colNames) {
      // PAN-OS: use defined column names
      colNames.forEach((name, i) => {
        if (i < values.length && !name.startsWith('future_use')) {
          obj[name] = values[i] ?? '';
        }
      });
    } else {
      // Generic headerless CSV: use positional names
      values.forEach((v, i) => { obj[`_${i}`] = v; });
    }
    return obj;
  }).filter((obj) => Object.keys(obj).length > 1);
}

/**
 * Parse CSV content using externally-provided column headers.
 * Used when the user uploads a header file or pastes a feed config
 * to name columns in headerless CSV data (Zscaler NSS, PAN-OS, etc.).
 */
export function parseCsvWithHeaders(
  csvContent: string,
  headers: string[],
  skipFirstRow: boolean = false,
): ParsedSample {
  const lines = csvContent.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { format: 'csv', eventCount: 0, fields: [], rawEvents: [], sourceName: 'csv', timestampField: '', errors: ['No data lines found'] };
  }

  const dataLines = skipFirstRow ? lines.slice(1) : lines;
  const events: Array<Record<string, unknown>> = [];

  for (const line of dataLines) {
    // Strip syslog prefix if present
    const stripped = stripSyslogPrefix(line);
    const values = stripped.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < Math.min(headers.length, values.length); i++) {
      const name = headers[i].trim();
      if (name && !name.startsWith('future_use')) {
        obj[name] = values[i] ?? '';
      }
    }
    // Include any extra columns beyond the header count as _N
    for (let i = headers.length; i < values.length; i++) {
      obj[`_extra_${i}`] = values[i];
    }
    if (Object.keys(obj).length > 0) events.push(obj);
  }

  const fields = collectFields(events);
  const timestampField = guessTimestampField(fields);
  const rawEvents = events.slice(0, 200).map((e) => JSON.stringify(e));

  return {
    format: 'csv',
    eventCount: events.length,
    fields,
    rawEvents,
    sourceName: 'csv-with-headers',
    timestampField,
    errors: [],
  };
}

// Parse key=value format (Palo Alto, FortiGate, etc.)
function parseKv(content: string): Array<Record<string, unknown>> {
  return content.trim().split('\n').filter(Boolean).map((line) => {
    const obj: Record<string, unknown> = {};
    // Handle quoted values: key="value with spaces" key2=value2
    const regex = /(\w+)=(?:"([^"]*)"|((?:[^\s,]|,(?=\S))+))/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      obj[match[1]] = match[2] ?? match[3] ?? '';
    }
    if (Object.keys(obj).length === 0) {
      // Try space-separated without quotes
      for (const pair of line.split(/\s+/)) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          obj[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
    }
    return obj;
  }).filter((obj) => Object.keys(obj).length > 0);
}

// Parse CEF format: CEF:0|vendor|product|version|id|name|severity|extension
function parseCef(content: string): Array<Record<string, unknown>> {
  return content.trim().split('\n').filter((l) => l.includes('CEF:')).map((line) => {
    const cefStart = line.indexOf('CEF:');
    const cefPart = line.slice(cefStart);
    const parts = cefPart.split('|');
    const obj: Record<string, unknown> = {};
    if (parts.length >= 7) {
      obj['CEFVersion'] = parts[0].replace('CEF:', '');
      obj['DeviceVendor'] = parts[1];
      obj['DeviceProduct'] = parts[2];
      obj['DeviceVersion'] = parts[3];
      obj['DeviceEventClassID'] = parts[4];
      obj['Name'] = parts[5];
      obj['Severity'] = parts[6];
      // Parse extension key=value pairs
      if (parts.length > 7) {
        const extension = parts.slice(7).join('|');
        const kvRegex = /(\w+)=(.*?)(?=\s\w+=|$)/g;
        let match: RegExpExecArray | null;
        while ((match = kvRegex.exec(extension)) !== null) {
          obj[match[1]] = match[2].trim();
        }
      }
    }
    // Include syslog header if present
    if (cefStart > 0) {
      obj['_syslogHeader'] = line.slice(0, cefStart).trim();
    }
    return obj;
  }).filter((obj) => Object.keys(obj).length > 0);
}

// Parse LEEF format: LEEF:version|vendor|product|version|eventID|extension
function parseLeef(content: string): Array<Record<string, unknown>> {
  return content.trim().split('\n').filter((l) => l.includes('LEEF:')).map((line) => {
    const leefStart = line.indexOf('LEEF:');
    const parts = line.slice(leefStart).split('|');
    const obj: Record<string, unknown> = {};
    if (parts.length >= 5) {
      obj['LEEFVersion'] = parts[0].replace('LEEF:', '');
      obj['DeviceVendor'] = parts[1];
      obj['DeviceProduct'] = parts[2];
      obj['DeviceVersion'] = parts[3];
      obj['EventID'] = parts[4];
      if (parts.length > 5) {
        const ext = parts.slice(5).join('|');
        const delimiter = ext.includes('\t') ? '\t' : '\t';
        for (const pair of ext.split(delimiter)) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx > 0) obj[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
    }
    return obj;
  }).filter((obj) => Object.keys(obj).length > 0);
}

// Parse syslog lines into structured objects
function parseSyslog(content: string): Array<Record<string, unknown>> {
  return content.trim().split('\n').filter(Boolean).map((line) => {
    const obj: Record<string, unknown> = { _raw: line };
    // RFC 3164: <priority>timestamp hostname process[pid]: message
    const rfc3164 = line.match(/^(?:<(\d+)>)?(\w{3}\s+\d+\s+\d+:\d+:\d+)\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s*(.*)/);
    if (rfc3164) {
      if (rfc3164[1]) obj['Priority'] = parseInt(rfc3164[1], 10);
      obj['Timestamp'] = rfc3164[2];
      obj['Hostname'] = rfc3164[3];
      obj['Program'] = rfc3164[4];
      if (rfc3164[5]) obj['PID'] = parseInt(rfc3164[5], 10);
      obj['Message'] = rfc3164[6];
      // Calculate facility and severity from priority
      if (rfc3164[1]) {
        const pri = parseInt(rfc3164[1], 10);
        obj['Facility'] = Math.floor(pri / 8);
        obj['Severity'] = pri % 8;
      }
    }
    // RFC 5424: <priority>version timestamp hostname app-name procid msgid structured-data msg
    const rfc5424 = line.match(/^<(\d+)>(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)/);
    if (rfc5424 && !rfc3164) {
      obj['Priority'] = parseInt(rfc5424[1], 10);
      obj['Version'] = parseInt(rfc5424[2], 10);
      obj['Timestamp'] = rfc5424[3];
      obj['Hostname'] = rfc5424[4];
      obj['AppName'] = rfc5424[5];
      obj['ProcID'] = rfc5424[6];
      obj['MsgID'] = rfc5424[7];
      obj['Message'] = rfc5424[8];
    }
    return obj;
  }).filter((obj) => Object.keys(obj).length > 1); // Must have more than just _raw
}

// Main parse function
function parseContent(content: string, format: ParsedSample['format']): Array<Record<string, unknown>> {
  switch (format) {
    case 'json': return parseJson(content);
    case 'ndjson': return parseNdjson(content);
    case 'csv': return parseCsv(content);
    case 'kv': return parseKv(content);
    case 'cef': return parseCef(content);
    case 'leef': return parseLeef(content);
    case 'syslog': return parseSyslog(content);
    default: {
      // Try each parser in order
      for (const parser of [parseJson, parseNdjson, parseCef, parseLeef, parseKv, parseCsv, parseSyslog]) {
        try {
          const result = parser(content);
          if (result.length > 0 && Object.keys(result[0]).length > 1) return result;
        } catch { continue; }
      }
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Vendor Output Feed Config Parser
// ---------------------------------------------------------------------------

function parseVendorFeedConfig(configText: string): VendorFeedConfig {
  const result: VendorFeedConfig = {
    vendor: 'unknown', feedType: 'unknown', format: 'unknown',
    fields: [], transportProtocol: '', port: 0, rawConfig: configText,
  };

  const lower = configText.toLowerCase();

  // Zscaler NSS feed configuration
  // Supports multiple formats:
  //   1. Admin portal format: %s{datetime},%s{cloudname},%s{host},%d{action},...
  //   2. Feed output definition: Fields: datetime,cloudname,host,serverip,...
  //   3. NSS config text: nss_type=web, fields=datetime,cloudname,...
  if (lower.includes('zscaler') || lower.includes('nss') || lower.includes('%s{') || lower.includes('%d{')) {
    result.vendor = 'Zscaler';
    result.format = 'csv';

    // Detect feed type from content
    if (lower.includes('nss for web') || lower.includes('nss_type=web') || lower.includes('weblog')) {
      result.feedType = 'nss_web';
    } else if (lower.includes('nss for firewall') || lower.includes('nss_type=firewall') || lower.includes('fwlog')) {
      result.feedType = 'nss_firewall';
    } else if (lower.includes('nss for dns') || lower.includes('nss_type=dns') || lower.includes('dnslog')) {
      result.feedType = 'nss_dns';
    } else if (lower.includes('nss for tunnel') || lower.includes('nss_type=tunnel')) {
      result.feedType = 'nss_tunnel';
    } else {
      result.feedType = 'nss';
    }

    // Extract field names from format string patterns
    // Pattern 1: %s{fieldname}, %d{fieldname}, %02d{fieldname}
    const formatFields = configText.match(/%[sd]\d*\{([^}]+)\}/g);
    if (formatFields && formatFields.length > 0) {
      result.fields = formatFields.map((f) => {
        const m = f.match(/\{([^}]+)\}/);
        return m ? m[1] : f;
      });
    }

    // Pattern 2: Fields: field1,field2,field3 or fields=field1,field2
    if (result.fields.length === 0) {
      const fieldsMatch = configText.match(/[Ff]ields[=:]\s*(.+)/);
      if (fieldsMatch) {
        result.fields = fieldsMatch[1].split(',').map((f) => f.trim()).filter(Boolean);
      }
    }

    // Pattern 3: Comma-separated field list on a single line (bare field names)
    if (result.fields.length === 0) {
      const lines = configText.trim().split('\n');
      for (const line of lines) {
        const parts = line.split(',').map((p) => p.trim());
        if (parts.length >= 5 && parts.every((p) => /^[a-zA-Z_]\w*$/.test(p))) {
          result.fields = parts;
          break;
        }
      }
    }

    result.transportProtocol = lower.includes('tcp') ? 'TCP' : lower.includes('https') ? 'HTTPS' : 'TCP';
    const portMatch = configText.match(/port[=:\s]+(\d+)/i);
    if (portMatch) result.port = parseInt(portMatch[1], 10);
  }

  // Palo Alto syslog forwarding profile
  else if (lower.includes('syslog-server-profile') || lower.includes('pan-os') || lower.includes('paloalto')) {
    result.vendor = 'Palo Alto';
    result.feedType = 'syslog_forwarding';
    const serverMatch = configText.match(/server\s+(\S+)/);
    const portMatch = configText.match(/port\s+(\d+)/);
    const protoMatch = configText.match(/transport\s+(TCP|UDP|SSL)/i);
    const formatMatch = configText.match(/format\s+(BSD|IETF)/i);
    if (portMatch) result.port = parseInt(portMatch[1], 10);
    if (protoMatch) result.transportProtocol = protoMatch[1].toUpperCase();
    if (formatMatch) result.format = formatMatch[1].toUpperCase() === 'BSD' ? 'syslog_bsd' : 'syslog_ietf';
    else result.format = 'syslog';
    // Extract log types from config
    const logTypes = configText.match(/(traffic|threat|url|data|wildfire|tunnel|auth|sctp|decryption|gtp|hip-match)/gi);
    if (logTypes) result.fields = [...new Set(logTypes.map((t) => t.toLowerCase()))];
  }

  // FortiGate syslog config
  else if (lower.includes('config log syslogd') || lower.includes('fortigate') || lower.includes('fortinet')) {
    result.vendor = 'Fortinet';
    result.feedType = 'syslog_forwarding';
    result.format = 'kv';
    const portMatch = configText.match(/port\s+(\d+)/i);
    if (portMatch) result.port = parseInt(portMatch[1], 10);
    const protoMatch = configText.match(/(tcp|udp)/i);
    if (protoMatch) result.transportProtocol = protoMatch[1].toUpperCase();
    const filterMatch = configText.match(/filter\s+"([^"]+)"/);
    if (filterMatch) result.fields = filterMatch[1].split(/\s+/);
  }

  // Cloudflare Logpush job config (JSON)
  else if (lower.includes('logpush') || lower.includes('cloudflare') || lower.includes('dataset')) {
    result.vendor = 'Cloudflare';
    result.feedType = 'logpush';
    try {
      const parsed = JSON.parse(configText);
      if (parsed.dataset) result.fields = [parsed.dataset];
      if (parsed.logpull_options) {
        const fieldsMatch = parsed.logpull_options.match(/fields=([^&]+)/);
        if (fieldsMatch) result.fields = fieldsMatch[1].split(',');
      }
      if (parsed.destination_conf) {
        if (parsed.destination_conf.includes('https://')) result.transportProtocol = 'HTTPS';
      }
      result.format = 'ndjson';
    } catch {
      // Not JSON, try extracting fields from text
      const fieldsMatch = configText.match(/fields[=:]\s*"?([^"&\n]+)/i);
      if (fieldsMatch) result.fields = fieldsMatch[1].split(',').map((f) => f.trim());
    }
  }

  // CrowdStrike SIEM Connector / Event Streams
  else if (lower.includes('crowdstrike') || lower.includes('falcon') || lower.includes('event_streams')) {
    result.vendor = 'CrowdStrike';
    result.feedType = 'event_stream';
    result.format = 'json';
    result.transportProtocol = 'HTTPS';
    const eventTypes = configText.match(/(DetectionSummary|AuthActivity|RemoteResponse|UserActivity|IncidentSummary)/gi);
    if (eventTypes) result.fields = [...new Set(eventTypes)];
  }

  // Generic syslog config
  else if (lower.includes('syslog') || lower.includes('rsyslog') || lower.includes('syslog-ng')) {
    result.vendor = 'generic';
    result.feedType = 'syslog_forwarding';
    result.format = 'syslog';
    const portMatch = configText.match(/port[=:\s]+(\d+)/i);
    if (portMatch) result.port = parseInt(portMatch[1], 10);
    const protoMatch = configText.match(/(tcp|udp|tls)/i);
    if (protoMatch) result.transportProtocol = protoMatch[1].toUpperCase();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Parse a file or pasted content and return discovered fields
export function parseSampleContent(
  content: string,
  sourceName: string = 'pasted',
): ParsedSample {
  const errors: string[] = [];
  let format = detectFormat(content);
  let events: Array<Record<string, unknown>> = [];

  try {
    events = parseContent(content, format);
  } catch (err) {
    errors.push(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (events.length === 0 && errors.length === 0) {
    errors.push('Could not parse any events from the provided content');
  }

  // Cribl capture detection: if events are NDJSON with a _raw field containing
  // structured vendor data, parse the INNER format from _raw. This is the standard
  // format when users capture samples from Cribl sources.
  // The _raw field contains the actual vendor log line (CEF, CSV, KV, JSON, syslog).
  if ((format === 'ndjson' || format === 'json') && events.length > 0 && events[0]._raw !== undefined) {
    const rawValues = events.map((e) => String(e._raw || '')).filter(Boolean);
    if (rawValues.length > 0) {
      const innerFormat = detectInnerRawFormat(rawValues);
      if (innerFormat && innerFormat !== 'unknown') {
        // Re-parse using the _raw content directly to discover vendor fields
        const rawContent = rawValues.join('\n');
        let innerEvents: Array<Record<string, unknown>> = [];
        try {
          innerEvents = parseContent(rawContent, innerFormat);
        } catch { /* fall back to outer parse */ }

        if (innerEvents.length > 0 && Object.keys(innerEvents[0]).length > 1) {
          // Inner parse succeeded -- use vendor fields instead of wrapper fields
          events = innerEvents;
          format = innerFormat;
        }
      }
    }
  }

  const fields = collectFields(events);
  const timestampField = guessTimestampField(fields);

  // Keep first 200 raw events for pack sample data
  const rawEvents = events.slice(0, 200).map((e) => JSON.stringify(e));

  return {
    format,
    eventCount: events.length,
    fields,
    rawEvents,
    sourceName,
    timestampField,
    errors,
  };
}

// Detect the format of vendor data inside _raw fields from Cribl captures.
// Inspects the first few _raw values to determine CEF, CSV, KV, JSON, etc.
function detectInnerRawFormat(rawValues: string[]): ParsedSample['format'] {
  // Sample a few _raw values for detection
  const samples = rawValues.slice(0, 5);

  for (const raw of samples) {
    // CEF: contains 'CEF:' prefix (may have syslog header before it)
    if (raw.includes('CEF:')) return 'cef';
    // LEEF: contains 'LEEF:' prefix
    if (raw.includes('LEEF:')) return 'leef';
  }

  // Check first sample for other formats
  const first = samples[0] || '';

  // JSON: starts with { (nested JSON in _raw)
  if (first.trim().startsWith('{')) {
    try { JSON.parse(first); return 'ndjson'; } catch { /* not JSON */ }
  }

  // CSV: has 5+ comma-separated fields (PAN-OS syslog, generic CSV)
  // Strip syslog header first if present
  const csvCandidate = stripSyslogPrefix(first);
  const commaCount = (csvCandidate.match(/,/g) || []).length;
  if (commaCount >= 5) return 'csv';

  // Key=Value: has 3+ key=value pairs separated by spaces
  const kvPairs = first.split(/\s+/).filter((p) => p.includes('='));
  if (kvPairs.length >= 3) return 'kv';

  // Syslog: starts with priority or timestamp
  if (/^<\d+>/.test(first) || /^\w{3}\s+\d+\s+\d+:\d+:\d+/.test(first)) return 'syslog';

  return 'unknown';
}

// Strip syslog prefix from a line to get to the actual data content.
// Handles common syslog formats:
//   - RFC 3164: "Jan  1 12:00:00 hostname "
//   - RFC 5424: "<14>1 2024-01-01T12:00:00Z hostname app - - "
//   - Simple: "Apr 08 12:45:16 PA-VM "
function stripSyslogPrefix(line: string): string {
  // Try RFC 5424: <priority>version timestamp hostname app procid msgid
  const rfc5424 = line.match(/^<\d+>\d+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)/);
  if (rfc5424) return rfc5424[1];

  // Try RFC 3164: timestamp hostname
  const rfc3164 = line.match(/^\w{3}\s+\d+\s+\d+:\d+:\d+\s+\S+\s+(.*)/);
  if (rfc3164) return rfc3164[1];

  // Try simple: just strip leading non-data prefix before first digit-comma pattern
  // PAN-OS: "Apr 08 12:45:16 PA-VM 1,2020/05/07,..." -> starts at "1,2020..."
  const panOsMatch = line.match(/(\d+,\d{4}\/\d{2}\/\d{2}.*)/);
  if (panOsMatch) return panOsMatch[1];

  return line;
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerSampleParserHandlers(ipcMain: IpcMain) {
  // Parse pasted content
  ipcMain.handle('samples:parse-content', async (_event, {
    content, sourceName,
  }: { content: string; sourceName?: string }) => {
    return parseSampleContent(content, sourceName || 'pasted');
  });

  // Open file dialog and parse selected file(s)
  ipcMain.handle('samples:parse-files', async (event) => {
    const result = await dialog.showOpenDialog({
      title: 'Select Sample Log Files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Log Files', extensions: ['json', 'log', 'txt', 'csv', 'xml', 'ndjson'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) return [];

    const parsed: ParsedSample[] = [];
    for (const filePath of result.filePaths) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const fileName = path.basename(filePath);
        parsed.push(parseSampleContent(content, fileName));
      } catch (err) {
        parsed.push({
          format: 'unknown', eventCount: 0, fields: [], rawEvents: [],
          sourceName: path.basename(filePath), timestampField: '',
          errors: [`Failed to read file: ${err instanceof Error ? err.message : String(err)}`],
        });
      }
    }

    return parsed;
  });

  // Parse vendor output feed configuration text
  ipcMain.handle('samples:parse-feed-config', async (_event, { configText }: { configText: string }) => {
    return parseVendorFeedConfig(configText);
  });

  // Parse CSV content with externally-provided headers (for headerless CSV files)
  ipcMain.handle('samples:parse-csv-with-headers', async (_event, {
    csvContent, headers, skipFirstRow,
  }: { csvContent: string; headers: string[]; skipFirstRow: boolean }) => {
    return parseCsvWithHeaders(csvContent, headers, skipFirstRow);
  });

  // Store tagged sample data: user associates sample content with a vendor + log type
  // This is used during pack building to create per-logtype pipelines
  const taggedSamples = new Map<string, Array<{
    vendor: string;
    logType: string;
    parsed: ParsedSample;
  }>>();

  ipcMain.handle('samples:tag-sample', async (_event, {
    vendor, logType, content, sourceName,
  }: { vendor: string; logType: string; content: string; sourceName?: string }) => {
    const parsed = parseSampleContent(content, sourceName || `${vendor}_${logType}`);
    const key = vendor.toLowerCase();
    if (!taggedSamples.has(key)) taggedSamples.set(key, []);
    // Replace existing logType entry or add new
    const existing = taggedSamples.get(key)!;
    const idx = existing.findIndex((s) => s.logType === logType);
    const entry = { vendor, logType, parsed };
    if (idx >= 0) {
      existing[idx] = entry;
    } else {
      existing.push(entry);
    }
    return {
      vendor, logType,
      format: parsed.format,
      eventCount: parsed.eventCount,
      fieldCount: parsed.fields.length,
      timestampField: parsed.timestampField,
      errors: parsed.errors,
    };
  });

  // Get all tagged samples for a vendor
  ipcMain.handle('samples:get-tagged', async (_event, { vendor }: { vendor: string }) => {
    const key = vendor.toLowerCase();
    const samples = taggedSamples.get(key) || [];
    return samples.map((s) => ({
      vendor: s.vendor,
      logType: s.logType,
      format: s.parsed.format,
      eventCount: s.parsed.eventCount,
      fieldCount: s.parsed.fields.length,
      fields: s.parsed.fields,
      rawEvents: s.parsed.rawEvents,
      timestampField: s.parsed.timestampField,
    }));
  });

  // List all vendors with tagged samples
  ipcMain.handle('samples:list-tagged-vendors', async () => {
    const result: Array<{ vendor: string; logTypes: string[]; totalEvents: number }> = [];
    for (const [, samples] of taggedSamples) {
      if (samples.length === 0) continue;
      result.push({
        vendor: samples[0].vendor,
        logTypes: samples.map((s) => s.logType),
        totalEvents: samples.reduce((sum, s) => sum + s.parsed.eventCount, 0),
      });
    }
    return result;
  });

  // Auto-detect log types from captured/pasted data (best effort)
  // Looks for common discriminator fields to split events into log types
  ipcMain.handle('samples:auto-detect-types', async (_event, { content }: { content: string }) => {
    const parsed = parseSampleContent(content, 'auto-detect');
    if (parsed.eventCount === 0) return { logTypes: [], error: 'No events parsed' };

    // Try to find a discriminator field
    const discriminators = ['event_simpleName', 'type', 'Type', 'subtype',
      'eventType', 'EventType', 'log_type', 'logType', 'category', 'sourcetype',
      'action', 'Activity', 'DeviceEventClassID', 'dataset'];

    let bestField = '';
    let bestValues = new Set<string>();

    for (const field of discriminators) {
      const f = parsed.fields.find((pf) => pf.name === field);
      if (f && f.sampleValues.length > 0) {
        const values = new Set(f.sampleValues);
        if (values.size > 1 || (values.size === 1 && parsed.fields.length > 5)) {
          // Good discriminator -- has multiple values or is a known type field
          if (values.size >= bestValues.size) {
            bestField = field;
            bestValues = values;
          }
        }
      }
    }

    if (!bestField) {
      // No clear discriminator -- treat all events as one log type
      return {
        logTypes: [{ name: 'default', eventCount: parsed.eventCount, discriminator: '', value: '' }],
        discriminatorField: '',
      };
    }

    return {
      logTypes: Array.from(bestValues).map((v) => ({
        name: String(v).replace(/[^a-zA-Z0-9_]/g, '_'),
        eventCount: parsed.rawEvents.filter((re) => {
          try { return JSON.parse(re)[bestField] === v; } catch { return false; }
        }).length,
        discriminator: bestField,
        value: v,
      })),
      discriminatorField: bestField,
    };
  });
}
