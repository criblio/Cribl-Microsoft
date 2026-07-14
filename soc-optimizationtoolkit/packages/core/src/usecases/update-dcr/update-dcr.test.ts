/**
 * Pins for the in-place DCR update (user request 2026-07-13: the inventory
 * listed DCRs but offered no way to modify them).
 */

import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import {
  addTableColumn,
  checkDcrUpdatePermissions,
  diffColumns,
  previewDcrUpdate,
  removeTableColumn,
  updateDcrInPlace,
} from "./update-dcr";

const TABLE_SCHEMA = {
  status: 200,
  body: {
    properties: {
      schema: {
        standardColumns: [
          { name: "TimeGenerated", type: "datetime" },
          { name: "Computer", type: "string" },
          { name: "EventID", type: "int" },
        ],
      },
    },
  },
};

const INPUT = {
  subscriptionId: "sub",
  resourceGroup: "rg",
  workspaceName: "ws",
  dcrName: "dcr-someone-else-made",
  table: "SecurityEvent",
  location: "eastus",
};

describe("updateDcrInPlace", () => {
  it("PUTs the freshly-built Direct body over the EXISTING name", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      TABLE_SCHEMA,
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
    );
    const result = await updateDcrInPlace(azure, INPUT);
    expect(result.provisioningState).toBe("Succeeded");
    expect(result.columnCount).toBeGreaterThan(0);
    const put = azure.calls.find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    expect(put!.path.endsWith("/dataCollectionRules/dcr-someone-else-made")).toBe(true);
    expect((put!.body as { kind?: string }).kind).toBe("Direct");
  });

  it("targets the DCR's OWN resource group while reading the table from the workspace's", async () => {
    // The inventory can browse any group in the subscription (2026-07-13);
    // the DCR paths follow that selection, the table path never does.
    const azure = new FakeAzureManagement();
    azure.respondWith(
      TABLE_SCHEMA,
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
    );
    await updateDcrInPlace(azure, { ...INPUT, dcrResourceGroup: "other-rg" });
    const tableGet = azure.calls.find((c) => c.path.includes("/tables/"));
    expect(tableGet?.path).toContain("/resourceGroups/rg/");
    const put = azure.calls.find((c) => c.method === "PUT");
    expect(put?.path).toContain("/resourceGroups/other-rg/");
  });

  it("rebuilds the DCE variant when a dceResourceId is supplied", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      TABLE_SCHEMA,
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
    );
    await updateDcrInPlace(azure, {
      ...INPUT,
      dceResourceId: "/subscriptions/s/rg/dce-1",
    });
    const put = azure.calls.find((c) => c.method === "PUT");
    const body = put!.body as {
      kind?: string;
      properties: { dataCollectionEndpointId?: string };
    };
    // DCE bodies carry the endpoint and NO kind.
    expect(body.kind).toBeUndefined();
    expect(body.properties.dataCollectionEndpointId).toBe(
      "/subscriptions/s/rg/dce-1",
    );
  });

  it("polls a pending upsert to Succeeded", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      TABLE_SCHEMA,
      { status: 200, body: { properties: { provisioningState: "Updating" } } },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
    );
    const result = await updateDcrInPlace(azure, INPUT);
    expect(result.provisioningState).toBe("Succeeded");
  });

  it("diffColumns names added, removed, and retyped columns", () => {
    const diff = diffColumns(
      [
        { name: "Keep", type: "string" },
        { name: "Gone", type: "string" },
        { name: "Retyped", type: "string" },
      ],
      [
        { name: "keep", type: "string" },
        { name: "Retyped", type: "long" },
        { name: "Fresh", type: "dynamic" },
      ],
    );
    expect(diff.added).toEqual([{ name: "Fresh", type: "dynamic" }]);
    expect(diff.removed).toEqual([{ name: "Gone", type: "string" }]);
    expect(diff.retyped).toEqual([{ name: "Retyped", from: "string", to: "long" }]);
    expect(diff.unchanged).toBe(1);
  });

  it("previewDcrUpdate reports current vs rebuilt declaration without writing", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      // The DCR's live body: declaration is missing EventID.
      {
        status: 200,
        body: {
          properties: {
            streamDeclarations: {
              "Custom-SecurityEvent": {
                columns: [
                  { name: "TimeGenerated", type: "datetime" },
                  { name: "Computer", type: "string" },
                ],
              },
            },
          },
        },
      },
      TABLE_SCHEMA,
    );
    const preview = await previewDcrUpdate(azure, INPUT);
    expect(preview.currentDcrColumns.length).toBe(2);
    expect(preview.diff.added.map((c) => c.name)).toContain("EventID");
    expect(preview.diff.removed).toEqual([]);
    // Read-only: no PUT/PATCH happened.
    expect(azure.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("addTableColumn suffixes _CF on native tables (user correction 2026-07-13)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      {
        status: 200,
        body: {
          properties: {
            schema: {
              standardColumns: [{ name: "TimeGenerated", type: "datetime" }],
            },
          },
        },
      },
      { status: 200, body: {} },
    );
    const result = await addTableColumn(azure, {
      subscriptionId: "sub",
      resourceGroup: "rg",
      workspaceName: "ws",
      table: "CommonSecurityLog",
      column: { name: "RiskScore", type: "long" },
    });
    expect(result.columnName).toBe("RiskScore_CF");
    const patch = azure.calls.find((c) => c.method === "PATCH");
    const body = patch!.body as {
      properties: { schema: { columns: Array<{ name: string }> } };
    };
    expect(body.properties.schema.columns.map((c) => c.name)).toEqual([
      "RiskScore_CF",
    ]);
  });

  it("merges native custom (_CF) columns into the rebuilt declaration", async () => {
    // selectSchemaColumns picks ONE source; the rebuild needs standard AND
    // custom columns or an added _CF field would vanish from the DCR.
    const azure = new FakeAzureManagement();
    azure.respondWith(
      {
        status: 200,
        body: {
          properties: {
            streamDeclarations: {
              "Custom-SecurityEvent": {
                columns: [{ name: "TimeGenerated", type: "datetime" }],
              },
            },
          },
        },
      },
      {
        status: 200,
        body: {
          properties: {
            schema: {
              standardColumns: [
                { name: "TimeGenerated", type: "datetime" },
                { name: "Computer", type: "string" },
              ],
              columns: [{ name: "RiskScore_CF", type: "long" }],
            },
          },
        },
      },
    );
    const preview = await previewDcrUpdate(azure, INPUT);
    expect(preview.rebuiltDcrColumns.map((c) => c.name)).toContain("RiskScore_CF");
    expect(preview.diff.added.map((c) => c.name)).toContain("RiskScore_CF");
  });

  it("VERIFIES the lock hypothesis when a schema edit fails", async () => {
    // The failure probe reads provisioningState: Succeeded = not locked,
    // so the error states the operation is restricted, not "maybe locked".
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { properties: { schema: { columns: [] } } } },
      { status: 500, body: { error: { code: "InternalServerError" } } },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
    );
    await expect(
      addTableColumn(azure, {
        subscriptionId: "sub",
        resourceGroup: "rg",
        workspaceName: "ws",
        table: "CommonSecurityLog",
        column: { name: "ztest", type: "string" },
      }),
    ).rejects.toThrow(/VERIFIED: the table is NOT locked.*RESTRICTED for this table/);

    const azure2 = new FakeAzureManagement();
    azure2.respondWith(
      { status: 200, body: { properties: { schema: { columns: [] } } } },
      { status: 500, body: {} },
      { status: 200, body: { properties: { provisioningState: "Updating" } } },
    );
    await expect(
      addTableColumn(azure2, {
        subscriptionId: "sub",
        resourceGroup: "rg",
        workspaceName: "ws",
        table: "CommonSecurityLog",
        column: { name: "ztest", type: "string" },
      }),
    ).rejects.toThrow(/VERIFIED: the table IS locked.*retry once it settles/);
  });

  it("polls a 202 long-running schema update until the table unlocks", async () => {
    // 2023-09-01 tables API: schema edits can return 202 Accepted; the
    // follow-up DCR update must not run while the table is locked
    // (provisioningState Updating).
    const azure = new FakeAzureManagement();
    azure.respondWith(
      {
        status: 200,
        body: { properties: { schema: { columns: [] } } },
      },
      { status: 202, body: {} },
      { status: 200, body: { properties: { provisioningState: "Updating" } } },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
    );
    const result = await addTableColumn(azure, {
      subscriptionId: "sub",
      resourceGroup: "rg",
      workspaceName: "ws",
      table: "Acme_CL",
      column: { name: "Slow", type: "string" },
    });
    expect(result.columnName).toBe("Slow");
    // The edit rides the newer tables api-version.
    const patch = azure.calls.find((c) => c.method === "PATCH");
    expect(patch?.apiVersion).toBe("2023-09-01");
  });

  it("addTableColumn PATCHes a custom table and refuses duplicates", async () => {
    const scope = {
      subscriptionId: "sub",
      resourceGroup: "rg",
      workspaceName: "ws",
    };
    const azure = new FakeAzureManagement();
    azure.respondWith(
      {
        status: 200,
        body: {
          properties: {
            schema: {
              columns: [{ name: "Existing", type: "string" }],
              standardColumns: [{ name: "TimeGenerated", type: "datetime" }],
            },
          },
        },
      },
      { status: 200, body: {} },
    );
    const result = await addTableColumn(azure, {
      ...scope,
      table: "Acme_CL",
      column: { name: "RiskScore", type: "long" },
    });
    expect(result.columnCount).toBe(2);
    const patch = azure.calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.path.endsWith("/tables/Acme_CL")).toBe(true);
    const body = patch!.body as {
      properties: { schema: { columns: Array<{ name: string }> } };
    };
    expect(body.properties.schema.columns.map((c) => c.name)).toEqual([
      "Existing",
      "RiskScore",
    ]);

    const azure2 = new FakeAzureManagement();
    azure2.respondWith({
      status: 200,
      body: {
        properties: {
          schema: { columns: [{ name: "RiskScore", type: "long" }] },
        },
      },
    });
    await expect(
      addTableColumn(azure2, {
        ...scope,
        table: "Acme_CL",
        column: { name: "riskscore", type: "long" },
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("removeTableColumn drops ONLY the named custom column, keeping the rest", async () => {
    const scope = {
      subscriptionId: "sub",
      resourceGroup: "rg",
      workspaceName: "ws",
      table: "Acme_CL",
    };
    const azure = new FakeAzureManagement();
    azure.respondWith(
      {
        status: 200,
        body: {
          properties: {
            schema: {
              columns: [
                { name: "TimeGenerated", type: "dateTime" },
                { name: "Keep", type: "string" },
                { name: "Gone", type: "string" },
              ],
            },
          },
        },
      },
      { status: 200, body: {} },
    );
    const result = await removeTableColumn(azure, { ...scope, columnName: "gone" });
    expect(result.columnName).toBe("Gone");
    const patch = azure.calls.find((c) => c.method === "PATCH");
    const body = patch!.body as {
      properties: { schema: { columns: Array<{ name: string }> } };
    };
    // The array REPLACES the custom set - the survivors must ride along.
    expect(body.properties.schema.columns.map((c) => c.name)).toEqual([
      "TimeGenerated",
      "Keep",
    ]);
  });

  it("removeTableColumn refuses TimeGenerated, standard columns, and unknowns", async () => {
    const scope = {
      subscriptionId: "sub",
      resourceGroup: "rg",
      workspaceName: "ws",
      table: "SecurityEvent",
    };
    await expect(
      removeTableColumn(new FakeAzureManagement(), {
        ...scope,
        columnName: "TimeGenerated",
      }),
    ).rejects.toThrow(/TimeGenerated is required/);

    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        properties: {
          schema: {
            columns: [{ name: "Extra_CF", type: "string" }],
            standardColumns: [{ name: "Computer", type: "string" }],
          },
        },
      },
    });
    await expect(
      removeTableColumn(azure, { ...scope, columnName: "Computer" }),
    ).rejects.toThrow(/standard column.*only custom columns/);

    const azure2 = new FakeAzureManagement();
    azure2.respondWith({
      status: 200,
      body: { properties: { schema: { columns: [] } } },
    });
    await expect(
      removeTableColumn(azure2, { ...scope, columnName: "Nope_CF" }),
    ).rejects.toThrow(/not a custom column/);
  });

  it("surfaces schema-fetch and PUT failures with their status", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 404, body: {} });
    await expect(updateDcrInPlace(azure, INPUT)).rejects.toThrow(
      /fetch schema for table 'SecurityEvent': HTTP 404/,
    );

    const azure2 = new FakeAzureManagement();
    azure2.respondWith(TABLE_SCHEMA, { status: 409, body: { error: "busy" } });
    await expect(updateDcrInPlace(azure2, INPUT)).rejects.toThrow(
      /update DCR 'dcr-someone-else-made': HTTP 409/,
    );
  });
});

describe("checkDcrUpdatePermissions", () => {
  const SCOPE = {
    subscriptionId: "sub",
    dcrResourceGroup: "dcr-rg",
    workspaceResourceGroup: "ws-rg",
  };
  const grantAll = { status: 200, body: { value: [{ actions: ["*"], notActions: [] }] } };
  const readOnly = {
    status: 200,
    body: { value: [{ actions: ["*/read"], notActions: [] }] },
  };

  it("grants when the write actions are effective at both scopes", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(grantAll, grantAll);
    const check = await checkDcrUpdatePermissions(azure, {
      ...SCOPE,
      includeTableEdit: true,
    });
    expect(check).toEqual({ granted: true, missing: [], indeterminate: false });
    // Two scopes = two permission GETs, each at its resource group.
    expect(azure.calls.map((c) => c.path)).toEqual([
      "/subscriptions/sub/resourceGroups/dcr-rg/providers/Microsoft.Authorization/permissions",
      "/subscriptions/sub/resourceGroups/ws-rg/providers/Microsoft.Authorization/permissions",
    ]);
  });

  it("names each missing write action with its scope", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(readOnly, readOnly);
    const check = await checkDcrUpdatePermissions(azure, {
      ...SCOPE,
      includeTableEdit: true,
    });
    expect(check.granted).toBe(false);
    expect(check.missing).toEqual([
      {
        action: "Microsoft.Insights/dataCollectionRules/write",
        scope: "/subscriptions/sub/resourceGroups/dcr-rg",
      },
      {
        action: "Microsoft.OperationalInsights/workspaces/tables/write",
        scope: "/subscriptions/sub/resourceGroups/ws-rg",
      },
    ]);
  });

  it("reuses one GET when the DCR and workspace share a resource group", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(grantAll);
    const check = await checkDcrUpdatePermissions(azure, {
      subscriptionId: "sub",
      dcrResourceGroup: "rg",
      workspaceResourceGroup: "rg",
      includeTableEdit: true,
    });
    expect(check.granted).toBe(true);
    expect(azure.calls.length).toBe(1);
  });

  it("fails OPEN when the permissions API is unreadable", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: {} });
    const check = await checkDcrUpdatePermissions(azure, {
      ...SCOPE,
      includeTableEdit: false,
    });
    expect(check).toEqual({ granted: true, missing: [], indeterminate: true });
  });
});
