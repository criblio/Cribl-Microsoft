/**
 * Pins for the content-install domain (2026-07-14): the analytics-rule and
 * workbook ARM bodies, the duration/operator/severity/tactic normalizations,
 * upload parsing, installed-state partitioning, and the outcome summary -
 * grounded in the verified ARM shapes (SecurityInsights 2025-09-01 scheduled
 * required set; NRT omits the scheduling block; tactics space-free enum;
 * workbook serializedData verbatim).
 */

import { describe, expect, it } from "vitest";
import type { ParsedAnalyticRule } from "../coverage-analysis/index";
import {
  alertRuleResourceFromParsed,
  parserResourceBody,
  parserResourceFromYaml,
  partitionByInstalled,
  parseWorkbookUpload,
  summarizeInstallOutcomes,
  toArmSeverity,
  toArmTriggerOperator,
  toIsoDuration,
  workbookResourceBody,
} from "./index";

function rule(over: Partial<ParsedAnalyticRule>): ParsedAnalyticRule {
  return {
    id: "id",
    name: "Rule",
    severity: "Medium",
    tactics: [],
    dataTypes: [],
    query: "Table | where 1 == 1",
    entityFields: [],
    fileName: "r.yaml",
    ...over,
  };
}

describe("duration / operator / severity codecs", () => {
  it("converts YAML durations to ISO8601 with a fallback", () => {
    expect(toIsoDuration("1h", "PT1H")).toBe("PT1H");
    expect(toIsoDuration("30m", "PT1H")).toBe("PT30M");
    expect(toIsoDuration("5d", "PT1H")).toBe("P5D");
    expect(toIsoDuration("PT2H", "PT1H")).toBe("PT2H");
    expect(toIsoDuration(undefined, "PT1H")).toBe("PT1H");
    expect(toIsoDuration("garbage", "PT1H")).toBe("PT1H");
  });

  it("maps trigger operators and severities to the ARM enums", () => {
    expect(toArmTriggerOperator("gt")).toBe("GreaterThan");
    expect(toArmTriggerOperator("lt")).toBe("LessThan");
    expect(toArmTriggerOperator("NotEqual")).toBe("NotEqual");
    expect(toArmTriggerOperator(undefined)).toBe("GreaterThan");
    expect(toArmSeverity("high")).toBe("High");
    expect(toArmSeverity("weird")).toBe("Medium");
  });
});

describe("alertRuleResourceFromParsed", () => {
  it("builds a Scheduled body with the required scheduling block and space-free tactics", () => {
    const res = alertRuleResourceFromParsed(
      rule({
        kind: "Scheduled",
        severity: "High",
        queryFrequency: "1h",
        queryPeriod: "1h",
        triggerOperator: "gt",
        triggerThreshold: 5,
        tactics: ["Lateral Movement", "None"],
        techniques: ["T1078"],
        id: "9b8f1e2a-1111-2222-3333-444455556666",
        version: "1.0.2",
      }),
    );
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.kind).toBe("Scheduled");
    const props = res.body.properties as Record<string, unknown>;
    expect(props.queryFrequency).toBe("PT1H");
    expect(props.triggerOperator).toBe("GreaterThan");
    expect(props.triggerThreshold).toBe(5);
    expect(props.tactics).toEqual(["LateralMovement"]); // space stripped, None dropped
    expect(props.suppressionEnabled).toBe(false);
    expect(props.suppressionDuration).toBe("PT5H");
    // GUID id -> template linkage.
    expect(props.alertRuleTemplateName).toBe("9b8f1e2a-1111-2222-3333-444455556666");
    expect(props.templateVersion).toBe("1.0.2");
  });

  it("OMITS the scheduling block for NRT (not on the NRT schema)", () => {
    const res = alertRuleResourceFromParsed(rule({ kind: "NRT" }));
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.kind).toBe("NRT");
    const props = res.body.properties as Record<string, unknown>;
    expect(props).not.toHaveProperty("queryFrequency");
    expect(props).not.toHaveProperty("triggerOperator");
    expect(props.displayName).toBe("Rule");
  });

  it("refuses unsupported kinds and empty queries with an honest reason", () => {
    const fusion = alertRuleResourceFromParsed(rule({ kind: "Fusion" }));
    expect(fusion.supported).toBe(false);
    if (!fusion.supported) expect(fusion.reason).toContain("Fusion");
    const empty = alertRuleResourceFromParsed(rule({ query: "  " }));
    expect(empty.supported).toBe(false);
  });

  it("passes structured entity mappings through", () => {
    const res = alertRuleResourceFromParsed(
      rule({
        entityMappings: [
          { entityType: "Host", fieldMappings: [{ identifier: "FullName", columnName: "Computer" }] },
        ],
      }),
    );
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    const props = res.body.properties as Record<string, unknown>;
    expect(props.entityMappings).toEqual([
      { entityType: "Host", fieldMappings: [{ identifier: "FullName", columnName: "Computer" }] },
    ]);
  });
});

describe("workbookResourceBody", () => {
  it("links the workbook to the workspace as a shared sentinel workbook", () => {
    const body = workbookResourceBody({
      displayName: "Cloudflare Overview",
      serializedData: '{"version":"Notebook/1.0"}',
      workspaceResourceId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law",
      location: "eastus",
    });
    expect(body.location).toBe("eastus");
    expect(body.kind).toBe("shared");
    const props = body.properties as Record<string, unknown>;
    expect(props.category).toBe("sentinel");
    expect(props.sourceId).toContain("workspaces/law");
    expect(props.serializedData).toBe('{"version":"Notebook/1.0"}');
  });
});

describe("parseWorkbookUpload", () => {
  it("uses a raw gallery template body verbatim as serializedData", () => {
    const text = '{"version":"Notebook/1.0","items":[]}';
    expect(parseWorkbookUpload("My Board.json", text)).toEqual({
      displayName: "My Board",
      serializedData: text,
    });
  });

  it("extracts serializedData from a portal ARM template export", () => {
    const arm = JSON.stringify({
      resources: [
        {
          type: "microsoft.insights/workbooks",
          properties: { displayName: "Exported", serializedData: '{"items":[]}' },
        },
      ],
    });
    expect(parseWorkbookUpload("export.json", arm)).toEqual({
      displayName: "Exported",
      serializedData: '{"items":[]}',
    });
  });

  it("returns null for non-workbook JSON and junk", () => {
    expect(parseWorkbookUpload("x.json", "not json")).toBeNull();
    expect(parseWorkbookUpload("x.json", '{"foo":1}')).toBeNull();
  });
});

describe("parserResourceFromYaml", () => {
  it("extracts the alias, dedented query, and function body from a parser YAML", () => {
    const yaml = [
      "id: p-1",
      "FunctionName: Cloudflare",
      "FunctionAlias: Cloudflare",
      "FunctionQuery: |",
      "    Cloudflare_CL",
      "    | extend ClientIP = ClientIP_s",
      "version: 1",
    ].join("\n");
    const parser = parserResourceFromYaml(yaml);
    expect(parser).not.toBeNull();
    expect(parser?.alias).toBe("Cloudflare");
    expect(parser?.query).toBe("Cloudflare_CL\n| extend ClientIP = ClientIP_s");
    const body = parserResourceBody(parser!);
    const props = body.properties as Record<string, unknown>;
    expect(props.category).toBe("Function");
    expect(props.functionAlias).toBe("Cloudflare");
  });

  it("returns null for a file that is not an installable function", () => {
    expect(parserResourceFromYaml("just some text")).toBeNull();
    expect(parserResourceFromYaml("FunctionAlias: X\n")).toBeNull(); // no query
  });
});

describe("partitionByInstalled / summarizeInstallOutcomes", () => {
  it("splits available content on case-insensitive installed names", () => {
    const { installed, installable } = partitionByInstalled(
      [{ n: "Rule A" }, { n: "Rule B" }],
      new Set(["rule a"]),
      (x) => x.n,
    );
    expect(installed.map((x) => x.n)).toEqual(["Rule A"]);
    expect(installable.map((x) => x.n)).toEqual(["Rule B"]);
  });

  it("summarizes outcomes with installed/failed/skipped counts", () => {
    expect(
      summarizeInstallOutcomes(
        [
          { name: "a", ok: true, detail: "installed" },
          { name: "b", ok: false, detail: "HTTP 400" },
        ],
        1,
      ),
    ).toBe("1 installed, 1 FAILED, 1 skipped");
  });
});
