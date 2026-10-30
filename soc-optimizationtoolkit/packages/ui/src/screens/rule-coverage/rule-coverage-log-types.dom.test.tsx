// @vitest-environment happy-dom
/**
 * DBT-223: Rule Coverage pooled every log type, so one close-match apply
 * cleared the missing chip for all of them. Reported on TMNA with PAN-OS
 * TRAFFIC and THREAT samples. A mount, because the defect is what the operator
 * SEES - the chip and the candidates - over two log types in one table.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AzureConfig, GapFieldMapping, GapReport, SchemaCatalog } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { RuleCoverageSection } from "./rule-coverage-section";

afterEach(cleanup);

const CONFIG = {
  clientId: "",
  tenantId: "",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
} as AzureConfig;

const COLUMNS = ["TimeGenerated", "SourceUserID", "DestinationIP", "AdditionalExtensions"];
const catalog: SchemaCatalog = {
  resolveSchema: async () => COLUMNS.map((name) => ({ name, type: "string" })),
};

function row(source: string, dest: string, action: GapFieldMapping["action"]): GapFieldMapping {
  return {
    source,
    dest,
    sourceType: "string",
    destType: "string",
    confidence: "exact",
    action,
    needsCoercion: false,
    description: "",
  } as GapFieldMapping;
}

function report(logType: string, mappings: GapFieldMapping[]): GapReport {
  return {
    tableName: "CommonSecurityLog",
    logType,
    fieldMappings: mappings,
    destSchema: COLUMNS.map((name) => ({ name, type: "string" })),
  } as unknown as GapReport;
}

// TRAFFIC also carries a near-miss in overflow, so a pooled candidate list
// would offer it beside THREAT's - the per-log-type pin can then fail.
const TRAFFIC = report("TRAFFIC", [
  row("suser", "SourceUserID", "rename"),
  row("dst", "DestinationIP", "rename"),
  row("source_user_ident", "AdditionalExtensions", "overflow"),
]);
const THREAT = report("THREAT", [
  row("dst", "DestinationIP", "rename"),
  row("source_user_id", "AdditionalExtensions", "overflow"),
]);

const RULE_KQL = "CommonSecurityLog | project SourceUserID, DestinationIP";

async function mountAndAnalyze(onApplyCloseMatch = vi.fn()) {
  const view = render(
    <PortsProvider ports={{} as UiPorts} config={CONFIG}>
      <RuleCoverageSection
        solutionName=""
        reports={[TRAFFIC, THREAT]}
        catalog={catalog}
        contentFilter="rules"
        onApplyCloseMatch={onApplyCloseMatch}
      />
    </PortsProvider>,
  );
  const input = view.container.querySelector<HTMLInputElement>(
    ".rule-coverage-upload input[type=file]",
  )!;
  fireEvent.change(input, {
    target: { files: [new File([RULE_KQL], "users.kql", { type: "text/plain" })] },
  });
  await waitFor(() => {
    expect(chipTexts(view.container).length).toBeGreaterThan(0);
  });
  return { ...view, onApplyCloseMatch };
}

const chipTexts = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".coverage-missing-chips button.missing-field-button")].map(
    (b) => b.textContent ?? "",
  );

describe("Rule Coverage over two log types (DBT-223)", () => {
  it("keeps a column TRAFFIC fills as missing, and names THREAT as the log type that lacks it", async () => {
    const { container } = await mountAndAnalyze();
    expect(chipTexts(container)).toEqual(["SourceUserID - missing in THREAT"]);
  });

  it("offers THREAT's own candidates, and applies the choice to THREAT only", async () => {
    const { container, onApplyCloseMatch } = await mountAndAnalyze();
    fireEvent.click(container.querySelector(".coverage-missing-chips button.missing-field-button")!);
    const panel = container.querySelector(".close-match-panel")!;
    expect(panel.querySelector(".close-match-head")!.textContent).toContain("missing in THREAT");
    const rows = [...panel.querySelectorAll(".close-match-row")];
    expect(rows.length).toBeGreaterThan(0);
    // Only THREAT's fields are offered - TRAFFIC already has its choice.
    for (const r of rows) expect(r.textContent).toContain("(THREAT)");
    fireEvent.click(rows[0]!.querySelector("button.mapping-suggest-apply")!);
    expect(onApplyCloseMatch).toHaveBeenCalledWith({
      logType: "THREAT",
      sourceField: "source_user_id",
      dest: "SourceUserID",
    });
  });
});
