// @vitest-environment happy-dom
/**
 * DBT-203 through the WHOLE screen: a Rule Coverage missing-field chip offers
 * "Use this field", the choice lands in the DCR Gap Analysis table, and the
 * chip clears.
 *
 * A MOUNT, because both halves of the defect live in integrate-screen.tsx and
 * nowhere a pure module can see: the coverage sections were handed the
 * analysis BASELINE reports (so an applied field never counted as available
 * and its chip stayed), and the panel's only action was a sentence telling the
 * operator to go and find the row in another section. The apply itself travels
 * page -> mapping review as a nonce event, exactly like "Drop unneeded fields".
 *
 * The fixture is the PAN-OS UAT shape (2026-10-29): PanSrcMac sits in
 * AdditionalExtensions while SourceMACAddress stays empty - the edit the UAT
 * operator made by hand (apply-remap.ts) - and a rule needs SourceMACAddress.
 * The same rule also reads ReceivedBytes, which CEF `in` now fills on its own
 * (GEN-20 aliased it), so it must NOT surface as a chip. No solution is
 * selected and no content port is wired - the rule arrives as a custom KQL
 * upload, which the rules section analyzes without fetching anything.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { DEFAULT_CRIBL_OPTIONS, parseSampleContent } from "@soc/core";
import type { AzureConfig, TaggedSample } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { IntegrateScreen } from "./integrate-screen";

afterEach(cleanup);

const CEF =
  "CEF:0|Palo Alto Networks|PAN-OS|10.1|end|TRAFFIC|1|src=10.0.0.1 dst=10.0.0.2 in=4242 PanSrcMac=00:11:22:33:44:55";

function sample(): TaggedSample {
  return {
    logType: "PanOS",
    format: "cef",
    rawEvents: [CEF],
    parsed: parseSampleContent(CEF, { sourceName: "panos.log" }),
  };
}

const CONFIG: AzureConfig = {
  clientId: "",
  tenantId: "",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
};

/** Offline ports: every network read fails; the sample store holds one CEF sample. */
function ports(): UiPorts {
  return {
    azure: { request: vi.fn().mockRejectedValue(new Error("offline")) },
    cribl: { request: vi.fn().mockRejectedValue(new Error("offline")) },
    packs: { list: vi.fn().mockRejectedValue(new Error("offline")) },
    packInstall: { list: vi.fn().mockRejectedValue(new Error("offline")) },
    jobs: { list: vi.fn().mockResolvedValue([]) },
    samples: {
      list: vi.fn(async () => [sample()]),
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as UiPorts;
}

/** Mount, run the gap analysis, upload one rule and analyze its coverage. */
async function renderCovered() {
  const { container } = render(
    <PortsProvider ports={ports()} config={CONFIG}>
      <IntegrateScreen
        toolkitVersion="9.9.9-test"
        scopeCommitted={false}
        offline
        onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
        criblDefaults={DEFAULT_CRIBL_OPTIONS}
      />
    </PortsProvider>,
  );
  const analyze = await waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>(
      ".mapping-review-analyze button",
    );
    expect(button?.disabled).toBe(false);
    return button!;
  });
  fireEvent.click(analyze);
  await waitFor(() => {
    expect(gapRow(container, "PanSrcMac")).not.toBeNull();
  });

  // The FIRST coverage panel is the rules instance (section 4, Rules view).
  const rules = container.querySelector<HTMLElement>(".rule-coverage")!;
  // The reports reach coverage one render after the table appears; an upload
  // before that is queued until they arrive (DBT-212). Waiting keeps this flow
  // on the direct run path, which is the one under test here.
  await waitFor(() => {
    expect(
      rules.querySelector<HTMLButtonElement>(".rule-coverage-controls .run-button")
        ?.disabled,
    ).toBe(false);
  });
  const upload = rules.querySelector<HTMLInputElement>(
    ".rule-coverage-upload input[type=file]",
  )!;
  const rule = new File(
    [
      'CommonSecurityLog | where ReceivedBytes > 1000000 | where SourceMACAddress == "00:11:22:33:44:55" | project SourceIP',
    ],
    "exfil.kql",
    { type: "text/plain" },
  );
  fireEvent.change(upload, { target: { files: [rule] } });
  // Only SourceMACAddress: ReceivedBytes is filled by the `in` rename.
  await waitFor(() => {
    expect(chips(rules)).toEqual(["SourceMACAddress"]);
  });
  return { container, rules };
}

const gapRow = (container: HTMLElement, source: string) =>
  container.querySelector<HTMLTableRowElement>(
    `tr.mapping-row[data-source="${source}"]`,
  );

/** The aggregated "Fields missing across rules" chips, in order. */
const chips = (rules: HTMLElement): string[] =>
  [
    ...rules.querySelectorAll(".coverage-missing-chips button.missing-field-button"),
  ].map((b) => b.textContent ?? "");

const unmappedColumns = (container: HTMLElement): string[] =>
  [
    ...container.querySelectorAll(
      "tr.mapping-row-unmapped button.missing-field-button",
    ),
  ].map((b) => b.textContent ?? "");

function chip(rules: HTMLElement, field: string): HTMLButtonElement {
  const button = [
    ...rules.querySelectorAll<HTMLButtonElement>(
      ".coverage-missing-chips button.missing-field-button",
    ),
  ].find((b) => b.textContent === field);
  if (button === undefined) throw new Error(`no chip for ${field}`);
  return button;
}

function candidateApply(rules: HTMLElement, source: string): HTMLButtonElement {
  const button = rules.querySelector<HTMLButtonElement>(
    `.close-match-panel .close-match-row[data-source="${source}"] button.mapping-suggest-apply`,
  );
  if (button === null) throw new Error(`no apply button for ${source}`);
  return button;
}

const fieldsSummary = (container: HTMLElement): string =>
  container.querySelector(".mapping-review-fields-summary")?.textContent ?? "";

describe("Rule Coverage chips apply a close match (DBT-203)", () => {
  it("arrives with CEF `in` renamed to ReceivedBytes, so the rule's ReceivedBytes is no chip (GEN-20)", async () => {
    const { container, rules } = await renderCovered();
    expect(gapRow(container, "in")?.className).toBe(
      "mapping-row mapping-row-rename",
    );
    expect(gapRow(container, "in")!.querySelectorAll("select")[0]!.value).toBe(
      "ReceivedBytes",
    );
    expect(unmappedColumns(container)).not.toContain("ReceivedBytes");
    expect(chips(rules)).not.toContain("ReceivedBytes");
  });

  it("offers 'Use this field' for the overflow field that fills the missing column", async () => {
    const { rules } = await renderCovered();
    fireEvent.click(chip(rules, "SourceMACAddress"));
    const apply = candidateApply(rules, "PanSrcMac");
    expect(apply.textContent).toBe("Use this field");
    expect(apply.getAttribute("aria-label")).toBe(
      "Use this field: PanSrcMac into SourceMACAddress (PanOS)",
    );
    // The old dead end is gone: nothing tells the operator to go hunting.
    expect(rules.querySelector(".close-match-panel")?.textContent).not.toContain(
      "open the Gap Analysis section and search",
    );
  });

  it("applies in the Gap Analysis table, withdraws the approval, and clears the chip", async () => {
    const { container, rules } = await renderCovered();
    const approve = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Approve PanOS",
    )!;
    fireEvent.click(approve);
    await waitFor(() => {
      expect(fieldsSummary(container)).toContain("Approved");
    });
    expect(gapRow(container, "PanSrcMac")?.className).toBe(
      "mapping-row mapping-row-overflow",
    );
    expect(unmappedColumns(container)).toContain("SourceMACAddress");

    fireEvent.click(chip(rules, "SourceMACAddress"));
    fireEvent.click(candidateApply(rules, "PanSrcMac"));

    // The Gap Analysis row is now the rename the pack build receives.
    await waitFor(() => {
      expect(gapRow(container, "PanSrcMac")?.className).toBe(
        "mapping-row mapping-row-rename",
      );
    });
    const selects = gapRow(container, "PanSrcMac")!.querySelectorAll("select");
    expect(selects[0]!.value).toBe("SourceMACAddress");
    expect(selects[1]!.value).toBe("rename");
    expect(unmappedColumns(container)).not.toContain("SourceMACAddress");
    // Same path as the Unmapped Destination Fields panel: approval withdrawn.
    expect(fieldsSummary(container)).toContain("Approval Required");

    // The chip clears: coverage reads the EFFECTIVE mappings.
    await waitFor(() => {
      expect(chips(rules)).toEqual([]);
    });
    expect(rules.querySelector(".close-match-panel")).toBeNull();
    expect(rules.querySelector(".mapping-suggest-applied")?.textContent).toBe(
      "PanSrcMac now fills SourceMACAddress (PanOS) in the DCR Gap Analysis.",
    );
  });

  it("keeps the applied note true after the table is approved again, and focuses it", async () => {
    const { container, rules } = await renderCovered();
    fireEvent.click(chip(rules, "SourceMACAddress"));
    const apply = candidateApply(rules, "PanSrcMac");
    apply.focus();
    fireEvent.click(apply);
    const note = await waitFor(() => {
      const el = rules.querySelector<HTMLElement>(".mapping-suggest-applied");
      expect(el).not.toBeNull();
      return el!;
    });
    // The apply button left with the panel and the chip cleared, so focus
    // lands on the announcement instead of falling to the page body.
    expect(document.activeElement).toBe(note);

    // The operator approves the table; coverage cannot see approvals, so its
    // note must not keep asking for one (the DBT-202 note rule).
    const approve = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Approve PanOS",
    )!;
    fireEvent.click(approve);
    await waitFor(() => {
      expect(fieldsSummary(container)).toContain("Approved");
    });
    expect(rules.querySelector(".mapping-suggest-applied")?.textContent).toBe(
      "PanSrcMac now fills SourceMACAddress (PanOS) in the DCR Gap Analysis.",
    );
  });
});
