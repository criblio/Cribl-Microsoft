import { describe, expect, it } from "vitest";
import {
  detectRouteDiscriminator,
  discriminatorFilter,
  LOGTYPE_FALLBACK_FIELD,
  type DiscriminatorSample,
} from "./route-discriminator";

/** Helper: one sample whose single raw event is the given object. */
function sample(logType: string, event: Record<string, unknown>): DiscriminatorSample {
  return { logType, rawEvents: [JSON.stringify(event)] };
}

describe("detectRouteDiscriminator - the 3 strategies", () => {
  it("single sample needs no discriminator - filter is `true`", () => {
    const result = detectRouteDiscriminator([sample("firewall", { type: "traffic" })]);
    expect(result.strategy).toBe("single-sample");
    expect(result.field).toBe("");
    expect(result.filters).toEqual({ firewall: "true" });
    expect(result.logTypeValues).toEqual({});
  });

  it("zero samples yields an empty single-sample result", () => {
    const result = detectRouteDiscriminator([]);
    expect(result.strategy).toBe("single-sample");
    expect(result.filters).toEqual({});
  });

  it("Strategy 1 (unique-field): first field present-and-DISTINCT in every sample", () => {
    const result = detectRouteDiscriminator([
      sample("firewall", { type: "traffic" }),
      sample("web", { type: "url" }),
    ]);
    expect(result.strategy).toBe("unique-field");
    expect(result.field).toBe("type");
    expect(result.filters).toEqual({
      firewall: "type=='traffic'",
      web: "type=='url'",
    });
    expect(result.logTypeValues).toEqual({ firewall: "traffic", web: "url" });
  });

  it("Strategy 2 (partial-field): first field present in every sample, values may COLLIDE", () => {
    // `category` is present in both but identical -> Strategy 1 rejects it (not
    // distinct); Strategy 2 accepts it. No earlier field is present in both.
    const result = detectRouteDiscriminator([
      sample("alpha", { category: "security" }),
      sample("beta", { category: "security" }),
    ]);
    expect(result.strategy).toBe("partial-field");
    expect(result.field).toBe("category");
    expect(result.filters).toEqual({
      alpha: "category=='security'",
      beta: "category=='security'",
    });
  });

  it("Strategy 1 vs 2 presence test differs: empty string is present for 2, absent for 1", () => {
    // `type` present in both, one value empty -> Strategy 1's trim() test
    // disqualifies it, but Strategy 2's defined-and-non-null test keeps it.
    const result = detectRouteDiscriminator([
      sample("a", { type: "traffic" }),
      sample("b", { type: "" }),
    ]);
    expect(result.strategy).toBe("partial-field");
    expect(result.field).toBe("type");
    expect(result.filters).toEqual({ a: "type=='traffic'", b: "type==''" });
  });

  it("Strategy 3 (logtype-fallback): no shared field -> sourcetype regex on the log-type name", () => {
    const result = detectRouteDiscriminator([
      sample("Firewall", { foo: 1 }),
      sample("WEB", { bar: 2 }),
    ]);
    expect(result.strategy).toBe("logtype-fallback");
    expect(result.field).toBe(LOGTYPE_FALLBACK_FIELD);
    expect(result.filters).toEqual({
      Firewall: "sourcetype && sourcetype.match(/firewall/i)",
      WEB: "sourcetype && sourcetype.match(/web/i)",
    });
    expect(result.logTypeValues).toEqual({ Firewall: "firewall", WEB: "web" });
  });

  it("an unparseable raw event disqualifies every field, forcing the fallback", () => {
    const result = detectRouteDiscriminator([
      sample("good", { type: "traffic" }),
      { logType: "bad", rawEvents: ["}{ not json"] },
    ]);
    expect(result.strategy).toBe("logtype-fallback");
    expect(result.filters.bad).toBe("sourcetype && sourcetype.match(/bad/i)");
  });

  it("a sample with no raw events disqualifies fields (fallback)", () => {
    const result = detectRouteDiscriminator([
      sample("good", { type: "traffic" }),
      { logType: "empty", rawEvents: [] },
    ]);
    expect(result.strategy).toBe("logtype-fallback");
  });
});

describe("discriminatorFilter", () => {
  it("builds an equality filter for a real field", () => {
    expect(discriminatorFilter("subtype", "dns")).toBe("subtype=='dns'");
  });
  it("builds a sourcetype regex filter for the fallback field", () => {
    expect(discriminatorFilter(LOGTYPE_FALLBACK_FIELD, "tunnel")).toBe(
      "sourcetype && sourcetype.match(/tunnel/i)",
    );
  });
});
