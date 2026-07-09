/**
 * Pins for the custom-rule upload parsers (user question 2026-07-08: rules
 * are KQL, not YAML). The upload accepts the three wrappings KQL actually
 * arrives in: repo YAML detections, portal ARM JSON exports, and raw KQL.
 */

import { describe, expect, it } from "vitest";
import {
  isRuleUploadFileName,
  parseAnalyticRuleArmJson,
  parseRawKqlRule,
  parseRuleUploadFile,
} from "./parse-rule-uploads";

// A trimmed portal Analytics-blade export: template wrapper + one Scheduled
// alertRules resource.
const ARM_EXPORT = JSON.stringify({
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [
    {
      type: "Microsoft.OperationalInsights/workspaces/providers/alertRules",
      name: "ws/Microsoft.SecurityInsights/1111-2222",
      kind: "Scheduled",
      properties: {
        displayName: "Excessive Denies From Same Source",
        severity: "Medium",
        query:
          'CommonSecurityLog\n| where DeviceVendor == "Palo Alto Networks"\n| summarize count() by SourceIP',
        tactics: ["Discovery"],
        entityMappings: [
          {
            entityType: "IP",
            fieldMappings: [{ identifier: "Address", columnName: "SourceIP" }],
          },
        ],
      },
    },
    {
      type: "Microsoft.Insights/workbooks",
      name: "not-a-rule",
      properties: { displayName: "ignore me" },
    },
  ],
});

describe("parseAnalyticRuleArmJson", () => {
  it("parses alertRules resources out of a portal export template", () => {
    const rules = parseAnalyticRuleArmJson(ARM_EXPORT, "export.json");
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe("Excessive Denies From Same Source");
    expect(rules[0].severity).toBe("Medium");
    expect(rules[0].tactics).toEqual(["Discovery"]);
    expect(rules[0].query).toContain("CommonSecurityLog");
    expect(rules[0].entityFields).toEqual(["SourceIP"]);
  });

  it("accepts a single bare resource object", () => {
    const rules = parseAnalyticRuleArmJson(
      JSON.stringify({
        name: "solo",
        properties: { displayName: "Solo Rule", query: "Syslog | take 1" },
      }),
      "solo.json",
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe("Solo Rule");
    expect(rules[0].severity).toBe("Unknown");
  });

  it("returns no rules for unparseable or rule-free JSON (never throws)", () => {
    expect(parseAnalyticRuleArmJson("{not json", "bad.json")).toEqual([]);
    expect(parseAnalyticRuleArmJson('{"resources":[]}', "empty.json")).toEqual(
      [],
    );
  });
});

describe("parseRawKqlRule / parseRuleUploadFile", () => {
  it("wraps raw KQL as one rule named after the file", () => {
    const rule = parseRawKqlRule(
      "CommonSecurityLog | where DeviceProduct == 'PAN-OS'",
      "denied-traffic.kql",
    );
    expect(rule.name).toBe("denied-traffic");
    expect(rule.severity).toBe("Unknown");
    expect(rule.query).toContain("CommonSecurityLog");
  });

  it("dispatches by extension and drops empty KQL files", () => {
    expect(parseRuleUploadFile("export.json", ARM_EXPORT)).toHaveLength(1);
    expect(parseRuleUploadFile("q.kql", "Syslog | take 1")).toHaveLength(1);
    expect(parseRuleUploadFile("empty.txt", "   ")).toEqual([]);
    const yaml = parseRuleUploadFile(
      "rule.yaml",
      "name: Yaml Rule\nseverity: High\nquery: |\n  Syslog\n  | take 1\n",
    );
    expect(yaml).toHaveLength(1);
    expect(yaml[0].name).toBe("Yaml Rule");
  });

  it("accepts exactly the advertised extensions", () => {
    expect(isRuleUploadFileName("a.yaml")).toBe(true);
    expect(isRuleUploadFileName("a.yml")).toBe(true);
    expect(isRuleUploadFileName("a.JSON")).toBe(true);
    expect(isRuleUploadFileName("a.kql")).toBe(true);
    expect(isRuleUploadFileName("a.txt")).toBe(true);
    expect(isRuleUploadFileName("a.csv")).toBe(false);
  });
});
