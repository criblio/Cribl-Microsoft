import { describe, expect, it } from "vitest";

import {
  CROWDSTRIKE_MAX_EVENT_BYTES,
  DEFAULT_MAX_EVENT_BYTES,
  generateBreakersYml,
  isCrowdStrikeSolution,
} from "./breakers";

describe("generateBreakersYml", () => {
  it("emits the two JSON breaker rules with default sizing", () => {
    const yml = generateBreakersYml("Cloudflare");
    expect(yml).toContain("id: json_array");
    expect(yml).toContain("type: json_array");
    expect(yml).toContain("id: json_newline");
    expect(yml).toContain(`maxEventBytes: ${DEFAULT_MAX_EVENT_BYTES}`);
    expect(yml).toContain("timestampAnchorRegex: /^/");
  });

  it("applies CrowdStrike FDR tuning (768KB + timestamp anchor)", () => {
    const yml = generateBreakersYml("CrowdStrike Falcon Endpoint Protection");
    expect(yml).toContain(`maxEventBytes: ${CROWDSTRIKE_MAX_EVENT_BYTES}`);
    expect(yml).toContain('timestampAnchorRegex: /"timestamp"\\s*:\\s*"/');
    expect(yml).not.toContain("maxEventBytes: 51200");
  });

  it("detects CrowdStrike by case-insensitive substring", () => {
    expect(isCrowdStrikeSolution("crowdstrike-fdr")).toBe(true);
    expect(isCrowdStrikeSolution("CROWDSTRIKE")).toBe(true);
    expect(isCrowdStrikeSolution("Palo Alto")).toBe(false);
  });
});
