/**
 * Pins for the 2026-07-08 DELIBERATE matcher improvements (the user request
 * behind docs/ai-assisted-analysis-plan.md): the curated ALIAS_TABLE extension
 * and the case-insensitive alias-key fallback. Every extension entry is pinned
 * here so vendor knowledge cannot regress silently; the no-regression block
 * re-asserts legacy behavior stayed intact.
 */

import { describe, expect, it } from "vitest";

import { matchFields } from "./match-fields";
import { scoreMatch } from "./scoring";
import type { DestField, SourceField } from "./models";

/** A CommonSecurityLog-ish destination subset covering the new aliases. */
const CSL_COLUMNS: DestField[] = [
  { name: "SourceIP", type: "string" },
  { name: "DestinationIP", type: "string" },
  { name: "DestinationPort", type: "int" },
  { name: "RequestClientApplication", type: "string" },
  { name: "RequestMethod", type: "string" },
  { name: "RequestContext", type: "string" },
  { name: "RequestURL", type: "string" },
  { name: "Reason", type: "string" },
  { name: "SourceMACAddress", type: "string" },
  { name: "DestinationMACAddress", type: "string" },
  { name: "SourceHostName", type: "string" },
  { name: "DestinationHostName", type: "string" },
  { name: "CommunicationDirection", type: "string" },
  { name: "FileSize", type: "long" },
  { name: "FileHash", type: "string" },
  { name: "FileName", type: "string" },
  { name: "FilePath", type: "string" },
  { name: "OldFileName", type: "string" },
  { name: "OldFilePath", type: "string" },
  { name: "DeviceName", type: "string" },
  { name: "Protocol", type: "string" },
  { name: "EventOutcome", type: "string" },
  { name: "LogSeverity", type: "string" },
  { name: "SourceTranslatedPort", type: "int" },
  { name: "AdditionalExtensions", type: "string" },
];

/** Match one lone source field against the CSL subset; return its match row. */
function matchOne(name: string, type = "string", sampleValue?: string) {
  const source: SourceField[] = [{ name, type, sampleValue }];
  const result = matchFields(source, CSL_COLUMNS, undefined, "CommonSecurityLog");
  return result.matched[0];
}

describe("curated alias extension (2026-07-08)", () => {
  const CASES: Array<[source: string, dest: string]> = [
    // PAN-OS THREAT/URL fields (panos-dictionary emission names)
    ["user_agent", "RequestClientApplication"],
    ["http_method", "RequestMethod"],
    ["referer", "RequestContext"],
    ["session_end_reason", "Reason"],
    ["src_mac", "SourceMACAddress"],
    ["dst_mac", "DestinationMACAddress"],
    ["src_host", "SourceHostName"],
    ["dst_host", "DestinationHostName"],
    // CEF standard keys the legacy table missed
    ["deviceDirection", "CommunicationDirection"],
    ["fsize", "FileSize"],
    ["oldFileName", "OldFileName"],
    ["oldFilePath", "OldFilePath"],
    // FortiGate
    ["devname", "DeviceName"],
    // CORRECTED 2026-07-09: the live fortinet sample's trandisp=snat trio
    // proves transport is the TRANSLATED PORT (58012), not the protocol.
    ["transport", "SourceTranslatedPort"],
    // Cross-vendor web/API conventions
    ["useragent", "RequestClientApplication"],
    ["http_user_agent", "RequestClientApplication"],
    ["method", "RequestMethod"],
    ["uri", "RequestURL"],
    ["status_code", "EventOutcome"],
    ["response_code", "EventOutcome"],
    ["client_ip", "SourceIP"],
    ["clientip", "SourceIP"],
    ["server_ip", "DestinationIP"],
    ["serverip", "DestinationIP"],
    // Splunk CIM style
    ["dest_ip", "DestinationIP"],
    ["dest_port", "DestinationPort"],
    ["dest_host", "DestinationHostName"],
    // Hash/file conventions
    ["sha256", "FileHash"],
    ["sha1", "FileHash"],
    ["md5", "FileHash"],
    ["file_hash", "FileHash"],
    ["file_name", "FileName"],
    ["file_path", "FilePath"],
    ["file_size", "FileSize"],
    // Severity variants
    ["log_level", "LogSeverity"],
  ];

  for (const [source, dest] of CASES) {
    it(`maps ${source} -> ${dest}`, () => {
      const match = matchOne(source);
      expect(match, `${source} did not match at all`).toBeDefined();
      expect(match.destName).toBe(dest);
      expect(match.action).toBe("rename");
    });
  }

  it("previously sent these THREAT-log fields to overflow (documents the gain)", () => {
    // Without the extension entries, none of these had any score path to
    // their column (verified against the legacy ladder before extending).
    for (const name of ["user_agent", "http_method", "referer", "uri"]) {
      const match = matchOne(name);
      expect(match.confidence).toBe("alias");
    }
  });

  it("maps Syslog transport fields to the Syslog table's dedicated columns", () => {
    const SYSLOG_COLUMNS: DestField[] = [
      { name: "ProcessID", type: "int" },
      { name: "ProcessName", type: "string" },
      { name: "SyslogMessage", type: "string" },
    ];
    const result = matchFields(
      [
        { name: "procid", type: "int" },
        { name: "appname", type: "string" },
        { name: "program", type: "string" },
      ],
      SYSLOG_COLUMNS,
      undefined,
      "Syslog",
    );
    const byName = new Map(result.matched.map((m) => [m.sourceName, m.destName]));
    expect(byName.get("procid")).toBe("ProcessID");
    // appname wins ProcessName (listed first); program has no column left and
    // is not force-fitted.
    expect(byName.get("appname")).toBe("ProcessName");
  });

  it("FortiGate eventtime maps to TimeGenerated when nothing higher-priority claims it", () => {
    const result = matchFields(
      [{ name: "eventtime", type: "string" }],
      [{ name: "TimeGenerated", type: "datetime" }],
      undefined,
      "CommonSecurityLog",
    );
    expect(result.matched[0]?.destName).toBe("TimeGenerated");
  });

  it("eventtime yields TimeGenerated to a higher-priority coalesce source", () => {
    // The legacy chain ranks timestamp > ... > EventTime (case-insensitively
    // claims `eventtime`) > receive_time; the reservation contract is intact.
    const result = matchFields(
      [
        { name: "eventtime", type: "string" },
        { name: "timestamp", type: "string" },
      ],
      [{ name: "TimeGenerated", type: "datetime" }],
      undefined,
      "CommonSecurityLog",
    );
    const winner = result.matched.find((m) => m.destName === "TimeGenerated");
    expect(winner?.sourceName).toBe("timestamp");
  });
});

describe("Zscaler NSS aliases (2026-07-09)", () => {
  // Live gap: 76 of 83 Zscaler fields overflowed. Names verified against the
  // real ZIA web + firewall test logs (elastic/integrations zscaler_zia
  // pipeline fixtures - the files the Elastic browse tier serves).
  const ZS_COLUMNS: DestField[] = [
    { name: "SourceIP", type: "string" },
    { name: "SourcePort", type: "int" },
    { name: "DestinationIP", type: "string" },
    { name: "DestinationPort", type: "int" },
    { name: "SourceTranslatedAddress", type: "string" },
    { name: "SourceTranslatedPort", type: "int" },
    { name: "DestinationTranslatedAddress", type: "string" },
    { name: "DestinationTranslatedPort", type: "int" },
    { name: "ReceivedBytes", type: "long" },
    { name: "SentBytes", type: "long" },
    { name: "ApplicationProtocol", type: "string" },
    { name: "ExternalID", type: "string" },
    { name: "ReceiptTime", type: "string" },
    { name: "RequestMethod", type: "string" },
    { name: "RequestContext", type: "string" },
    { name: "EventOutcome", type: "string" },
    { name: "SourceUserName", type: "string" },
    { name: "SourceHostName", type: "string" },
    { name: "DestinationHostName", type: "string" },
    { name: "FileType", type: "string" },
    { name: "AdditionalExtensions", type: "string" },
  ];

  function zsMatchOne(name: string, type = "string") {
    const result = matchFields(
      [{ name, type }],
      ZS_COLUMNS,
      undefined,
      "CommonSecurityLog",
    );
    return result.matched[0];
  }

  const CASES: Array<[source: string, dest: string, type?: string]> = [
    // Web (NSS web feed)
    ["cltip", "SourceIP"],
    ["cltpubip", "SourceTranslatedAddress"],
    ["cltsourceport", "SourcePort", "int"],
    ["reqmethod", "RequestMethod"],
    ["respcode", "EventOutcome"],
    ["reqsize", "SentBytes", "int"],
    ["respsize", "ReceivedBytes", "int"],
    ["applayerprotocol", "ApplicationProtocol"],
    ["login", "SourceUserName"],
    ["refererhost", "RequestContext"],
    ["host", "DestinationHostName"],
    ["devicehostname", "SourceHostName"],
    ["epochtime", "ReceiptTime", "int"],
    ["datetime", "ReceiptTime"],
    // Firewall (NSS firewall feed)
    ["csip", "SourceIP"],
    ["csport", "SourcePort", "int"],
    ["cdip", "DestinationIP"],
    ["cdport", "DestinationPort", "int"],
    ["ssip", "SourceTranslatedAddress"],
    ["ssport", "SourceTranslatedPort", "int"],
    ["sdip", "DestinationTranslatedAddress"],
    ["sdport", "DestinationTranslatedPort", "int"],
    ["inbytes", "ReceivedBytes", "int"],
    ["outbytes", "SentBytes", "int"],
    ["nwsvc", "ApplicationProtocol"],
    ["recordid", "ExternalID"],
  ];

  for (const [source, dest, type] of CASES) {
    it(`maps ${source} -> ${dest}`, () => {
      const match = zsMatchOne(source, type ?? "string");
      expect(match, `${source} did not match at all`).toBeDefined();
      expect(match.destName).toBe(dest);
    });
  }

  it("maps the full firewall address quad without column collisions", () => {
    // c=client-side, s=server-side (post-NAT): four IPs, four ports, one
    // event - every alias must land on ITS column, none stolen.
    const result = matchFields(
      [
        { name: "csip", type: "string" },
        { name: "csport", type: "int" },
        { name: "cdip", type: "string" },
        { name: "cdport", type: "int" },
        { name: "ssip", type: "string" },
        { name: "ssport", type: "int" },
        { name: "sdip", type: "string" },
        { name: "sdport", type: "int" },
      ],
      ZS_COLUMNS,
      undefined,
      "CommonSecurityLog",
    );
    const byName = new Map(
      result.matched.map((m) => [m.sourceName, m.destName]),
    );
    expect(byName.get("csip")).toBe("SourceIP");
    expect(byName.get("cdip")).toBe("DestinationIP");
    expect(byName.get("ssip")).toBe("SourceTranslatedAddress");
    expect(byName.get("sdip")).toBe("DestinationTranslatedAddress");
    expect(byName.get("csport")).toBe("SourcePort");
    expect(byName.get("cdport")).toBe("DestinationPort");
    expect(byName.get("ssport")).toBe("SourceTranslatedPort");
    expect(byName.get("sdport")).toBe("DestinationTranslatedPort");
    expect(result.overflow).toEqual([]);
  });
});

describe("vendor-research aliases wave 2 (2026-07-09)", () => {
  // Field names verified against the REAL elastic/integrations test fixtures
  // for each vendor (the files the Elastic browse tier serves); coverage
  // measured with the dev-time harness before/after. Every destination is a
  // real CommonSecurityLog column.
  const W2_COLUMNS: DestField[] = [
    { name: "Activity", type: "string" },
    { name: "SourceIP", type: "string" },
    { name: "SourcePort", type: "int" },
    { name: "DestinationIP", type: "string" },
    { name: "DestinationPort", type: "int" },
    { name: "SourceTranslatedAddress", type: "string" },
    { name: "SourceTranslatedPort", type: "int" },
    { name: "DeviceAddress", type: "string" },
    { name: "DeviceAction", type: "string" },
    { name: "DeviceExternalID", type: "string" },
    { name: "DeviceInboundInterface", type: "string" },
    { name: "DeviceOutboundInterface", type: "string" },
    { name: "DeviceEventCategory", type: "string" },
    { name: "DestinationDnsDomain", type: "string" },
    { name: "SourceMACAddress", type: "string" },
    { name: "DestinationMACAddress", type: "string" },
    { name: "RequestClientApplication", type: "string" },
    { name: "ApplicationProtocol", type: "string" },
    { name: "CommunicationDirection", type: "string" },
    { name: "SourceNTDomain", type: "string" },
    { name: "SourceProcessId", type: "int" },
    { name: "FileHash", type: "string" },
    { name: "ExternalID", type: "string" },
    { name: "ReceiptTime", type: "string" },
    { name: "EventOutcome", type: "string" },
    { name: "Reason", type: "string" },
    { name: "Message", type: "string" },
    { name: "AdditionalExtensions", type: "string" },
  ];

  function w2MatchOne(name: string, type = "string") {
    const result = matchFields(
      [{ name, type }],
      W2_COLUMNS,
      undefined,
      "CommonSecurityLog",
    );
    return result.matched[0];
  }

  const CASES: Array<[source: string, dest: string, type?: string]> = [
    // CrowdStrike FDR / alert streams
    ["LocalAddressIP4", "SourceIP"],
    ["LocalAddressIP6", "SourceIP"],
    ["RemoteAddressIP4", "DestinationIP"],
    ["RemoteAddressIP6", "DestinationIP"],
    ["LocalPort", "SourcePort", "int"],
    ["RemotePort", "DestinationPort", "int"],
    ["aip", "DeviceAddress"],
    ["aid", "DeviceExternalID"],
    ["agent_id", "DeviceExternalID"],
    ["event_simpleName", "Activity"],
    ["SHA256HashData", "FileHash"],
    ["ConnectionDirection", "CommunicationDirection"],
    ["ContextTimeStamp", "ReceiptTime"],
    ["logon_domain", "SourceNTDomain"],
    ["RawProcessId", "SourceProcessId", "int"],
    // FortiGate (real column first; legacy candidates were not CSL columns)
    ["transip", "SourceTranslatedAddress"],
    ["srcintf", "DeviceInboundInterface"],
    ["dstintf", "DeviceOutboundInterface"],
    ["mastersrcmac", "SourceMACAddress"],
    ["masterdstmac", "DestinationMACAddress"],
    ["catdesc", "DeviceEventCategory"],
    ["qname", "DestinationDnsDomain"],
    ["agent", "RequestClientApplication"],
    ["logdesc", "Message"],
    // PAN-OS THREAT
    ["inbound_if", "DeviceInboundInterface"],
    ["outbound_if", "DeviceOutboundInterface"],
    ["thr_category", "DeviceEventCategory"],
    ["seqno", "ExternalID"],
    // Suricata EVE
    ["app_proto", "ApplicationProtocol"],
    ["in_iface", "DeviceInboundInterface"],
    // Cisco Secure Endpoint + Duo
    ["detection", "Message"],
    ["detection_id", "ExternalID"],
    ["connector_guid", "DeviceExternalID"],
    ["isotimestamp", "ReceiptTime"],
    // Zscaler NSS dns feed
    ["clt_sip", "SourceIP"],
    ["srv_dip", "DestinationIP"],
    ["srv_dport", "DestinationPort", "int"],
    ["dns_req", "DestinationDnsDomain"],
    ["http_code", "EventOutcome"],
    ["reqaction", "DeviceAction"],
    ["error", "Reason"],
  ];

  for (const [source, dest, type] of CASES) {
    it(`maps ${source} -> ${dest}`, () => {
      const match = w2MatchOne(source, type ?? "string");
      expect(match, `${source} did not match at all`).toBeDefined();
      expect(match.destName).toBe(dest);
    });
  }

  it("action still claims DeviceAction, never Activity (candidate-order trap)", () => {
    // Alias candidates tie on score, so the SCHEMA order picks the column -
    // adding Activity to action's candidates flipped action=Blocked onto
    // Activity and displaced threat_name (verified 2026-07-09, reverted).
    const result = matchFields(
      [
        { name: "action", type: "string" },
        { name: "threat_name", type: "string" },
      ],
      W2_COLUMNS,
      undefined,
      "CommonSecurityLog",
    );
    const byName = new Map(
      result.matched.map((m) => [m.sourceName, m.destName]),
    );
    expect(byName.get("action")).toBe("DeviceAction");
    expect(byName.get("threat_name")).toBe("Activity");
  });

  it("maps pid to the Syslog table's ProcessID", () => {
    const result = matchFields(
      [{ name: "pid", type: "int" }],
      [{ name: "ProcessID", type: "int" }, { name: "SyslogMessage", type: "string" }],
      undefined,
      "Syslog",
    );
    expect(result.matched[0]?.destName).toBe("ProcessID");
  });
});

describe("case-insensitive alias-key fallback (2026-07-08)", () => {
  it("matches case variants of known alias keys", () => {
    // Exact key "src" exists; "SRC" previously missed the alias entirely.
    expect(scoreMatch("SRC", "SourceIP").confidence).toBe("alias");
    expect(scoreMatch("User_Agent", "RequestClientApplication").confidence).toBe(
      "alias",
    );
    expect(scoreMatch("Session_End_Reason", "Reason").confidence).toBe("alias");
  });

  it("exact-key lookup still wins first (unchanged path)", () => {
    expect(scoreMatch("src", "SourceIP")).toMatchObject({
      score: 90,
      confidence: "alias",
    });
  });
});

describe("no regression on legacy behavior", () => {
  it("legacy aliases still map identically", () => {
    expect(scoreMatch("src", "SourceIP").score).toBe(90);
    expect(scoreMatch("dpt", "DestinationPort").score).toBe(90);
    expect(scoreMatch("suser", "SourceUserName").score).toBe(90);
    expect(scoreMatch("bytes_sent", "SentBytes").score).toBe(90);
  });

  it("exact and case-insensitive name matches still outrank aliases", () => {
    expect(scoreMatch("SourceIP", "SourceIP").score).toBe(100);
    expect(scoreMatch("sourceip", "SourceIP").score).toBe(95);
  });

  it("unrelated names still do not match", () => {
    expect(scoreMatch("future_use1", "SourceIP").score).toBe(0);
    expect(scoreMatch("seqno", "DestinationPort").score).toBe(0);
  });
});
