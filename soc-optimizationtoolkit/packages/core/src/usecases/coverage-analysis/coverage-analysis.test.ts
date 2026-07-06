/**
 * Content-coverage ACQUISITION usecase pins (porting-plan Unit 23). Exercises
 * the two acquisition sources against the in-memory port fakes and shows both
 * feeding the ONE shared analyzer end to end:
 *   - alert rules via FakeSentinelContent (the three dir-name variants),
 *   - workbooks via FakeAzureManagement (ARM Microsoft.Insights/workbooks),
 * then analyzeContentCoverage over the union.
 */

import { describe, expect, it } from "vitest";

import { FakeSentinelContent } from "../../testing/fake-sentinel-content";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import {
  analyzeContentCoverage,
  unionSchemaColumns,
} from "../../domain/coverage-analysis/index";
import {
  WORKBOOKS_API_VERSION,
  acquireAnalyticRules,
  acquireWorkbooks,
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

describe("acquireWorkbooks over the AzureManagement port", () => {
  const serialized = JSON.stringify({
    items: [
      {
        type: 3,
        content: {
          query: "SigninLogs | project IPAddress, UserPrincipalName",
          queryType: 0,
        },
      },
    ],
  });

  it("enumerates workbooks and mines their buried KQL", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          {
            id: "/subscriptions/s/providers/Microsoft.Insights/workbooks/wb-1",
            name: "wb-1",
            properties: {
              displayName: "Sign-in Analysis",
              serializedData: serialized,
            },
          },
        ],
      },
    });

    const items = await acquireWorkbooks(azure, { subscriptionId: "s" });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("workbook");
    expect(items[0].name).toBe("Sign-in Analysis");
    expect(items[0].queries[0]).toContain("SigninLogs");

    // The request targeted the ARM workbooks surface with the sentinel category.
    expect(azure.calls[0].path).toContain(
      "/providers/Microsoft.Insights/workbooks",
    );
    expect(azure.calls[0].apiVersion).toBe(WORKBOOKS_API_VERSION);
    expect(azure.calls[0].query).toMatchObject({
      category: "sentinel",
      canFetchContent: "true",
    });
  });

  it("still yields an item (1 unparseable) when serializedData is absent", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          { id: "wb-2", name: "wb-2", properties: { displayName: "No Data" } },
        ],
      },
    });
    const items = await acquireWorkbooks(azure, { subscriptionId: "s" });
    expect(items).toHaveLength(1);
    expect(items[0].queries).toEqual([]);
    expect(items[0].unparseableQueryCount).toBe(1);
  });
});

describe("end to end: rules + workbooks into ONE analyzer", () => {
  it("scores both sources against a unioned destination schema", async () => {
    const content = new FakeSentinelContent({
      files: { "Solutions/AAD/Analytic Rules/r.yaml": RULE_YAML },
    });
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          {
            id: "wb-1",
            name: "wb-1",
            properties: {
              displayName: "WB",
              serializedData: JSON.stringify({
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
          },
        ],
      },
    });

    const rules = await acquireAnalyticRules(content, "AAD");
    const workbooks = await acquireWorkbooks(azure, { subscriptionId: "s" });

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
