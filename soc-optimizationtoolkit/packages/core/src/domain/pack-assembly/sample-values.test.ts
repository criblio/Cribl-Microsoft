import { describe, expect, it } from "vitest";

import { generateFieldValue, isoFromEpochMs } from "./sample-values";

describe("isoFromEpochMs (pure, Date-free)", () => {
  it("formats the sample time base and epoch correctly", () => {
    expect(isoFromEpochMs(1_749_997_800_000)).toBe("2025-06-15T14:30:00.000Z");
    expect(isoFromEpochMs(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(isoFromEpochMs(1_749_997_800_000 + 3_599_000)).toBe("2025-06-15T15:29:59.000Z");
  });
});

describe("generateFieldValue - determinism", () => {
  it("returns the same value for the same name/type/seed", () => {
    expect(generateFieldValue("SourceIP", "string", 0)).toBe(generateFieldValue("SourceIP", "string", 0));
    expect(generateFieldValue("Port", "int", 3)).toBe(generateFieldValue("Port", "int", 3));
  });

  it("varies by seed (so multiple synthetic events differ)", () => {
    const vals = new Set([0, 1, 2, 3, 4].map((s) => generateFieldValue("SourceIP", "string", s)));
    expect(vals.size).toBeGreaterThan(1);
  });
});

describe("generateFieldValue - heuristic table", () => {
  it("datetime fields land on the fixed synthetic day (14:30 + up to 1h)", () => {
    // Base 2025-06-15T14:30:00Z + a 0..1h deterministic offset -> 14:30..15:30.
    expect(String(generateFieldValue("EventTime", "datetime", 0))).toMatch(/^2025-06-15T1[45]:/);
  });

  it("port fields are integers in the ephemeral range", () => {
    const v = generateFieldValue("SourcePort", "int", 0) as number;
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(1024);
    expect(v).toBeLessThan(1024 + 64000);
  });

  it("boolean fields are booleans", () => {
    expect(typeof generateFieldValue("IsAdmin", "boolean", 0)).toBe("boolean");
  });

  it("IP-named string fields render dotted quads (source uses 10.x)", () => {
    const v = generateFieldValue("SourceIP", "string", 0) as string;
    expect(v).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(v.startsWith("10.")).toBe(true);
  });

  it("guid-named fields render a hex UUID shape", () => {
    const v = generateFieldValue("CorrelationId", "string", 0) as string;
    expect(v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("falls back to a generic labelled string", () => {
    expect(generateFieldValue("SomethingObscure", "string", 0)).toBe("sample_SomethingObscure_value");
  });
});
