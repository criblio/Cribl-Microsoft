// @vitest-environment happy-dom
/**
 * THE SEAM PIN for DBT-250: the Destination table override offers the schema
 * repository's tables through the REAL component, whether or not the workspace
 * can be read, and says "not in this workspace" only when it was read.
 *
 * The decision is pinned in destination-table-options.test.ts; this file pins
 * the wiring - the repo listing reaching the dropdown, the verified flag
 * reaching the flag, and a non-workspace pick still re-analysing (the override
 * is never gated on existence).
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  FakeSentinelContent,
  KQL_VALIDATION_TABLES_DIR,
  parseSampleContent,
} from "@soc/core";
import type { GapReport, SchemaCatalog, TaggedSample } from "@soc/core";
import { MappingReviewSection } from "./mapping-review-section";

afterEach(cleanup);

/** Defined ONLY in the schema repository - no other source can offer it. */
const REPO_TABLE = "RepoOnlyAudit_CL";

const catalog: SchemaCatalog = {
  resolveSchema: async () => [
    { name: "TimeGenerated", type: "datetime" },
    { name: "SrcUserName", type: "string" },
  ],
};

function sample(): TaggedSample {
  const raw = JSON.stringify({ srcUser: "abby", action: "login" });
  return {
    logType: "AUDIT",
    format: "json",
    rawEvents: [raw],
    parsed: parseSampleContent(raw, { sourceName: "audit.json" }),
  };
}

function renderSection(workspace: { tables?: string[]; verified: boolean }) {
  let latest: GapReport[] = [];
  const content = new FakeSentinelContent({
    files: {
      [`${KQL_VALIDATION_TABLES_DIR}/${REPO_TABLE}.json`]: JSON.stringify({
        Name: REPO_TABLE,
        Properties: [{ Name: "TimeGenerated", Type: "DateTime" }],
      }),
    },
  });
  const { container } = render(
    <MappingReviewSection
      solutionName=""
      samples={[sample()]}
      content={content}
      catalog={catalog}
      workspaceTables={workspace.tables}
      workspaceTablesVerified={workspace.verified}
      fetchTableSchema={async () => null}
      onReportsChange={(next) => {
        latest = next;
      }}
    />,
  );
  return { container, reports: () => latest };
}

async function analyze(h: ReturnType<typeof renderSection>): Promise<void> {
  const button = [...h.container.querySelectorAll("button")].find((b) =>
    /analyze/i.test(b.textContent ?? ""),
  );
  if (button === undefined) throw new Error("Analyze button not rendered");
  fireEvent.click(button);
  await waitFor(() => {
    expect(h.reports().length).toBe(1);
  });
}

function openOptions(h: ReturnType<typeof renderSection>): Element[] {
  const control = h.container.querySelector(
    ".mapping-review-table-select .searchable-select-control",
  );
  if (control === null) throw new Error("destination table control not rendered");
  fireEvent.click(control);
  return [...h.container.querySelectorAll(".searchable-select-option")];
}

async function pick(h: ReturnType<typeof renderSection>, table: string) {
  const option = openOptions(h).find((o) => o.textContent?.includes(table));
  if (option === undefined) throw new Error(`${table} not offered`);
  fireEvent.click(option);
  await waitFor(() => {
    expect(h.reports()[0]?.tableName).toBe(table);
  });
}

describe("Destination table override - schema repository tables (DBT-250)", () => {
  it("offers repo tables with NO workspace read, flags nothing, and still re-analyses", async () => {
    const h = renderSection({ verified: false });
    await analyze(h);
    const options = openOptions(h);
    // The regression was four natives; the repo AND the bundled catalog
    // must both be contributing now.
    expect(options.length).toBeGreaterThan(4);
    const repoOption = options.find((o) => o.textContent?.includes(REPO_TABLE));
    expect(repoOption).toBeDefined();
    expect(repoOption?.textContent).not.toContain("not in workspace");
    fireEvent.click(repoOption!);
    await waitFor(() => {
      expect(h.reports()[0]?.tableName).toBe(REPO_TABLE);
    });
    expect(h.container.querySelector(".mapping-review-table-absent")).toBeNull();
  });

  it("flags a pick the READ workspace does not contain, without blocking it", async () => {
    const h = renderSection({ tables: ["Syslog", "SecurityEvent"], verified: true });
    await analyze(h);
    const repoOption = openOptions(h).find((o) => o.textContent?.includes(REPO_TABLE));
    expect(repoOption?.textContent).toContain("not in workspace");
    fireEvent.click(repoOption!);
    await waitFor(() => {
      expect(h.reports()[0]?.tableName).toBe(REPO_TABLE);
    });
    const note = h.container.querySelector(".mapping-review-table-absent");
    expect(note?.textContent).toContain(`${REPO_TABLE} is not in this workspace`);
    expect(note?.textContent).toContain("pack can still be built");
  });

  it("does not flag a table the read workspace has", async () => {
    const h = renderSection({ tables: ["Syslog", REPO_TABLE], verified: true });
    await analyze(h);
    await pick(h, REPO_TABLE);
    expect(h.container.querySelector(".mapping-review-table-absent")).toBeNull();
  });
});
