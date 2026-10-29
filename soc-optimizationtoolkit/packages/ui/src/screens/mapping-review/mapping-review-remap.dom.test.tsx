// @vitest-environment happy-dom
/**
 * GEN-19 / DBT-193 / DBT-194 through the REAL component: the PAN-OS UAT
 * (2026-10-29) re-pointed an overflow row's Dest Field at a real column. The
 * reducer pins in mapping-review-state.test.ts hand applyRemap its schema and
 * catch-all directly; this one proves the screen does - that the Dest Field
 * select's change reaches applyRemap with the report's schema and the table's
 * own catch-all column, that the row the pack build receives is a rename, that
 * the header stops counting overflow as mapped, and that setting the field
 * back clears "Modified".
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { parseSampleContent } from "@soc/core";
import type { GapFieldMapping, GapReport, SchemaCatalog, TaggedSample } from "@soc/core";
import { MappingReviewSection } from "./mapping-review-section";

afterEach(cleanup);

const catalog: SchemaCatalog = {
  resolveSchema: async () => [
    { name: "TimeGenerated", type: "datetime" },
    { name: "AdditionalExtensions", type: "string" },
    { name: "SourceMACAddress", type: "string" },
  ],
};

function sample(): TaggedSample {
  const content = JSON.stringify({
    TimeGenerated: "2026-10-29T12:00:00Z",
    qqvendorfield: "00:11:22:33:44:55",
  });
  return {
    logType: "PanOS",
    format: "json",
    rawEvents: [content],
    parsed: parseSampleContent(content, { sourceName: "panos.json" }),
  };
}

async function renderAnalyzed() {
  let reports: GapReport[] = [];
  let effective: Readonly<Record<string, GapFieldMapping[]>> = {};
  const { container } = render(
    <MappingReviewSection
      solutionName=""
      samples={[sample()]}
      catalog={catalog}
      onReportsChange={(next) => {
        reports = next;
      }}
      onEffectiveMappingsChange={(next) => {
        effective = next;
      }}
    />,
  );
  const button = [...container.querySelectorAll("button")].find((b) =>
    /analyze/i.test(b.textContent ?? ""),
  );
  if (button === undefined) throw new Error("Analyze button not rendered");
  fireEvent.click(button);
  await waitFor(() => {
    expect(reports.length).toBe(1);
  });
  await waitFor(() => {
    expect(container.querySelector(".mapping-review-grid")).not.toBeNull();
  });
  return {
    container,
    report: reports[0]!,
    effective: () => effective,
  };
}

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

describe("mapping review - re-pointing an overflow row (GEN-19)", () => {
  it("makes the row a rename, counts it as mapped, and clears Modified on revert", async () => {
    const { container, report, effective } = await renderAnalyzed();
    // The precondition the UAT had: the vendor field sits in the catch-all.
    const before = report.fieldMappings.find((m) => m.source === "qqvendorfield");
    expect(before?.action).toBe("overflow");
    expect(before?.dest).toBe("AdditionalExtensions");
    expect(summary(container)).toContain(
      "Field Mappings (1 mapped, 1 to overflow, 1 unmapped)",
    );

    const destSelect = () =>
      rowFor(container, "qqvendorfield").querySelector<HTMLSelectElement>(
        "select.mapping-select",
      )!;
    fireEvent.change(destSelect(), { target: { value: "SourceMACAddress" } });

    await waitFor(() => {
      expect(rowFor(container, "qqvendorfield").cells[3]!.textContent).toContain(
        "SourceMACAddress",
      );
    });
    const edited = effective().PanOS?.find((m) => m.source === "qqvendorfield");
    expect(edited?.action).toBe("rename");
    expect(edited?.dest).toBe("SourceMACAddress");
    expect(edited?.destType).toBe("string");
    // SourceMACAddress is filled; the now-empty catch-all is the one unmapped
    // column, and nothing is named as overflow any more.
    expect(summary(container)).toContain(
      "Field Mappings (2 mapped, 1 unmapped)",
    );
    expect(summary(container)).toContain("Modified");

    // Set it back: the baseline row returns and nothing reads as modified.
    fireEvent.change(destSelect(), { target: { value: "AdditionalExtensions" } });
    await waitFor(() => {
      expect(summary(container)).toContain(
        "Field Mappings (1 mapped, 1 to overflow, 1 unmapped)",
      );
    });
    expect(summary(container)).not.toContain("Modified");
    expect(effective().PanOS?.find((m) => m.source === "qqvendorfield")).toEqual(
      before,
    );
  });
});
