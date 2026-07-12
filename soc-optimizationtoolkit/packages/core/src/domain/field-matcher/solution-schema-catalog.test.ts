/**
 * Pins for the solution-aware schema tier (Wave E): a solution's own table
 * ARM resources resolve ahead of the bundled snapshot, and every failure
 * degrades to the fallback.
 */

import { describe, expect, it } from "vitest";
import type { SentinelContent } from "../../ports/sentinel-content";
import {
  createSolutionSchemaCatalog,
  tablesFromArmJson,
} from "./solution-schema-catalog";

const OKTA_STYLE_TABLES = {
  resources: [
    {
      type: "Microsoft.OperationalInsights/workspaces/tables",
      name: "[concat(parameters('workspaceName'), '/OktaV2_CL')]",
      properties: {
        schema: {
          name: "OktaV2_CL",
          columns: [
            { name: "TimeGenerated", type: "datetime" },
            { name: "ActorDisplayName", type: "string" },
            { name: "ClientIpAddress", type: "string" },
            { name: "_ResourceId", type: "string" },
          ],
        },
      },
    },
  ],
};

describe("tablesFromArmJson", () => {
  it("extracts tables from template resources, filtering system columns", () => {
    const tables = tablesFromArmJson(OKTA_STYLE_TABLES);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("OktaV2_CL");
    // TimeGenerated is a REAL DCR column (the bundled catalog keeps it too);
    // only the Azure-managed system columns (_ResourceId...) are filtered.
    expect(tables[0].columns.map((c) => c.name)).toEqual([
      "TimeGenerated",
      "ActorDisplayName",
      "ClientIpAddress",
    ]);
  });

  it("handles a top-level resource ARRAY (the CCP bundle shape)", () => {
    const tables = tablesFromArmJson([
      OKTA_STYLE_TABLES.resources[0],
      { type: "Microsoft.Insights/dataCollectionRules", properties: {} },
    ]);
    expect(tables.map((t) => t.name)).toEqual(["OktaV2_CL"]);
  });

  it("yields nothing for schemas without a name or columns", () => {
    expect(
      tablesFromArmJson({
        type: "Microsoft.OperationalInsights/workspaces/tables",
        properties: { schema: { columns: [] } },
      }),
    ).toEqual([]);
    expect(tablesFromArmJson(null)).toEqual([]);
    expect(tablesFromArmJson("x")).toEqual([]);
  });
});

function fakeContent(files: Record<string, string>): SentinelContent {
  return {
    listSolutions: async () => [],
    listSolutionFiles: async () => [],
    listRepoFiles: async () => [],
    listConnectorFiles: async () =>
      Object.keys(files).map((p) => ({
        name: p.split("/").pop() ?? p,
        path: p,
        size: files[p].length,
      })),
    readFile: async (p: string) => files[p] ?? null,
    rawFetch: async () => null,
    getCommitSha: async () => null,
  };
}

const FALLBACK = {
  async resolveSchema(tableName: string) {
    return tableName === "CommonSecurityLog"
      ? [{ name: "DeviceVendor", type: "string" }]
      : null;
  },
};

describe("createSolutionSchemaCatalog", () => {
  it("serves the solution's own table definitions ahead of the fallback", async () => {
    const catalog = createSolutionSchemaCatalog(
      fakeContent({
        "Solutions/X/Data Connectors/ccp/OktaSSOv2_Tables.json":
          JSON.stringify(OKTA_STYLE_TABLES),
      }),
      "Okta Single Sign-On",
      FALLBACK,
    );
    const columns = await catalog.resolveSchema("OktaV2_CL");
    expect(columns?.map((c) => c.name)).toEqual([
      "TimeGenerated",
      "ActorDisplayName",
      "ClientIpAddress",
    ]);
    // Misses still reach the fallback.
    const csl = await catalog.resolveSchema("CommonSecurityLog");
    expect(csl?.[0]?.name).toBe("DeviceVendor");
  });

  it("ignores non-table files and degrades to the fallback on failure", async () => {
    const broken: SentinelContent = {
      ...fakeContent({}),
      listConnectorFiles: async () => {
        throw new Error("network down");
      },
    };
    const catalog = createSolutionSchemaCatalog(broken, "Any", FALLBACK);
    expect(await catalog.resolveSchema("CommonSecurityLog")).toEqual([
      { name: "DeviceVendor", type: "string" },
    ]);
    expect(await catalog.resolveSchema("Missing_CL")).toBeNull();
  });

  it("passes straight through for an empty solution name", async () => {
    const catalog = createSolutionSchemaCatalog(fakeContent({}), "", FALLBACK);
    expect(await catalog.resolveSchema("CommonSecurityLog")).toEqual([
      { name: "DeviceVendor", type: "string" },
    ]);
  });
});
