// @vitest-environment happy-dom
/**
 * Surface pin for the delivery-fit badge column (DBT-15).
 *
 * The derivation is pinned without a DOM in
 * packages/core/src/domain/sentinel-content/delivery-fit-badge.test.ts. What
 * that cannot see is the half that actually shipped the defect: the JSX
 * rendered the badge behind `ingestion !== null &&`, so a solution the shipped
 * map does not cover produced no element at all. A correct derivation wired
 * behind that guard is still a blank cell, which is why the invariant pinned
 * here is counted over the RENDERED rows: every row, one badge, non-empty text.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { AzureConfig, SentinelContent, SolutionRef } from "@soc/core";
import { DELIVERY_FIT_UNMEASURED_LABEL } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { SolutionBrowser } from "./solution-browser";

afterEach(cleanup);

/**
 * One solution per badge state, using REAL names from the shipped
 * classification map so the fixture cannot drift from the thing under test.
 * The last is the live report's own row: absent from the map because the
 * generator found no parseable connector JSON for it.
 */
const SOLUTIONS: SolutionRef[] = [
  { name: "AbnormalSecurity", path: "Solutions/AbnormalSecurity" },
  { name: "1Password", path: "Solutions/1Password" },
  { name: "Agent 365", path: "Solutions/Agent 365" },
  { name: "Palo Alto Cortex XDR", path: "Solutions/Palo Alto Cortex XDR" },
];

const content: SentinelContent = {
  async getCommitSha(): Promise<string | null> {
    return "abcdef012345";
  },
  async listSolutions(): Promise<SolutionRef[]> {
    return SOLUTIONS;
  },
} as unknown as SentinelContent;

const CONFIG = {
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
} as unknown as AzureConfig;

async function renderList(): Promise<HTMLElement[]> {
  render(
    <PortsProvider ports={{ content } as unknown as UiPorts} config={CONFIG}>
      <SolutionBrowser />
    </PortsProvider>,
  );
  await waitFor(() => {
    expect(screen.getByText("Palo Alto Cortex XDR")).toBeTruthy();
  });
  // Scoped to the list on purpose: the legend renders one specimen badge per
  // state, so a document-wide count would pass with every row still blank.
  const items = document.querySelectorAll<HTMLElement>(
    ".solution-browser-list .solution-browser-item",
  );
  return [...items];
}

describe("SolutionBrowser delivery-fit column (DBT-15)", () => {
  it("gives EVERY row exactly one badge, and none of them are blank", async () => {
    const rows = await renderList();
    expect(rows.length).toBe(SOLUTIONS.length);
    for (const row of rows) {
      const badges = row.querySelectorAll(".ingestion-badge");
      expect(badges.length).toBe(1);
      expect((badges[0].textContent ?? "").trim()).not.toBe("");
    }
  });

  it("says NOT MEASURED on the row the shipped map does not cover", async () => {
    const rows = await renderList();
    const row = rows.find((r) =>
      (r.textContent ?? "").includes("Palo Alto Cortex XDR"),
    );
    expect(row).toBeTruthy();
    const badge = row?.querySelector(".ingestion-badge");
    expect(badge?.textContent).toBe(DELIVERY_FIT_UNMEASURED_LABEL);
    // The tooltip must carry the distinction, not just the label: the point of
    // the state is that it is an absence of evidence, not a verdict of no fit.
    expect(badge?.getAttribute("title")).toMatch(/not measured/i);
    expect(badge?.getAttribute("title")).toMatch(
      /not the same as a poor fit or no fit/i,
    );
  });

  it("still shows the three measured tiers on the rows that have them", async () => {
    // Guards the pin above. A regression that labelled the whole column "Not
    // measured" would satisfy "every row has a badge" and destroy the feature.
    const rows = await renderList();
    const labelFor = (name: string) =>
      rows
        .find((r) => (r.textContent ?? "").includes(name))
        ?.querySelector(".ingestion-badge")?.textContent;
    expect(labelFor("AbnormalSecurity")).toBe("Recommended");
    expect(labelFor("1Password")).toBe("Supported");
    expect(labelFor("Agent 365")).toBe("Legacy");
  });

  it("styles the unmeasured badge as its own state, not as a tier", async () => {
    // A shared class with legacy would read as "the worst tier" rather than
    // "no measurement", so the class the stylesheet keys off is pinned.
    const rows = await renderList();
    const badge = rows
      .find((r) => (r.textContent ?? "").includes("Palo Alto Cortex XDR"))
      ?.querySelector(".ingestion-badge");
    expect(badge?.className).toContain("ingestion-badge-unmeasured");
    expect(badge?.className).not.toContain("ingestion-badge-legacy");
  });
});
