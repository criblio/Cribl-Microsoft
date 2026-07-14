/**
 * EDR content filter - porting-plan Unit 14 (ENG-22 content-filter data ONLY;
 * crash detection dropped). The built-in blocklist survives as an optional
 * filter; the fetching.json marker machinery does not exist here.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_EDR_BLOCKLIST,
  blockedSolutionNames,
  isPathAllowedByEdr,
  isSolutionAllowed,
  mergeBlocklist,
  solutionNameFromPath,
} from "./edr-filter";
import type { BlockedSolution } from "./edr-filter";

describe("BUILTIN_EDR_BLOCKLIST", () => {
  it("keeps the built-in entries (BloodHound / FalconFriday survive as a filter)", () => {
    const names = BUILTIN_EDR_BLOCKLIST.map((s) => s.name);
    expect(names).toContain("BloodHound Enterprise");
    expect(names).toContain("FalconFriday");
    expect(BUILTIN_EDR_BLOCKLIST).toHaveLength(4);
  });
  it("every entry is source:'built-in'", () => {
    expect(BUILTIN_EDR_BLOCKLIST.every((s) => s.source === "built-in")).toBe(true);
    // reason text is carried through for the UI badge.
    expect(BUILTIN_EDR_BLOCKLIST.every((s) => s.reason.length > 0)).toBe(true);
  });
});

describe("mergeBlocklist", () => {
  it("appends user entries and dedupes by name (built-in wins)", () => {
    const extra: BlockedSolution[] = [
      { name: "My Custom Redteam", reason: "internal", source: "user" },
      { name: "FalconFriday", reason: "dup", source: "user" }, // already built-in
    ];
    const merged = mergeBlocklist(extra);
    expect(merged.filter((s) => s.name === "FalconFriday")).toHaveLength(1);
    expect(merged.some((s) => s.name === "My Custom Redteam")).toBe(true);
    expect(merged.length).toBe(BUILTIN_EDR_BLOCKLIST.length + 1);
  });
  it("with no extras returns exactly the built-ins", () => {
    expect(mergeBlocklist().map((s) => s.name)).toEqual(
      BUILTIN_EDR_BLOCKLIST.map((s) => s.name),
    );
  });
});

describe("isSolutionAllowed / blockedSolutionNames", () => {
  const names = blockedSolutionNames();
  it("blocks listed solutions, allows others", () => {
    expect(isSolutionAllowed("FalconFriday", names)).toBe(false);
    expect(isSolutionAllowed("BloodHound Enterprise", names)).toBe(false);
    expect(isSolutionAllowed("CrowdStrike Falcon Endpoint Protection", names)).toBe(true);
  });
});

describe("path helpers", () => {
  it("solutionNameFromPath extracts the Solutions/<name> segment", () => {
    expect(solutionNameFromPath("Solutions/FalconFriday/Analytic Rules/r.yaml")).toBe(
      "FalconFriday",
    );
    expect(solutionNameFromPath("Sample Data/x.csv")).toBeNull();
    expect(solutionNameFromPath("README.md")).toBeNull();
  });

  it("isPathAllowedByEdr drops files of blocked solutions, passes the rest", () => {
    const names = blockedSolutionNames();
    expect(isPathAllowedByEdr("Solutions/FalconFriday/Analytic Rules/r.yaml", names)).toBe(false);
    expect(isPathAllowedByEdr("Solutions/1Password/Data Connectors/c.json", names)).toBe(true);
    // Non-Solutions paths are not judged by the solution filter (file-selection is).
    expect(isPathAllowedByEdr("Sample Data/x.csv", names)).toBe(true);
  });
});
