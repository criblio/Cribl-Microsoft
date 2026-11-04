import { describe, expect, it } from "vitest";
import {
  initialCollapsed,
  parsePinned,
  pinnedKey,
  sectionsToCollapseOnMove,
} from "./section-folding-rules";

describe("auto-collapse on move (moved from integrate, DBT-232)", () => {
  it("folds every other open section except pinned, kept-open and already-folded ones", () => {
    const all = ["solution", "sample-data", "gap-analysis", "rule-coverage", "deploy"];
    expect(
      sectionsToCollapseOnMove(
        "sample-data",
        all,
        new Set(["solution"]),
        new Set(["rule-coverage"]),
        new Set(["deploy"]),
      ),
    ).toEqual(["gap-analysis"]);
  });

  it("never folds the section moved to", () => {
    expect(sectionsToCollapseOnMove("a", ["a", "b"], new Set(), new Set(), new Set())).toEqual(["b"]);
  });
});

describe("pins (moved from integrate, DBT-232)", () => {
  it("keys the pin list per user under the page's prefix", () => {
    expect(pinnedKey("integrate-pinned-sections", "u-1")).toBe("integrate-pinned-sections:u-1");
    expect(pinnedKey("setup-pinned-sections", "u-1")).toBe("setup-pinned-sections:u-1");
  });

  it("reads a stored pin list, dropping ids the page no longer has", () => {
    expect(parsePinned('["deploy","workbook-coverage"]', ["solution", "deploy"])).toEqual(["deploy"]);
    expect(parsePinned("not json", ["deploy"])).toEqual([]);
    expect(parsePinned(null, ["deploy"])).toEqual([]);
    expect(parsePinned('{"a":1}', ["a"])).toEqual([]);
  });
});

describe("the page opens collapsed (moved from integrate, DBT-237)", () => {
  it("folds every section except the current one", () => {
    expect([...initialCollapsed(["solution", "sample-data", "gap-analysis", "deploy"], "sample-data")]).toEqual([
      "solution",
      "gap-analysis",
      "deploy",
    ]);
  });
  it("folds everything when no section is current", () => {
    expect([...initialCollapsed(["solution", "deploy"], undefined)]).toEqual(["solution", "deploy"]);
  });
});
