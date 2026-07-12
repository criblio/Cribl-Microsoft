/**
 * Pins for the learned-mappings feedback loop (user direction 2026-07-09,
 * technique #1 of the best-of-class matching plan): approved reviewer edits
 * persist per solution and replay ahead of the vendor packs.
 */

import { describe, expect, it } from "vitest";
import {
  LEARNED_MAPPING_DESCRIPTION,
  diffLearnedMappings,
  learnedMappingsCacheKey,
  learnedToVendorMappings,
  mergeLearnedMappings,
  parseLearnedMappings,
} from "./learned-mappings";
import { matchFields } from "./match-fields";

describe("diffLearnedMappings", () => {
  const BASELINE = [
    { source: "b64url", dest: "AdditionalExtensions", action: "overflow" },
    { source: "cltip", dest: "SourceIP", action: "rename" },
    { source: "noise", dest: "AdditionalExtensions", action: "overflow" },
  ];

  it("learns a hand edit (dest or action changed vs the baseline)", () => {
    const learned = diffLearnedMappings(BASELINE, [
      { source: "b64url", dest: "RequestURL", action: "decode" },
      { source: "cltip", dest: "SourceIP", action: "rename" }, // untouched
    ]);
    expect(learned).toEqual([
      { sourceName: "b64url", destName: "RequestURL", action: "decode" },
    ]);
  });

  it("learns a drop with an empty destination", () => {
    const learned = diffLearnedMappings(BASELINE, [
      { source: "noise", dest: "AdditionalExtensions", action: "drop" },
    ]);
    expect(learned).toEqual([{ sourceName: "noise", destName: "", action: "drop" }]);
  });

  it("never learns an overflow disposition (the matcher default)", () => {
    const learned = diffLearnedMappings(BASELINE, [
      { source: "cltip", dest: "AdditionalExtensions", action: "overflow" },
    ]);
    expect(learned).toEqual([]);
  });
});

describe("mergeLearnedMappings", () => {
  it("last-write-wins per source name, case-insensitively", () => {
    const merged = mergeLearnedMappings(
      [
        { sourceName: "b64url", destName: "RequestURL", action: "decode" },
        { sourceName: "noise", destName: "", action: "drop" },
      ],
      [{ sourceName: "B64URL", destName: "RequestContext", action: "map" }],
    );
    expect(merged).toEqual([
      { sourceName: "B64URL", destName: "RequestContext", action: "map" },
      { sourceName: "noise", destName: "", action: "drop" },
    ]);
  });
});

describe("parseLearnedMappings", () => {
  it("decodes stored entries and drops anything malformed", () => {
    expect(
      parseLearnedMappings([
        { sourceName: "a", destName: "B", action: "map" },
        { sourceName: "", destName: "B", action: "map" },
        { sourceName: "c", destName: "D", action: "explode" },
        "garbage",
        null,
      ]),
    ).toEqual([{ sourceName: "a", destName: "B", action: "map" }]);
    expect(parseLearnedMappings("not an array")).toEqual([]);
    expect(parseLearnedMappings(null)).toEqual([]);
  });
});

describe("replay (learnedToVendorMappings + Phase 0)", () => {
  it("keys the store per normalized solution name", () => {
    expect(learnedMappingsCacheKey("Zscaler Internet Access")).toBe(
      "learned-mappings~v1~zscalerinternetaccess",
    );
  });

  it("replays with the learned provenance visible on the match row", () => {
    const replayed = learnedToVendorMappings([
      { sourceName: "b64url", destName: "RequestURL", action: "decode" },
    ]);
    const result = matchFields(
      [{ name: "b64url", type: "string" }],
      [
        { name: "RequestURL", type: "string" },
        { name: "AdditionalExtensions", type: "string" },
      ],
      replayed,
      "CommonSecurityLog",
    );
    expect(result.matched[0]?.destName).toBe("RequestURL");
    expect(result.matched[0]?.action).toBe("decode");
    expect(result.matched[0]?.description).toContain(
      LEARNED_MAPPING_DESCRIPTION,
    );
  });
});
