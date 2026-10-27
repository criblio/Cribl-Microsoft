import { describe, expect, it } from "vitest";
import { CHECK_KINDS, aggregateVerdict } from "./index";
import type { ArrivalReading, StepVerdict } from "./index";

const ok: StepVerdict = { kind: "as-expected" };
const differs: StepVerdict = {
  kind: "present-differs",
  diffs: [{ field: "sku", expected: "Standard", actual: "Basic" }],
};
const otherName: StepVerdict = { kind: "present-other-name", name: "x", diffs: [] };
const absent: StepVerdict = { kind: "absent" };
const unknown: StepVerdict = { kind: "unknown", reason: "denied", detail: "403" };

describe("CHECK_KINDS", () => {
  it("has no arrival kind: arrival is a reading, not a verdict", () => {
    expect(CHECK_KINDS as readonly string[]).not.toContain("eh-hub-arrival");
    expect(CHECK_KINDS.length).toBe(23);
    expect(new Set(CHECK_KINDS).size).toBe(CHECK_KINDS.length);
  });
});

describe("aggregateVerdict", () => {
  it("is unknown for an empty list", () => {
    expect(aggregateVerdict([])).toBe("unknown");
  });

  it("ranks unknown > absent > differs > as-expected", () => {
    expect(aggregateVerdict([ok, unknown])).toBe("unknown");
    expect(aggregateVerdict([unknown, ok])).toBe("unknown");
    expect(aggregateVerdict([ok, absent, differs])).toBe("absent");
    expect(aggregateVerdict([absent, unknown])).toBe("unknown");
    expect(aggregateVerdict([ok, differs])).toBe("differs");
    expect(aggregateVerdict([ok, otherName])).toBe("differs");
    expect(aggregateVerdict([ok, ok])).toBe("as-expected");
  });
});

describe("ArrivalReading", () => {
  it("keeps a measured zero distinct from unknown", () => {
    const zero: ArrivalReading = { kind: "measured", messages: 0, window: "PT1H" };
    const cannot: ArrivalReading = { kind: "unknown", reason: "denied", detail: "403" };
    expect(zero).not.toEqual(cannot);
    expect(zero.kind).not.toBe(cannot.kind);
    // Type-level: a measured reading cannot carry a reason, an unknown cannot carry a count.
    // @ts-expect-error - messages is not part of the unknown variant
    const bad: ArrivalReading = { kind: "unknown", reason: "denied", detail: "", messages: 0 };
    expect(bad.kind).toBe("unknown");
  });
});
