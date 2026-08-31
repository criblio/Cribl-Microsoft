/**
 * Pins for the hand-authored schema source (TBL-1).
 *
 * The editing operations are pinned by IDENTITY as well as value, because
 * the defect they guard against is not a wrong array - it is a re-created
 * row object stealing focus from the input the operator is typing in, which
 * a value-only assertion passes straight through.
 */

import { describe, expect, it } from "vitest";
import { CUSTOM_COLUMN_TYPES } from "@soc/core";
import {
  addManualColumn,
  emptyManualColumns,
  manualColumnsToSchema,
  manualRowStatuses,
  manualSchemaErrors,
  removeManualColumn,
  updateManualColumn,
} from "./manual-schema-state";
import type { ManualColumnDraft } from "./manual-schema-state";

const rows = (...specs: [string, string, string][]): ManualColumnDraft[] =>
  specs.map(([id, name, type]) => ({ id, name, type }));

describe("the editor's row operations", () => {
  it("opens with exactly one blank row, so there is somewhere to type", () => {
    const start = emptyManualColumns();
    expect(start).toHaveLength(1);
    expect(start[0]?.name).toBe("");
    expect(start[0]?.type).toBe("string");
  });

  it("adds a row with an id no existing row holds", () => {
    const before = rows(["1", "A", "string"], ["7", "B", "int"]);
    const after = addManualColumn(before);
    expect(after).toHaveLength(3);
    // One past the HIGHEST id, not one past the count - otherwise adding
    // after a removal reuses an id that is still on screen.
    expect(after[2]?.id).toBe("8");
    expect(new Set(after.map((r) => r.id)).size).toBe(3);
  });

  it("removes only the named row", () => {
    const before = rows(["1", "A", "string"], ["2", "B", "int"], ["3", "C", "long"]);
    const after = removeManualColumn(before, "2");
    expect(after.map((r) => r.id)).toEqual(["1", "3"]);
  });

  it("leaves one blank row when the last row is removed", () => {
    // An editor with zero rows offers nothing to do and reads as broken.
    const after = removeManualColumn(rows(["4", "Only", "string"]), "4");
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe("");
  });

  it("updates the target row and leaves the others IDENTICAL", () => {
    const before = rows(["1", "A", "string"], ["2", "B", "int"]);
    const after = updateManualColumn(before, "2", { name: "Bee" });
    expect(after[1]).toEqual({ id: "2", name: "Bee", type: "int" });
    // Object identity, not just equal contents: a new object for row 1 would
    // remount its input and drop the caret mid-word.
    expect(after[0]).toBe(before[0]);
  });
});

describe("turning rows into a schema", () => {
  it("skips blank rows and trims names", () => {
    const schema = manualColumnsToSchema(
      rows(["1", "  ClientIP  ", "string"], ["2", "", "string"], ["3", "Bytes", "long"]),
    );
    expect(schema).toEqual([
      { name: "ClientIP", type: "string" },
      { name: "Bytes", type: "long" },
    ]);
  });

  it("yields nothing from a freshly opened editor", () => {
    expect(manualColumnsToSchema(emptyManualColumns())).toEqual([]);
  });
});

describe("per-row verdicts", () => {
  it("marks EVERY copy of a duplicated name, not just the later one", () => {
    // The operator has to decide which one is wrong; marking only the second
    // implies the first is the keeper, which it may not be.
    const statuses = manualRowStatuses(
      rows(["1", "ClientIP", "string"], ["2", "Bytes", "long"], ["3", "clientip", "int"]),
    );
    expect(statuses.map((s) => s.issues)).toEqual([
      ["duplicate-name"],
      [],
      ["duplicate-name"],
    ]);
    expect(statuses.filter((s) => s.blocking)).toHaveLength(2);
  });

  it("matches duplicate names case-insensitively, as Log Analytics does", () => {
    const statuses = manualRowStatuses(
      rows(["1", "Status", "string"], ["2", "STATUS", "string"]),
    );
    expect(statuses.every((s) => s.issues.includes("duplicate-name"))).toBe(true);
  });

  it("blocks a type the tables API does not accept, and names the choices", () => {
    const [status] = manualRowStatuses(rows(["1", "When", "guid"]));
    expect(status?.issues).toEqual(["unknown-type"]);
    expect(status?.blocking).toBe(true);
    // The message must list the real enum, so it cannot drift from it.
    for (const type of CUSTOM_COLUMN_TYPES) {
      expect(status?.message).toContain(type);
    }
  });

  it("accepts every type the tables API does accept", () => {
    // Guards the casing trap: the enum has `dateTime`, not `datetime`.
    const statuses = manualRowStatuses(
      CUSTOM_COLUMN_TYPES.map((type, i) => ({
        id: String(i + 1),
        name: `Col${i}`,
        type,
      })),
    );
    expect(statuses.flatMap((s) => s.issues)).toEqual([]);
  });

  it("notes a blank name WITHOUT blocking - it is the resting trailing row", () => {
    const [status] = manualRowStatuses(emptyManualColumns());
    expect(status?.issues).toEqual(["blank-name"]);
    expect(status?.blocking).toBe(false);
    expect(status?.message).toContain("remove the row");
  });
});

describe("whole-schema errors", () => {
  it("reports ONE sentence for a duplicate that marks two rows", () => {
    const errors = manualSchemaErrors(
      rows(["1", "ClientIP", "string"], ["2", "ClientIP", "string"]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ClientIP");
  });

  it("says nothing about a valid schema with a trailing blank row", () => {
    expect(
      manualSchemaErrors(rows(["1", "ClientIP", "string"], ["2", "", "string"])),
    ).toEqual([]);
  });
});
