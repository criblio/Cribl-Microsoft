import { describe, expect, it } from "vitest";

import {
  isHeaderlessCsv,
  parseCsvWithHeaders,
  parseSampleContent,
} from "./index";

// NEW coverage (Unit 12 named this a coverage gap - no legacy tests existed).
// These pin the headerless-CSV resolution behavior mined from the legacy
// sample-parser.ts parseCsvWithHeaders: syslog prefix stripped BEFORE the split,
// future_use columns skipped, surplus values kept as _extra_N overflow, the
// skipFirstRow option, and the documented naive-split quoted-comma limitation.

describe("parseCsvWithHeaders", () => {
  it("strips the syslog prefix BEFORE splitting and skips future_use columns", () => {
    // RFC 3164 prefix "Jan 01 12:00:00 PA-VM " is removed before the comma split,
    // so the supplied headers line up with the PAN-OS positional data. The
    // future_use1 header is skipped (its value is discarded).
    const headers = ["future_use1", "receive_time", "src", "dst"];
    const parsed = parseCsvWithHeaders(
      "Jan 01 12:00:00 PA-VM 1,2020/05/07,10.0.0.1,10.0.0.2",
      headers,
    );
    expect(parsed.eventCount).toBe(1);
    expect(parsed.records[0]).toEqual({
      receive_time: "2020/05/07",
      src: "10.0.0.1",
      dst: "10.0.0.2",
    });
    // future_use1 was skipped, not named.
    expect(parsed.records[0]).not.toHaveProperty("future_use1");
  });

  it("keeps surplus values as _extra_N overflow (index is absolute)", () => {
    const parsed = parseCsvWithHeaders("1,2,3,4", ["a", "b"]);
    expect(parsed.records[0]).toEqual({
      a: "1",
      b: "2",
      _extra_2: "3",
      _extra_3: "4",
    });
  });

  it("honors skipFirstRow (drops the sample's own header line)", () => {
    const parsed = parseCsvWithHeaders(
      "hdr1,hdr2\nv1,v2\nv3,v4",
      ["a", "b"],
      { skipFirstRow: true },
    );
    expect(parsed.eventCount).toBe(2);
    expect(parsed.records[0]).toEqual({ a: "v1", b: "v2" });
    expect(parsed.records[1]).toEqual({ a: "v3", b: "v4" });
  });

  it("documents the quoted-comma limitation: naive split breaks quoted values", () => {
    // A quoted value containing a comma is split into two fields, shifting every
    // later column and spilling one value into the overflow. Preserved, not fixed.
    const parsed = parseCsvWithHeaders('val1,"has,comma",val3', ["f1", "f2", "f3"]);
    expect(parsed.records[0]).toEqual({
      f1: "val1",
      f2: "has",
      f3: "comma",
      _extra_3: "val3",
    });
  });

  it("returns an error result for empty content", () => {
    const parsed = parseCsvWithHeaders("   ", ["a"]);
    expect(parsed.eventCount).toBe(0);
    expect(parsed.records).toEqual([]);
    expect(parsed.errors).toContain("No data lines found");
  });

  it("emits a Unit 11 ParsedSample (records + inferred field types + timestamp)", () => {
    const parsed = parseCsvWithHeaders(
      "2024-01-01T00:00:00,42\n2024-01-02T00:00:00,7",
      ["ts", "count"],
    );
    expect(parsed.format).toBe("csv");
    expect(parsed.records).toHaveLength(2);
    expect(parsed.fields.find((f) => f.name === "count")?.type).toBe("int");
    // guessTimestampField falls back to the first datetime-typed field.
    expect(parsed.timestampField).toBe("ts");
  });

  it("resolves a sample that isHeaderlessCsv (Unit 11) flags as needing headers", () => {
    // The trigger heuristic (reused, not re-implemented) marks positional _N
    // fields as headerless; the resolver then names them.
    const raw = "1,2,3,4\n5,6,7,8";
    const detected = parseSampleContent(raw, { sourceName: "raw.csv" });
    expect(isHeaderlessCsv(detected.fields)).toBe(true);

    const resolved = parseCsvWithHeaders(raw, ["w", "x", "y", "z"]);
    expect(resolved.records[0]).toEqual({ w: "1", x: "2", y: "3", z: "4" });
  });
});
