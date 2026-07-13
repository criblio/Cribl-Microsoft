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
    });
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
