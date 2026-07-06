import { describe, expect, it } from "vitest";
import { CROWDSTRIKE_MAX_EVENT_BYTES } from "../../domain/pack-assembly";
import {
  buildCrowdStrikeFdrBreaker,
  buildFdrBreakerRequest,
  isCrowdStrikeVendor,
  BREAKERS_API_PATH,
  CROWDSTRIKE_FDR_BREAKER_ID,
} from "./fdr-breaker";

describe("buildCrowdStrikeFdrBreaker (verbatim literal)", () => {
  it("reproduces the legacy FDR breaker byte-for-byte", () => {
    expect(buildCrowdStrikeFdrBreaker()).toEqual({
      id: "CrowdStrike_FDR",
      lib: "custom",
      description:
        "CrowdStrike FDR event breaker. Anchors timestamp extraction directly " +
        'on the "timestamp" field (epoch ms) to handle varying field positions ' +
        "across event types. 768KB max for ScriptContent events.",
      tags: "CrowdStrike,FDR,Sentinel",
      rules: [
        {
          name: "CrowdStrike FDR JSON",
          type: "json_array",
          condition:
            "/crowdstrike/i.test(source) || /crowdstrike/i.test(sourcetype)",
          timestampAnchorRegex: '/"timestamp":\\s*"/',
          timestamp: { type: "format", length: 150, format: "%s%L" },
          timestampTimezone: "utc",
          maxEventBytes: 786432,
          jsonExtractAll: true,
        },
      ],
    });
  });

  it("returns a fresh object each call (no shared mutable core data)", () => {
    const a = buildCrowdStrikeFdrBreaker();
    const b = buildCrowdStrikeFdrBreaker();
    expect(a).not.toBe(b);
    expect(a.rules).not.toBe(b.rules);
  });

  it("maxEventBytes matches pack-assembly CROWDSTRIKE_MAX_EVENT_BYTES (drift guard)", () => {
    expect(buildCrowdStrikeFdrBreaker().rules[0]!.maxEventBytes).toBe(
      CROWDSTRIKE_MAX_EVENT_BYTES,
    );
    expect(CROWDSTRIKE_MAX_EVENT_BYTES).toBe(786432);
  });
});

describe("isCrowdStrikeVendor", () => {
  it("matches case-insensitively on the substring", () => {
    expect(isCrowdStrikeVendor("CrowdStrike Falcon")).toBe(true);
    expect(isCrowdStrikeVendor("crowdstrike_fdr")).toBe(true);
    expect(isCrowdStrikeVendor("Palo Alto Networks")).toBe(false);
  });
});

describe("buildFdrBreakerRequest", () => {
  it("shapes a POST to /lib/breakers scoped to the worker group", () => {
    const request = buildFdrBreakerRequest("wg-prod");
    expect(request.method).toBe("POST");
    expect(request.path).toBe(BREAKERS_API_PATH);
    expect(request.groupId).toBe("wg-prod");
    expect((request.body as { id: string }).id).toBe(CROWDSTRIKE_FDR_BREAKER_ID);
  });
});
