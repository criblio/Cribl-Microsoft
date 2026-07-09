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

/** One documented source -> destination mapping. */
export interface VendorPackEntry {
  sourceName: string;
  destName: string;
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
      "Zscaler NSS feed output format (web/firewall/dns) + ZIA CEF mapping guide",
    mappings: [
      // Web (NSS web feed)
      { sourceName: "login", destName: "SourceUserName" },
      { sourceName: "cltip", destName: "SourceIP" },
      { sourceName: "cltpubip", destName: "SourceTranslatedAddress" },
      { sourceName: "cltsourceport", destName: "SourcePort" },
      { sourceName: "serverip", destName: "DestinationIP" },
      { sourceName: "reqmethod", destName: "RequestMethod" },
      { sourceName: "respcode", destName: "EventOutcome" },
      { sourceName: "reqsize", destName: "SentBytes" },
      { sourceName: "respsize", destName: "ReceivedBytes" },
      { sourceName: "useragent", destName: "RequestClientApplication" },
      { sourceName: "refererhost", destName: "RequestContext" },
      { sourceName: "host", destName: "DestinationHostName" },
      { sourceName: "filetype", destName: "FileType" },
      { sourceName: "devicehostname", destName: "SourceHostName" },
      { sourceName: "applayerprotocol", destName: "ApplicationProtocol" },
      { sourceName: "epochtime", destName: "ReceiptTime" },
      { sourceName: "url", destName: "RequestURL" },
      { sourceName: "action", destName: "DeviceAction" },
      // Firewall (NSS firewall feed): c=client-side, s=server-side post-NAT
      { sourceName: "csip", destName: "SourceIP" },
      { sourceName: "csport", destName: "SourcePort" },
      { sourceName: "cdip", destName: "DestinationIP" },
      { sourceName: "cdport", destName: "DestinationPort" },
      { sourceName: "ssip", destName: "SourceTranslatedAddress" },
      { sourceName: "ssport", destName: "SourceTranslatedPort" },
      { sourceName: "sdip", destName: "DestinationTranslatedAddress" },
      { sourceName: "sdport", destName: "DestinationTranslatedPort" },
      { sourceName: "inbytes", destName: "ReceivedBytes" },
      { sourceName: "outbytes", destName: "SentBytes" },
      { sourceName: "nwsvc", destName: "ApplicationProtocol" },
      { sourceName: "user", destName: "SourceUserName" },
      { sourceName: "recordid", destName: "ExternalID" },
      { sourceName: "datetime", destName: "ReceiptTime" },
      // DNS (NSS dns feed)
      { sourceName: "dns_req", destName: "DestinationDnsDomain" },
      { sourceName: "clt_sip", destName: "SourceIP" },
      { sourceName: "srv_dip", destName: "DestinationIP" },
      { sourceName: "srv_dport", destName: "DestinationPort" },
      { sourceName: "reqaction", destName: "DeviceAction" },
      { sourceName: "http_code", destName: "EventOutcome" },
      { sourceName: "error", destName: "Reason" },
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

function isGeneratedPack(value: unknown): value is VendorMappingPack {
  const v = value as VendorMappingPack;
  return (
    typeof v?.id === "string" &&
    typeof v?.vendor === "string" &&
    Array.isArray(v?.solutionKeywords) &&
    Array.isArray(v?.mappings)
  );
}

/** Every pack, hand-verified first (their entries win the dedupe). */
export const VENDOR_MAPPING_PACKS: readonly VendorMappingPack[] = [
  ...HAND_PACKS,
  ...(Array.isArray(generatedPacks)
    ? (generatedPacks as unknown[]).filter(isGeneratedPack)
    : []),
];

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
  const seenSource = new Set<string>();
  const out: VendorMapping[] = [];
  for (const pack of vendorPacksForSolution(solutionName)) {
    for (const entry of pack.mappings) {
      const sourceKey = entry.sourceName.toLowerCase();
      if (seenSource.has(sourceKey)) continue;
      seenSource.add(sourceKey);
      out.push({
        sourceName: entry.sourceName,
        destName: entry.destName,
        sourceType: "",
        destType: "",
        action: "map",
      });
    }
  }
  return out;
}
