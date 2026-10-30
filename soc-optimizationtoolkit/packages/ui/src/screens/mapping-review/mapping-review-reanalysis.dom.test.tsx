// @vitest-environment happy-dom
/**
 * DBT-210 through the REAL component: the edit store used to outlive a
 * re-analysis untouched, so edits made against the old rows were applied to
 * the new ones and the badge said "your edits are applied when the pack is
 * built". Now a re-analysis keeps an edit only while its source field is still
 * there, drops the rest, and says how many in one sentence; Modified reflects
 * only the edits that survived.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { parseSampleContent } from "@soc/core";
import type { GapFieldMapping, SchemaCatalog, TaggedSample } from "@soc/core";
import { MappingReviewSection } from "./mapping-review-section";

afterEach(cleanup);

const catalog: SchemaCatalog = {
  resolveSchema: async () => [
    { name: "TimeGenerated", type: "datetime" },
    { name: "AdditionalExtensions", type: "string" },
    { name: "SourceMACAddress", type: "string" },
  ],
};

function sample(fields: Record<string, string>): TaggedSample {
  const content = JSON.stringify({ TimeGenerated: "2026-10-29T12:00:00Z", ...fields });
  return {
    logType: "PanOS",
    format: "json",
    rawEvents: [content],
    parsed: parseSampleContent(content, { sourceName: "panos.json" }),
  };
}

const BOTH = { qqvendorfield: "00:11:22:33:44:55", qqother: "x" };

function rowFor(container: HTMLElement, source: string): HTMLTableRowElement {
  const row = [
    ...container.querySelectorAll<HTMLTableRowElement>(
      ".mapping-review-grid tbody tr.mapping-row:not(.mapping-row-unmapped)",
    ),
  ].find((tr) => tr.cells[0]!.textContent === source);
  if (row === undefined) throw new Error(`no row for ${source}`);
  return row;
}

const summary = (container: HTMLElement): string =>
  container.querySelector(".mapping-review-fields-summary")?.textContent ?? "";

const notice = (container: HTMLElement): string | null =>
  container.querySelector(".mapping-review-dropped-edits")?.textContent ?? null;

function clickAnalyze(container: HTMLElement) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    /analyze/i.test(b.textContent ?? ""),
  );
  if (button === undefined) throw new Error("Analyze button not rendered");
  fireEvent.click(button);
}

/** Analyze BOTH, then edit both vendor rows: one Dest re-point, one drop. */
async function renderEdited() {
  let effective: Readonly<Record<string, GapFieldMapping[]>> = {};
  const props = {
    solutionName: "",
    catalog,
    onEffectiveMappingsChange: (next: Readonly<Record<string, GapFieldMapping[]>>) => {
      effective = next;
    },
  };
  const view = render(<MappingReviewSection {...props} samples={[sample(BOTH)]} />);
  const { container } = view;
  clickAnalyze(container);
  await waitFor(() => {
    expect(container.querySelector(".mapping-review-grid")).not.toBeNull();
  });
  fireEvent.change(
    rowFor(container, "qqvendorfield").querySelectorAll("select.mapping-select")[0]!,
    { target: { value: "SourceMACAddress" } },
  );
  fireEvent.change(
    rowFor(container, "qqother").querySelectorAll("select.mapping-select")[1]!,
    { target: { value: "drop" } },
  );
  await waitFor(() => {
    expect(effective.PanOS?.find((m) => m.source === "qqother")?.action).toBe("drop");
  });
  expect(effective.PanOS?.find((m) => m.source === "qqvendorfield")?.action).toBe(
    "rename",
  );
  expect(summary(container)).toContain("Modified");
  expect(notice(container)).toBeNull();

  /** Re-analyze a sample carrying only `fields`. */
  const reanalyze = async (fields: Record<string, string>) => {
    view.rerender(<MappingReviewSection {...props} samples={[sample(fields)]} />);
    clickAnalyze(container);
    await waitFor(() => {
      expect(notice(container)).not.toBeNull();
    });
  };
  return { container, effective: () => effective, reanalyze };
}

describe("mapping review - edits across a re-analysis (DBT-210)", () => {
  it("drops the edit whose field is gone, keeps the other, and says one was dropped", async () => {
    const { container, effective, reanalyze } = await renderEdited();
    await reanalyze({ qqvendorfield: "00:11:22:33:44:55" });

    expect(notice(container)).toBe(
      "1 mapping edit no longer matches a field in the new analysis and was dropped.",
    );
    // onEffectiveMappingsChange fires from an effect, which can land after the
    // notice renders; wait for it rather than reading a stale snapshot.
    await waitFor(() => {
      expect((effective().PanOS ?? []).map((m) => m.source).sort()).toEqual([
        "TimeGenerated",
        "qqvendorfield",
      ]);
    });
    const rows = effective().PanOS ?? [];
    expect(rows.find((m) => m.source === "qqvendorfield")?.action).toBe("rename");
    // The surviving edit is still an edit.
    expect(summary(container)).toContain("Modified");
    expect(container.querySelector(".gap-modified-line")).not.toBeNull();
  });

  it("clears Modified when no edit survives", async () => {
    const { container, effective, reanalyze } = await renderEdited();
    await reanalyze({});

    expect(notice(container)).toBe(
      "2 mapping edits no longer match a field in the new analysis and were dropped.",
    );
    await waitFor(() => {
      expect(effective().PanOS?.map((m) => m.source)).toEqual(["TimeGenerated"]);
    });
    expect(summary(container)).not.toContain("Modified");
    expect(container.querySelector(".gap-modified-line")).toBeNull();
  });

  it("after a log-type rename, re-bases against the rows the edits were made on", async () => {
    // The edit store re-keys to the new name but the reports do not, so the
    // rows the edits were made against must be found under the OLD name. Read
    // against the new analysis instead, every row the new analysis decides
    // differently looks like an edit: here qqother, overflow in the old
    // schema, would be forced back into overflow over the new column.
    let columns = [
      { name: "TimeGenerated", type: "datetime" },
      { name: "AdditionalExtensions", type: "string" },
      { name: "SourceMACAddress", type: "string" },
    ];
    const growing: SchemaCatalog = { resolveSchema: async () => columns };
    let effective: Readonly<Record<string, GapFieldMapping[]>> = {};
    const props = {
      solutionName: "",
      catalog: growing,
      onEffectiveMappingsChange: (next: Readonly<Record<string, GapFieldMapping[]>>) => {
        effective = next;
      },
    };
    const view = render(<MappingReviewSection {...props} samples={[sample(BOTH)]} />);
    const { container } = view;
    clickAnalyze(container);
    await waitFor(() => {
      expect(container.querySelector(".mapping-review-grid")).not.toBeNull();
    });
    expect(effective.PanOS?.find((m) => m.source === "qqother")?.action).toBe("overflow");
    fireEvent.change(
      rowFor(container, "qqvendorfield").querySelectorAll("select.mapping-select")[0]!,
      { target: { value: "SourceMACAddress" } },
    );
    await waitFor(() => {
      expect(effective.PanOS?.find((m) => m.source === "qqvendorfield")?.action).toBe(
        "rename",
      );
    });

    columns = [...columns, { name: "qqother", type: "string" }];
    // Two renames before the re-run: Traffic's rows are still PanOS's.
    view.rerender(
      <MappingReviewSection
        {...props}
        samples={[{ ...sample(BOTH), logType: "Mid" }]}
        renameEvent={{ from: "PanOS", to: "Mid", nonce: 1 }}
      />,
    );
    view.rerender(
      <MappingReviewSection
        {...props}
        samples={[{ ...sample(BOTH), logType: "Traffic" }]}
        renameEvent={{ from: "Mid", to: "Traffic", nonce: 2 }}
      />,
    );
    clickAnalyze(container);
    await waitFor(() => {
      expect(effective.Traffic).toBeDefined();
    });

    const rows = effective.Traffic ?? [];
    expect(rows.find((m) => m.source === "qqother")).toMatchObject({
      dest: "qqother",
      action: "keep",
    });
    expect(rows.find((m) => m.source === "qqvendorfield")).toMatchObject({
      dest: "SourceMACAddress",
      action: "rename",
    });
    expect(notice(container)).toBeNull();
  });
});
