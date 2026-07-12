/**
 * VENDOR MAPPING PACKS - documented per-vendor field mappings fed to the
 * matcher's Phase 0 (its highest-priority tier, which shipped with the legacy
 * port but was never wired: every caller passed `undefined`).
 *
 * A pack states, from the VENDOR'S OWN DOCUMENTATION, that source field X is
 * destination column Y - deterministic and labeled ("Vendor mapping" in the
 * review table), where the alias/fuzzy ladder merely infers. Sources:
 *
 *  - HAND-VERIFIED packs written from vendor docs (Zscaler NSS feed output
 *    format + ZIA CEF mapping guide), cross-checked against the live sample
 *    corpus (elastic/integrations test fixtures).
 *  - GENERATED packs mined from elastic/integrations pipeline test fixtures:
 *    each raw-event/-expected.json pair documents vendor field -> ECS field
 *    (maintained by Elastic against vendor docs); a curated ECS -> Sentinel
 *    bridge completes the chain. Regenerate with
 *    scripts/generate-vendor-packs.mjs; NEVER hand-edit the generated asset.
 *
 * Resolution rules (pinned):
 *  - Packs match a solution by lowercased keyword containment.
 *  - EVERY matching pack contributes, in declaration order (hand packs are
 *    declared before generated ones), deduplicated by source name -
 *    first-declared wins, so a hand-verified entry always beats a mined one.
 *  - The analyzeSamples usecase applies a pack entry ONLY when its
 *    destination column exists in the resolved schema (Phase 0 itself would
 *    otherwise map onto a nonexistent column).
 *  - Log-type-AMBIGUOUS fields are deliberately absent from packs (e.g.
 *    Zscaler's `proto` means HTTP_PROXY in web logs but TCP in firewall
 *    logs); those stay with the alias ladder.
 *
 * Pure data + pure lookup: no IO, no fetch, no React, no Date/crypto.
 */

import type { VendorMapping } from "./match-fields";
import generatedPacks from "../../assets/generated-vendor-packs.json";
import sentinelDcrPacks from "../../assets/generated-sentinel-dcr-packs.json";

/** One documented source -> destination mapping. */
export interface VendorPackEntry {
  sourceName: string;
  destName: string;
  /**
   * How the pipeline realizes it. "map" (default) renames/keeps; "decode"
   * base64-decodes the source into the destination (the source carries the
   * destination's data encoded - e.g. Zscaler b64url).
   */
  action?: "map" | "decode";
  /**
   * CEF custom-column label contract: when the destination is a
   * DeviceCustomString/Number column, the vendor's feed also sets the
   * companion <destName>Label column to this literal (e.g. cs1Label=dept)
   * so queries can interpret the payload. When set, applying this mapping
   * also seeds the label constant as an editable enrichment - see
   * {@link vendorLabelEnrichments}.
   */
  label?: string;
  /** Vendor-documentation citation for this field (hand packs). */
  doc?: string;
  /** The mined ECS path (generated packs; the generator writes it). */
  ecs?: string;
}

/** A per-vendor documented mapping pack. */
export interface VendorMappingPack {
  /** Stable id (e.g. "zscaler-zia"). */
  id: string;
  /** Display vendor name. */
  vendor: string;
  /** Lowercased substrings matched against the solution name. */
  solutionKeywords: readonly string[];
  /** Where the mapping knowledge comes from (doc pointer / generator tag). */
  provenance: string;
  /** Link to the vendor documentation backing the pack, when one exists. */
  docUrl?: string;
  mappings: readonly VendorPackEntry[];
}

/**
 * HAND-VERIFIED packs (vendor documentation, cross-checked against the live
 * sample corpus). Declared FIRST so their entries win over generated ones.
 */
const HAND_PACKS: readonly VendorMappingPack[] = [
  {
    id: "zscaler-zia",
    vendor: "Zscaler",
    solutionKeywords: ["zscaler"],
    provenance:
      "Zscaler NSS feed output format (web/firewall/dns) + Zscaler and Microsoft Sentinel Deployment Guide (canonical feed: github.com/zscaler/microsoft-resources)",
    docUrl:
      "https://help.zscaler.com/zscaler-technology-partners/zscaler-and-microsoft-sentinel-deployment-guide",
    mappings: [
      // Web (NSS web feed)
      { sourceName: "login", destName: "SourceUserName", doc: "NSS web: login/email of the transaction owner" },
      { sourceName: "cltip", destName: "SourceIP", doc: "NSS web: client IP address of the transaction" },
      { sourceName: "cltpubip", destName: "SourceTranslatedAddress", doc: "NSS web: public client IP as seen by Zscaler" },
      { sourceName: "cltsourceport", destName: "SourcePort", doc: "NSS web: client source port" },
      { sourceName: "serverip", destName: "DestinationIP", doc: "NSS web: destination server IP" },
      { sourceName: "reqmethod", destName: "RequestMethod", doc: "NSS web: HTTP request method" },
      { sourceName: "respcode", destName: "EventOutcome", doc: "NSS web: HTTP response status code" },
      { sourceName: "reqsize", destName: "SentBytes", doc: "NSS web: request bytes (client to server)" },
      { sourceName: "respsize", destName: "ReceivedBytes", doc: "NSS web: response bytes (server to client)" },
      { sourceName: "useragent", destName: "RequestClientApplication", doc: "NSS web: full user agent string" },
      // The NSS web feed carries the URL and referer base64-ENCODED; decode
      // them into their columns (a rename would land base64 text where rules
      // filter on decoded URLs). b64referer is declared BEFORE refererhost
      // so the full decoded referer wins the per-sample dest collision;
      // refererhost stays as the fallback for feeds without b64 fields.
      { sourceName: "b64url", destName: "RequestURL", action: "decode", doc: "NSS web: full URL, base64-encoded by the feed" },
      { sourceName: "b64referer", destName: "RequestContext", action: "decode", doc: "NSS web: full referer URL, base64-encoded by the feed" },
      { sourceName: "refererhost", destName: "RequestContext", doc: "NSS web: host portion of the HTTP referer" },
      { sourceName: "host", destName: "DestinationHostName", doc: "NSS web: destination host of the request" },
      { sourceName: "filetype", destName: "FileType", doc: "NSS web: type of the transferred file" },
      { sourceName: "devicehostname", destName: "SourceHostName", doc: "NSS web: client device hostname (Client Connector)" },
      { sourceName: "applayerprotocol", destName: "ApplicationProtocol", doc: "NSS web: application-layer protocol" },
      { sourceName: "epochtime", destName: "ReceiptTime", doc: "NSS web: transaction time, epoch seconds" },
      { sourceName: "url", destName: "RequestURL", doc: "NSS web: full URL (feeds configured un-encoded)" },
      { sourceName: "action", destName: "DeviceAction", doc: "NSS: action Zscaler applied (allowed/blocked)" },
      // VENDOR PARITY (2026-07-12): the remaining named-column mappings from
      // Zscaler's own Microsoft Sentinel feed definition (nss-web.cef /
      // cloud-nss-web.fof in github.com/zscaler/microsoft-resources), so our
      // coverage is a superset of the vendor's published integration. Label
      // literals are VERBATIM from the feed (cs1Label=dept ... cn1Label=
      // riskscore). bamd5 (feed: fileHash={bamd5}) is DELIBERATELY absent:
      // the alias ladder already maps sha256 -> FileHash, and a Phase-0
      // bamd5 entry would outrank the stronger hash.
      { sourceName: "urlcat", destName: "DeviceEventCategory", doc: "Sentinel feed: cat={urlcat} - URL category" },
      { sourceName: "urlsubcat", destName: "DeviceEventCategory", doc: "Cloud NSS raw name for the URL category (CEF feed: cat={urlcat})" },
      { sourceName: "location", destName: "SourceUserPrivileges", doc: "Sentinel feed: spriv={location} - Zscaler location of the transaction" },
      { sourceName: "appname", destName: "DestinationServiceName", doc: "Sentinel feed: destinationServiceName={appname} - cloud application" },
      { sourceName: "dept", destName: "DeviceCustomString1", label: "dept", doc: "Sentinel feed: cs1={dept}, cs1Label=dept - user department" },
      { sourceName: "urlsupercat", destName: "DeviceCustomString2", label: "urlsupercat", doc: "Sentinel feed: cs2={urlsupercat}, cs2Label=urlsupercat - URL super category" },
      { sourceName: "appclass", destName: "DeviceCustomString3", label: "appclass", doc: "Sentinel feed: cs3={appclass}, cs3Label=appclass - application class" },
      { sourceName: "malwarecat", destName: "DeviceCustomString4", label: "malwarecat", doc: "Sentinel feed: cs4={malwarecat}, cs4Label=malwarecat - malware category" },
      { sourceName: "malwarecategory", destName: "DeviceCustomString4", label: "malwarecat", doc: "Cloud NSS raw name for the malware category (CEF feed: cs4={malwarecat})" },
      { sourceName: "threatname", destName: "DeviceCustomString5", label: "threatname", doc: "Sentinel feed: cs5={threatname}, cs5Label=threatname - threat name" },
      { sourceName: "dlpeng", destName: "DeviceCustomString6", label: "dlpeng", doc: "Sentinel feed: cs6={dlpeng}, cs6Label=dlpeng - DLP engine" },
      { sourceName: "riskscore", destName: "DeviceCustomNumber1", label: "riskscore", doc: "Sentinel feed: cn1={riskscore}, cn1Label=riskscore - application risk score" },
      // Firewall (NSS firewall feed): c=client-side, s=server-side post-NAT
      { sourceName: "csip", destName: "SourceIP", doc: "NSS firewall: client source IP" },
      { sourceName: "csport", destName: "SourcePort", doc: "NSS firewall: client source port" },
      { sourceName: "cdip", destName: "DestinationIP", doc: "NSS firewall: client destination IP" },
      { sourceName: "cdport", destName: "DestinationPort", doc: "NSS firewall: client destination port" },
      { sourceName: "ssip", destName: "SourceTranslatedAddress", doc: "NSS firewall: server source IP (post-NAT egress)" },
      { sourceName: "ssport", destName: "SourceTranslatedPort", doc: "NSS firewall: server source port (post-NAT egress)" },
      { sourceName: "sdip", destName: "DestinationTranslatedAddress", doc: "NSS firewall: server destination IP" },
      { sourceName: "sdport", destName: "DestinationTranslatedPort", doc: "NSS firewall: server destination port" },
      { sourceName: "inbytes", destName: "ReceivedBytes", doc: "NSS firewall: bytes received" },
      { sourceName: "outbytes", destName: "SentBytes", doc: "NSS firewall: bytes sent" },
      { sourceName: "nwsvc", destName: "ApplicationProtocol", doc: "NSS firewall: network service (application protocol)" },
      { sourceName: "user", destName: "SourceUserName", doc: "NSS firewall: user who owns the session" },
      { sourceName: "recordid", destName: "ExternalID", doc: "NSS: unique record identifier" },
      { sourceName: "datetime", destName: "ReceiptTime", doc: "NSS firewall: transaction date and time" },
      // DNS (NSS dns feed)
      { sourceName: "dns_req", destName: "DestinationDnsDomain", doc: "NSS dns: requested domain name" },
      { sourceName: "clt_sip", destName: "SourceIP", doc: "NSS dns: client source IP" },
      { sourceName: "srv_dip", destName: "DestinationIP", doc: "NSS dns: resolver destination IP" },
      { sourceName: "srv_dport", destName: "DestinationPort", doc: "NSS dns: resolver destination port" },
      { sourceName: "reqaction", destName: "DeviceAction", doc: "NSS dns: action taken on the DNS request" },
      { sourceName: "http_code", destName: "EventOutcome", doc: "NSS dns: response code of the transaction" },
      { sourceName: "error", destName: "Reason", doc: "NSS dns: error reason" },
    ],
  },
  {
    id: "crowdstrike-corrections",
    vendor: "CrowdStrike",
    solutionKeywords: ["crowdstrike"],
    provenance:
      "Hand corrections over the generated crowdstrike pack (FDR field docs)",
    mappings: [
      // Elastic maps event_simpleName to ecs event.action, but in CSL terms
      // it is the event NAME (ProcessRollup2, DnsRequest...), not an
      // allow/block disposition - Activity is the faithful column. Declared
      // before the generated pack so this entry wins the dedupe.
      { sourceName: "event_simpleName", destName: "Activity" },
    ],
  },
];

/**
 * CATALOG-ONLY pack: Microsoft's documented CEF key -> CommonSecurityLog
 * column mapping - the shared vocabulary MOST CEF/syslog Sentinel solutions
 * ride, which the alias ladder already applies at RUNTIME. Its
 * solutionKeywords are deliberately EMPTY so vendorPacksForSolution never
 * feeds it into Phase 0 (that would duplicate the aliases); it exists so the
 * Mapping Catalog can show, with citations, the coverage every CEF vendor
 * gets. Source: learn.microsoft.com/azure/sentinel/cef-name-mapping.
 */
export const CEF_CATALOG_PACK: VendorMappingPack = {
  id: "cef-standard",
  vendor: "CEF (all vendors)",
  solutionKeywords: [],
  provenance:
    "Microsoft Sentinel CEF connector field mapping (applies to every CEF/syslog vendor via the alias ladder)",
  docUrl: "https://learn.microsoft.com/azure/sentinel/cef-name-mapping",
  mappings: [
      { sourceName: "act", destName: "DeviceAction", doc: "CEF act: Action mentioned in the event" },
      { sourceName: "app", destName: "ApplicationProtocol", doc: "CEF app: Application-layer protocol (HTTP, HTTPS, SSH...)" },
      { sourceName: "cat", destName: "DeviceEventCategory", doc: "CEF cat: Event category the device assigns" },
      { sourceName: "cnt", destName: "EventCount", doc: "CEF cnt: Number of aggregated events" },
      { sourceName: "deviceDirection", destName: "CommunicationDirection", doc: "CEF deviceDirection: Direction of the observed communication" },
      { sourceName: "deviceDnsDomain", destName: "DeviceDnsDomain", doc: "CEF deviceDnsDomain: DNS domain of the reporting device" },
      { sourceName: "deviceExternalId", destName: "DeviceExternalID", doc: "CEF deviceExternalId: Unique identifier of the reporting device" },
      { sourceName: "deviceFacility", destName: "DeviceFacility", doc: "CEF deviceFacility: Facility generating the event" },
      { sourceName: "deviceInboundInterface", destName: "DeviceInboundInterface", doc: "CEF deviceInboundInterface: Interface the connection entered on" },
      { sourceName: "deviceOutboundInterface", destName: "DeviceOutboundInterface", doc: "CEF deviceOutboundInterface: Interface the connection left on" },
      { sourceName: "deviceProcessName", destName: "ProcessName", doc: "CEF deviceProcessName: Process associated with the event" },
      { sourceName: "dhost", destName: "DestinationHostName", doc: "CEF dhost: Destination host name (FQDN)" },
      { sourceName: "dmac", destName: "DestinationMACAddress", doc: "CEF dmac: Destination MAC address" },
      { sourceName: "dntdom", destName: "DestinationNTDomain", doc: "CEF dntdom: Windows domain of the destination user" },
      { sourceName: "dpid", destName: "DestinationProcessId", doc: "CEF dpid: Destination process id" },
      { sourceName: "dproc", destName: "DestinationProcessName", doc: "CEF dproc: Destination process name" },
      { sourceName: "dpt", destName: "DestinationPort", doc: "CEF dpt: Destination port" },
      { sourceName: "dst", destName: "DestinationIP", doc: "CEF dst: Destination IPv4 address" },
      { sourceName: "duid", destName: "DestinationUserID", doc: "CEF duid: Destination user id" },
      { sourceName: "duser", destName: "DestinationUserName", doc: "CEF duser: Destination user name (UPN preferred)" },
      { sourceName: "dvc", destName: "DeviceAddress", doc: "CEF dvc: IPv4 address of the reporting device" },
      { sourceName: "dvchost", destName: "DeviceName", doc: "CEF dvchost: Host name (FQDN) of the reporting device" },
      { sourceName: "end", destName: "EndTime", doc: "CEF end: Time the activity ended" },
      { sourceName: "externalId", destName: "ExternalID", doc: "CEF externalId: Id the reporting device assigns the event" },
      { sourceName: "fname", destName: "FileName", doc: "CEF fname: File name" },
      { sourceName: "filePath", destName: "FilePath", doc: "CEF filePath: Full file path including the name" },
      { sourceName: "fileHash", destName: "FileHash", doc: "CEF fileHash: File digest" },
      { sourceName: "fsize", destName: "FileSize", doc: "CEF fsize: File size in bytes" },
      { sourceName: "in", destName: "ReceivedBytes", doc: "CEF in: Bytes transferred inbound" },
      { sourceName: "msg", destName: "Message", doc: "CEF msg: Human-readable event detail" },
      { sourceName: "out", destName: "SentBytes", doc: "CEF out: Bytes transferred outbound" },
      { sourceName: "outcome", destName: "EventOutcome", doc: "CEF outcome: Outcome of the event (e.g. success/failure)" },
      { sourceName: "proto", destName: "Protocol", doc: "CEF proto: Transport protocol (TCP, UDP...)" },
      { sourceName: "reason", destName: "Reason", doc: "CEF reason: Reason for the audit/action" },
      { sourceName: "request", destName: "RequestURL", doc: "CEF request: URL accessed in the request" },
      { sourceName: "requestClientApplication", destName: "RequestClientApplication", doc: "CEF requestClientApplication: User agent of the request" },
      { sourceName: "requestContext", destName: "RequestContext", doc: "CEF requestContext: Context of the request (e.g. the HTTP referer)" },
      { sourceName: "requestMethod", destName: "RequestMethod", doc: "CEF requestMethod: HTTP method of the request" },
      { sourceName: "rt", destName: "ReceiptTime", doc: "CEF rt: Time the event was received" },
      { sourceName: "shost", destName: "SourceHostName", doc: "CEF shost: Source host name (FQDN)" },
      { sourceName: "smac", destName: "SourceMACAddress", doc: "CEF smac: Source MAC address" },
      { sourceName: "sntdom", destName: "SourceNTDomain", doc: "CEF sntdom: Windows domain of the source user" },
      { sourceName: "spid", destName: "SourceProcessId", doc: "CEF spid: Source process id" },
      { sourceName: "sproc", destName: "SourceProcessName", doc: "CEF sproc: Source process name" },
      { sourceName: "spt", destName: "SourcePort", doc: "CEF spt: Source port" },
      { sourceName: "src", destName: "SourceIP", doc: "CEF src: Source IPv4 address" },
      { sourceName: "start", destName: "StartTime", doc: "CEF start: Time the activity started" },
      { sourceName: "suid", destName: "SourceUserID", doc: "CEF suid: Source user id" },
      { sourceName: "suser", destName: "SourceUserName", doc: "CEF suser: Source user name (UPN preferred)" },
  ],
};

function isGeneratedPack(value: unknown): value is VendorMappingPack {
  const v = value as VendorMappingPack;
  return (
    typeof v?.id === "string" &&
    typeof v?.vendor === "string" &&
    Array.isArray(v?.solutionKeywords) &&
    Array.isArray(v?.mappings)
  );
}

/**
 * Every pack, in AUTHORITY order (first-declared wins the per-source dedupe):
 *  1. HAND-VERIFIED packs (vendor docs, human-checked).
 *  2. SENTINEL-DCR packs - mined from the Azure-Sentinel repo's CCP DCR
 *     transformKql projections, the exact transform Microsoft runs at
 *     ingestion (scripts/generate-sentinel-dcr-packs.mjs).
 *  3. ELASTIC-MINED packs - value-vote mining over elastic/integrations
 *     pipeline fixtures (scripts/generate-vendor-packs.mjs).
 * The catalog-only CEF pack rides along for display; its empty keyword list
 * keeps it out of every runtime lookup.
 */
export const VENDOR_MAPPING_PACKS: readonly VendorMappingPack[] = [
  ...HAND_PACKS,
  CEF_CATALOG_PACK,
  ...(Array.isArray(sentinelDcrPacks)
    ? (sentinelDcrPacks as unknown[]).filter(isGeneratedPack)
    : []),
  ...(Array.isArray(generatedPacks)
    ? (generatedPacks as unknown[]).filter(isGeneratedPack)
    : []),
];

/**
 * THE dedupe rule shared by the runtime lookup and the catalog's merged
 * view: first-declared entry wins per lowercased source name (hand packs
 * are declared before generated ones). Appends the survivors of `incoming`
 * onto `accepted` in place and returns it.
 */
export function foldEntriesBySource<T extends { sourceName: string }>(
  accepted: T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set(accepted.map((e) => e.sourceName.toLowerCase()));
  for (const entry of incoming) {
    const key = entry.sourceName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(entry);
  }
  return accepted;
}

/** The packs whose keywords match a solution name, in declaration order. */
export function vendorPacksForSolution(
  solutionName: string,
): VendorMappingPack[] {
  const haystack = solutionName.trim().toLowerCase();
  if (haystack === "") return [];
  return VENDOR_MAPPING_PACKS.filter((pack) =>
    pack.solutionKeywords.some((k) => haystack.includes(k)),
  );
}

/**
 * The Phase-0 vendor mappings for a solution: every matching pack's entries
 * in declaration order, deduplicated by SOURCE name (first wins - hand packs
 * are declared first). Destination names deliberately repeat across entries:
 * a vendor's web, firewall, and dns feeds map DIFFERENT source fields onto
 * the same column (cltip/csip/clt_sip -> SourceIP) and only one feed appears
 * in a given sample - the per-sample destination-collision guard lives in
 * the analyzeSamples usecase, which sees the actual fields. Types are left
 * empty: Phase 0 prefers the live sample/schema types when present.
 */
export function vendorMappingsForSolution(
  solutionName: string,
): VendorMapping[] {
  const deduped: VendorPackEntry[] = [];
  for (const pack of vendorPacksForSolution(solutionName)) {
    foldEntriesBySource(deduped, pack.mappings);
  }
  return deduped.map((entry) => {
    const description =
      entry.doc ??
      (entry.ecs !== undefined ? `Elastic ECS: ${entry.ecs}` : undefined);
    return {
      sourceName: entry.sourceName,
      destName: entry.destName,
      sourceType: "",
      destType: "",
      action: entry.action ?? "map",
      ...(description !== undefined ? { description } : {}),
    };
  });
}

/** One label constant a pack entry demands when its mapping applies. */
export interface VendorLabelEnrichment {
  /** The pack entry's source field - seed only when this mapping applied. */
  sourceName: string;
  /** The pack entry's destination column (the custom column carrying data). */
  destName: string;
  /** The companion label column to set (e.g. DeviceCustomString1Label). */
  field: string;
  /** The vendor-documented label literal (e.g. "dept"). */
  value: string;
}

/**
 * The CEF label constants a solution's packs demand: for every entry with a
 * `label`, the companion `<destName>Label` column must carry the vendor's
 * literal so queries can interpret the custom column. The caller seeds each
 * one as an editable enrichment ONLY for reports where the entry's mapping
 * actually applied (source present, destination claimed).
 */
export function vendorLabelEnrichments(
  solutionName: string,
): VendorLabelEnrichment[] {
  const deduped: VendorPackEntry[] = [];
  for (const pack of vendorPacksForSolution(solutionName)) {
    foldEntriesBySource(deduped, pack.mappings);
  }
  return deduped
    .filter((entry) => entry.label !== undefined && entry.label !== "")
    .map((entry) => ({
      sourceName: entry.sourceName,
      destName: entry.destName,
      field: `${entry.destName}Label`,
      value: entry.label as string,
    }));
}
