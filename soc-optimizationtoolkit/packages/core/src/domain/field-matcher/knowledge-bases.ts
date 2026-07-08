/**
 * field-matcher KNOWLEDGE BASES - porting-plan Unit 13 (ENG-04).
 *
 * Ported VERBATIM from legacy field-matcher.ts, then DELIBERATELY EXTENDED
 * (user request 2026-07-08, docs/ai-assisted-analysis-plan.md): the legacy
 * entries below are unchanged and stay characterization-pinned; the "curated
 * extension" section at the end of ALIAS_TABLE adds vendor knowledge for
 * fields that previously landed in fuzzy/overflow (PAN-OS field names as the
 * panos-dictionary parser emits them, missing CEF standard keys, FortiGate,
 * and cross-vendor web/hash conventions). Every extension entry is pinned in
 * field-matcher-improvements.test.ts - additions must come with a test.
 *
 *   ALIAS_TABLE          legacy lines 73-316  (~240 entries) + curated extension
 *   REVERSE_ALIAS        legacy lines 319-327
 *   classifyEventType    legacy lines 367-383
 *   EVENT_TYPE_BOOSTS    legacy lines 386-395
 *   COALESCE_PRIORITY    legacy lines 404-424
 *   VALUE_NORMALIZATIONS legacy lines 488-520
 *
 * Pure data: no IO, no fetch, no React, no Date/crypto.
 */

/**
 * Known abbreviation / alias table. Maps common short source field names to
 * their standard long destination names (src -> SourceIP, dst -> DestinationIP).
 */
export const ALIAS_TABLE: Record<string, string[]> = {
  // IP addresses
  src: ["SourceIP", "SourceAddress", "SrcAddr", "src_ip", "srcip"],
  dst: ["DestinationIP", "DestinationAddress", "DstAddr", "dst_ip", "dstip"],
  srcip: ["SourceIP", "SourceAddress"],
  dstip: ["DestinationIP", "DestinationAddress"],
  src_ip: ["SourceIP"],
  dst_ip: ["DestinationIP"],
  natsrc: ["SourceTranslatedAddress", "NATSourceIP"],
  natdst: ["DestinationTranslatedAddress", "NATDestinationIP"],
  ClientIP: ["SourceIP", "ClientIP"],
  OriginIP: ["DestinationIP", "OriginIP"],
  ip: ["SourceIP"],
  ipaddr: ["SourceIP"],

  // Ports
  sport: ["SourcePort", "src_port"],
  dport: ["DestinationPort", "dst_port"],
  srcport: ["SourcePort"],
  dstport: ["DestinationPort"],
  src_port: ["SourcePort"],
  dst_port: ["DestinationPort"],
  natsport: ["SourceTranslatedPort"],
  natdport: ["DestinationTranslatedPort"],

  // Users
  srcuser: ["SourceUserName", "SourceUser", "src_user"],
  dstuser: ["DestinationUserName", "DestinationUser", "dst_user"],
  user: ["SourceUserName", "UserName"],
  username: ["SourceUserName", "UserName"],
  account: ["SourceUserName", "AccountName"],

  // Network
  proto: ["Protocol", "NetworkProtocol", "IPProtocol"],
  app: ["ApplicationProtocol", "Application", "AppName"],
  service: ["DestinationServiceName", "Service"],
  action: ["DeviceAction", "Action", "EventAction"],
  rule: ["RuleName", "SecurityRule"],

  // Zones / Interfaces
  from: ["SourceZone", "FromZone", "InboundZone"],
  to: ["DestinationZone", "ToZone", "OutboundZone"],
  inbound_if: ["InboundInterface", "SourceInterface"],
  outbound_if: ["OutboundInterface", "DestinationInterface"],
  srcintf: ["InboundInterface", "SourceInterface"],
  dstintf: ["OutboundInterface", "DestinationInterface"],

  // Bytes / Packets
  bytes_sent: ["SentBytes", "BytesSent", "OutBytes"],
  bytes_received: ["ReceivedBytes", "BytesReceived", "InBytes"],
  sentbyte: ["SentBytes"],
  rcvdbyte: ["ReceivedBytes"],
  out: ["SentBytes"], // CEF standard: outbound bytes
  // Note: 'in' is a JS reserved word -- handled via overflow guard, not alias
  packets_sent: ["SentPackets", "PacketsSent"],
  packets_received: ["ReceivedPackets", "PacketsReceived"],
  elapsed: ["Duration", "SessionDuration"],
  duration: ["Duration", "SessionDuration"],

  // Timestamps
  receive_time: ["TimeGenerated", "ReceiveTime", "EventTime"],
  start_time: ["StartTime", "SessionStartTime"],
  generated_time: ["TimeGenerated"],
  event_time: ["EventTime", "TimeGenerated"],
  timestamp: ["TimeGenerated", "EventTime"],
  Timestamp: ["TimeGenerated"],
  Datetime: ["TimeGenerated"],
  EdgeStartTimestamp: ["TimeGenerated"],
  published: ["TimeGenerated"],
  createdDateTime: ["TimeGenerated"],
  date: ["TimeGenerated"],
  time: ["TimeGenerated"],

  // Device / Host
  serial: ["DeviceName", "DeviceSerialNumber"],
  device_name: ["DeviceName", "Computer"],
  hostname: ["Computer", "HostName", "DeviceName"],
  host_name: ["Computer", "HostName"],
  HostName: ["Computer", "HostName"],
  Computer: ["Computer"],
  dvchost: ["DeviceName"],

  // Severity
  severity: ["LogSeverity", "SeverityLevel", "Severity"],
  LogSeverity: ["LogSeverity"],
  level: ["SeverityLevel", "LogSeverity"],
  priority: ["LogSeverity", "Priority"],

  // Threat / Security
  threatid: ["DeviceEventClassID", "ThreatID", "SignatureID"],
  threat_name: ["Activity", "ThreatName"],
  subtype: ["Activity", "EventSubType"],
  type: ["DeviceEventClassID", "EventType", "Type"],
  category: ["DeviceEventCategory", "Category", "URLCategory"],
  thr_category: ["ThreatCategory"],
  misc: ["RequestURL", "AdditionalInfo"],
  direction: ["CommunicationDirection"],
  filedigest: ["FileHash", "SHA256"],
  filename: ["FileName"],
  url: ["RequestURL", "DestinationURL"],

  // Session
  sessionid: ["SessionID", "ExternalID"],
  repeatcnt: ["EventCount", "RepeatCount"],
  vsys: ["VirtualSystem"],

  // CEF standard header fields
  DeviceVendor: ["DeviceVendor"],
  DeviceProduct: ["DeviceProduct"],
  DeviceVersion: ["DeviceVersion"],
  DeviceEventClassID: ["DeviceEventClassID"],
  Name: ["Activity"],
  act: ["DeviceAction"],
  rt: ["ReceiptTime"],
  start: ["StartTime"],
  end: ["EndTime"],
  request: ["RequestURL"],
  requestMethod: ["RequestMethod"],
  requestContext: ["RequestContext"],
  requestClientApplication: ["RequestClientApplication"],
  msg: ["Message", "SyslogMessage"],
  externalId: ["ExternalID"],
  spt: ["SourcePort"],
  dpt: ["DestinationPort"],
  cnt: ["EventCount"],
  fname: ["FileName"],

  // CEF custom string/number fields -- standard abbreviations AND long-form variations.
  // csN -> DeviceCustomStringN, cnN -> DeviceCustomNumberN
  // Also handles: customstring1, CustomString1, custom_string_1, etc.
  cs1: ["DeviceCustomString1"],
  cs1Label: ["DeviceCustomString1Label"],
  customstring1: ["DeviceCustomString1"],
  CustomString1: ["DeviceCustomString1"],
  custom_string_1: ["DeviceCustomString1"],
  cs2: ["DeviceCustomString2"],
  cs2Label: ["DeviceCustomString2Label"],
  customstring2: ["DeviceCustomString2"],
  CustomString2: ["DeviceCustomString2"],
  custom_string_2: ["DeviceCustomString2"],
  cs3: ["DeviceCustomString3"],
  cs3Label: ["DeviceCustomString3Label"],
  customstring3: ["DeviceCustomString3"],
  cs4: ["DeviceCustomString4"],
  cs4Label: ["DeviceCustomString4Label"],
  customstring4: ["DeviceCustomString4"],
  cs5: ["DeviceCustomString5"],
  cs5Label: ["DeviceCustomString5Label"],
  customstring5: ["DeviceCustomString5"],
  cs6: ["DeviceCustomString6"],
  cs6Label: ["DeviceCustomString6Label"],
  customstring6: ["DeviceCustomString6"],
  cn1: ["DeviceCustomNumber1"],
  cn1Label: ["DeviceCustomNumber1Label"],
  customnumber1: ["DeviceCustomNumber1"],
  CustomNumber1: ["DeviceCustomNumber1"],
  custom_number_1: ["DeviceCustomNumber1"],
  cn2: ["DeviceCustomNumber2"],
  cn2Label: ["DeviceCustomNumber2Label"],
  customnumber2: ["DeviceCustomNumber2"],
  CustomNumber2: ["DeviceCustomNumber2"],
  custom_number_2: ["DeviceCustomNumber2"],
  cn3: ["DeviceCustomNumber3"],
  cn3Label: ["DeviceCustomNumber3Label"],
  customnumber3: ["DeviceCustomNumber3"],
  c6a1: ["DeviceCustomIPv6Address1"],
  c6a1Label: ["DeviceCustomIPv6Address1Label"],
  c6a2: ["DeviceCustomIPv6Address2"],
  c6a2Label: ["DeviceCustomIPv6Address2Label"],
  c6a3: ["DeviceCustomIPv6Address3"],
  c6a3Label: ["DeviceCustomIPv6Address3Label"],
  cfp1: ["DeviceCustomFloatingPoint1"],
  cfp1Label: ["DeviceCustomFloatingPoint1Label"],
  cfp2: ["DeviceCustomFloatingPoint2"],
  cfp2Label: ["DeviceCustomFloatingPoint2Label"],
  cfp3: ["DeviceCustomFloatingPoint3"],
  cfp3Label: ["DeviceCustomFloatingPoint3Label"],
  cfp4: ["DeviceCustomFloatingPoint4"],
  cfp4Label: ["DeviceCustomFloatingPoint4Label"],
  flexString1: ["FlexString1"],
  flexString1Label: ["FlexString1Label"],
  flexString2: ["FlexString2"],
  flexString2Label: ["FlexString2Label"],
  flexDate1: ["FlexDate1"],
  flexDate1Label: ["FlexDate1Label"],

  // CEF address/host fields
  dvc: ["DeviceAddress"],
  duser: ["DestinationUserName"],
  suser: ["SourceUserName"],
  duid: ["DestinationUserID"],
  suid: ["SourceUserID"],
  dntdom: ["DestinationNTDomain"],
  sntdom: ["SourceNTDomain"],
  dhost: ["DestinationHostName"],
  shost: ["SourceHostName"],
  dmac: ["DestinationMACAddress"],
  smac: ["SourceMACAddress"],
  dpid: ["DestinationProcessId"],
  spid: ["SourceProcessId"],
  dproc: ["DestinationProcessName"],
  sproc: ["SourceProcessName"],
  cat: ["DeviceEventCategory"],
  outcome: ["EventOutcome"],
  sourceTranslatedAddress: ["SourceTranslatedAddress"],
  destinationTranslatedAddress: ["DestinationTranslatedAddress"],
  sourceTranslatedPort: ["SourceTranslatedPort"],
  destinationTranslatedPort: ["DestinationTranslatedPort"],
  deviceExternalId: ["DeviceExternalID"],
  deviceInboundInterface: ["DeviceInboundInterface"],
  deviceOutboundInterface: ["DeviceOutboundInterface"],
  deviceFacility: ["DeviceFacility"],

  // FortiGate specific (unique entries only -- srcip, dstip, etc. already defined above)
  policyid: ["PolicyID"],
  // msg already defined in CEF standard header section above
  attack: ["Activity", "AttackName"],
  logid: ["DeviceEventClassID"],

  // Cloudflare specific
  RayID: ["ExternalID", "RayID"],
  EdgeResponseStatus: ["EventOutcome", "EdgeResponseStatus"],
  ClientRequestHost: ["DestinationHostName", "ClientRequestHost"],
  ClientRequestURI: ["RequestURL", "ClientRequestURI"],
  ClientRequestMethod: ["RequestMethod", "ClientRequestMethod"],
  ClientRequestUserAgent: ["RequestClientApplication", "ClientRequestUserAgent"],

  // CrowdStrike specific
  DetectId: ["ExternalID", "DetectId"],
  SensorId: ["SensorId"],
  ComputerName: ["Computer", "ComputerName"],
  CommandLine: ["ProcessCommandLine", "CommandLine"],
  SHA256String: ["FileHash", "SHA256String"],
  imageFileName: ["FilePath"], // CrowdStrike image file path (NOT FileName)
  parentImageFileName: ["OldFilePath"],
  FalconHostLink: ["FalconHostLink"],

  // Okta specific
  uuid: ["ExternalID"],
  eventType: ["Activity", "EventType"],
  displayMessage: ["Message", "Activity"],
  // outcome already defined in CEF address/host section above
  actor: ["SourceUserName"],

  // -------------------------------------------------------------------------
  // Curated extension (2026-07-08) - deliberate additions for fields observed
  // landing in fuzzy/overflow. Alias hits require the destination column to
  // exist in the resolved schema, so entries here have zero blast radius on
  // tables that lack the column. Pinned in field-matcher-improvements.test.ts.
  // -------------------------------------------------------------------------

  // PAN-OS THREAT/URL fields exactly as the panos-dictionary parser emits them
  user_agent: ["RequestClientApplication"],
  http_method: ["RequestMethod"],
  referer: ["RequestContext"], // CEF requestContext IS the HTTP referer
  session_end_reason: ["Reason"],
  src_mac: ["SourceMACAddress"],
  dst_mac: ["DestinationMACAddress"],
  src_host: ["SourceHostName"],
  dst_host: ["DestinationHostName"],

  // CEF standard keys the legacy table missed
  deviceDirection: ["CommunicationDirection"],
  fsize: ["FileSize"],
  oldFileName: ["OldFileName"],
  oldFilePath: ["OldFilePath"],

  // FortiGate key=value fields
  devname: ["DeviceName", "Computer"],
  eventtime: ["TimeGenerated", "EventTime"],
  transport: ["Protocol", "NetworkProtocol"],

  // Cross-vendor web/API log conventions (IIS, nginx, Zscaler, WAFs)
  useragent: ["RequestClientApplication"],
  http_user_agent: ["RequestClientApplication"],
  method: ["RequestMethod"],
  uri: ["RequestURL"],
  status_code: ["EventOutcome"],
  response_code: ["EventOutcome"],
  client_ip: ["SourceIP"],
  clientip: ["SourceIP"],
  server_ip: ["DestinationIP"],
  serverip: ["DestinationIP"],

  // Splunk CIM-style source names
  dest_ip: ["DestinationIP"],
  dest_port: ["DestinationPort"],
  dest_host: ["DestinationHostName"],

  // File-hash conventions (any EDR/AV feed)
  sha256: ["FileHash"],
  sha1: ["FileHash"],
  md5: ["FileHash"],
  file_hash: ["FileHash"],
  file_name: ["FileName"],
  file_path: ["FilePath"],
  file_size: ["FileSize"],

  // Severity/level variants
  log_level: ["LogSeverity", "SeverityLevel"],

  // Syslog transport fields (the Syslog table's dedicated columns)
  procid: ["ProcessID"],
  appname: ["ProcessName", "AppName"],
  app_name: ["ProcessName", "AppName"],
  program: ["ProcessName"],
};

/** Reverse lookup: destName (lowercased) -> sourceNames (lowercased). */
export const REVERSE_ALIAS: Map<string, Set<string>> = new Map();
for (const [source, dests] of Object.entries(ALIAS_TABLE)) {
  for (const dest of dests) {
    if (!REVERSE_ALIAS.has(dest.toLowerCase())) {
      REVERSE_ALIAS.set(dest.toLowerCase(), new Set());
    }
    REVERSE_ALIAS.get(dest.toLowerCase())!.add(source.toLowerCase());
  }
}

/** Event category detected from source-field co-occurrence (Chronicle UDM pattern). */
export type EventCategory =
  | "network"
  | "authentication"
  | "process"
  | "file"
  | "dns"
  | "web"
  | "firewall"
  | "generic";

/**
 * Detect the event category from field co-occurrence. Order matters -- more
 * specific categories first. Verbatim from legacy classifyEventType.
 */
export function classifyEventType(sourceFieldNames: string[]): EventCategory {
  const fields = new Set(sourceFieldNames.map((f) => f.toLowerCase()));
  // Order matters -- more specific categories first
  if (
    (fields.has("query") || fields.has("queryname") || fields.has("dnsquery")) &&
    (fields.has("answer") || fields.has("rcode") || fields.has("dnsresponsename"))
  )
    return "dns";
  if (
    (fields.has("url") ||
      fields.has("request") ||
      fields.has("requesturl") ||
      fields.has("uri")) &&
    (fields.has("requestmethod") ||
      fields.has("method") ||
      fields.has("useragent"))
  )
    return "web";
  if (
    (fields.has("user") ||
      fields.has("suser") ||
      fields.has("duser") ||
      fields.has("username")) &&
    (fields.has("logon") ||
      fields.has("login") ||
      fields.has("auth") ||
      fields.has("authentication"))
  )
    return "authentication";
  if (
    fields.has("src") &&
    fields.has("dst") &&
    (fields.has("proto") || fields.has("spt") || fields.has("dpt"))
  )
    return "network";
  if (fields.has("act") || fields.has("action") || fields.has("deviceaction"))
    return "firewall";
  if (
    fields.has("process") ||
    fields.has("pid") ||
    fields.has("commandline") ||
    fields.has("image")
  )
    return "process";
  if (fields.has("filename") || fields.has("filepath") || fields.has("fname"))
    return "file";
  return "generic";
}

/** Boost scores for matches contextually appropriate for the event type. */
export const EVENT_TYPE_BOOSTS: Record<EventCategory, Record<string, number>> = {
  network: {
    SourceIP: 5,
    DestinationIP: 5,
    SourcePort: 5,
    DestinationPort: 5,
    Protocol: 5,
    SentBytes: 3,
    ReceivedBytes: 3,
    Duration: 3,
  },
  firewall: {
    DeviceAction: 5,
    SourceIP: 3,
    DestinationIP: 3,
    Protocol: 3,
    DeviceEventClassID: 3,
  },
  authentication: {
    SourceUserName: 5,
    DestinationUserName: 5,
    EventOutcome: 5,
    LogSeverity: 3,
  },
  dns: { DestinationHostName: 5, RequestURL: 3, DeviceEventClassID: 3 },
  web: {
    RequestURL: 5,
    RequestMethod: 5,
    RequestClientApplication: 3,
    DestinationHostName: 3,
  },
  process: { ProcessCommandLine: 5, FilePath: 5, FileHash: 3 },
  file: { FileName: 5, FilePath: 5, FileHash: 3 },
  generic: {},
};

/**
 * Coalesce priority chains (ASIM pattern). When multiple source fields could
 * map to the same destination, prefer the highest-priority source. Verbatim
 * from legacy COALESCE_PRIORITY.
 */
export const COALESCE_PRIORITY: Record<string, string[]> = {
  // Timestamps: prefer specific fields over generic ones
  TimeGenerated: [
    "timestamp",
    "Timestamp",
    "event_time",
    "EventTime",
    "receive_time",
    "generated_time",
    "datetime",
    "Datetime",
    "time",
    "date",
    "rt",
  ],
  ReceiptTime: ["rt", "receive_time", "ReceiveTime"],
  StartTime: ["start", "start_time", "StartTime", "SessionStartTime"],
  // IPs: prefer standard CEF/syslog short names
  SourceIP: ["src", "srcip", "src_ip", "SourceIP", "ClientIP", "ip"],
  DestinationIP: ["dst", "dstip", "dst_ip", "DestinationIP", "OriginIP"],
  // Ports: prefer standard CEF short names
  SourcePort: ["spt", "sport", "srcport", "src_port", "SourcePort"],
  DestinationPort: ["dpt", "dport", "dstport", "dst_port", "DestinationPort"],
  // Action/Protocol: prefer standard CEF
  DeviceAction: ["act", "action", "DeviceAction"],
  Protocol: ["proto", "protocol", "Protocol", "app"],
  // Users
  SourceUserName: ["suser", "srcuser", "user", "username", "SourceUserName"],
  DestinationUserName: ["duser", "dstuser", "DestinationUserName"],
  // Device
  DeviceName: ["dvchost", "serial", "device_name", "hostname", "DeviceName"],
  FileName: ["fname", "filename", "FileName"],
};

/**
 * Value normalization dictionaries (ASIM/Chronicle pattern). Beyond field NAME
 * mapping, normalize field VALUES to standard forms. EXPORTED but currently
 * UNUSED - reserved for the future Lookup-function feature that will generate
 * Eval expressions in the pipeline. Kept verbatim so that feature inherits the
 * curated dictionaries intact.
 */
export const VALUE_NORMALIZATIONS: Record<string, Record<string, string>> = {
  DeviceAction: {
    allow: "Allow",
    permit: "Allow",
    accept: "Allow",
    pass: "Allow",
    allowed: "Allow",
    deny: "Deny",
    block: "Deny",
    drop: "Deny",
    reject: "Deny",
    denied: "Deny",
    blocked: "Deny",
    dropped: "Deny",
    rejected: "Deny",
    refused: "Deny",
    reset: "Reset",
    "reset-both": "Reset",
    "reset-client": "Reset",
    "reset-server": "Reset",
    alert: "Alert",
    warn: "Alert",
    warning: "Alert",
  },
  LogSeverity: {
    critical: "10",
    crit: "10",
    emergency: "10",
    emerg: "10",
    high: "8",
    alert: "8",
    error: "8",
    err: "8",
    medium: "5",
    warning: "5",
    warn: "5",
    low: "3",
    notice: "3",
    info: "1",
    informational: "1",
    information: "1",
    debug: "0",
    trace: "0",
  },
  Protocol: {
    tcp: "TCP",
    udp: "UDP",
    icmp: "ICMP",
    igmp: "IGMP",
    http: "HTTP",
    https: "HTTPS",
    dns: "DNS",
    ssh: "SSH",
    ftp: "FTP",
    smtp: "SMTP",
    tls: "TLS",
    ssl: "SSL",
    gre: "GRE",
    esp: "ESP",
    ah: "AH",
    "6": "TCP",
    "17": "UDP",
    "1": "ICMP",
    "47": "GRE",
    "50": "ESP",
  },
  EventOutcome: {
    success: "Success",
    successful: "Success",
    ok: "Success",
    passed: "Success",
    failure: "Failure",
    failed: "Failure",
    fail: "Failure",
    error: "Failure",
    unknown: "Unknown",
    na: "NA",
    partial: "Partial",
  },
  CommunicationDirection: {
    inbound: "Inbound",
    ingress: "Inbound",
    incoming: "Inbound",
    outbound: "Outbound",
    egress: "Outbound",
    outgoing: "Outbound",
    lateral: "Lateral",
    internal: "Lateral",
  },
};
