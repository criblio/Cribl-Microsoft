// @vitest-environment happy-dom
/**
 * DBT-106: the Field Mappings table shows AWS's own spelling of a VPC Flow v2
 * field beside the parsed name.
 *
 * WHY THIS IS A DOM PIN. The constant behind it (VPC_FLOW_V2_AWS_NAMES) sat in
 * core for weeks with a comment claiming "the mapping table can show an
 * operator the name they will recognise from the AWS documentation" - and no
 * mapping table read it. A core pin on the lookup alone would have passed the
 * whole time. So this drives the REAL section through Analyze and reads the
 * rows an operator sees.
 *
 * The negative half matters as much: the alias is only true when the
 * positional parser minted the name. A JSON sample carrying `account_id` is not
 * AWS's account-id, and labelling it so would be a confident wrong answer.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { parseSampleContent } from "@soc/core";
import type { GapReport, SchemaCatalog, TaggedSample } from "@soc/core";
import { MappingReviewSection } from "./mapping-review-section";

afterEach(cleanup);

/** Two real v2 lines, in AWS's default field order. */
const VPC_CONTENT = [
  "2 123456789012 eni-0abc123def4567890 10.0.1.25 10.0.2.18 49832 443 6 12 6840 1725265200 1725265260 ACCEPT OK",
  "2 123456789012 eni-0abc123def4567890 10.0.1.25 203.0.113.77 49120 22 6 3 180 1725265380 1725265440 REJECT OK",
].join("\n");

/**
 * The SOURCE-field rows only. The unmapped-destination rows share the
 * `mapping-row` class, and counting them would make "14" measure the schema.
 */
const SOURCE_ROWS = "tr.mapping-row:not(.mapping-row-unmapped)";

/** A catalog with a couple of columns, so the analysis produces a report. */
const catalog: SchemaCatalog = {
  resolveSchema: async () => [
    { name: "TimeGenerated", type: "datetime" },
    { name: "SrcAddr", type: "string" },
  ],
};

function sampleOf(logType: string, content: string, name: string): TaggedSample {
  const parsed = parseSampleContent(content, { sourceName: name });
  return {
    logType,
    format: parsed.format,
    rawEvents: parsed.rawEvents,
    parsed,
  };
}

async function renderAndAnalyze(sample: TaggedSample): Promise<HTMLElement> {
  let reports: GapReport[] = [];
  const { container } = render(
    <MappingReviewSection
      solutionName=""
      samples={[sample]}
      catalog={catalog}
      onReportsChange={(next) => {
        reports = next;
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
    expect(container.querySelectorAll(SOURCE_ROWS).length).toBeGreaterThan(0);
  });
  return container;
}

/** The AWS-spelling labels, keyed by the parsed source name of their row. */
function aliasesBySource(container: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of container.querySelectorAll(SOURCE_ROWS)) {
    const alias = row.querySelector(".mapping-aws-name");
    if (alias === null) continue;
    const source = row.getAttribute("data-source") ?? "";
    out[source] = alias.textContent ?? "";
  }
  return out;
}

describe("mapping review - AWS spelling beside VPC Flow v2 fields (DBT-106)", () => {
  it("shows account-id, interface-id and log-status on exactly those three rows", async () => {
    const sample = sampleOf("VPCFLOW", VPC_CONTENT, "vpc.log");
    // Guard the premise: the parser must have NAMED the columns, or there is
    // no AWS spelling to show and the assertion below would mean nothing.
    expect(sample.format).toBe("positional");
    const container = await renderAndAnalyze(sample);

    // All 14 parsed fields reach the table as rows, so "3" below is a choice
    // the screen made, not an artefact of only three rows existing.
    expect(container.querySelectorAll(SOURCE_ROWS).length).toBe(14);
    expect(aliasesBySource(container)).toEqual({
      account_id: "account-id",
      interface_id: "interface-id",
      log_status: "log-status",
    });
  });

  it("shows NO AWS spelling for a JSON sample that happens to carry account_id", async () => {
    const content = JSON.stringify({
      account_id: "123456789012",
      log_status: "OK",
      srcaddr: "10.0.1.25",
    });
    const sample = sampleOf("APPLOG", content, "app.json");
    expect(sample.format).not.toBe("positional");
    const container = await renderAndAnalyze(sample);

    expect(container.querySelectorAll(SOURCE_ROWS).length).toBe(3);
    expect(aliasesBySource(container)).toEqual({});
  });
});
