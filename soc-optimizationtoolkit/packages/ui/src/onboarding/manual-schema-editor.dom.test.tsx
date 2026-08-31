// @vitest-environment happy-dom
/**
 * Surface pins for the hand-authored schema editor (TBL-1).
 *
 * The rules themselves are pinned in manual-schema-state.test.ts. What these
 * assert is that the RENDER carries them: that a verdict computed for row N
 * appears against row N, that a reserved name is visible on the row rather
 * than only in the preview block underneath, and that editing reports the
 * right row id upward. A rule that is computed correctly and rendered against
 * the wrong row is indistinguishable from a wrong rule to the operator.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManualSchemaEditor } from "./manual-schema-editor";
import { manualRowStatuses } from "./manual-schema-state";
import type { ManualColumnDraft } from "./manual-schema-state";

afterEach(cleanup);

const rows = (...specs: [string, string, string][]): ManualColumnDraft[] =>
  specs.map(([id, name, type]) => ({ id, name, type }));

function renderEditor(
  drafts: ManualColumnDraft[],
  overrides: Partial<{
    reservedNames: string[];
    onAdd: () => void;
    onRemove: (id: string) => void;
    onEdit: (id: string, patch: Record<string, string>) => void;
  }> = {},
) {
  const onAdd = overrides.onAdd ?? vi.fn();
  const onRemove = overrides.onRemove ?? vi.fn();
  const onEdit = overrides.onEdit ?? vi.fn();
  const view = render(
    <ManualSchemaEditor
      rows={drafts}
      statuses={manualRowStatuses(drafts)}
      reservedNames={overrides.reservedNames}
      onAdd={onAdd}
      onRemove={onRemove}
      onEdit={onEdit}
    />,
  );
  return { view, onAdd, onRemove, onEdit };
}

describe("ManualSchemaEditor", () => {
  it("renders one name input and one type select per row", () => {
    renderEditor(rows(["1", "ClientIP", "string"], ["2", "Bytes", "long"]));
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(
      (screen.getByLabelText("Field 2 type") as HTMLSelectElement).value,
    ).toBe("long");
  });

  it("reports the edited ROW ID, not the index", () => {
    // Ids and positions differ here on purpose: an implementation that passed
    // the index would look correct against a 1,2,3 fixture.
    const { onEdit } = renderEditor(
      rows(["7", "ClientIP", "string"], ["9", "Bytes", "long"]),
    );
    fireEvent.change(screen.getByLabelText("Field 2 name"), {
      target: { value: "ByteCount" },
    });
    expect(onEdit).toHaveBeenCalledWith("9", { name: "ByteCount" });
  });

  it("puts a row's verdict against THAT row", () => {
    // Row 2 is the invalid one. The message must be inside row 2's name cell,
    // not merely somewhere on the page.
    const { view } = renderEditor(
      rows(["1", "ClientIP", "string"], ["2", "bad name", "string"]),
    );
    const cells = view.container.querySelectorAll(".csv-map-name");
    expect(cells).toHaveLength(2);
    expect(cells[0]?.textContent ?? "").not.toContain("not a valid column name");
    expect(cells[1]?.textContent ?? "").toContain("not a valid column name");
  });

  it("tints only the blocking row", () => {
    const { view } = renderEditor(
      rows(["1", "ClientIP", "string"], ["2", "bad name", "string"]),
    );
    const warned = view.container.querySelectorAll(".csv-map-row-warn");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.textContent ?? "").toContain("bad name");
  });

  it("does NOT tint a blank trailing row - that is the resting state", () => {
    const { view } = renderEditor(rows(["1", "ClientIP", "string"], ["2", "", "string"]));
    expect(view.container.querySelectorAll(".csv-map-row-warn")).toHaveLength(0);
  });

  it("says on the row that a reserved field will not be created", () => {
    // TBL-1: a field the operator typed that creation silently drops is the
    // same class of quiet loss as HON-4. The preview block below the editor
    // already lists it; the operator is looking at the row.
    const { view } = renderEditor(
      rows(["1", "ClientIP", "string"], ["2", "Computer", "string"]),
      { reservedNames: ["Computer"] },
    );
    const cells = view.container.querySelectorAll(".csv-map-name");
    expect(cells[1]?.textContent ?? "").toContain("not created");
    expect(cells[0]?.textContent ?? "").not.toContain("not created");
  });

  it("removes by row id", () => {
    const { onRemove } = renderEditor(
      rows(["7", "ClientIP", "string"], ["9", "Bytes", "long"]),
    );
    fireEvent.click(screen.getByTitle("Remove field 1"));
    expect(onRemove).toHaveBeenCalledWith("7");
  });

  it("offers every type the tables API accepts, and no others", () => {
    renderEditor(rows(["1", "ClientIP", "string"]));
    const options = Array.from(
      (screen.getByLabelText("Field 1 type") as HTMLSelectElement).options,
    ).map((o) => o.value);
    // Exact set, not a superset: an extra option here is a value core rejects.
    expect(options).toEqual([
      "string",
      "int",
      "long",
      "real",
      "boolean",
      "dateTime",
      "dynamic",
    ]);
  });
});
