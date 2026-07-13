/**
 * Pins for the in-place DCR update (user request 2026-07-13: the inventory
 * listed DCRs but offered no way to modify them).
 */

import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { updateDcrInPlace } from "./update-dcr";

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
