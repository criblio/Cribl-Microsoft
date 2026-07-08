import { describe, expect, it } from "vitest";

import {
  clampHighlight,
  filterOptions,
  moveHighlight,
  multiSummary,
  selectedLabel,
} from "./searchable-select-filter";
import type { SelectOption } from "./searchable-select-filter";

const opts: SelectOption[] = [
  { value: "wg-1", label: "defaultHybrid" },
  { value: "wg-2", label: "AzureManaged" },
  { value: "wg-3", label: "windows", hint: "fleet-3" },
];

describe("filterOptions", () => {
  it("returns all options for a blank or whitespace query", () => {
    expect(filterOptions(opts, "")).toHaveLength(3);
    expect(filterOptions(opts, "   ")).toHaveLength(3);
  });

  it("matches label case-insensitively", () => {
    expect(filterOptions(opts, "azure").map((o) => o.value)).toEqual(["wg-2"]);
    expect(filterOptions(opts, "WIN").map((o) => o.value)).toEqual(["wg-3"]);
  });

  it("matches on value and hint too", () => {
    expect(filterOptions(opts, "wg-1").map((o) => o.value)).toEqual(["wg-1"]);
    expect(filterOptions(opts, "fleet").map((o) => o.value)).toEqual(["wg-3"]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterOptions(opts, "zzz")).toEqual([]);
  });
});

describe("clampHighlight", () => {
  it("clamps into range and returns -1 for empty", () => {
    expect(clampHighlight(5, 3)).toBe(2);
    expect(clampHighlight(-2, 3)).toBe(0);
    expect(clampHighlight(1, 3)).toBe(1);
    expect(clampHighlight(0, 0)).toBe(-1);
  });
});

describe("moveHighlight", () => {
  it("wraps around both ends", () => {
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });
});

describe("selectedLabel / multiSummary", () => {
  it("single: label, fallback to value, or placeholder", () => {
    expect(selectedLabel(opts, "wg-2", "Pick...")).toBe("AzureManaged");
    expect(selectedLabel(opts, "", "Pick...")).toBe("Pick...");
    expect(selectedLabel(opts, "unknown", "Pick...")).toBe("unknown");
  });

  it("multi: placeholder / single label / N selected", () => {
    expect(multiSummary(opts, [], "None")).toBe("None");
    expect(multiSummary(opts, ["wg-3"], "None")).toBe("windows");
    expect(multiSummary(opts, ["wg-1", "wg-2"], "None")).toBe("2 selected");
  });
});
