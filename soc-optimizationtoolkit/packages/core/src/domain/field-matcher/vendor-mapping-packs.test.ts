/**
 * Pins for the vendor mapping packs (Phase 0 knowledge; user direction
 * 2026-07-09: align mappings with vendor documentation). The dedupe/precedence
 * rules ARE the contract: hand-verified entries beat generated ones, and the
 * generated asset is machine-written (scripts/generate-vendor-packs.mjs).
 */

import { describe, expect, it } from "vitest";
import {
  CEF_CATALOG_PACK,
  VENDOR_MAPPING_PACKS,
  vendorMappingsForSolution,
  vendorPacksForSolution,
} from "./vendor-mapping-packs";
import { matchFields } from "./match-fields";
import { documentedLogTypePacksForSolution } from "../log-type-catalog/vendor-log-types";

describe("vendorPacksForSolution", () => {
  it("matches the Zscaler solution to both the hand and generated packs", () => {
    const packs = vendorPacksForSolution("Zscaler Internet Access");
    const ids = packs.map((p) => p.id);
    expect(ids).toContain("zscaler-zia");
    expect(ids).toContain("generated-zscaler_zia");
    // Hand pack first: declaration order is the dedupe precedence.
    expect(ids.indexOf("zscaler-zia")).toBeLessThan(
      ids.indexOf("generated-zscaler_zia"),
    );
  });

  it("returns no packs for uncurated solutions and empty names", () => {
    // Cloudflare graduated to a generated pack on 2026-07-12; Barracuda
    // remains alias-ladder-only.
    expect(vendorPacksForSolution("Barracuda CloudGen Firewall")).toEqual([]);
    expect(vendorPacksForSolution("")).toEqual([]);
  });

  it("does NOT claim a SIBLING PRODUCT's solution (Zscaler ZPA)", () => {
    // The 2026-08-20 audit case. Every "Zscaler Private Access" solution name
    // contains "zscaler", so all three ZIA packs - hand, mined Sentinel DCR,
    // Elastic-mined - claimed a ZPA solution and the review table cited
    // Zscaler's NSS web feed as the documentation for fields ZPA has never
    // emitted. Meanwhile the log-type recommendation, ON THE SAME SCREEN,
    // correctly offered ZPA's LSS feeds: two vendor claims about one solution.
    // ZPA has no mapping pack; the alias ladder covers it.
    expect(vendorPacksForSolution("Zscaler Private Access")).toEqual([]);
    expect(vendorMappingsForSolution("Zscaler Private Access")).toEqual([]);
    expect(vendorPacksForSolution("Zscaler ZPA")).toEqual([]);

    // ZIA is untouched: the exclusion must not cost the product it curates.
    const zia = vendorPacksForSolution("Zscaler Internet Access").map(
      (p) => p.id,
    );
    expect(zia).toContain("zscaler-zia");
    expect(zia).toContain("sentinel-dcr-zscaler");
    expect(zia).toContain("generated-zscaler_zia");
  });

  it("agrees with the log-type catalog about WHICH PRODUCT a solution is", () => {
    // The two matchers are one predicate now (packAppliesToSolution). Pinned
    // across the modules because that is exactly where they disagreed, and the
    // two answers render on one screen: whichever side learns an exclusion,
    // the other can no longer miss it.
    //
    // Pack ids are compared, not vendor labels - both Zscaler products carry
    // the vendor name "Zscaler", so a vendor-level check would not see this.
    const zpaMappingIds = vendorPacksForSolution("Zscaler Private Access").map(
      (p) => p.id,
    );
    const zpaLogTypeIds = documentedLogTypePacksForSolution(
      "Zscaler Private Access",
    ).map((p) => p.id);

    // Neither module offers ZIA to a ZPA operator...
    expect(zpaMappingIds).not.toContain("zscaler-zia");
    expect(zpaLogTypeIds).not.toContain("zscaler-zia");
    // ...and the catalog still identifies the product correctly.
    expect(zpaLogTypeIds).toEqual(["zscaler-zpa"]);

    // The mirror case: ZIA resolves to ZIA on both sides.
    expect(vendorPacksForSolution("Zscaler Internet Access").map((p) => p.id))
      .toContain("zscaler-zia");
    expect(
      documentedLogTypePacksForSolution("Zscaler Internet Access").map(
        (p) => p.id,
      ),
    ).toEqual(["zscaler-zia"]);
  });
});

describe("vendorMappingsForSolution", () => {
  const zscaler = vendorMappingsForSolution("Zscaler Internet Access");
  const byName = new Map(zscaler.map((m) => [m.sourceName, m.destName]));

  it("hand-verified entries win the per-source dedupe over mined ones", () => {
    // The miner paired srv_dport with source.port off a value collision in
    // the fixtures; the hand pack (Zscaler NSS dns feed docs) says the
    // server DESTINATION port. Hand wins.
    expect(byName.get("srv_dport")).toBe("DestinationPort");
  });

  it("keeps repeated destinations across feed vocabularies", () => {
    // web cltip, firewall csip, and dns clt_sip ALL map to SourceIP - only
    // one feed appears per sample, so all three entries must survive.
    expect(byName.get("cltip")).toBe("SourceIP");
    expect(byName.get("csip")).toBe("SourceIP");
    expect(byName.get("clt_sip")).toBe("SourceIP");
  });

  it("corrects the mined CrowdStrike event_simpleName mapping", () => {
    const cs = vendorMappingsForSolution("CrowdStrike Falcon Endpoint Protection");
    const map = new Map(cs.map((m) => [m.sourceName, m.destName]));
    // Elastic maps event_simpleName to event.action (-> DeviceAction); in
    // CSL terms it is the event NAME - the hand correction wins.
    expect(map.get("event_simpleName")).toBe("Activity");
    // And a purely mined entry still flows through.
    expect(map.get("LocalAddressIP4")).toBe("SourceIP");
  });

  it("every pack mapping is Phase-0 shaped (map/decode action, empty types)", () => {
    for (const m of vendorMappingsForSolution("Zscaler Internet Access")) {
      expect(["map", "decode"]).toContain(m.action);
      expect(m.sourceType).toBe("");
      expect(m.destType).toBe("");
    }
  });

  it("all packs carry provenance", () => {
    for (const pack of VENDOR_MAPPING_PACKS) {
      expect(pack.provenance.trim()).not.toBe("");
    }
  });
});

describe("CEF catalog-only pack", () => {
  it("ships the documented CEF vocabulary for the catalog", () => {
    expect(CEF_CATALOG_PACK.mappings.length).toBeGreaterThanOrEqual(45);
    const byName = new Map(
      CEF_CATALOG_PACK.mappings.map((m) => [m.sourceName, m.destName]),
    );
    expect(byName.get("src")).toBe("SourceIP");
    expect(byName.get("request")).toBe("RequestURL");
    expect(byName.get("dvchost")).toBe("DeviceName");
  });

  it("never participates in runtime lookups (empty keywords)", () => {
    for (const name of ["Zscaler Internet Access", "Check Point", "AnythingElse"]) {
      expect(
        vendorPacksForSolution(name).some((p) => p.id === "cef-standard"),
      ).toBe(false);
    }
  });
});

describe("decode pack entries (base64-encoded vendor fields)", () => {
  const zscaler = vendorMappingsForSolution("Zscaler Internet Access");
  const byName = new Map(zscaler.map((m) => [m.sourceName, m]));

  it("documents b64url as a base64 DECODE into RequestURL, never a rename", () => {
    expect(byName.get("b64url")?.destName).toBe("RequestURL");
    expect(byName.get("b64url")?.action).toBe("decode");
  });

  it("prefers the decoded full referer over refererhost for RequestContext", () => {
    // Both entries survive the per-SOURCE dedupe (different sources); the
    // per-sample dest collision resolves by declaration order, so b64referer
    // must be declared first.
    const b64Index = zscaler.findIndex((m) => m.sourceName === "b64referer");
    const hostIndex = zscaler.findIndex((m) => m.sourceName === "refererhost");
    expect(b64Index).toBeGreaterThanOrEqual(0);
    expect(hostIndex).toBeGreaterThanOrEqual(0);
    expect(b64Index).toBeLessThan(hostIndex);
  });

  it("Phase 0 carries decode through to the match row", () => {
    const result = matchFields(
      [{ name: "b64url", type: "string", sampleValue: "d3d3Lg==" }],
      [
        { name: "RequestURL", type: "string" },
        { name: "AdditionalExtensions", type: "string" },
      ],
      zscaler.filter((m) => m.sourceName === "b64url"),
      "CommonSecurityLog",
    );
    expect(result.matched[0]?.destName).toBe("RequestURL");
    expect(result.matched[0]?.action).toBe("decode");
    expect(result.matched[0]?.description).toContain("base64 decode");
  });
});

describe("Phase 0 integration (documented mappings outrank the ladder)", () => {
  it("a pack mapping claims its column ahead of alias/fuzzy and labels itself", () => {
    const mappings = vendorMappingsForSolution("Zscaler Internet Access").filter(
      (m) => m.sourceName === "host",
    );
    const result = matchFields(
      [{ name: "host", type: "string" }],
      [
        { name: "DestinationHostName", type: "string" },
        { name: "DeviceName", type: "string" },
      ],
      mappings,
      "CommonSecurityLog",
    );
    expect(result.matched[0]?.destName).toBe("DestinationHostName");
    expect(result.matched[0]?.confidence).toBe("exact");
    expect(result.matched[0]?.description).toContain("Vendor mapping");
  });
});

describe("documentation references (user requirement 2026-07-12: ALL vendors)", () => {
  it("every pack carries provenance and every generated pack a pinned docUrl", () => {
    expect(VENDOR_MAPPING_PACKS.length).toBeGreaterThanOrEqual(75);
    for (const pack of VENDOR_MAPPING_PACKS) {
      expect(pack.provenance.length, pack.id).toBeGreaterThan(0);
    }
    const generated = VENDOR_MAPPING_PACKS.filter((p) =>
      p.id.startsWith("generated-"),
    );
    expect(generated.length).toBeGreaterThanOrEqual(70);
    for (const pack of generated) {
      // Pinned to the exact mined tree so the link cannot rot under us.
      expect(pack.docUrl, pack.id).toMatch(
        /^https:\/\/github\.com\/elastic\/integrations\/tree\/[0-9a-f]{40}\/packages\/[a-z0-9_]+$/,
      );
    }
  });

  it("every solution with packs exposes at least one documentation LINK", () => {
    // The per-table doc line renders anchors from docUrl; a solution whose
    // packs were all link-less would render text only. Every generated pack
    // now links, and the hand packs either link (zscaler) or share a vendor
    // with a generated pack that does (crowdstrike).
    const vendorsWithPacks = new Set(
      VENDOR_MAPPING_PACKS.filter((p) => p.solutionKeywords.length > 0).map(
        (p) => p.vendor.toLowerCase(),
      ),
    );
    for (const vendor of vendorsWithPacks) {
      const linked = VENDOR_MAPPING_PACKS.some(
        (p) =>
          p.vendor.toLowerCase() === vendor &&
          p.solutionKeywords.length > 0 &&
          p.docUrl !== undefined,
      );
      expect(linked, vendor).toBe(true);
    }
  });
});

describe("Sentinel-DCR packs (Wave A, 2026-07-12)", () => {
  const dcrPacks = VENDOR_MAPPING_PACKS.filter((p) =>
    p.id.startsWith("sentinel-dcr-"),
  );

  it("ships the mined DCR-transform packs with pinned repo doc links", () => {
    expect(dcrPacks.length).toBeGreaterThanOrEqual(5);
    for (const pack of dcrPacks) {
      expect(pack.docUrl, pack.id).toMatch(
        /^https:\/\/github\.com\/Azure\/Azure-Sentinel\/tree\/master\/Solutions\//,
      );
      expect(pack.provenance).toContain("Microsoft Sentinel solution DCR");
      expect(pack.mappings.length, pack.id).toBeGreaterThan(0);
    }
  });

  it("outranks Elastic-mined packs and is outranked by hand packs", () => {
    const ids = VENDOR_MAPPING_PACKS.map((p) => p.id);
    const firstHand = ids.indexOf("zscaler-zia");
    const firstDcr = ids.findIndex((id) => id.startsWith("sentinel-dcr-"));
    const firstElastic = ids.findIndex((id) => id.startsWith("generated-"));
    expect(firstHand).toBeGreaterThanOrEqual(0);
    expect(firstDcr).toBeGreaterThan(firstHand);
    expect(firstElastic).toBeGreaterThan(firstDcr);
  });

  it("Zscaler gains the official CEF-key crosswalk (act -> DeviceAction)", () => {
    const mappings = vendorMappingsForSolution("Zscaler Internet Access");
    const act = mappings.find((m) => m.sourceName === "act");
    expect(act?.destName).toBe("DeviceAction");
    expect(act?.description).toContain("Sentinel solution DCR");
    // The hand pack still wins for sources it declares.
    const host = mappings.find((m) => m.sourceName === "host");
    expect(host?.description).toContain("NSS web");
  });

  it("Cortex XDR custom-table projections are exposed for its solution", () => {
    const mappings = vendorMappingsForSolution("Palo Alto Cortex XDR");
    expect(mappings.length).toBeGreaterThan(100);
    const incident = mappings.find((m) => m.sourceName === "incident_id");
    expect(incident?.destName).toBe("IncidentId");
  });
});
