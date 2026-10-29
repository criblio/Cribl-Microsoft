// @vitest-environment happy-dom
/**
 * DBT-202 through the REAL component: an Unmapped Destination Fields column
 * name opens the sample fields that could fill it, and one click applies the
 * choice. The PAN-OS UAT (2026-10-29) shape: the CEF `in` key sat in
 * AdditionalExtensions while ReceivedBytes stayed empty, and the only fix was
 * to find the row and re-point its Dest Field by hand.
 *
 * Pinned here, each against the screen rather than the reducer: the panel
 * lists the documented candidate first with its example value; applying makes
 * the row a rename the pack build receives (and the generated pipeline
 * renames), drops the unmapped count by one, and withdraws the approval; a
 * field that already fills a column MOVES and vacates it, warning when that
 * column is a rule column; an auto-dropped field stays applied when the drop
 * policy is switched back; the empty state hands the column name to the
 * enrichment editor; Escape and Dismiss close the panel.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  buildPipelinePlan,
  generatePipelineConfForPlan,
  parseSampleContent,
} from "@soc/core";
import type {
  GapFieldMapping,
  GapReport,
  SchemaCatalog,
  TaggedSample,
} from "@soc/core";
import type { RequirementsForAssessment } from "./mapping-review-state";
import { MappingReviewSection } from "./mapping-review-section";

afterEach(cleanup);

const catalog: SchemaCatalog = {
  resolveSchema: async () => [
    { name: "TimeGenerated", type: "datetime" },
    { name: "AdditionalExtensions", type: "string" },
    { name: "ReceivedBytes", type: "long" },
    { name: "SourceMACAddress", type: "string" },
    { name: "DestinationMACAddress", type: "string" },
    { name: "DeviceVendor", type: "string" },
  ],
};

function sample(): TaggedSample {
  const content = JSON.stringify({
    TimeGenerated: "2026-10-29T12:00:00Z",
    in: 4242,
    SourceMACAddress: "00:11:22:33:44:55",
    qqzz: "zz",
  });
  return {
    logType: "PanOS",
    format: "json",
    rawEvents: [content],
    parsed: parseSampleContent(content, { sourceName: "panos.json" }),
  };
}

async function renderAnalyzed(
  extra: {
    ruleFields?: ReadonlySet<string>;
    contentRequirements?: RequirementsForAssessment;
  } = {},
) {
  let reports: GapReport[] = [];
  let effective: Readonly<Record<string, GapFieldMapping[]>> = {};
  const { container } = render(
    <MappingReviewSection
      solutionName=""
      samples={[sample()]}
      catalog={catalog}
      {...extra}
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
  return { container, report: () => reports[0]!, effective: () => effective };
}

const summary = (container: HTMLElement): string =>
  container.querySelector(".mapping-review-fields-summary")?.textContent ?? "";

const unmappedHead = (container: HTMLElement): string =>
  container.querySelector(".mapping-unmapped-head td")?.textContent ?? "";

/** The unmapped column names, as their buttons render them. */
const unmappedColumns = (container: HTMLElement): string[] =>
  [
    ...container.querySelectorAll<HTMLButtonElement>(
      "tr.mapping-row-unmapped button.missing-field-button",
    ),
  ].map((b) => b.textContent ?? "");

function columnButton(container: HTMLElement, column: string): HTMLButtonElement {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>(
      "tr.mapping-row-unmapped button.missing-field-button",
    ),
  ].find((b) => b.textContent === column);
  if (button === undefined) throw new Error(`no unmapped button for ${column}`);
  return button;
}

const panel = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>("tr.mapping-suggest-row .close-match-panel");

const candidates = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".mapping-suggest-candidate")].map(
    (c) => c.getAttribute("data-source") ?? "",
  );

function candidate(container: HTMLElement, source: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(
    `.mapping-suggest-candidate[data-source="${source}"]`,
  );
  if (row === null) throw new Error(`no candidate ${source}`);
  return row;
}

const applyButton = (container: HTMLElement, source: string) =>
  candidate(container, source).querySelector<HTMLButtonElement>(
    "button.mapping-suggest-apply",
  )!;

const approveButton = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Approve PanOS",
  );

describe("unmapped column suggestions (DBT-202)", () => {
  it("lists the documented field first, with its example value and disposition", async () => {
    const { container } = await renderAnalyzed();
    const button = columnButton(container, "ReceivedBytes");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panel(container)).toBeNull();

    fireEvent.click(button);
    const opened = panel(container)!;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(opened.id);
    // Labelled by its own heading, and focused so Escape reaches it.
    const heading = container.querySelector(
      `#${opened.getAttribute("aria-labelledby")}`,
    );
    expect(heading?.textContent).toBe("Sample fields that could fill ReceivedBytes");
    expect(opened.getAttribute("role")).toBe("region");
    expect(document.activeElement).toBe(opened);

    expect(candidates(container)[0]).toBe("in");
    const top = candidate(container, "in");
    expect(top.querySelector(".close-match-sample")?.textContent).toBe("e.g. 4242");
    expect(top.querySelector(".close-match-disposition")?.textContent).toBe(
      "now: overflow into AdditionalExtensions",
    );
    expect(top.textContent).toContain("Documented: CEF in: Bytes transferred inbound");
    expect(applyButton(container, "in").textContent).toBe("Use this field");
    expect(applyButton(container, "in").getAttribute("aria-label")).toBe(
      "Use this field: in into ReceivedBytes",
    );
  });

  it("applies through the remap: a rename the pipeline emits, one fewer unmapped column, approval withdrawn", async () => {
    const { container, effective, report } = await renderAnalyzed();
    expect(unmappedHead(container)).toContain("Unmapped Destination Fields (3)");
    fireEvent.click(approveButton(container)!);
    await waitFor(() => {
      expect(summary(container)).toContain("Approved");
    });

    fireEvent.click(columnButton(container, "ReceivedBytes"));
    fireEvent.click(applyButton(container, "in"));

    await waitFor(() => {
      expect(unmappedHead(container)).toContain("Unmapped Destination Fields (2)");
    });
    expect(unmappedColumns(container)).not.toContain("ReceivedBytes");
    expect(panel(container)).toBeNull();
    const applied = effective().PanOS?.find((m) => m.source === "in");
    expect(applied).toMatchObject({
      dest: "ReceivedBytes",
      destType: "long",
      action: "rename",
      needsCoercion: true,
      confidence: "reviewer",
    });
    // F1-c: the approval is withdrawn, and the screen says why.
    expect(approveButton(container)).toBeDefined();
    expect(summary(container)).toContain("Approval Required");
    expect(summary(container)).toContain("Modified");
    expect(container.querySelector(".mapping-suggest-applied")?.textContent).toBe(
      "in now fills ReceivedBytes. Approve PanOS again to save it as a learned mapping.",
    );

    // What the pack build receives renames `in` and converts it on the target.
    const plan = buildPipelinePlan({
      solutionName: "Palo Alto Networks",
      packName: "MS-Sentinel-PANOS",
      version: "1.0.0",
      tables: [
        {
          sentinelTable: "CommonSecurityLog",
          logType: "PanOS",
          sourceFormat: "json",
          fieldOverrides: effective().PanOS!,
        },
      ],
    }).tables[0]!;
    expect(plan.overflowConfig.sourceFields).toEqual(["qqzz"]);
    const conf = generatePipelineConfForPlan(plan, "Palo Alto Networks");
    expect(conf).toContain("currentName: in\n");
    expect(conf).toContain("newName: ReceivedBytes");
    expect(report().fieldMappings.find((m) => m.source === "in")?.action).toBe(
      "overflow",
    );
  });

  it("moves a field that already fills a column, vacating it and warning when rules use it", async () => {
    const { container, effective } = await renderAnalyzed({
      ruleFields: new Set(["sourcemacaddress"]),
    });
    expect(unmappedColumns(container)).not.toContain("SourceMACAddress");
    fireEvent.click(columnButton(container, "DestinationMACAddress"));
    const move = candidate(container, "SourceMACAddress");
    expect(applyButton(container, "SourceMACAddress").textContent).toBe(
      "Move from SourceMACAddress",
    );
    expect(move.querySelector(".close-match-disposition")?.textContent).toBe(
      "now: fills SourceMACAddress (keep)",
    );
    expect(move.querySelector('[role="note"]')?.textContent).toBe(
      "SourceMACAddress is used by analytics rules and nothing else fills it: moving SourceMACAddress leaves it empty.",
    );

    fireEvent.click(applyButton(container, "SourceMACAddress"));
    await waitFor(() => {
      expect(unmappedColumns(container)).toContain("SourceMACAddress");
    });
    expect(unmappedColumns(container)).not.toContain("DestinationMACAddress");
    expect(
      effective().PanOS?.find((m) => m.source === "SourceMACAddress"),
    ).toMatchObject({ dest: "DestinationMACAddress", action: "rename" });
  });

  it("keeps an applied field applied when the drop policy it was dropped by is switched off", async () => {
    const { container, effective } = await renderAnalyzed({
      contentRequirements: {
        columns: new Set(["receivedbytes"]),
        catchAllKeys: new Set(),
        opaqueCatchAll: false,
        itemCount: 1,
      },
    });
    const policyButton = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === label,
      )!;
    fireEvent.click(policyButton("Drop unneeded fields"));
    await waitFor(() => {
      expect(effective().PanOS?.find((m) => m.source === "in")?.action).toBe("drop");
    });

    fireEvent.click(columnButton(container, "ReceivedBytes"));
    expect(
      candidate(container, "in").querySelector(".close-match-disposition")?.textContent,
    ).toBe("now: dropped");
    fireEvent.click(applyButton(container, "in"));
    await waitFor(() => {
      expect(effective().PanOS?.find((m) => m.source === "in")?.action).toBe("rename");
    });

    // Restoring what the policy dropped must not reach the reviewer's choice.
    fireEvent.click(policyButton("Restore all dropped fields"));
    await waitFor(() => {
      expect(
        effective().PanOS?.find((m) => m.source === "qqzz")?.action,
      ).toBe("overflow");
    });
    expect(effective().PanOS?.find((m) => m.source === "in")).toMatchObject({
      action: "rename",
      dest: "ReceivedBytes",
    });
  });

  it("offers a constant when nothing in the sample fits, handing the column to the enrichment editor", async () => {
    const { container } = await renderAnalyzed();
    fireEvent.click(columnButton(container, "DeviceVendor"));
    expect(candidates(container)).toEqual([]);
    expect(panel(container)?.querySelector(".mapping-suggest-empty")?.textContent).toContain(
      "No sample field looks close to DeviceVendor.",
    );
    const add = [...panel(container)!.querySelectorAll("button")].find(
      (b) => b.textContent === "Add a constant",
    )!;
    fireEvent.click(add);
    expect(panel(container)).toBeNull();
    const block = container.querySelector(".mapping-review-fields .enrich-table-block")!;
    const [fieldInput, valueInput] = [
      ...block.querySelectorAll<HTMLInputElement>(".enrich-add input"),
    ];
    expect(fieldInput!.value).toBe("DeviceVendor");
    expect(document.activeElement).toBe(valueInput);
  });

  it("closes on Escape and on Dismiss, returning focus to the column", async () => {
    const { container } = await renderAnalyzed();
    const button = columnButton(container, "ReceivedBytes");
    button.focus();
    fireEvent.click(button);
    fireEvent.keyDown(panel(container)!, { key: "Escape" });
    expect(panel(container)).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    const dismiss = panel(container)!.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss the suggestions for ReceivedBytes"]',
    )!;
    fireEvent.click(dismiss);
    expect(panel(container)).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
