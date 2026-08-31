/**
 * Tests for the workspace table listing.
 *
 * The pins that matter are about DEGRADATION and about not duplicating the
 * preflight probe: a surprising element must cost one row rather than the whole
 * picker, and a 403 must surface rather than render as an empty workspace.
 */
import { describe, expect, it } from "vitest";

import {
  fetchWorkspaceTableSchema,
  listWorkspaceTables,
  parseWorkspaceTable,
  workspaceTablesPath,
} from "./workspace-tables";
import { WORKSPACE_API_VERSION } from "../azure-discovery";
import { listingRows } from "../../domain/inventory-listing";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import type { PortHttpResponse } from "../../ports/http";

const TARGET = {
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  workspaceName: "law-1",
};

function table(name: string, extra: Record<string, unknown> = {}) {
  return { name, properties: { plan: "Analytics", ...extra } };
}
function page(...values: unknown[]): PortHttpResponse {
  return { status: 200, body: { value: values } };
}

describe("path and naming", () => {
  it("targets the workspace's tables collection", () => {
    expect(workspaceTablesPath(TARGET)).toBe(
      "/subscriptions/sub-1/resourceGroups/rg-1" +
        "/providers/Microsoft.OperationalInsights/workspaces/law-1/tables",
    );
  });

  it("reuses the onboarding path's custom-table predicate, case-insensitively", () => {
    // domain/custom-table owns this rule and is deliberately case-INSENSITIVE,
    // so "app_cl" is an ATTEMPTED custom table rather than silently native.
    // Defining a second, case-sensitive copy here is precisely the duplicated
    // decision the architecture audit hunts for - the compiler caught it.
    expect(parseWorkspaceTable(table("App_CL"))?.kind).toBe("custom");
    expect(parseWorkspaceTable(table("app_cl"))?.kind).toBe("custom");
    expect(parseWorkspaceTable(table("SecurityEvent"))?.kind).toBe("native");
  });
});

describe("parseWorkspaceTable", () => {
  it("projects name, kind, retention and plan", () => {
    expect(
      parseWorkspaceTable(table("App_CL", { retentionInDays: 90 })),
    ).toEqual({
      name: "App_CL",
      kind: "custom",
      retentionInDays: 90,
      plan: "Analytics",
    });
  });

  it("reports an absent retention as null, not zero", () => {
    // Zero would read as "retain nothing", which is a different fact from
    // "the workspace default applies".
    expect(parseWorkspaceTable(table("SecurityEvent"))?.retentionInDays).toBeNull();
  });

  it("drops an element with no usable name", () => {
    for (const junk of [null, 42, {}, { name: "" }, { name: 5 }]) {
      expect(parseWorkspaceTable(junk)).toBeNull();
    }
  });
});

describe("listWorkspaceTables", () => {
  it("issues one GET at the workspace api-version", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(page(table("SecurityEvent")));
    await listWorkspaceTables(azure, TARGET);
    expect(azure.calls).toHaveLength(1);
    expect(azure.calls[0]!.method).toBe("GET");
    expect(azure.calls[0]!.apiVersion).toBe(WORKSPACE_API_VERSION);
  });

  it("sorts by name so every surface shows the same order", async () => {
    // ARM's ordering is not documented as stable, so the sort lives here rather
    // than at each call site.
    const azure = new FakeAzureManagement();
    azure.respondWith(page(table("Syslog"), table("App_CL"), table("Heartbeat")));
    const tables = listingRows(await listWorkspaceTables(azure, TARGET));
    expect(tables.map((t) => t.name)).toEqual(["App_CL", "Heartbeat", "Syslog"]);
  });

  it("costs ONE row when an element is malformed, never the whole picker", async () => {
    // A picker missing one table beats a picker that will not open.
    const azure = new FakeAzureManagement();
    azure.respondWith(page(table("Syslog"), { properties: {} }, table("App_CL")));
    const tables = listingRows(await listWorkspaceTables(azure, TARGET));
    expect(tables.map((t) => t.name)).toEqual(["App_CL", "Syslog"]);
  });

  it("separates custom from native", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(page(table("App_CL"), table("SecurityEvent")));
    const tables = listingRows(await listWorkspaceTables(azure, TARGET));
    expect(tables.map((t) => t.kind)).toEqual(["custom", "native"]);
  });

  it("SURFACES a 403 rather than returning an empty list", async () => {
    // An empty picker would read as an empty workspace. A denied read is
    // meaningful and the operator has to see it - reads have no fallback
    // artifact, so the honest message is the whole answer.
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: "Forbidden" } });
    await expect(listWorkspaceTables(azure, TARGET)).rejects.toThrow(/law-1/);
  });

  it("returns an EMPTY LISTING, which does not claim the workspace is empty", async () => {
    // Renamed in DBT-61, and the old name is the reason: it said "for a
    // genuinely empty workspace", which is precisely what this function cannot
    // know. ARM answers 200-with-nothing the same way whether the workspace
    // holds no tables or holds tables this principal may not see, so the value
    // returned here now carries no count for a caller to misread - deciding
    // which of the two happened belongs to whoever holds the capability.
    const azure = new FakeAzureManagement();
    azure.respondWith(page());
    expect(await listWorkspaceTables(azure, TARGET)).toEqual({ kind: "empty" });
  });
});

describe("fetchWorkspaceTableSchema", () => {
  const schemaResponse = (schema: unknown): PortHttpResponse => ({
    status: 200,
    body: { properties: { schema } },
  });

  it("projects the live columns as destination fields", () => {
    // The selected table's schema REPLACES the derived destSchema (user
    // decision 2026-08-10) - once a real table is named, ARM is the authority.
    const azure = new FakeAzureManagement();
    azure.respondWith(
      schemaResponse({
        columns: [
          { name: "TimeGenerated", type: "datetime" },
          { name: "SrcIp", type: "string" },
        ],
      }),
    );
    return fetchWorkspaceTableSchema(azure, TARGET, "App_CL").then((fields) => {
      expect(fields).toEqual([
        { name: "TimeGenerated", type: "datetime" },
        { name: "SrcIp", type: "string" },
      ]);
    });
  });

  it("defers the column-source choice to selectSchemaColumns", async () => {
    // A NATIVE table prefers standardColumns; restating that rule here instead
    // of importing it is the duplication this module already tripped over once.
    const azure = new FakeAzureManagement();
    azure.respondWith(
      schemaResponse({
        columns: [{ name: "FromColumns", type: "string" }],
        standardColumns: [{ name: "FromStandard", type: "string" }],
      }),
    );
    const fields = await fetchWorkspaceTableSchema(azure, TARGET, "SecurityEvent");
    expect(fields?.map((f) => f.name)).toEqual(["FromStandard"]);
  });

  it("returns null - not a throw - for a table with no usable columns", async () => {
    // A real state for a table provisioned but not yet materialized, and
    // distinct from a failed fetch.
    const azure = new FakeAzureManagement();
    azure.respondWith(schemaResponse({}));
    expect(await fetchWorkspaceTableSchema(azure, TARGET, "App_CL")).toBeNull();
  });

  it("surfaces a failed fetch by name", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: {} });
    await expect(
      fetchWorkspaceTableSchema(azure, TARGET, "App_CL"),
    ).rejects.toThrow(/App_CL/);
  });

  it("reads the single table, not the collection", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(schemaResponse({ columns: [{ name: "A", type: "string" }] }));
    await fetchWorkspaceTableSchema(azure, TARGET, "App_CL");
    expect(azure.calls[0]!.path.endsWith("/tables/App_CL")).toBe(true);
  });
});
