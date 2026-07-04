import { describe, expect, it } from "vitest";

import {
  autoDetectLogTypes,
  DISCRIMINATOR_FIELDS,
  HIGH_CONFIDENCE_DISCRIMINATOR_COUNT,
  parseSampleContent,
  selectDiscriminatorField,
} from "./index";

// The legacy codebase had THREE drifted discriminator lists (sample-parser
// auto-detect, sample-resolver DISCRIMINATOR_FIELDS, renderer deploy
// discriminatorFields). These tests pin the reconciled UNION and the single
// high-confidence selection rule.

describe("DISCRIMINATOR_FIELDS reconciliation", () => {
  it("is the union of all three legacy copies (no member dropped)", () => {
    // Members unique to each source must all survive the union.
    expect(DISCRIMINATOR_FIELDS).toContain("event_simpleName"); // A + B
    expect(DISCRIMINATOR_FIELDS).toContain("Type"); // A only
    expect(DISCRIMINATOR_FIELDS).toContain("event_type"); // C only
    expect(DISCRIMINATOR_FIELDS).toContain("module"); // C only
    // Common members present too.
    for (const shared of ["type", "subtype", "DeviceEventClassID", "action"]) {
      expect(DISCRIMINATOR_FIELDS).toContain(shared);
    }
    // No duplicates.
    expect(new Set(DISCRIMINATOR_FIELDS).size).toBe(DISCRIMINATOR_FIELDS.length);
  });

  it("keeps the resolver's high-confidence six at the front", () => {
    expect(HIGH_CONFIDENCE_DISCRIMINATOR_COUNT).toBe(6);
    expect(DISCRIMINATOR_FIELDS.slice(0, 6)).toEqual([
      "event_simpleName",
      "type",
      "subtype",
      "DeviceEventClassID",
      "Activity",
      "eventType",
    ]);
  });
});

describe("selectDiscriminatorField", () => {
  it("selects a high-confidence field on a SINGLE distinct value", () => {
    const records = [
      { event_simpleName: "DnsRequest", x: 1 },
      { event_simpleName: "DnsRequest", x: 2 },
    ];
    expect(selectDiscriminatorField(records)).toBe("event_simpleName");
  });

  it("does NOT select a low-confidence field on a single value", () => {
    // 'category' is index >= 6, so one distinct value is not enough.
    const records = [{ category: "web" }, { category: "web" }];
    expect(selectDiscriminatorField(records)).toBeUndefined();
  });

  it("selects a low-confidence field once it has >=2 distinct values", () => {
    const records = [{ logType: "auth" }, { logType: "traffic" }];
    expect(selectDiscriminatorField(records)).toBe("logType");
  });

  it("prefers the earlier field when several qualify", () => {
    const records = [
      { type: "A", action: "allow" },
      { type: "B", action: "deny" },
    ];
    expect(selectDiscriminatorField(records)).toBe("type");
  });
});

describe("autoDetectLogTypes", () => {
  it("splits records by the chosen discriminator", () => {
    const sample = parseSampleContent(
      '{"event_simpleName":"DnsRequest","x":1}\n' +
        '{"event_simpleName":"ProcessRollup2","x":2}\n' +
        '{"event_simpleName":"DnsRequest","x":3}',
    );
    const result = autoDetectLogTypes(sample);
    expect(result.discriminatorField).toBe("event_simpleName");
    const byName = new Map(result.logTypes.map((lt) => [lt.name, lt.eventCount]));
    expect(byName.get("DnsRequest")).toBe(2);
    expect(byName.get("ProcessRollup2")).toBe(1);
  });

  it("sanitizes non-alphanumeric characters in the group name", () => {
    const sample = parseSampleContent(
      '{"event_simpleName":"Some Value!","x":1}\n' +
        '{"event_simpleName":"Other/Type","x":2}',
    );
    const names = autoDetectLogTypes(sample).logTypes.map((lt) => lt.name);
    expect(names).toContain("Some_Value_");
    expect(names).toContain("Other_Type");
  });

  it("returns a single default group when no discriminator qualifies", () => {
    const sample = parseSampleContent('{"foo":"a"}\n{"bar":"b"}');
    const result = autoDetectLogTypes(sample);
    expect(result.discriminatorField).toBeUndefined();
    expect(result.logTypes).toEqual([
      { name: "default", eventCount: 2, discriminator: "", value: "" },
    ]);
  });
});
