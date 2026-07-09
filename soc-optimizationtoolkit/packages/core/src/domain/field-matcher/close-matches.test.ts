/**
 * Pins for the close-match suggester (user request 2026-07-09). The founding
 * case is real: Zscaler web logs carry the URL only base64-encoded as
 * `b64url` - the MATCHER must never rename it onto RequestURL (rules filter
 * on decoded URL text), but the SUGGESTER must surface it for human review.
 */

import { describe, expect, it } from "vitest";
import { nameTokens, suggestCloseMatches } from "./close-matches";
import { scoreMatch } from "./scoring";

describe("nameTokens", () => {
  it("splits camelCase, separators, and letter/digit boundaries", () => {
    expect(nameTokens("RequestURL")).toEqual(["request", "url"]);
    expect(nameTokens("b64url")).toEqual(["64", "url"]);
    expect(nameTokens("source_nat_ip")).toEqual(["source", "nat", "ip"]);
  });
});

describe("suggestCloseMatches", () => {
  const ZSCALER_WEB_ROWS = [
    {
      sourceName: "b64url",
      logType: "BLOCKED",
      disposition: "overflow",
      sampleValue: "d3d3LnRyeXRoaXNlbmNvZGV1cmwuY29t",
    },
    {
      sourceName: "urlclass",
      logType: "BLOCKED",
      disposition: "overflow",
      sampleValue: "Bandwidth Loss",
    },
    { sourceName: "cltip", logType: "BLOCKED", disposition: "mapped to SourceIP" },
    { sourceName: "reqsize", logType: "BLOCKED", disposition: "mapped to SentBytes" },
  ];

  it("surfaces b64url for RequestURL even though the matcher refuses it", () => {
    // The matcher is deliberately conservative here (base64 content).
    expect(scoreMatch("b64url", "RequestURL").score).toBe(0);
    // The suggester is deliberately looser.
    const suggestions = suggestCloseMatches("RequestURL", ZSCALER_WEB_ROWS);
    expect(suggestions[0]?.sourceName).toBe("b64url");
    expect(suggestions[0]?.score).toBeLessThan(50); // never reads as a match
    expect(suggestions[0]?.sampleValue).toContain("d3d3");
    // urlclass shares "url" too and is offered, ranked at/below b64url.
    expect(suggestions.map((s) => s.sourceName)).toContain("urlclass");
  });

  it("drops fields sharing nothing with the missing field", () => {
    const suggestions = suggestCloseMatches("RequestURL", ZSCALER_WEB_ROWS);
    expect(suggestions.map((s) => s.sourceName)).not.toContain("cltip");
    expect(suggestions.map((s) => s.sourceName)).not.toContain("reqsize");
  });

  it("ranks matcher-ladder hits above token overlaps", () => {
    const rows = [
      { sourceName: "b64url", logType: "A", disposition: "overflow" },
      { sourceName: "uri", logType: "A", disposition: "overflow" },
    ];
    // "uri" is a known alias for RequestURL (score 90) and must outrank the
    // 35-point token overlap of b64url.
    const suggestions = suggestCloseMatches("RequestURL", rows);
    expect(suggestions[0]?.sourceName).toBe("uri");
    expect(suggestions[0]?.score).toBeGreaterThanOrEqual(50);
    expect(suggestions[1]?.sourceName).toBe("b64url");
  });

  it("dedupes by source and log type and honors the limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      sourceName: `url_variant_${i}`,
      logType: "A",
      disposition: "overflow",
    }));
    const suggestions = suggestCloseMatches("RequestURL", [...rows, ...rows], 3);
    expect(suggestions).toHaveLength(3);
  });
});
