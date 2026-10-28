import { describe, expect, it } from "vitest";
import { CHECK_KINDS, aggregateVerdict, otherNameAlsoFound } from "./index";
import type { ArrivalReading, CheckKind, StepVerdict } from "./index";

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

// DBT-189: one wording for the other-name count, in the unit each kind's
// classifier counted - Validate, the How-to step and the lane all use it.
describe("otherNameAlsoFound", () => {
  const cases: ReadonlyArray<[number | undefined, CheckKind | undefined, string]> = [
    [undefined, "policy-assignment", ""],
    [0, "policy-assignment", ""],
    [1, "policy-assignment", "1 other policy assignment like it was also found"],
    [3, "policy-assignment", "3 other policy assignments like it were also found"],
    // A remediation verdict counts assignments with remediations, and says so.
    [1, "policy-remediation", "1 other assignment like it with remediations was also found"],
    [2, "policy-remediation", "2 other assignments like it with remediations were also found"],
    [1, "defender-export", "1 other continuous export like it was also found"],
    [4, "entra-setting", "4 other diagnostic settings like it were also found"],
    [2, "eh-hub", "2 other objects like it were also found"],
    [1, undefined, "1 other object like it was also found"],
  ];
  it.each(cases)("alsoFound %s for %s reads %j", (alsoFound, kind, expected) => {
    expect(otherNameAlsoFound(alsoFound, kind)).toBe(expected);
  });
  // The count is of objects that matched the way the named one did; a bare
  // "2 other policy assignments" on a lane card reads as an inventory.
  it("every kind's count says the others are like the one named", () => {
    for (const kind of CHECK_KINDS) {
      expect(otherNameAlsoFound(2, kind), kind).toMatch(/^2 other .*\blike it\b.* were also found$/);
    }
  });
});
