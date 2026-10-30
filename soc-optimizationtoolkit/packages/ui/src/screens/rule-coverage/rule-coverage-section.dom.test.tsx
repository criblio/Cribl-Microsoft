// @vitest-environment happy-dom
/**
 * DBT-212: Rule Coverage's two ways of showing the operator nothing, or
 * something stale, while looking finished.
 *
 *   - A custom rule uploaded BEFORE the gap reports arrive was accepted (the
 *     section said "1 custom rule") and never analyzed: runCoverage returns
 *     early on an empty report set, and nothing ran it once reports came. The
 *     upload is now QUEUED and runs when they arrive.
 *   - After a new gap analysis changes the destination tables, the last run's
 *     availability kept rendering its chips. A field the new analysis maps
 *     stayed a chip and read as a failed apply. The result is now marked stale
 *     with a "Re-analyze to refresh" note and its chips are withheld.
 *
 * A MOUNT of the section itself, because both defects are about when the
 * component runs and what it renders between runs - nothing a pure module
 * sees. No content port and no solution: the rule arrives as a custom KQL
 * upload, and the schema comes from a fixed catalog.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AzureConfig, GapFieldMapping, GapReport, SchemaCatalog } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { RuleCoverageSection } from "./rule-coverage-section";
import type { RuleCoverageSectionProps } from "./rule-coverage-section";

afterEach(cleanup);

const CONFIG: AzureConfig = {
  clientId: "",
  tenantId: "",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
};

const COLUMNS = ["TimeGenerated", "SourceIP", "DestinationIP", "DeviceAction"];

const catalog: SchemaCatalog = {
  resolveSchema: async () => COLUMNS.map((name) => ({ name, type: "string" })),
};

function mapped(source: string, dest: string): GapFieldMapping {
  return {
    source,
    dest,
    sourceType: "string",
    destType: "string",
    confidence: "exact",
    action: "rename",
    needsCoercion: false,
    description: "",
  } as GapFieldMapping;
}

/** The slice of a gap report coverage reads. */
function report(tableName: string, mappings: GapFieldMapping[]): GapReport {
  return {
    tableName,
    logType: "Traffic",
    fieldMappings: mappings,
    destSchema: [],
  } as unknown as GapReport;
}

const REPORT_A = report("TableA", [mapped("src", "SourceIP")]);
// A later gap analysis: a different table, and DeviceAction now mapped.
const REPORT_B = report("TableB", [
  mapped("src", "SourceIP"),
  mapped("act", "DeviceAction"),
]);

const RULE_KQL = 'TableA | where DeviceAction == "deny" | project SourceIP';

function mount(reports: GapReport[], schemas: SchemaCatalog = catalog) {
  const props: RuleCoverageSectionProps = {
    solutionName: "",
    reports,
    catalog: schemas,
    contentFilter: "rules",
  };
  const view = render(
    <PortsProvider ports={{} as UiPorts} config={CONFIG}>
      <RuleCoverageSection {...props} />
    </PortsProvider>,
  );
  const rerenderWith = (next: GapReport[]) =>
    view.rerender(
      <PortsProvider ports={{} as UiPorts} config={CONFIG}>
        <RuleCoverageSection {...props} reports={next} />
      </PortsProvider>,
    );
  return { ...view, rerenderWith };
}

function upload(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>(
    ".rule-coverage-upload input[type=file]",
  )!;
  const rule = new File([RULE_KQL], "deny.kql", { type: "text/plain" });
  fireEvent.change(input, { target: { files: [rule] } });
}

/** The aggregated "Fields missing across rules" chips, in order. */
const chips = (container: HTMLElement): string[] =>
  [
    ...container.querySelectorAll(
      ".coverage-missing-chips button.missing-field-button",
    ),
  ].map((b) => b.textContent ?? "");

const note = (container: HTMLElement, kind: string): string | null =>
  container.querySelector(`[data-coverage-note="${kind}"]`)?.textContent ?? null;

const runButton = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(".rule-coverage-controls .run-button")!;

describe("a custom rule uploaded before the gap reports (DBT-212)", () => {
  it("is queued with a note, then analyzed when the reports arrive", async () => {
    const { container, rerenderWith } = mount([]);
    upload(container);

    await waitFor(() => {
      expect(note(container, "queued")).toBe(
        "1 custom rule is queued - its coverage runs as soon as the DCR Gap Analysis reports arrive.",
      );
    });
    expect(container.querySelector(".coverage-sections")).toBeNull();

    rerenderWith([REPORT_A]);

    await waitFor(() => {
      expect(chips(container)).toEqual(["DeviceAction"]);
    });
    expect(
      [...container.querySelectorAll(".coverage-item-name")].map((n) => n.textContent),
    ).toEqual(["denyCUSTOM"]);
    expect(note(container, "queued")).toBeNull();
    expect(runButton(container).textContent).toBe("Re-analyze coverage");
  });

  it("drops the queued run when the custom rules are cleared first", async () => {
    const { container, rerenderWith } = mount([]);
    upload(container);
    await waitFor(() => {
      expect(note(container, "queued")).not.toBeNull();
    });
    const clear = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Clear",
    )!;
    fireEvent.click(clear);
    await waitFor(() => {
      expect(note(container, "queued")).toBeNull();
    });

    rerenderWith([REPORT_A]);
    // Nothing ran: no result, and the button still offers the first analysis.
    await waitFor(() => {
      expect(runButton(container).disabled).toBe(false);
    });
    expect(container.querySelector(".coverage-sections")).toBeNull();
    expect(runButton(container).textContent).toBe("Analyze rule coverage");
  });
});

describe("a custom rule uploaded while a run is in flight (DBT-212)", () => {
  it("is queued behind that run and analyzed when it finishes", async () => {
    // The first run blocks on its schema lookup until released, so the upload
    // lands while it is in flight - the run that cannot see the upload.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: SchemaCatalog = {
      resolveSchema: async () => {
        await gate;
        return COLUMNS.map((name) => ({ name, type: "string" }));
      },
    };
    const { container } = mount([REPORT_A], slow);
    fireEvent.click(runButton(container));
    await waitFor(() => {
      expect(runButton(container).textContent).toBe("Analyzing coverage...");
    });
    upload(container);
    await waitFor(() => {
      expect(container.querySelector(".rule-coverage-controls .field-hint")?.textContent).toBe(
        "1 custom rule",
      );
    });
    // The reports are here, so the waiting-for-reports note would be false.
    expect(note(container, "queued")).toBeNull();
    release();

    await waitFor(() => {
      expect(
        [...container.querySelectorAll(".coverage-item-name")].map((n) => n.textContent),
      ).toEqual(["denyCUSTOM"]);
    });
    expect(chips(container)).toEqual(["DeviceAction"]);
    expect(runButton(container).textContent).toBe("Re-analyze coverage");
  });
});

describe("coverage after a new gap analysis changes the tables (DBT-212)", () => {
  it("withholds the old chips behind a Re-analyze to refresh note until re-run", async () => {
    const { container, rerenderWith } = mount([REPORT_A]);
    upload(container);
    await waitFor(() => {
      expect(chips(container)).toEqual(["DeviceAction"]);
    });
    expect(note(container, "stale")).toBeNull();

    // TableA -> TableB, and the new analysis maps DeviceAction. The old run's
    // availability must not keep DeviceAction as a chip.
    rerenderWith([REPORT_B]);

    await waitFor(() => {
      expect(note(container, "stale")).toBe(
        "The DCR Gap Analysis changed the destination tables (now TableB) since this coverage ran - Re-analyze to refresh.",
      );
    });
    expect(chips(container)).toEqual([]);
    expect(container.querySelector(".coverage-sections")).toBeNull();

    fireEvent.click(runButton(container));

    await waitFor(() => {
      expect(container.querySelector(".coverage-sections")).not.toBeNull();
    });
    expect(note(container, "stale")).toBeNull();
    expect(chips(container)).toEqual([]);
    expect(
      [...container.querySelectorAll(".coverage-pct")].map((n) => n.textContent),
    ).toEqual(["100%"]);
  });

  // With NO reports the stale note would ask for a Re-analyze the disabled
  // button cannot give ("now none"); the no-reports note already says what to
  // do, so it speaks alone - and the old result stays withheld.
  it("says only 'run the gap analysis first' when the reports are gone", async () => {
    const { container, rerenderWith } = mount([REPORT_A]);
    upload(container);
    await waitFor(() => {
      expect(chips(container)).toEqual(["DeviceAction"]);
    });

    rerenderWith([]);

    await waitFor(() => {
      expect(runButton(container).disabled).toBe(true);
    });
    expect(note(container, "stale")).toBeNull();
    expect(container.querySelector(".coverage-sections")).toBeNull();
    expect(
      // The note's own text node; its (i) tip renders inside the same <p>.
      [...container.querySelectorAll("p.field-hint")].map((p) => p.firstChild?.textContent),
    ).toEqual(["Run the DCR Gap Analysis first."]);
  });
});
