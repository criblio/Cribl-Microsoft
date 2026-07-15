/**
 * Pins for the analyzeSiemExport usecase (Unit 26): fast analysis (ONE
 * content call - enrichment is per-solution and on demand after the
 * 2026-07-14 stall regression), the legacy graceful degradation (no port /
 * unreachable content = static maps only), and the per-solution rule fetch.
 */

import { describe, expect, it } from "vitest";
import { FakeSentinelContent } from "../../testing/index";
import { enrichPlanWithAnalyticRules } from "../../domain/siem-migration/index";
import {
  analyzeSiemExport,
  fetchSolutionAnalyticRules,
} from "./analyze-siem-export";

const SPLUNK_EXPORT = JSON.stringify({
  result: {
    alertrules: [
      { title: "Okta anomaly", search: "`okta` | stats count", "alert.severity": 2 },
    ],
  },
});

const RULE_YAML = [
  "id: r-1",
  "name: Okta Rule One",
  "severity: High",
  "tactics:",
  "  - CredentialAccess",
  "query: |",
  "  Okta_CL | where outcome == 'FAILURE'",
].join("\n");

describe("analyzeSiemExport", () => {
  it("degrades to the static maps when no content port is bound", async () => {
    const plan = await analyzeSiemExport(
      {},
      { content: SPLUNK_EXPORT, platform: "splunk", fileName: "x.json" },
    );
    expect(plan.dataSources[0].sentinelSolution).toBe("Okta Single Sign-On");
    expect(plan.dataSources[0].sentinelAnalyticRules).toEqual([]);
    expect(plan.totalSentinelRules).toBe(0);
  });

  it("does NOT enrich eagerly (the 2026-07-14 stall fix): rules load per solution on demand", async () => {
    const content = new FakeSentinelContent({
      files: {
        "Solutions/Okta Single Sign-On/Analytic Rules/rule1.yaml": RULE_YAML,
        "Solutions/Okta Single Sign-On/Data Connectors/conn.json": "{}",
      },
    });
    const plan = await analyzeSiemExport(
      { content },
      { content: SPLUNK_EXPORT, platform: "splunk", fileName: "x.json" },
    );
    const okta = plan.dataSources.find(
      (d) => d.sentinelSolution === "Okta Single Sign-On",
    );
    expect(okta?.sentinelAnalyticRules).toEqual([]);
    expect(plan.totalSentinelRules).toBe(0);

    // The on-demand path: one solution's rules, folded in purely.
    const matches = await fetchSolutionAnalyticRules(
      content,
      ["Okta Single Sign-On"],
      "Okta Single Sign-On",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ name: "Okta Rule One", severity: "High" });
    const enriched = enrichPlanWithAnalyticRules(
      plan,
      new Map([["okta single sign-on", matches]]),
    );
    expect(enriched.totalSentinelRules).toBe(1);
    expect(
      enriched.dataSources.find((d) => d.sentinelSolution === "Okta Single Sign-On")
        ?.sentinelAnalyticRules,
    ).toHaveLength(1);
  });

  it("fetchSolutionAnalyticRules reports progress and fuzzy-matches the dir name", async () => {
    const content = new FakeSentinelContent({
      files: {
        "Solutions/Okta Single Sign-On/Analytic Rules/rule1.yaml": RULE_YAML,
        "Solutions/Okta Single Sign-On/Analytic Rules/rule2.yaml": RULE_YAML,
        "Solutions/Okta Single Sign-On/Data Connectors/conn.json": "{}",
      },
    });
    const ticks: Array<[number, number]> = [];
    const matches = await fetchSolutionAnalyticRules(
      content,
      ["Okta Single Sign-On"],
      "okta single signon", // fuzzy: normalized containment
      (read, total) => ticks.push([read, total]),
    );
    expect(matches).toHaveLength(2);
    expect(ticks).toEqual([
      [1, 2],
      [2, 2],
    ]);
    // No matching directory resolves to [] (never throws).
    await expect(
      fetchSolutionAnalyticRules(content, ["Okta Single Sign-On"], "Zebra Firewall"),
    ).resolves.toEqual([]);
  });

  it("fuzzy-maps unmapped sources against the live solution list", async () => {
    const content = new FakeSentinelContent({
      files: {
        "Solutions/Salesforce Service Cloud/Data Connectors/conn.json": "{}",
      },
    });
    const plan = await analyzeSiemExport(
      { content },
      {
        content: JSON.stringify({
          result: { alertrules: [{ title: "sf", search: "`salesforce` | x" }] },
        }),
        platform: "splunk",
        fileName: "x.json",
      },
    );
    expect(plan.dataSources[0].sentinelSolution).toBe("Salesforce Service Cloud");
    expect(plan.dataSources[0].confidence).toBe("medium");
  });
});
