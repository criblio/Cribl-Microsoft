// @vitest-environment happy-dom
/**
 * DBT-213 / DBT-208 through the REAL component: the Dest Field select and the
 * Unmapped Destination Fields panel's "Use this field" are ONE re-point.
 *
 *   - DBT-213: a Dest Field re-point withdraws the table's approval (decision
 *     F1-c - approving again saves it as a learned mapping) and forgets the
 *     auto-drop key, so switching the drop policy back cannot undo it. Both
 *     were true of "Use this field" and false of the Dest select.
 *   - DBT-208: pointing a row at a column another row already fills used to
 *     write two Renames onto one name; the second overwrote the first, so that
 *     value reached neither the column nor overflow. The screen now shows the
 *     claim and asks; moving sends the other row to the catch-all.
 *
 * The rows: `in` arrives renamed to ReceivedBytes (GEN-20's alias),
 * SourceMACAddress keeps its own column, and qqzz / qqyy sit in overflow.
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
  ],
};

function sample(): TaggedSample {
  const content = JSON.stringify({
    TimeGenerated: "2026-10-29T12:00:00Z",
    in: 4242,
    SourceMACAddress: "00:11:22:33:44:55",
    qqzz: 7,
    qqyy: "yy",
  });
  return {
    logType: "PanOS",
    format: "json",
    rawEvents: [content],
    parsed: parseSampleContent(content, { sourceName: "panos.json" }),
  };
}

async function renderAnalyzed(
  props: {
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
      {...props}
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
  return { container, effective: () => effective };
}

function rowFor(container: HTMLElement, source: string): HTMLTableRowElement {
  const row = [
    ...container.querySelectorAll<HTMLTableRowElement>(
      ".mapping-review-grid tbody tr.mapping-row:not(.mapping-row-unmapped)",
    ),
  ].find((tr) => tr.getAttribute("data-source") === source);
  if (row === undefined) throw new Error(`no row for ${source}`);
  return row;
}

const destSelect = (container: HTMLElement, source: string) =>
  rowFor(container, source).querySelector<HTMLSelectElement>("select.mapping-select")!;

const pointAt = (container: HTMLElement, source: string, column: string) =>
  fireEvent.change(destSelect(container, source), { target: { value: column } });

const summary = (container: HTMLElement): string =>
  container.querySelector(".mapping-review-fields-summary")?.textContent ?? "";

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  );

const claimPanel = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>("tr.mapping-claim-row .close-match-panel");

const rowOf = (
  effective: () => Readonly<Record<string, GapFieldMapping[]>>,
  source: string,
) => effective().PanOS?.find((m) => m.source === source);

describe("Dest Field re-point = 'Use this field' (DBT-213)", () => {
  it("withdraws the table's approval and says why, as an applied suggestion does", async () => {
    const { container, effective } = await renderAnalyzed();
    fireEvent.click(button(container, "Approve PanOS")!);
    await waitFor(() => {
      expect(summary(container)).toContain("Approved");
    });

    pointAt(container, "qqzz", "DestinationMACAddress");
    await waitFor(() => {
      expect(rowOf(effective, "qqzz")).toMatchObject({
        dest: "DestinationMACAddress",
        action: "rename",
      });
    });
    expect(summary(container)).toContain("Approval Required");
    expect(button(container, "Approve PanOS")).toBeDefined();
    expect(container.querySelector(".mapping-suggest-applied")?.textContent).toBe(
      "qqzz now fills DestinationMACAddress. Approve PanOS again to save it as a learned mapping.",
    );
  });

  it("keeps a hand re-point of an auto-dropped field when the drop policy is switched back", async () => {
    const { container, effective } = await renderAnalyzed({
      contentRequirements: {
        columns: new Set(["receivedbytes"]),
        catchAllKeys: new Set(),
        opaqueCatchAll: false,
        itemCount: 1,
      },
    });
    fireEvent.click(button(container, "Drop unneeded fields")!);
    await waitFor(() => {
      expect(rowOf(effective, "qqzz")?.action).toBe("drop");
    });
    expect(rowOf(effective, "qqyy")?.action).toBe("drop");

    pointAt(container, "qqzz", "DestinationMACAddress");
    await waitFor(() => {
      expect(rowOf(effective, "qqzz")?.action).toBe("rename");
    });

    // Restoring what the policy dropped must not reach the reviewer's choice.
    fireEvent.click(button(container, "Restore all dropped fields")!);
    await waitFor(() => {
      expect(rowOf(effective, "qqyy")?.action).toBe("overflow");
    });
    expect(rowOf(effective, "qqzz")).toMatchObject({
      action: "rename",
      dest: "DestinationMACAddress",
    });
  });
});

describe("Dest Field re-point onto a column another row fills (DBT-208)", () => {
  it("asks first, and changes nothing until the reviewer answers", async () => {
    const { container, effective } = await renderAnalyzed();
    expect(rowOf(effective, "in")).toMatchObject({
      dest: "ReceivedBytes",
      action: "rename",
    });
    destSelect(container, "qqzz").focus();
    pointAt(container, "qqzz", "ReceivedBytes");

    const panel = claimPanel(container)!;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("role")).toBe("region");
    expect(
      container.querySelector(`#${panel.getAttribute("aria-labelledby")}`)?.textContent,
    ).toBe("ReceivedBytes is already filled by in");
    expect(panel.querySelector(".mapping-claim-text")?.textContent).toBe(
      "Using qqzz there moves in out of ReceivedBytes into AdditionalExtensions (overflow), so its value is kept.",
    );
    expect(document.activeElement).toBe(panel);
    // Nothing applied yet: both rows are as the analysis left them.
    expect(rowOf(effective, "qqzz")?.action).toBe("overflow");
    expect(rowOf(effective, "in")?.dest).toBe("ReceivedBytes");
    expect(destSelect(container, "qqzz").value).toBe("AdditionalExtensions");

    // Keep: nothing changes, and focus returns to the select.
    fireEvent.click(button(container, "Keep in")!);
    expect(claimPanel(container)).toBeNull();
    expect(rowOf(effective, "qqzz")?.action).toBe("overflow");
    expect(document.activeElement).toBe(destSelect(container, "qqzz"));

    // Escape answers the same way.
    pointAt(container, "qqzz", "ReceivedBytes");
    fireEvent.keyDown(claimPanel(container)!, { key: "Escape" });
    expect(claimPanel(container)).toBeNull();
    expect(rowOf(effective, "in")?.dest).toBe("ReceivedBytes");
  });

  it("moves the column on 'Move': one Rename onto it, and the other field reaches overflow", async () => {
    const { container, effective } = await renderAnalyzed();
    fireEvent.click(button(container, "Approve PanOS")!);
    pointAt(container, "qqzz", "ReceivedBytes");
    const move = button(container, "Move ReceivedBytes from in")!;
    expect(move.getAttribute("aria-label")).toBe(
      "Move ReceivedBytes from in to qqzz",
    );
    fireEvent.click(move);

    await waitFor(() => {
      expect(rowOf(effective, "qqzz")).toMatchObject({
        dest: "ReceivedBytes",
        action: "rename",
      });
    });
    expect(claimPanel(container)).toBeNull();
    expect(rowOf(effective, "in")).toMatchObject({
      dest: "AdditionalExtensions",
      action: "overflow",
    });
    expect(summary(container)).toContain("Approval Required");

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
    // The displaced field is collected into the catch-all, not lost.
    expect(plan.overflowConfig.sourceFields).toEqual(["in", "qqyy"]);
    const conf = generatePipelineConfForPlan(plan, "Palo Alto Networks");
    expect(conf.match(/newName: ReceivedBytes\n/g)).toHaveLength(1);
    expect(conf).toContain("currentName: qqzz\n");
    expect(conf).not.toContain("currentName: in\n");
  });

  it("warns, as a DBT-202 move does, when the re-pointed field leaves a rule column empty", async () => {
    const { container } = await renderAnalyzed({
      ruleFields: new Set(["sourcemacaddress"]),
    });
    pointAt(container, "SourceMACAddress", "ReceivedBytes");
    expect(claimPanel(container)?.querySelector('[role="note"]')?.textContent).toBe(
      "SourceMACAddress is used by analytics rules and nothing else fills it: moving SourceMACAddress leaves it empty.",
    );
  });
});
