/**
 * Pins for content requirements (user direction 2026-07-12): rules-first
 * analysis with a default DROP for fields neither rules nor workbooks need,
 * distinguishing direct column references, catch-all key extraction, and
 * opaque catch-all use.
 */

import { describe, expect, it } from "vitest";
import {
  deriveContentRequirements,
  mergeContentRequirements,
} from "./content-requirements";
import type { ContentItem } from "./models";

function item(queries: string[]): ContentItem {
  return {
    type: "analyticsRule",
    id: "r1",
    name: "rule",
    queries,
  } as unknown as ContentItem;
}

describe("deriveContentRequirements", () => {
  it("collects direct columns, including transformation base columns", () => {
    const req = deriveContentRequirements([
      item([
        'CommonSecurityLog\n| where DeviceVendor == "Zscaler"\n| extend host = split(RequestURL, "/")[2]\n| project DeviceAction, host',
      ]),
    ]);
    expect(req.columns.has("requesturl")).toBe(true);
    expect(req.columns.has("deviceaction")).toBe(true);
    expect(req.opaqueCatchAll).toBe(false);
    expect(req.catchAllKeys.size).toBe(0);
  });

  it("extracts catch-all keys from extract() literals and dynamic access", () => {
    const req = deriveContentRequirements([
      item([
        'CommonSecurityLog\n| extend dept = extract(@"dept=([^;]+)", 1, AdditionalExtensions)\n| extend risk = parse_json(AdditionalExtensions)["riskscore"]',
      ]),
    ]);
    expect([...req.catchAllKeys].sort()).toEqual(["dept", "riskscore"]);
    expect(req.opaqueCatchAll).toBe(false);
  });

  it("flags opaque catch-all use (no determinable keys)", () => {
    const req = deriveContentRequirements([
      item(["CommonSecurityLog\n| project AdditionalExtensions"]),
    ]);
    expect(req.opaqueCatchAll).toBe(true);
  });

  it("counts items and stays empty for none", () => {
    expect(deriveContentRequirements([]).itemCount).toBe(0);
  });
});

describe("mergeContentRequirements", () => {
  it("unions columns/keys and ORs the opaque flag", () => {
    const a = deriveContentRequirements([item(["T | project ColA"])]);
    const b = deriveContentRequirements([
      item(["T | project ColB, AdditionalExtensions"]),
    ]);
    const merged = mergeContentRequirements([a, b]);
    expect(merged.columns.has("cola")).toBe(true);
    expect(merged.columns.has("colb")).toBe(true);
    expect(merged.opaqueCatchAll).toBe(true);
    expect(merged.itemCount).toBe(2);
  });
});
