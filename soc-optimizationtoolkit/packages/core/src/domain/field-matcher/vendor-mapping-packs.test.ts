/**
 * Pins for the vendor mapping packs (Phase 0 knowledge; user direction
 * 2026-07-09: align mappings with vendor documentation). The dedupe/precedence
 * rules ARE the contract: hand-verified entries beat generated ones, and the
 * generated asset is machine-written (scripts/generate-vendor-packs.mjs).
 */

import { describe, expect, it } from "vitest";
import {
  VENDOR_MAPPING_PACKS,
  vendorMappingsForSolution,
  vendorPacksForSolution,
} from "./vendor-mapping-packs";
import { matchFields } from "./match-fields";

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
