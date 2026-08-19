/**
 * Vendor LOG-TYPE catalog - what a vendor emits, independent of any Sentinel
 * content (ADR 0003; user direction 2026-08-19).
 *
 * WHY THIS EXISTS. The log-type recommendation derives from the solution's own
 * detections, which is the strongest possible evidence when it is available and
 * NOTHING at all when it is not: a Sentinel solution shipping few or no analytic
 * rules yields an empty result, and the panel can only say "I cannot advise".
 * But the vendor still emits a known, documented set of log types - Zscaler
 * publishes ZIA Web, DNS, Firewall and Tunnel feeds whether or not Microsoft
 * ships a rule that filters on them.
 *
 * So this is the FALLBACK tier, and it makes a DIFFERENT CLAIM. Content-derived
 * says "your solution's detections need this". Vendor-derived says "your vendor
 * emits this". The second cannot tell you what your content requires, and must
 * never be presented as if it could - which is why every entry carries its
 * provenance and the UI labels the tier rather than merging them into one list.
 *
 * THE PRECEDENCE MIRRORS vendor-mapping-packs DELIBERATELY, because it is the
 * same problem with the same answer and this codebase has already settled it:
 *
 *   1. HAND packs - read off vendor documentation, each entry cited.
 *   2. GENERATED packs - mined from the elastic/integrations `data_stream`
 *      directory names, which ARE the vendor's own log-type split.
 *
 * Hand packs are declared FIRST and win the per-value dedupe, exactly as
 * HAND_PACKS beat generated mapping packs. Do not hand-edit the generated
 * asset; extend the generator instead.
 *
 * Pure data: no IO, no fetch, no React, no Date/crypto.
 */

import generatedLogTypes from "../../assets/generated-vendor-log-types.json";

/** One log type a vendor documents. */
export interface DocumentedLogType {
  /**
   * The log-type name as the VENDOR writes it. Matching against samples and
   * content is separator- and case-insensitive, so the casing here is for
   * display, not for comparison.
   */
  value: string;
  /** What this feed carries, one line, from the vendor's own wording. */
  doc?: string;
  /**
   * Other names the same feed is known by - a Sentinel rule may filter on
   * `NSSWeblog` where the vendor's docs say "ZIA Web". Matched alongside
   * {@link value}.
   */
  aliases?: readonly string[];
}

/** A per-vendor documented log-type pack. */
export interface DocumentedLogTypePack {
  /** Stable id (e.g. "zscaler-zia"). */
  id: string;
  /** Display vendor name. */
  vendor: string;
  /** Lowercased substrings matched against the solution name. */
  solutionKeywords: readonly string[];
  /** Where the knowledge comes from (doc pointer / generator tag). */
  provenance: string;
  /** Link to the vendor documentation backing the pack, when one exists. */
  docUrl?: string;
  logTypes: readonly DocumentedLogType[];
}

/**
 * HAND-VERIFIED packs, read off vendor documentation. Declared FIRST so their
 * entries win over generated ones.
 *
 * Every entry is a log type the VENDOR names in its own docs, not a guess and
 * not something inferred from a sample. When a vendor's own naming differs from
 * what Sentinel content filters on, the Sentinel form goes in `aliases` so both
 * resolve to one entry rather than showing the operator the same feed twice.
 */
const HAND_PACKS: readonly DocumentedLogTypePack[] = [
  {
    id: "zscaler-zia",
    vendor: "Zscaler",
    solutionKeywords: ["zscaler"],
    provenance:
      "Zscaler NSS feed types documented in the Zscaler and Microsoft Sentinel Deployment Guide (canonical feed definitions: github.com/zscaler/microsoft-resources)",
    docUrl:
      "https://help.zscaler.com/zscaler-technology-partners/zscaler-and-microsoft-sentinel-deployment-guide",
    logTypes: [
      {
        value: "ZIA Web",
        doc: "Web transaction log - every proxied HTTP/HTTPS request, the highest-volume ZIA feed",
        aliases: ["NSSWeblog", "web"],
      },
      {
        value: "ZIA Firewall",
        doc: "Firewall session log - non-web traffic allowed or blocked by the ZIA firewall",
        aliases: ["NSSFWlog", "firewall", "fwlog"],
      },
      {
        value: "ZIA DNS",
        doc: "DNS transaction log - resolutions and DNS-tunnelling detections",
        aliases: ["NSSDNSlog", "dns"],
      },
      {
        value: "ZIA Tunnel",
        doc: "Tunnel (GRE/IPSec) status log - tunnel establishment and teardown events",
        aliases: ["NSSTunnellog", "tunnel"],
      },
      {
        value: "ZIA Alerts",
        doc: "Administrative and system alert log",
        aliases: ["NSSAlertlog"],
      },
    ],
  },
  {
    id: "paloalto-panos",
    vendor: "Palo Alto Networks",
    solutionKeywords: ["palo alto", "paloalto", "pan-os", "panos"],
    provenance:
      "PAN-OS syslog field reference - the log types the firewall emits, matching the column dictionaries in domain/sample-parsing/panos-dictionary.ts",
    docUrl: "https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-admin/monitoring/use-syslog-for-monitoring/syslog-field-descriptions",
    logTypes: [
      { value: "TRAFFIC", doc: "Session start/end records for permitted and denied traffic" },
      { value: "THREAT", doc: "Threat, URL filtering, WildFire and data-filtering events" },
      { value: "SYSTEM", doc: "Device system events" },
      { value: "CONFIG", doc: "Configuration changes" },
      { value: "HIPMATCH", doc: "GlobalProtect Host Information Profile match records" },
      { value: "GLOBALPROTECT", doc: "GlobalProtect portal and gateway authentication and session events" },
      { value: "USERID", doc: "User-ID mapping events" },
      { value: "DECRYPTION", doc: "TLS decryption events" },
    ],
  },
  {
    id: "crowdstrike-fdr",
    vendor: "CrowdStrike",
    solutionKeywords: ["crowdstrike", "falcon"],
    provenance:
      "CrowdStrike Falcon Data Replicator event families - FDR splits by event_simpleName, and the Sentinel solution routes those families to separate custom tables",
    docUrl: "https://www.crowdstrike.com/",
    logTypes: [
      { value: "ProcessRollup2", doc: "Process execution events - the highest-volume FDR family" },
      { value: "DnsRequest", doc: "DNS resolution requests made by monitored hosts" },
      { value: "NetworkConnectIP4", doc: "Outbound IPv4 network connections" },
      { value: "NetworkReceiveAcceptIP4", doc: "Inbound IPv4 network connections" },
      { value: "UserLogon", doc: "Interactive and network logon events" },
      { value: "DetectionSummaryEvent", doc: "Detection summaries raised by the sensor" },
    ],
  },
  {
    id: "fortinet-fortigate",
    vendor: "Fortinet",
    solutionKeywords: ["fortinet", "fortigate"],
    provenance:
      "FortiGate log types documented in the FortiOS Log Reference - the firewall's `type` field partitions its syslog output",
    docUrl: "https://docs.fortinet.com/document/fortigate/latest/fortios-log-message-reference",
    logTypes: [
      { value: "traffic", doc: "Session logs for forwarded, local and multicast traffic" },
      { value: "utm", doc: "Security profile events - antivirus, IPS, web filter, application control" },
      { value: "event", doc: "System, VPN, user and admin events" },
      { value: "anomaly", doc: "DoS policy anomaly detections" },
    ],
  },
  {
    id: "cisco-asa",
    vendor: "Cisco",
    solutionKeywords: ["cisco asa", "cisco-asa", "ciscoasa"],
    provenance:
      "Cisco ASA syslog message classes - ASA partitions its syslog by message class rather than a single type field",
    docUrl:
      "https://www.cisco.com/c/en/us/td/docs/security/asa/syslog/b_syslog.html",
    logTypes: [
      { value: "Connection", doc: "Connection build-up and tear-down messages (the %ASA-6-302xxx family)" },
      { value: "Access List", doc: "ACL permit and deny messages" },
      { value: "VPN", doc: "IPsec and SSL VPN session events" },
      { value: "Authentication", doc: "AAA authentication and authorization events" },
    ],
  },
];

/** Shape guard for a generated pack read off the JSON asset. */
function isGeneratedPack(value: unknown): value is DocumentedLogTypePack {
  const v = value as Partial<DocumentedLogTypePack> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.id === "string" &&
    typeof v.vendor === "string" &&
    Array.isArray(v.solutionKeywords) &&
    typeof v.provenance === "string" &&
    Array.isArray(v.logTypes)
  );
}

/**
 * Every pack, HAND FIRST so hand entries win the per-value dedupe - the same
 * declaration-order precedence VENDOR_MAPPING_PACKS uses.
 */
export const DOCUMENTED_LOG_TYPE_PACKS: readonly DocumentedLogTypePack[] = [
  ...HAND_PACKS,
  ...(Array.isArray(generatedLogTypes)
    ? (generatedLogTypes as unknown[]).filter(isGeneratedPack)
    : []),
];

/** Collapse a name for comparison: lowercase, alphanumerics only. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The packs whose keywords match a solution name, in declaration order. */
export function documentedLogTypePacksForSolution(
  solutionName: string,
): DocumentedLogTypePack[] {
  const haystack = solutionName.trim().toLowerCase();
  if (haystack === "") return [];
  return DOCUMENTED_LOG_TYPE_PACKS.filter((pack) =>
    pack.solutionKeywords.some((k) => haystack.includes(k)),
  );
}

/** One vendor-documented log type, carrying which pack vouched for it. */
export interface DocumentedLogTypeEntry extends DocumentedLogType {
  vendor: string;
  provenance: string;
  docUrl?: string;
}

/**
 * The vendor-documented log types for a solution: every matching pack's entries
 * in declaration order, deduplicated by VALUE (first wins, so a hand pack's
 * cited entry beats a generated data-stream name for the same feed).
 *
 * Aliases participate in the dedupe: a generated `web` stream must not appear
 * beside the hand-curated "ZIA Web" that lists `web` as an alias, or the
 * operator sees one feed twice under two names.
 */
export function documentedLogTypesForSolution(
  solutionName: string,
): DocumentedLogTypeEntry[] {
  const out: DocumentedLogTypeEntry[] = [];
  const seen = new Set<string>();
  for (const pack of documentedLogTypePacksForSolution(solutionName)) {
    for (const logType of pack.logTypes) {
      const keys = [logType.value, ...(logType.aliases ?? [])].map(normalize);
      if (keys.some((k) => seen.has(k))) continue;
      for (const k of keys) seen.add(k);
      out.push({
        ...logType,
        vendor: pack.vendor,
        provenance: pack.provenance,
        ...(pack.docUrl !== undefined ? { docUrl: pack.docUrl } : {}),
      });
    }
  }
  return out;
}
