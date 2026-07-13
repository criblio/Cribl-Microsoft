/**
 * Pins for the per-log-type route discriminators (live flaw 2026-07-13: a
 * Zscaler pack shipped two match-all final routes - web-BLOCKED swallowed
 * everything and firewall was unreachable).
 */

import { describe, expect, it } from "vitest";
import { deriveRouteDiscriminator } from "./route-discriminator";

const others = (...fields: string[]): Array<ReadonlySet<string>> => [
  new Set(fields.map((f) => f.toLowerCase())),
];

describe("deriveRouteDiscriminator", () => {
  it("builds presence + raw-token terms from fields unique to this log type", () => {
    const filter = deriveRouteDiscriminator(
      ["act", "requestClientApplication", "src"],
      others("act", "src", "proto"),
      "cef",
    );
    expect(filter).toBe(
      "requestClientApplication !== undefined || " +
        "(typeof _raw === 'string' && _raw.indexOf('requestClientApplication=') !== -1)",
    );
  });

  it("quotes JSON keys in the raw token", () => {
    const filter = deriveRouteDiscriminator(["nwapp"], others("url"), "json");
    expect(filter).toContain(`_raw.indexOf('"nwapp"')`);
  });

  it("caps at two unique fields, longest first, deterministically", () => {
    const filter = deriveRouteDiscriminator(
      ["aa", "bb", "long_field_name", "cc"],
      others("shared"),
      "kv",
    );
    expect(filter).toContain("long_field_name !== undefined");
    // Ties broken alphabetically: aa is the second pick; bb/cc dropped by cap.
    expect(filter).toContain("aa !== undefined");
    expect(filter).not.toContain("bb");
    expect(filter).not.toContain("cc");
  });

  it("compares uniqueness case-insensitively and skips blank sources", () => {
    expect(
      deriveRouteDiscriminator(["ACT", ""], others("act"), "cef"),
    ).toBeNull();
  });

  it("emits only the raw term for a non-identifier field name", () => {
    const filter = deriveRouteDiscriminator(
      ["user.name"],
      others("other"),
      "kv",
    );
    expect(filter).toBe(
      "(typeof _raw === 'string' && _raw.indexOf('user.name=') !== -1)",
    );
  });

  it("returns null for CSV (positional rows carry no field names)", () => {
    expect(
      deriveRouteDiscriminator(["unique_col"], others("other"), "csv"),
    ).toBeNull();
  });

  it("escapes quotes and backslashes in the raw token", () => {
    const filter = deriveRouteDiscriminator(
      ["odd'field"],
      others("other"),
      "kv",
    );
    expect(filter).toContain("_raw.indexOf('odd\\'field=')");
  });
});
