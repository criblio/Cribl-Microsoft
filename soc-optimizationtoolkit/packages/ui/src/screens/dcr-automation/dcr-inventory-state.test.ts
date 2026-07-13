/**
 * Pins for the DCR update preview presentation (user feedback 2026-07-13:
 * unreadable column dumps became color-coded chips, changes first).
 */

import { describe, expect, it } from "vitest";
import { mergePreviewColumns, summarizePreview } from "./dcr-inventory-state";

const PREVIEW = {
  currentDcrColumns: [
    { name: "TimeGenerated", type: "datetime" },
    { name: "Gone", type: "string" },
    { name: "Retyped", type: "string" },
  ],
  rebuiltDcrColumns: [
    { name: "TimeGenerated", type: "datetime" },
    { name: "Retyped", type: "long" },
    { name: "Fresh", type: "dynamic" },
  ],
  diff: {
    added: [{ name: "Fresh", type: "dynamic" }],
    removed: [{ name: "Gone", type: "string" }],
    retyped: [{ name: "Retyped", from: "string", to: "long" }],
    unchanged: 1,
  },
};

describe("mergePreviewColumns", () => {
  it("orders changes first (added, retyped, removed), then unchanged", () => {
    expect(mergePreviewColumns(PREVIEW)).toEqual([
      { name: "Fresh", type: "dynamic", status: "added" },
      { name: "Retyped", type: "long", fromType: "string", status: "retyped" },
      { name: "Gone", type: "string", status: "removed" },
      { name: "TimeGenerated", type: "datetime", status: "unchanged" },
    ]);
  });

  it("marks everything unchanged when the diff is empty", () => {
    const inSync = {
      currentDcrColumns: PREVIEW.currentDcrColumns,
      rebuiltDcrColumns: PREVIEW.currentDcrColumns,
      diff: { added: [], removed: [], retyped: [], unchanged: 3 },
    };
    expect(
      mergePreviewColumns(inSync).every((c) => c.status === "unchanged"),
    ).toBe(true);
  });
});

describe("summarizePreview", () => {
  it("names the change counts", () => {
    expect(summarizePreview(PREVIEW)).toBe(
      "3 columns before, 3 after: 1 added, 1 removed, 1 retyped, 1 unchanged.",
    );
  });

  it("says in sync when nothing changes", () => {
    expect(
      summarizePreview({
        currentDcrColumns: PREVIEW.currentDcrColumns,
        rebuiltDcrColumns: PREVIEW.currentDcrColumns,
        diff: { added: [], removed: [], retyped: [], unchanged: 3 },
      }),
    ).toMatch(/^In sync/);
  });
});
