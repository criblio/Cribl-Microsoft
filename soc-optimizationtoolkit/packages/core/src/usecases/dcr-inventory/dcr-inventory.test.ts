/**
 * Pins for the DCR inventory usecase (user request 2026-07-13: inventory
 * existing DCRs and update them from the DCR Automation page).
 */

import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { listDcrInventory, parseDcrInventoryEntry } from "./dcr-inventory";

const DCR = {
  name: "dcr-CommonSecurityLog",
  location: "eastus",
  kind: "Direct",
  properties: {
    immutableId: "dcr-abc123",
    provisioningState: "Succeeded",
    endpoints: { logsIngestion: "https://dcr-x.eastus-1.ingest.monitor.azure.com" },
    dataFlows: [
      { streams: ["Custom-CommonSecurityLog"], outputStream: "Microsoft-CommonSecurityLog" },
      { streams: ["Custom-Extra_CL"], outputStream: "Custom-Extra_CL" },
    ],
  },
};

describe("parseDcrInventoryEntry", () => {
  it("extracts name, identity, endpoint, and deduplicated tables", () => {
    expect(parseDcrInventoryEntry(DCR)).toEqual({
      name: "dcr-CommonSecurityLog",
      location: "eastus",
      kind: "Direct",
      immutableId: "dcr-abc123",
      ingestionEndpoint: "https://dcr-x.eastus-1.ingest.monitor.azure.com",
      tables: ["CommonSecurityLog", "Extra_CL"],
      provisioningState: "Succeeded",
      dataCollectionEndpointId: "",
      streamDeclarationCount: 0,
    });
  });

  it("recognizes DCE-based DCRs (no kind) and stream-name table fallback", () => {
    // A DCE-based ingestion DCR: no kind, a DCE id, stream declarations,
    // and a dataFlow with streams but NO outputStream (live 2026-07-13:
    // one such row read as "not updatable").
    const entry = parseDcrInventoryEntry({
      name: "dcr-dce-based",
      location: "eastus",
      properties: {
        dataCollectionEndpointId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/dataCollectionEndpoints/dce-1",
        streamDeclarations: { "Custom-Acme_CL": { columns: [] } },
        dataFlows: [{ streams: ["Custom-Acme_CL"] }],
      },
    });
    expect(entry).toMatchObject({
      kind: "",
      tables: ["Acme_CL"],
      streamDeclarationCount: 1,
    });
    expect(entry?.dataCollectionEndpointId).toContain("dce-1");
  });

  it("returns null for junk and tolerates missing properties", () => {
    expect(parseDcrInventoryEntry("nope")).toBeNull();
    expect(parseDcrInventoryEntry({ name: "bare" })).toMatchObject({
      name: "bare",
      immutableId: "",
      tables: [],
    });
  });
});

describe("listDcrInventory", () => {
  it("lists the resource group's DCRs via the ARM listing", async () => {
    const azure = new FakeAzureManagement({ dataCollectionRulesList: [DCR] });
    const entries = await listDcrInventory(azure, {
      subscriptionId: "sub",
      resourceGroup: "rg",
    });
    expect(entries.map((e) => e.name)).toEqual(["dcr-CommonSecurityLog"]);
  });

  it("THROWS on a failed listing instead of reading as empty", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 500, body: { error: "boom" } });
    await expect(
      listDcrInventory(azure, { subscriptionId: "sub", resourceGroup: "rg" }),
    ).rejects.toThrow(/list DCRs in 'rg': HTTP 500/);
  });
});
