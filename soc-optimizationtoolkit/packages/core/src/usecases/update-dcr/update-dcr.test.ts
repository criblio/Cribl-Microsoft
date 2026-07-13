/**
 * Pins for the in-place DCR update (user request 2026-07-13: the inventory
 * listed DCRs but offered no way to modify them).
 */

import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import {
  addTableColumn,
  diffColumns,
  previewDcrUpdate,
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

  it("addTableColumn PATCHes a custom table and refuses native tables and duplicates", async () => {
    const scope = {
      subscriptionId: "sub",
      resourceGroup: "rg",
      workspaceName: "ws",
    };
    await expect(
      addTableColumn(new FakeAzureManagement(), {
        ...scope,
        table: "SecurityEvent",
        column: { name: "Extra", type: "string" },
      }),
    ).rejects.toThrow(/native Azure table.*fixed/);

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
