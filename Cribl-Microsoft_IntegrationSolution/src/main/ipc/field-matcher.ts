// Field Auto-Matching Engine
// Given a set of source fields (from sample data or vendor logs) and a set of
// destination fields (from DCR schema), automatically maps every source field
// to its best destination match using multiple matching strategies.
//
// Matching priority:
//   1. Exact name match (case-sensitive)
//   2. Case-insensitive match
//   3. Known abbreviation/alias lookup (src->SourceIP, dst->DestinationIP, etc.)
//   4. Normalized name match (strip underscores, lowercase, compare)
//   5. Substring/prefix/suffix match with scoring
//   6. Vendor-specific mapping overrides (from vendor-research fieldMappings)
//
// Unmatched source fields are flagged for user review.
// Unmatched dest fields are shown as optional.

import { IpcMain } from 'electron';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceField {
  name: string;
  type: string;
  sampleValue?: string;
}

export interface DestField {
  name: string;
  type: string;
}

export type MatchConfidence = 'exact' | 'alias' | 'fuzzy' | 'unmatched';
export type MatchAction = 'rename' | 'keep' | 'coerce' | 'drop' | 'overflow';

export interface FieldMatch {
  sourceName: string;
  sourceType: string;
  destName: string;
  destType: string;
  confidence: MatchConfidence;
  action: MatchAction;
  needsCoercion: boolean;     // sourceType != destType
  description: string;        // Why this match was chosen
  sampleValue?: string;
}

export interface OverflowConfig {
  enabled: boolean;
  fieldName: string;          // Destination field to collect overflow into (e.g., "AdditionalExtensions")
  fieldType: 'dynamic' | 'string';  // dynamic = JSON object, string = key=value pairs
  sourceFields: string[];     // Source field names that go into overflow
}

export interface MatchResult {
  matched: FieldMatch[];      // Source fields matched to a dedicated dest field
  overflow: FieldMatch[];     // Source fields collected into the overflow field
  unmatchedSource: SourceField[];  // Source fields with no match and no overflow (dropped)
  unmatchedDest: DestField[];     // Dest fields with no source match
  overflowConfig: OverflowConfig;
  totalSource: number;
  totalDest: number;
  matchRate: number;          // 0-1, percentage of source fields matched or overflowed
}

// ---------------------------------------------------------------------------
// Known Abbreviation / Alias Table
// Maps common short source field names to their standard long destination names.
// This is the core intelligence that handles the src->SourceIP type mappings.
// ---------------------------------------------------------------------------

const ALIAS_TABLE: Record<string, string[]> = {
  // IP addresses
  src: ['SourceIP', 'SourceAddress', 'SrcAddr', 'src_ip', 'srcip'],
  dst: ['DestinationIP', 'DestinationAddress', 'DstAddr', 'dst_ip', 'dstip'],
  srcip: ['SourceIP', 'SourceAddress'],
  dstip: ['DestinationIP', 'DestinationAddress'],
  src_ip: ['SourceIP'],
  dst_ip: ['DestinationIP'],
  natsrc: ['SourceTranslatedAddress', 'NATSourceIP'],
  natdst: ['DestinationTranslatedAddress', 'NATDestinationIP'],
  ClientIP: ['SourceIP', 'ClientIP'],
  OriginIP: ['DestinationIP', 'OriginIP'],
  ip: ['SourceIP'],
  ipaddr: ['SourceIP'],

  // Ports
  sport: ['SourcePort', 'src_port'],
  dport: ['DestinationPort', 'dst_port'],
  srcport: ['SourcePort'],
  dstport: ['DestinationPort'],
  src_port: ['SourcePort'],
  dst_port: ['DestinationPort'],
  natsport: ['SourceTranslatedPort'],
  natdport: ['DestinationTranslatedPort'],

  // Users
  srcuser: ['SourceUserName', 'SourceUser', 'src_user'],
  dstuser: ['DestinationUserName', 'DestinationUser', 'dst_user'],
  user: ['SourceUserName', 'UserName'],
  username: ['SourceUserName', 'UserName'],
  account: ['SourceUserName', 'AccountName'],

  // Network
  proto: ['Protocol', 'NetworkProtocol', 'IPProtocol'],
  app: ['ApplicationProtocol', 'Application', 'AppName'],
  service: ['DestinationServiceName', 'Service'],
  action: ['DeviceAction', 'Action', 'EventAction'],
  rule: ['RuleName', 'SecurityRule'],

  // Zones / Interfaces
  from: ['SourceZone', 'FromZone', 'InboundZone'],
  to: ['DestinationZone', 'ToZone', 'OutboundZone'],
  inbound_if: ['InboundInterface', 'SourceInterface'],
  outbound_if: ['OutboundInterface', 'DestinationInterface'],
  srcintf: ['InboundInterface', 'SourceInterface'],
  dstintf: ['OutboundInterface', 'DestinationInterface'],

  // Bytes / Packets
  bytes_sent: ['SentBytes', 'BytesSent', 'OutBytes'],
  bytes_received: ['ReceivedBytes', 'BytesReceived', 'InBytes'],
  sentbyte: ['SentBytes'],
  rcvdbyte: ['ReceivedBytes'],
  out: ['SentBytes'],          // CEF standard: outbound bytes
  // Note: 'in' is a JS reserved word -- handled via overflow guard, not alias
  packets_sent: ['SentPackets', 'PacketsSent'],
  packets_received: ['ReceivedPackets', 'PacketsReceived'],
  elapsed: ['Duration', 'SessionDuration'],
  duration: ['Duration', 'SessionDuration'],

  // Timestamps
  receive_time: ['TimeGenerated', 'ReceiveTime', 'EventTime'],
  start_time: ['StartTime', 'SessionStartTime'],
  generated_time: ['TimeGenerated'],
  event_time: ['EventTime', 'TimeGenerated'],
  timestamp: ['TimeGenerated', 'EventTime'],
  Timestamp: ['TimeGenerated'],
  Datetime: ['TimeGenerated'],
  EdgeStartTimestamp: ['TimeGenerated'],
  published: ['TimeGenerated'],
  createdDateTime: ['TimeGenerated'],
  date: ['TimeGenerated'],
  time: ['TimeGenerated'],

  // Device / Host
  serial: ['DeviceName', 'DeviceSerialNumber'],
  device_name: ['DeviceName', 'Computer'],
  hostname: ['Computer', 'HostName', 'DeviceName'],
  host_name: ['Computer', 'HostName'],
  HostName: ['Computer', 'HostName'],
  Computer: ['Computer'],
  dvchost: ['DeviceName'],

  // Severity
  severity: ['LogSeverity', 'SeverityLevel', 'Severity'],
  LogSeverity: ['LogSeverity'],
  level: ['SeverityLevel', 'LogSeverity'],
  priority: ['LogSeverity', 'Priority'],

  // Threat / Security
  threatid: ['DeviceEventClassID', 'ThreatID', 'SignatureID'],
  threat_name: ['Activity', 'ThreatName'],
  subtype: ['Activity', 'EventSubType'],
  type: ['DeviceEventClassID', 'EventType', 'Type'],
  category: ['DeviceEventCategory', 'Category', 'URLCategory'],
  thr_category: ['ThreatCategory'],
  misc: ['RequestURL', 'AdditionalInfo'],
  direction: ['CommunicationDirection'],
  filedigest: ['FileHash', 'SHA256'],
  filename: ['FileName'],
  url: ['RequestURL', 'DestinationURL'],

  // Session
  sessionid: ['SessionID', 'ExternalID'],
  repeatcnt: ['EventCount', 'RepeatCount'],
  vsys: ['VirtualSystem'],

  // CEF standard header fields
  DeviceVendor: ['DeviceVendor'],
  DeviceProduct: ['DeviceProduct'],
  DeviceVersion: ['DeviceVersion'],
  DeviceEventClassID: ['DeviceEventClassID'],
  Name: ['Activity'],
  act: ['DeviceAction'],
  rt: ['ReceiptTime'],
  start: ['StartTime'],
  end: ['EndTime'],
  request: ['RequestURL'],
  requestMethod: ['RequestMethod'],
  requestContext: ['RequestContext'],
  requestClientApplication: ['RequestClientApplication'],
  msg: ['Message', 'SyslogMessage'],
  externalId: ['ExternalID'],
  spt: ['SourcePort'],
  dpt: ['DestinationPort'],
  cnt: ['EventCount'],
  fname: ['FileName'],

  // CEF custom string/number fields -- standard abbreviations AND long-form variations.
  // csN -> DeviceCustomStringN, cnN -> DeviceCustomNumberN
  // Also handles: customstring1, CustomString1, custom_string_1, etc.
  cs1: ['DeviceCustomString1'],
  cs1Label: ['DeviceCustomString1Label'],
  customstring1: ['DeviceCustomString1'],
  CustomString1: ['DeviceCustomString1'],
  custom_string_1: ['DeviceCustomString1'],
  cs2: ['DeviceCustomString2'],
  cs2Label: ['DeviceCustomString2Label'],
  customstring2: ['DeviceCustomString2'],
  CustomString2: ['DeviceCustomString2'],
  custom_string_2: ['DeviceCustomString2'],
  cs3: ['DeviceCustomString3'],
  cs3Label: ['DeviceCustomString3Label'],
  customstring3: ['DeviceCustomString3'],
  cs4: ['DeviceCustomString4'],
  cs4Label: ['DeviceCustomString4Label'],
  customstring4: ['DeviceCustomString4'],
  cs5: ['DeviceCustomString5'],
  cs5Label: ['DeviceCustomString5Label'],
  customstring5: ['DeviceCustomString5'],
  cs6: ['DeviceCustomString6'],
  cs6Label: ['DeviceCustomString6Label'],
  customstring6: ['DeviceCustomString6'],
  cn1: ['DeviceCustomNumber1'],
  cn1Label: ['DeviceCustomNumber1Label'],
  customnumber1: ['DeviceCustomNumber1'],
  CustomNumber1: ['DeviceCustomNumber1'],
  custom_number_1: ['DeviceCustomNumber1'],
  cn2: ['DeviceCustomNumber2'],
  cn2Label: ['DeviceCustomNumber2Label'],
  customnumber2: ['DeviceCustomNumber2'],
  CustomNumber2: ['DeviceCustomNumber2'],
  custom_number_2: ['DeviceCustomNumber2'],
  cn3: ['DeviceCustomNumber3'],
  cn3Label: ['DeviceCustomNumber3Label'],
  customnumber3: ['DeviceCustomNumber3'],
  c6a1: ['DeviceCustomIPv6Address1'],
  c6a1Label: ['DeviceCustomIPv6Address1Label'],
  c6a2: ['DeviceCustomIPv6Address2'],
  c6a2Label: ['DeviceCustomIPv6Address2Label'],
  c6a3: ['DeviceCustomIPv6Address3'],
  c6a3Label: ['DeviceCustomIPv6Address3Label'],
  cfp1: ['DeviceCustomFloatingPoint1'],
  cfp1Label: ['DeviceCustomFloatingPoint1Label'],
  cfp2: ['DeviceCustomFloatingPoint2'],
  cfp2Label: ['DeviceCustomFloatingPoint2Label'],
  cfp3: ['DeviceCustomFloatingPoint3'],
  cfp3Label: ['DeviceCustomFloatingPoint3Label'],
  cfp4: ['DeviceCustomFloatingPoint4'],
  cfp4Label: ['DeviceCustomFloatingPoint4Label'],
  flexString1: ['FlexString1'],
  flexString1Label: ['FlexString1Label'],
  flexString2: ['FlexString2'],
  flexString2Label: ['FlexString2Label'],
  flexDate1: ['FlexDate1'],
  flexDate1Label: ['FlexDate1Label'],

  // CEF address/host fields
  dvc: ['DeviceAddress'],
  duser: ['DestinationUserName'],
  suser: ['SourceUserName'],
  duid: ['DestinationUserID'],
  suid: ['SourceUserID'],
  dntdom: ['DestinationNTDomain'],
  sntdom: ['SourceNTDomain'],
  dhost: ['DestinationHostName'],
  shost: ['SourceHostName'],
  dmac: ['DestinationMACAddress'],
  smac: ['SourceMACAddress'],
  dpid: ['DestinationProcessId'],
  spid: ['SourceProcessId'],
  dproc: ['DestinationProcessName'],
  sproc: ['SourceProcessName'],
  cat: ['DeviceEventCategory'],
  outcome: ['EventOutcome'],
  sourceTranslatedAddress: ['SourceTranslatedAddress'],
  destinationTranslatedAddress: ['DestinationTranslatedAddress'],
  sourceTranslatedPort: ['SourceTranslatedPort'],
  destinationTranslatedPort: ['DestinationTranslatedPort'],
  deviceExternalId: ['DeviceExternalID'],
  deviceInboundInterface: ['DeviceInboundInterface'],
  deviceOutboundInterface: ['DeviceOutboundInterface'],
  deviceFacility: ['DeviceFacility'],

  // FortiGate specific (unique entries only -- srcip, dstip, etc. already defined above)
  policyid: ['PolicyID'],
  // msg already defined in CEF standard header section above
  attack: ['Activity', 'AttackName'],
  logid: ['DeviceEventClassID'],

  // Cloudflare specific
  RayID: ['ExternalID', 'RayID'],
  EdgeResponseStatus: ['EventOutcome', 'EdgeResponseStatus'],
  ClientRequestHost: ['DestinationHostName', 'ClientRequestHost'],
  ClientRequestURI: ['RequestURL', 'ClientRequestURI'],
  ClientRequestMethod: ['RequestMethod', 'ClientRequestMethod'],
  ClientRequestUserAgent: ['RequestClientApplication', 'ClientRequestUserAgent'],

  // CrowdStrike specific
  DetectId: ['ExternalID', 'DetectId'],
  SensorId: ['SensorId'],
  ComputerName: ['Computer', 'ComputerName'],
  CommandLine: ['ProcessCommandLine', 'CommandLine'],
  SHA256String: ['FileHash', 'SHA256String'],
  imageFileName: ['FilePath'],        // CrowdStrike image file path (NOT FileName)
  parentImageFileName: ['OldFilePath'],
  FalconHostLink: ['FalconHostLink'],

  // Okta specific
  uuid: ['ExternalID'],
  eventType: ['Activity', 'EventType'],
  displayMessage: ['Message', 'Activity'],
  // outcome already defined in CEF address/host section above
  actor: ['SourceUserName'],
};

// Build a reverse lookup: destName -> sourceNames[]
export const REVERSE_ALIAS: Map<string, Set<string>> = new Map();
for (const [source, dests] of Object.entries(ALIAS_TABLE)) {
  for (const dest of dests) {
    if (!REVERSE_ALIAS.has(dest.toLowerCase())) {
      REVERSE_ALIAS.set(dest.toLowerCase(), new Set());
    }
    REVERSE_ALIAS.get(dest.toLowerCase())!.add(source.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Overflow Field Configuration per Destination Table
// Maps Sentinel table names to their overflow/catch-all field.
// ---------------------------------------------------------------------------

const TABLE_OVERFLOW_FIELDS: Record<string, { fieldName: string; fieldType: 'dynamic' | 'string' }> = {
  // CEF-based tables use AdditionalExtensions (string, key=value format)
  CommonSecurityLog: { fieldName: 'AdditionalExtensions', fieldType: 'string' },
  // Syslog uses a dynamic field or message field
  Syslog: { fieldName: 'SyslogMessage', fieldType: 'string' },
  // Windows events use EventData (dynamic/JSON)
  WindowsEvent: { fieldName: 'EventData', fieldType: 'dynamic' },
  SecurityEvent: { fieldName: 'EventData', fieldType: 'dynamic' },
  // Azure Activity uses Properties (dynamic)
  AzureActivity: { fieldName: 'Properties', fieldType: 'dynamic' },
  // Custom tables typically use a dynamic column for extras
  // Default for any _CL table:
  _default_custom: { fieldName: 'AdditionalData_d', fieldType: 'dynamic' },
  // Specific vendor tables
  CloudflareV2_CL: { fieldName: 'AdditionalFields_d', fieldType: 'dynamic' },
};

// Get the overflow field config for a table
export function getOverflowConfig(tableName: string): { fieldName: string; fieldType: 'dynamic' | 'string' } {
  // Exact match
  if (TABLE_OVERFLOW_FIELDS[tableName]) return TABLE_OVERFLOW_FIELDS[tableName];
  // Custom table default
  if (tableName.endsWith('_CL')) return TABLE_OVERFLOW_FIELDS['_default_custom'];
  // Fallback
  return { fieldName: 'AdditionalExtensions', fieldType: 'string' };
}

// ---------------------------------------------------------------------------
// Event Type Pre-Classification (from Chronicle UDM pattern)
// ---------------------------------------------------------------------------
// Detects the event category from field co-occurrence, then boosts scores
// for mappings that are contextually appropriate for that event type.

type EventCategory = 'network' | 'authentication' | 'process' | 'file' | 'dns' | 'web' | 'firewall' | 'generic';

function classifyEventType(sourceFieldNames: string[]): EventCategory {
  const fields = new Set(sourceFieldNames.map((f) => f.toLowerCase()));
  // Order matters -- more specific categories first
  if ((fields.has('query') || fields.has('queryname') || fields.has('dnsquery')) &&
      (fields.has('answer') || fields.has('rcode') || fields.has('dnsresponsename'))) return 'dns';
  if ((fields.has('url') || fields.has('request') || fields.has('requesturl') || fields.has('uri')) &&
      (fields.has('requestmethod') || fields.has('method') || fields.has('useragent'))) return 'web';
  if ((fields.has('user') || fields.has('suser') || fields.has('duser') || fields.has('username')) &&
      (fields.has('logon') || fields.has('login') || fields.has('auth') || fields.has('authentication'))) return 'authentication';
  if (fields.has('src') && fields.has('dst') && (fields.has('proto') || fields.has('spt') || fields.has('dpt'))) return 'network';
  if (fields.has('act') || fields.has('action') || fields.has('deviceaction')) return 'firewall';
  if (fields.has('process') || fields.has('pid') || fields.has('commandline') || fields.has('image')) return 'process';
  if (fields.has('filename') || fields.has('filepath') || fields.has('fname')) return 'file';
  return 'generic';
}

// Boost scores for matches that are contextually appropriate for the event type
const EVENT_TYPE_BOOSTS: Record<EventCategory, Record<string, number>> = {
  network: { SourceIP: 5, DestinationIP: 5, SourcePort: 5, DestinationPort: 5, Protocol: 5, SentBytes: 3, ReceivedBytes: 3, Duration: 3 },
  firewall: { DeviceAction: 5, SourceIP: 3, DestinationIP: 3, Protocol: 3, DeviceEventClassID: 3 },
  authentication: { SourceUserName: 5, DestinationUserName: 5, EventOutcome: 5, LogSeverity: 3 },
  dns: { DestinationHostName: 5, RequestURL: 3, DeviceEventClassID: 3 },
  web: { RequestURL: 5, RequestMethod: 5, RequestClientApplication: 3, DestinationHostName: 3 },
  process: { ProcessCommandLine: 5, FilePath: 5, FileHash: 3 },
  file: { FileName: 5, FilePath: 5, FileHash: 3 },
  generic: {},
};

// ---------------------------------------------------------------------------
// Coalesce Priority Chains (from ASIM pattern)
// ---------------------------------------------------------------------------
// When multiple source fields could map to the same destination, prefer the
// highest-priority source. This prevents ambiguous situations where the first
// alphabetical source field claims the destination.

const COALESCE_PRIORITY: Record<string, string[]> = {
  // Timestamps: prefer specific fields over generic ones
  TimeGenerated: ['timestamp', 'Timestamp', 'event_time', 'EventTime', 'receive_time', 'generated_time', 'datetime', 'Datetime', 'time', 'date', 'rt'],
  ReceiptTime: ['rt', 'receive_time', 'ReceiveTime'],
  StartTime: ['start', 'start_time', 'StartTime', 'SessionStartTime'],
  // IPs: prefer standard CEF/syslog short names
  SourceIP: ['src', 'srcip', 'src_ip', 'SourceIP', 'ClientIP', 'ip'],
  DestinationIP: ['dst', 'dstip', 'dst_ip', 'DestinationIP', 'OriginIP'],
  // Ports: prefer standard CEF short names
  SourcePort: ['spt', 'sport', 'srcport', 'src_port', 'SourcePort'],
  DestinationPort: ['dpt', 'dport', 'dstport', 'dst_port', 'DestinationPort'],
  // Action/Protocol: prefer standard CEF
  DeviceAction: ['act', 'action', 'DeviceAction'],
  Protocol: ['proto', 'protocol', 'Protocol', 'app'],
  // Users
  SourceUserName: ['suser', 'srcuser', 'user', 'username', 'SourceUserName'],
  DestinationUserName: ['duser', 'dstuser', 'DestinationUserName'],
  // Device
  DeviceName: ['dvchost', 'serial', 'device_name', 'hostname', 'DeviceName'],
  FileName: ['fname', 'filename', 'FileName'],
};

// ---------------------------------------------------------------------------
// Type-Aware Sample Value Scoring (from OCSF/ECS pattern)
// ---------------------------------------------------------------------------
// When two source fields tie on name score, inspect the sample value to boost
// or penalize confidence. A source field whose sample value LOOKS LIKE an IP
// gets a boost when mapped to an IP-typed destination column.

function typeValueBoost(sampleValue: string | undefined, destName: string, destType: string): number {
  if (!sampleValue) return 0;

  const destLower = destName.toLowerCase();

  // IP address detection -> boost for IP destination fields
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(sampleValue) ||
      /^[0-9a-f:]{3,39}$/i.test(sampleValue)) { // IPv4 or IPv6
    if (destLower.includes('ip') || destLower.includes('address')) return 12;
  }

  // Port number detection (1-65535) -> boost for Port fields
  if (/^\d{1,5}$/.test(sampleValue) && Number(sampleValue) >= 1 && Number(sampleValue) <= 65535) {
    if (destLower.includes('port')) return 10;
  }

  // Timestamp detection -> boost for time/date fields
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(sampleValue) || /^\d{10,13}$/.test(sampleValue)) {
    if (destType === 'datetime' || destLower.includes('time') || destLower.includes('date')) return 12;
  }

  // URL detection -> boost for URL/Request fields
  if (/^https?:\/\//.test(sampleValue) || /^\/[a-zA-Z0-9]/.test(sampleValue)) {
    if (destLower.includes('url') || destLower.includes('request') || destLower.includes('uri')) return 10;
  }

  // MAC address -> boost for MAC fields
  if (/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(sampleValue)) {
    if (destLower.includes('mac')) return 12;
  }

  // Protocol name -> boost for Protocol field
  if (/^(TCP|UDP|ICMP|HTTP|HTTPS|DNS|SSH|TLS|SSL|FTP|SMTP|GRE|ESP)$/i.test(sampleValue)) {
    if (destLower.includes('protocol')) return 10;
  }

  // Action value -> boost for Action field
  if (/^(allow|deny|drop|block|permit|reject|reset|alert|pass|accept)$/i.test(sampleValue)) {
    if (destLower.includes('action')) return 10;
  }

  // Numeric severity -> boost for Severity field
  if (/^[0-9]$/.test(sampleValue) || /^(low|medium|high|critical|informational|warning)$/i.test(sampleValue)) {
    if (destLower.includes('severity') || destLower.includes('level') || destLower.includes('priority')) return 8;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Value Normalization Dictionaries (from ASIM/Chronicle pattern)
// ---------------------------------------------------------------------------
// Beyond field NAME mapping, normalize field VALUES to standard forms.
// Used by pack-builder to generate Eval expressions in the pipeline.

export const VALUE_NORMALIZATIONS: Record<string, Record<string, string>> = {
  DeviceAction: {
    allow: 'Allow', permit: 'Allow', accept: 'Allow', pass: 'Allow', allowed: 'Allow',
    deny: 'Deny', block: 'Deny', drop: 'Deny', reject: 'Deny', denied: 'Deny',
    blocked: 'Deny', dropped: 'Deny', rejected: 'Deny', refused: 'Deny',
    reset: 'Reset', 'reset-both': 'Reset', 'reset-client': 'Reset', 'reset-server': 'Reset',
    alert: 'Alert', warn: 'Alert', warning: 'Alert',
  },
  LogSeverity: {
    critical: '10', crit: '10', emergency: '10', emerg: '10',
    high: '8', alert: '8', error: '8', err: '8',
    medium: '5', warning: '5', warn: '5',
    low: '3', notice: '3', info: '1', informational: '1', information: '1',
    debug: '0', trace: '0',
  },
  Protocol: {
    tcp: 'TCP', udp: 'UDP', icmp: 'ICMP', igmp: 'IGMP',
    http: 'HTTP', https: 'HTTPS', dns: 'DNS',
    ssh: 'SSH', ftp: 'FTP', smtp: 'SMTP', tls: 'TLS', ssl: 'SSL',
    gre: 'GRE', esp: 'ESP', ah: 'AH',
    '6': 'TCP', '17': 'UDP', '1': 'ICMP', '47': 'GRE', '50': 'ESP',
  },
  EventOutcome: {
    success: 'Success', successful: 'Success', ok: 'Success', passed: 'Success',
    failure: 'Failure', failed: 'Failure', fail: 'Failure', error: 'Failure',
    unknown: 'Unknown', na: 'NA', partial: 'Partial',
  },
  CommunicationDirection: {
    inbound: 'Inbound', ingress: 'Inbound', incoming: 'Inbound',
    outbound: 'Outbound', egress: 'Outbound', outgoing: 'Outbound',
    lateral: 'Lateral', internal: 'Lateral',
  },
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalize(name: string): string {
  return name
    .replace(/[_\-\s]/g, '')    // Strip separators
    .replace(/([a-z])([A-Z])/g, '$1$2')  // Keep camelCase intact for comparison
    .toLowerCase();
}

// Strip common prefixes/suffixes for fuzzy matching
function stripAffixes(name: string): string {
  return name
    .replace(/^(source|src|dest|destination|dst|device|event|client|origin|edge|network)/i, '')
    .replace(/(name|value|address|field|string|number|label|id)$/i, '')
    .toLowerCase()
    .replace(/[_\-]/g, '');
}

// ---------------------------------------------------------------------------
// Matching Engine
// ---------------------------------------------------------------------------

function scoreMatch(sourceName: string, destName: string): { score: number; confidence: MatchConfidence; reason: string } {
  // 1. Exact match
  if (sourceName === destName) {
    return { score: 100, confidence: 'exact', reason: 'Exact name match' };
  }

  // 2. Case-insensitive match
  if (sourceName.toLowerCase() === destName.toLowerCase()) {
    return { score: 95, confidence: 'exact', reason: 'Case-insensitive match' };
  }

  // 3. Known alias lookup
  const aliases = ALIAS_TABLE[sourceName];
  if (aliases) {
    for (const alias of aliases) {
      if (alias.toLowerCase() === destName.toLowerCase()) {
        return { score: 90, confidence: 'alias', reason: `Known alias: ${sourceName} -> ${alias}` };
      }
    }
  }

  // Also check reverse: does this dest name expect this source name?
  const reverseSet = REVERSE_ALIAS.get(destName.toLowerCase());
  if (reverseSet && reverseSet.has(sourceName.toLowerCase())) {
    return { score: 88, confidence: 'alias', reason: `Reverse alias: ${destName} <- ${sourceName}` };
  }

  // 4. Normalized name match
  const normSrc = normalize(sourceName);
  const normDst = normalize(destName);
  if (normSrc === normDst) {
    return { score: 80, confidence: 'fuzzy', reason: 'Normalized name match (stripped separators)' };
  }

  // 5. Stripped affixes match
  const strippedSrc = stripAffixes(sourceName);
  const strippedDst = stripAffixes(destName);
  if (strippedSrc.length > 2 && strippedDst.length > 2 && strippedSrc === strippedDst) {
    return { score: 70, confidence: 'fuzzy', reason: 'Core name match after stripping prefixes/suffixes' };
  }

  // 6. Substring containment (lower confidence)
  // Guard: vendor-prefixed source fields (PanOS*, Fortinet*, Cisco*, etc.) should NOT
  // claim standard Sentinel columns via fuzzy substring match. This prevents
  // "PanOSIsNonStandardDestinationPort" from claiming "DestinationPort".
  const STANDARD_COLUMNS = new Set([
    'sourceip', 'destinationip', 'sourceport', 'destinationport', 'protocol',
    'deviceaction', 'timegenerated', 'applicationprotocol', 'logseverity',
    'activity', 'devicename', 'computer', 'sourceusername', 'destinationusername',
    'receipttime', 'starttime', 'endtime', 'requesturl', 'filename', 'message',
    'eventcount', 'externalid', 'deviceaddress', 'deviceeventclassid',
    'deviceeventcategory', 'communicationdirection', 'eventoutcome',
    'devicecustomstring1', 'devicecustomstring2', 'devicecustomstring3',
    'devicecustomstring4', 'devicecustomstring5', 'devicecustomstring6',
    'devicecustomnumber1', 'devicecustomnumber2', 'devicecustomnumber3',
  ]);
  const isVendorPrefixed = /^(PanOS|Fortinet|Forti|Cisco|Check|Zscaler|CrowdStrike|Barracuda|Sophos)/i.test(sourceName);
  const isStandardDest = STANDARD_COLUMNS.has(normDst);
  // Also block *Label fields from claiming non-Label columns (e.g., imageFileNameLabel -> FileName)
  const isLabelClaimingNonLabel = sourceName.endsWith('Label') && !destName.endsWith('Label');

  if ((!isVendorPrefixed && !isLabelClaimingNonLabel) || !isStandardDest) {
    if (normSrc.length > 3 && normDst.includes(normSrc)) {
      return { score: 55, confidence: 'fuzzy', reason: `Source name "${sourceName}" contained in dest "${destName}"` };
    }
    if (normDst.length > 3 && normSrc.includes(normDst)) {
      return { score: 50, confidence: 'fuzzy', reason: `Dest name "${destName}" contained in source "${sourceName}"` };
    }
  }

  return { score: 0, confidence: 'unmatched', reason: '' };
}

// Main matching function: match ALL source fields to dest fields
export function matchFields(
  sourceFields: SourceField[],
  destFields: DestField[],
  vendorMappings?: Array<{ sourceName: string; destName: string; sourceType: string; destType: string; action: string }>,
  destTableName?: string,
): MatchResult {
  const matched: FieldMatch[] = [];
  const usedDest = new Set<string>();
  const usedSource = new Set<string>();

  // Phase 0: Apply vendor-specific mappings first (highest priority)
  // Uses case-insensitive lookup for source fields because vendor research
  // field names may use different casing than the actual data (e.g.,
  // "LoginSessionId" in vendor docs vs "loginSessionId" in real FDR events).
  // The matched result always uses the ACTUAL source field name (src.name)
  // so that downstream rename rules reference the real field casing.
  if (vendorMappings) {
    for (const vm of vendorMappings) {
      if (vm.action === 'drop') continue;
      const src = sourceFields.find((s) => s.name === vm.sourceName)
        || sourceFields.find((s) => s.name.toLowerCase() === vm.sourceName.toLowerCase());
      const dst = destFields.find((d) => d.name === vm.destName)
        || destFields.find((d) => d.name.toLowerCase() === vm.destName.toLowerCase());
      if (src) {
        matched.push({
          sourceName: src.name,  // Use actual casing from source data
          sourceType: src.type || vm.sourceType,
          destName: dst?.name || vm.destName,  // Use actual casing from schema
          destType: dst?.type || vm.destType,
          confidence: 'exact',
          action: src.name === (dst?.name || vm.destName) ? 'keep' : 'rename',
          needsCoercion: (src.type || vm.sourceType) !== (dst?.type || vm.destType),
          description: `Vendor mapping: ${src.name} -> ${dst?.name || vm.destName}`,
          sampleValue: src.sampleValue,
        });
        usedSource.add(src.name);
        usedDest.add(dst?.name || vm.destName);
      }
    }
  }

  // Phase 0.5: Coalesce priority pre-assignment.
  // For key destination fields with multiple possible source mappings, prefer
  // the highest-priority source field that actually exists in the data.
  // This prevents lower-priority fields from claiming the destination first.
  const coalesceReserved = new Map<string, string>(); // destName -> reserved sourceName
  for (const [destName, priorities] of Object.entries(COALESCE_PRIORITY)) {
    if (usedDest.has(destName)) continue;
    for (const srcName of priorities) {
      const src = sourceFields.find((s) => s.name === srcName || s.name.toLowerCase() === srcName.toLowerCase());
      if (src && !usedSource.has(src.name)) {
        coalesceReserved.set(destName, src.name);
        break; // First match in priority order wins
      }
    }
  }

  // Classify event type for contextual score boosts
  const eventType = classifyEventType(sourceFields.map((s) => s.name));
  const eventBoosts = EVENT_TYPE_BOOSTS[eventType] || {};

  // Phase 1: Exact, alias, and fuzzy matches with type-aware + event-type boosts
  for (const src of sourceFields) {
    if (usedSource.has(src.name)) continue;

    let bestScore = 0;
    let bestDest: DestField | null = null;
    let bestReason = '';
    let bestConfidence: MatchConfidence = 'unmatched';

    for (const dst of destFields) {
      if (usedDest.has(dst.name)) continue;

      // If this dest has a coalesce reservation, only the reserved source can claim it
      const reserved = coalesceReserved.get(dst.name);
      if (reserved && reserved !== src.name) continue;

      const { score: nameScore, confidence, reason } = scoreMatch(src.name, dst.name);
      if (nameScore === 0) continue;

      // Add type-aware sample value boost (tiebreaker for ambiguous matches)
      const valueBoost = typeValueBoost(src.sampleValue, dst.name, dst.type);

      // Add event-type contextual boost
      const eventBoost = eventBoosts[dst.name] || 0;

      const totalScore = nameScore + valueBoost + eventBoost;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestDest = dst;
        bestReason = reason + (valueBoost > 0 ? ` [+${valueBoost} value match]` : '') +
                              (eventBoost > 0 ? ` [+${eventBoost} ${eventType} context]` : '');
        bestConfidence = confidence;
      }
    }

    // Only accept matches above threshold (50 base, boosts can help borderline)
    if (bestDest && bestScore >= 50) {
      const needsCoercion = src.type !== bestDest.type && src.type !== '' && bestDest.type !== '';
      matched.push({
        sourceName: src.name,
        sourceType: src.type,
        destName: bestDest.name,
        destType: bestDest.type,
        confidence: bestConfidence,
        action: src.name === bestDest.name ? (needsCoercion ? 'coerce' : 'keep') : 'rename',
        needsCoercion,
        description: bestReason,
        sampleValue: src.sampleValue,
      });
      usedSource.add(src.name);
      usedDest.add(bestDest.name);
    }
  }

  // Collect unmatched source fields
  const rawUnmatchedSource = sourceFields.filter((s) => !usedSource.has(s.name));
  const unmatchedDest = destFields.filter((d) => !usedDest.has(d.name));

  // Determine overflow configuration for the destination table.
  // Unmatched source fields go into the overflow field rather than being dropped,
  // so no vendor data is lost.
  const overflowDef = getOverflowConfig(destTableName || '');

  // Check if the overflow field exists in the destination schema
  const overflowFieldExists = destFields.some(
    (d) => d.name === overflowDef.fieldName
  );

  // Fields to skip from overflow (Cribl internals, metadata -- these get cleaned up separately)
  const skipOverflow = new Set([
    '_raw', '_time', 'source', 'host', 'port', 'index',
    'sourcetype', 'cribl_breaker', 'cribl_pipe',
  ]);

  const overflow: FieldMatch[] = [];
  const trueUnmatchedSource: SourceField[] = [];

  for (const src of rawUnmatchedSource) {
    // Skip Cribl internal / transport fields
    if (skipOverflow.has(src.name) || src.name.startsWith('__') || src.name.startsWith('cribl_')) {
      trueUnmatchedSource.push(src);
      continue;
    }

    // Route to overflow
    overflow.push({
      sourceName: src.name,
      sourceType: src.type,
      destName: overflowDef.fieldName,
      destType: overflowDef.fieldType,
      confidence: 'unmatched',
      action: 'overflow',
      needsCoercion: false,
      description: `Collected into ${overflowDef.fieldName} (no dedicated destination column)`,
      sampleValue: src.sampleValue,
    });
  }

  // Sort matched by confidence (exact first, then alias, then fuzzy)
  const confOrder: Record<MatchConfidence, number> = { exact: 0, alias: 1, fuzzy: 2, unmatched: 3 };
  matched.sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence]);

  const totalHandled = matched.length + overflow.length;

  return {
    matched,
    overflow,
    unmatchedSource: trueUnmatchedSource,
    unmatchedDest,
    overflowConfig: {
      enabled: overflow.length > 0 && overflowFieldExists,
      fieldName: overflowDef.fieldName,
      fieldType: overflowDef.fieldType,
      sourceFields: overflow.map((o) => o.sourceName),
    },
    totalSource: sourceFields.length,
    totalDest: destFields.length,
    matchRate: sourceFields.length > 0 ? totalHandled / sourceFields.length : 0,
  };
}

// Convenience: match source fields from a parsed sample against a DCR schema
export function matchSampleToSchema(
  sampleFields: Array<{ name: string; type: string; sampleValues?: string[] }>,
  schemaColumns: Array<{ name: string; type: string }>,
  vendorMappings?: Array<{ sourceName: string; destName: string; sourceType: string; destType: string; action: string }>,
  tableName?: string,
): MatchResult {
  const sourceFields: SourceField[] = sampleFields.map((f) => ({
    name: f.name,
    type: f.type,
    sampleValue: f.sampleValues?.[0],
  }));
  const destFields: DestField[] = schemaColumns.map((c) => ({
    name: c.name,
    type: c.type,
  }));
  return matchFields(sourceFields, destFields, vendorMappings, tableName);
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerFieldMatcherHandlers(ipcMain: IpcMain) {
  // Auto-match source fields to destination schema
  ipcMain.handle('fields:match', async (_event, {
    sourceFields, destFields, vendorMappings,
  }: {
    sourceFields: SourceField[];
    destFields: DestField[];
    vendorMappings?: Array<{ sourceName: string; destName: string; sourceType: string; destType: string; action: string }>;
  }) => {
    return matchFields(sourceFields, destFields, vendorMappings);
  });

  // Match a parsed sample against a DCR schema by table name
  ipcMain.handle('fields:match-to-schema', async (_event, {
    sampleFields, tableName, vendorMappings,
  }: {
    sampleFields: Array<{ name: string; type: string; sampleValues?: string[] }>;
    tableName: string;
    vendorMappings?: Array<{ sourceName: string; destName: string; sourceType: string; destType: string; action: string }>;
  }) => {
    // Load DCR schema for the table
    const { loadDcrTemplateSchemaPublic } = await import('./pack-builder');
    const schemaColumns = loadDcrTemplateSchemaPublic(tableName);
    if (schemaColumns.length === 0) {
      return {
        matched: [],
        overflow: [],
        unmatchedSource: sampleFields.map((f) => ({ name: f.name, type: f.type })),
        unmatchedDest: [],
        overflowConfig: { enabled: false, fieldName: '', fieldType: 'dynamic' as const, sourceFields: [] },
        totalSource: sampleFields.length, totalDest: 0, matchRate: 0,
      };
    }
    return matchSampleToSchema(sampleFields, schemaColumns, vendorMappings, tableName);
  });
}
