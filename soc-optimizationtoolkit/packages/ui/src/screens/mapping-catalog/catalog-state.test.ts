/**
 * Pins for the Vendor Mapping Catalog projections (user request 2026-07-09:
 * a browsable, vendor-documented catalog of suggested Sentinel mappings).
 */

import { describe, expect, it } from "vitest";
import type { VendorMappingPack } from "@soc/core";
import { catalogTotals, entryDocLine, filterCatalog } from "./catalog-state";

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
    id: "generated-suricata",
    vendor: "Suricata",
    solutionKeywords: ["suricata"],
    provenance: "Generated from elastic/integrations fixtures",
    mappings: [
      { sourceName: "app_proto", destName: "ApplicationProtocol", ecs: "network.protocol" },
    ],
  },
];

describe("entryDocLine", () => {
  it("prefers the vendor doc, falls back to the mined ECS path", () => {
    expect(entryDocLine(PACKS[0].mappings[0])).toContain("base64-encoded");
    expect(entryDocLine(PACKS[1].mappings[0])).toBe(
      "Mined from Elastic pipeline fixtures (ECS: network.protocol)",
    );
    expect(entryDocLine({ sourceName: "x", destName: "Y" })).toBe("");
  });
});

describe("filterCatalog", () => {
  it("keeps everything on a blank query", () => {
    const views = filterCatalog(PACKS, "");
    expect(views).toHaveLength(2);
    expect(views[0].entries).toHaveLength(2);
    expect(views[0].docUrl).toContain("help.zscaler.com");
  });

  it("filters entries by source, destination, or documentation text", () => {
    expect(filterCatalog(PACKS, "b64url")[0].entries).toHaveLength(1);
    expect(filterCatalog(PACKS, "sourceip")[0].entries).toHaveLength(1);
    expect(filterCatalog(PACKS, "base64")[0].entries).toHaveLength(1);
    expect(filterCatalog(PACKS, "network.protocol")).toHaveLength(1);
  });

  it("a vendor-name hit keeps the whole pack; empty packs drop", () => {
    const views = filterCatalog(PACKS, "zscaler");
    expect(views).toHaveLength(1);
    expect(views[0].entries).toHaveLength(2);
  });

  it("counts totals across the catalog", () => {
    expect(catalogTotals(PACKS)).toEqual({ packs: 2, mappings: 3 });
  });
});
