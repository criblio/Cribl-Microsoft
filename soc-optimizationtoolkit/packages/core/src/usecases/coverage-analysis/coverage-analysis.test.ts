/**
 * Content-coverage ACQUISITION usecase pins (porting-plan Unit 23). Exercises
 * the two acquisition sources against the in-memory port fakes and shows both
 * feeding the ONE shared analyzer end to end:
 *   - alert rules via FakeSentinelContent (the three dir-name variants),
 *   - workbooks via FakeSentinelContent (the solution's Workbooks directory),
 * then analyzeContentCoverage over the union.
 *
 * BOTH SOURCES ARE THE REPO. The ARM acquirer these tests also drove was
 * deleted with its subject (DBT-57, 2026-08-31): it enumerated the
 * subscription's DEPLOYED workbooks, which the 2026-07-12 direction reversed,
 * and it had no production caller. The end-to-end case below is deliberately
 * kept and re-pointed at `acquireSolutionWorkbooks` rather than deleted - the
 * contract it pins is "two sources, one analyzer", which still ships; it was
 * only ever pinned through a path that did not.
 */

import { describe, expect, it } from "vitest";

import { FakeSentinelContent } from "../../testing/fake-sentinel-content";
import {
  analyzeContentCoverage,
  unionSchemaColumns,
} from "../../domain/coverage-analysis/index";
import {
  acquireAnalyticRules,
  acquireSolutionWorkbooks,
} from "./coverage-analysis";

const RULE_YAML = `id: rule-1
name: "Failed sign-ins"
severity: High
tactics:
  - CredentialAccess
query: |
  SigninLogs
  | where ResultType != 0
  | summarize by IPAddress, UserPrincipalName
entityMappings:
  - entityType: Account
    fieldMappings:
      - identifier: FullName
        columnName: UserPrincipalName
`;

describe("acquireAnalyticRules over the SentinelContent port", () => {
  it("finds rules under the 'Analytics Rules' dir-name variant", async () => {
    const content = new FakeSentinelContent({
      files: {
        "Solutions/AAD/Analytics Rules/failed-signins.yaml": RULE_YAML,
        "Solutions/AAD/Data Connectors/connector.json": "{}",
      },
    });
    const items = await acquireAnalyticRules(content, "AAD");
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("alert-rule");
    expect(items[0].name).toBe("Failed sign-ins");
    expect(items[0].queries[0]).toContain("SigninLogs");
    expect(items[0].extraFields).toContain("UserPrincipalName");
    expect(items[0].custom).toBe(false);
  });

  it("resolves [] when the solution has no rules directory", async () => {
    const content = new FakeSentinelContent({
      files: { "Solutions/Empty/Data Connectors/c.json": "{}" },
    });
    expect(await acquireAnalyticRules(content, "Empty")).toEqual([]);
  });

  it("ignores non-YAML files in the rules directory", async () => {
    const content = new FakeSentinelContent({
      files: {
        "Solutions/AAD/AnalyticRules/rule.yaml": RULE_YAML,
        "Solutions/AAD/AnalyticRules/README.md": "not a rule",
      },
    });
    const items = await acquireAnalyticRules(content, "AAD");
    expect(items).toHaveLength(1);
  });
});

describe("acquireSolutionWorkbooks over the SentinelContent port", () => {
  const workbookDoc = JSON.stringify({
    version: "Notebook/1.0",
    items: [
      { type: 1, content: { json: "## A markdown step (not a query)" } },
      {
        type: 3,
        content: {
          query: "CommonSecurityLog | project SourceIP, DeviceVendor",
          queryType: 0,
        },
      },
    ],
  });

  it("finds shipped workbooks under the 'Workbooks' dir and mines their KQL", async () => {
    const content = new FakeSentinelContent({
      files: {
        "Solutions/PAN/Workbooks/PaloAltoOverview.json": workbookDoc,
        "Solutions/PAN/Data Connectors/connector.json": "{}",
      },
    });
    const items = await acquireSolutionWorkbooks(content, "PAN");
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("workbook");
    expect(items[0].name).toBe("PaloAltoOverview");
    expect(items[0].queries[0]).toContain("CommonSecurityLog");
    expect(items[0].unparseableQueryCount).toBe(0);
  });

  it("skips the WorkbooksMetadata manifest and non-json files", async () => {
    const content = new FakeSentinelContent({
      files: {
        "Solutions/PAN/Workbooks/Overview.json": workbookDoc,
        "Solutions/PAN/Workbooks/WorkbooksMetadata.json": "[]",
        "Solutions/PAN/Workbooks/README.md": "not a workbook",
      },
    });
    const items = await acquireSolutionWorkbooks(content, "PAN");
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Overview");
  });

  it("resolves [] when the solution has no Workbooks directory", async () => {
    const content = new FakeSentinelContent({
      files: { "Solutions/Empty/Data Connectors/c.json": "{}" },
    });
    expect(await acquireSolutionWorkbooks(content, "Empty")).toEqual([]);
  });

  it("counts a corrupt workbook document as one unparseable unit, not dropped", async () => {
    const content = new FakeSentinelContent({
      files: { "Solutions/PAN/Workbooks/Broken.json": "{ not valid json" },
    });
    const items = await acquireSolutionWorkbooks(content, "PAN");
    expect(items).toHaveLength(1);
    expect(items[0].queries).toEqual([]);
    expect(items[0].unparseableQueryCount).toBe(1);
  });
});

describe("end to end: rules + workbooks into ONE analyzer", () => {
  it("scores both sources against a unioned destination schema", async () => {
    // ONE port now serves both sources - rules and workbooks come from the same
    // solution in the same repo, which is the point of the 2026-07-12 decision.
    const content = new FakeSentinelContent({
      files: {
        "Solutions/AAD/Analytic Rules/r.yaml": RULE_YAML,
        "Solutions/AAD/Workbooks/WB.json": JSON.stringify({
          items: [
            {
              type: 3,
              content: {
                query: "SigninLogs | project IPAddress",
                queryType: 0,
              },
            },
          ],
        }),
      },
    });

    const rules = await acquireAnalyticRules(content, "AAD");
    const workbooks = await acquireSolutionWorkbooks(content, "AAD");

    // The union is genuinely TWO sources, not one source counted twice - the
    // assertion the old ARM-driven version of this test made structurally.
    expect(rules).toHaveLength(1);
    expect(workbooks).toHaveLength(1);
    expect(workbooks[0].type).toBe("workbook");

    const schemaUnion = unionSchemaColumns([
      [{ name: "IPAddress" }, { name: "UserPrincipalName" }],
    ]);

    const report = analyzeContentCoverage({
      items: [...rules, ...workbooks],
      availableFields: ["IPAddress"], // UPN is a schema column but not available
      schemaUnion,
    });

    expect(report.summary.totalItems).toBe(2);
    // UserPrincipalName referenced by the rule is a schema column, missing.
    expect(report.summary.missingFieldsAcrossRules).toContain(
      "UserPrincipalName",
    );
    // The Unit 18 contract set contains only schema-resolvable fields.
    expect(report.summary.ruleReferencedFields).toEqual([
      "IPAddress",
      "UserPrincipalName",
    ]);
  });
});

describe("unionSchemaColumns", () => {
  it("unions and de-duplicates column names across tables, sorted", () => {
    const union = unionSchemaColumns([
      [{ name: "SourceIP" }, { name: "DeviceName" }],
      [{ name: "DeviceName" }, { name: "IPAddress" }],
    ]);
    expect(union).toEqual(["DeviceName", "IPAddress", "SourceIP"]);
  });

  it("returns [] for no tables", () => {
    expect(unionSchemaColumns([])).toEqual([]);
  });
});
