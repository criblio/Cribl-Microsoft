/**
 * Pins for the analyzeSiemExport usecase (Unit 26): fuzzy mapping + rule
 * enrichment over the SentinelContent port, with the legacy graceful
 * degradation (no port / unreachable content = static maps only).
 */

import { describe, expect, it } from "vitest";
import { FakeSentinelContent } from "../../testing/index";
import { analyzeSiemExport } from "./analyze-siem-export";

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

  it("enriches mapped solutions with their analytics rules through the port", async () => {
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
    expect(okta?.sentinelAnalyticRules).toHaveLength(1);
    expect(okta?.sentinelAnalyticRules[0]).toMatchObject({
      name: "Okta Rule One",
      severity: "High",
    });
    expect(plan.totalSentinelRules).toBe(1);
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
