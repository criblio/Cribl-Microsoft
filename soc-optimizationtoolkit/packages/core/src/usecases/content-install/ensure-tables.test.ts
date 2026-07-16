/**
 * Pins for auto-creating a rule's dependency table (2026-07-16): an existing
 * (native/standard) table short-circuits; a missing custom table is CREATED
 * from the CustomTables repo schema (PUT then readback poll); a data type the
 * repo does not define resolves a clear non-fatal outcome.
 */

import { describe, expect, it } from "vitest";
import { FakeAzureManagement, FakeSentinelContent } from "../../testing/index";
import { ensureRuleDataTable } from "./ensure-tables";
import type { WorkspaceScope } from "./content-install";

const WS: WorkspaceScope = {
  subscriptionId: "sub",
  resourceGroup: "rg",
  workspaceName: "law",
  location: "eastus",
};

const CF_SCHEMA = JSON.stringify({
  Name: "Cloudflare_CL",
  Properties: [
    { Name: "TimeGenerated", Type: "DateTime" },
    { Name: "ClientIP", Type: "String" },
    { Name: "EdgeStartTimestamp", Type: "DateTime" },
  ],
});

const CUSTOM_TABLES_PATH =
  ".script/tests/KqlvalidationsTests/CustomTables/Cloudflare_CL.json";

describe("ensureRuleDataTable", () => {
  it("short-circuits when the table already exists (native or standard)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { properties: {} } }); // GET tables/SecurityEvent
    const content = new FakeSentinelContent({ files: {} });
    const out = await ensureRuleDataTable(azure, content, WS, "SecurityEvent");
    expect(out).toEqual({
      table: "SecurityEvent",
      ok: true,
      detail: "already exists",
      created: false,
    });
    expect(azure.calls).toHaveLength(1);
  });

  it("creates a missing custom table from the CustomTables repo schema", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: { error: "not found" } }, // GET tables/Cloudflare
      { status: 404, body: { error: "not found" } }, // GET tables/Cloudflare_CL
      { status: 200, body: {} }, // PUT tables/Cloudflare_CL
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // poll
    );
    const content = new FakeSentinelContent({ files: { [CUSTOM_TABLES_PATH]: CF_SCHEMA } });
    const out = await ensureRuleDataTable(azure, content, WS, "Cloudflare");
    expect(out.ok).toBe(true);
    expect(out.created).toBe(true);
    expect(out.table).toBe("Cloudflare_CL");
    const put = azure.calls[2];
    expect(put.method).toBe("PUT");
    expect(put.path).toContain("/tables/Cloudflare_CL");
    // The PUT body carries the repo columns (system-safe; TimeGenerated kept).
    const body = put.body as { properties: { schema: { columns: { name: string }[] } } };
    const names = body.properties.schema.columns.map((c) => c.name);
    expect(names).toContain("ClientIP");
  });

  it("reports a clear non-fatal outcome when the repo has no schema", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} }, // GET tables/Weird
      { status: 404, body: {} }, // GET tables/Weird_CL
    );
    const content = new FakeSentinelContent({ files: {} }); // no schema file
    const out = await ensureRuleDataTable(azure, content, WS, "Weird");
    expect(out.ok).toBe(false);
    expect(out.created).toBe(false);
    expect(out.detail).toContain("CustomTables repo");
    // No PUT is attempted when there is no schema to create from.
    expect(azure.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
