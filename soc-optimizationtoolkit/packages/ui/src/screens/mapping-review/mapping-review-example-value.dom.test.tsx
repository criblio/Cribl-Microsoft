// @vitest-environment happy-dom
/**
 * DBT-122: the Field Mappings table shows an EXAMPLE VALUE per source field,
 * taken from the sample, so the operator can check a mapping by eye (a
 * "SrcUserName" column fed "abby" reads right; one fed "443" does not).
 *
 * The value already rode on every GapFieldMapping row (core populates
 * `sampleValue` for matched, vendor, drop and overflow rows alike - pinned in
 * analyze-samples.test.ts); the screen just never rendered it. This drives the
 * REAL component through Analyze and reads the rendered table, so it fails if
 * the column is missing, sits in the wrong place, or renders anything other
 * than the row's own sampleValue (rendering `m.source` there was the mutation
 * this was checked against).
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { parseSampleContent } from "@soc/core";
import type { GapReport, SchemaCatalog, TaggedSample } from "@soc/core";
import { MappingReviewSection } from "./mapping-review-section";

afterEach(cleanup);

const catalog: SchemaCatalog = {
  resolveSchema: async () => [
    { name: "TimeGenerated", type: "datetime" },
    { name: "SrcUserName", type: "string" },
    { name: "Note", type: "string" },
    { name: "NeverSent", type: "string" },
  ],
};

function sample(): TaggedSample {
  const content = JSON.stringify({
    SrcUserName: "abby",
    TimeGenerated: "2026-08-31T12:00:00Z",
    Note: "  padded",
  });
  return {
    logType: "AUDIT",
    format: "json",
    rawEvents: [content],
    parsed: parseSampleContent(content, { sourceName: "audit.json" }),
  };
}

async function renderAnalyzed(): Promise<{
  container: HTMLElement;
  report: GapReport;
}> {
  let latest: GapReport[] = [];
  const { container } = render(
    <MappingReviewSection
      solutionName=""
      samples={[sample()]}
      catalog={catalog}
      onReportsChange={(next) => {
        latest = next;
      }}
    />,
  );
  const button = [...container.querySelectorAll("button")].find((b) =>
    /analyze/i.test(b.textContent ?? ""),
  );
  if (button === undefined) throw new Error("Analyze button not rendered");
  fireEvent.click(button);
  await waitFor(() => {
    expect(latest.length).toBe(1);
  });
  await waitFor(() => {
    expect(container.querySelector(".mapping-review-grid")).not.toBeNull();
  });
  return { container, report: latest[0]! };
}

/** The header labels, stripped of their InfoTip trigger text. */
function headerLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".mapping-review-grid thead th")].map(
    (th) => (th.firstChild?.textContent ?? "").trim(),
  );
}

describe("Field Mappings table - Example Value column (DBT-122)", () => {
  it("adds the Example Value header right after the source Type", async () => {
    const { container } = await renderAnalyzed();
    expect(headerLabels(container)).toEqual([
      "Source Field",
      "Type",
      "Example Value",
      "Dest Field",
      "Type",
      "Confidence",
      "Action",
    ]);
  });

  it("renders each mapped row's OWN sample value in that column", async () => {
    const { container, report } = await renderAnalyzed();
    const rows = [
      ...container.querySelectorAll<HTMLTableRowElement>(
        ".mapping-review-grid tbody tr.mapping-row:not(.mapping-row-unmapped)",
      ),
    ];
    // Three sample fields, three mapped rows - and the report agrees, so the
    // per-row comparison below is not vacuous.
    expect(rows.length).toBe(3);
    expect(report.fieldMappings.length).toBe(3);

    const byField = new Map(
      rows.map((tr) => [
        tr.cells[0]!.textContent ?? "",
        tr.cells[2] as HTMLTableCellElement,
      ]),
    );
    expect([...byField.keys()].sort()).toEqual(
      ["Note", "SrcUserName", "TimeGenerated"],
    );
    expect(byField.get("SrcUserName")!.textContent).toBe("abby");
    expect(byField.get("TimeGenerated")!.textContent).toBe(
      "2026-08-31T12:00:00Z",
    );
    // Leading whitespace survives into the cell, untrimmed.
    expect(byField.get("Note")!.textContent).toBe("  padded");
    expect(byField.get("Note")!.getAttribute("title")).toBe("  padded");
  });

  it("keeps the unmapped-destination rows aligned to seven columns", async () => {
    const { container } = await renderAnalyzed();
    const head = container.querySelector(".mapping-unmapped-head td");
    expect(head?.getAttribute("colspan")).toBe("7");
    const unmapped = [
      ...container.querySelectorAll<HTMLTableRowElement>(
        "tr.mapping-row-unmapped",
      ),
    ];
    expect(unmapped.length).toBe(1);
    expect(unmapped[0]!.cells.length).toBe(7);
    expect(unmapped[0]!.cells[3]!.textContent).toBe("NeverSent");
  });
});
