/**
 * Pins for the Vendor Mapping Catalog projections (user request 2026-07-09;
 * reshaped 2026-07-12: one MERGED view per vendor - live report: the hand and
 * generated Zscaler packs rendered as redundant cards - selected via a
 * vendor dropdown).
 */

import { describe, expect, it } from "vitest";
import type { VendorMappingPack } from "@soc/core";
import {
  catalogTotals,
  entryDocLine,
  filterVendorEntries,
  mergedVendorCatalog,
} from "./catalog-state";

const PACKS: VendorMappingPack[] = [
  {
    id: "zscaler-zia",
    vendor: "Zscaler",
    solutionKeywords: ["zscaler"],
    provenance: "Zscaler NSS feed output format",
    docUrl: "https://help.zscaler.com/zia/nss-feed-output-format-web-logs",
    mappings: [
      {
        sourceName: "b64url",
        destName: "RequestURL",
        action: "decode",
        doc: "NSS web: full URL, base64-encoded by the feed",
      },
      { sourceName: "cltip", destName: "SourceIP", doc: "NSS web: client IP" },
    ],
  },
  {
    id: "generated-zscaler_zia",
    vendor: "Zscaler",
    solutionKeywords: ["zscaler"],
    provenance: "Generated from elastic/integrations fixtures",
    mappings: [
      // Duplicate source: the hand entry above must win the merge.
      { sourceName: "cltip", destName: "DeviceAddress", ecs: "host.ip" },
      { sourceName: "dns_req", destName: "DestinationDnsDomain", ecs: "dns.question.name" },
    ],
  },
  {
    id: "generated-suricata",
    vendor: "Suricata",
    solutionKeywords: ["suricata"],
    provenance: "Generated from elastic/integrations fixtures",
    mappings: [
      { sourceName: "app_proto", destName: "ApplicationProtocol", ecs: "network.protocol" },
    ],
  },
];

describe("mergedVendorCatalog", () => {
  const catalog = mergedVendorCatalog(PACKS);

  it("renders ONE view per vendor (no redundant Zscaler cards)", () => {
    expect(catalog.map((v) => v.vendor)).toEqual(["Suricata", "Zscaler"]);
  });

  it("applies the runtime dedupe: the hand entry wins a source collision", () => {
    const zscaler = catalog.find((v) => v.vendor === "Zscaler")!;
    const cltip = zscaler.entries.find((e) => e.sourceName === "cltip")!;
    expect(cltip.destName).toBe("SourceIP");
    expect(zscaler.entries.map((e) => e.sourceName).sort()).toEqual([
      "b64url",
      "cltip",
      "dns_req",
    ]);
  });

  it("collects every contributing provenance and the first doc link", () => {
    const zscaler = catalog.find((v) => v.vendor === "Zscaler")!;
    expect(zscaler.provenances).toHaveLength(2);
    expect(zscaler.docUrl).toContain("help.zscaler.com");
  });
});

describe("filterVendorEntries / entryDocLine / totals", () => {
  const catalog = mergedVendorCatalog(PACKS);
  const zscaler = catalog.find((v) => v.vendor === "Zscaler")!;

  it("filters by source, destination, or documentation text", () => {
    expect(filterVendorEntries(zscaler, "b64url")).toHaveLength(1);
    expect(filterVendorEntries(zscaler, "sourceip")).toHaveLength(1);
    expect(filterVendorEntries(zscaler, "base64")).toHaveLength(1);
    expect(filterVendorEntries(zscaler, "")).toHaveLength(3);
  });

  it("doc line prefers the vendor doc, falls back to the mined ECS path", () => {
    expect(entryDocLine(zscaler.entries[0])).toContain("base64-encoded");
    const mined = zscaler.entries.find((e) => e.sourceName === "dns_req")!;
    expect(entryDocLine(mined)).toBe(
      "Mined from Elastic pipeline fixtures (ECS: dns.question.name)",
    );
    expect(entryDocLine({ sourceName: "x", destName: "Y" })).toBe("");
  });

  it("counts totals across the merged catalog", () => {
    expect(catalogTotals(catalog)).toEqual({ vendors: 2, mappings: 4 });
  });
});
