/**
 * Usecase pins for the workspace inventory (MIG-2): what each call is
 * addressed to, and - the part that fails silently - that every refused or
 * partial read is reported rather than folded into a smaller inventory.
 */
import { describe, expect, it } from "vitest";

import {
  discoverWorkspaces,
  inventoryWorkspace,
  SOURCE_BATCH_SIZE,
  WORKSPACE_QUERY_API_VERSION,
  workspaceArmId,
} from "./workspace-inventory";
import { listingRows } from "../../domain/inventory-listing";
import { INVENTORY_TIMESPAN, USAGE_QUERY } from "../../domain/workspace-inventory";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import type { PortHttpResponse } from "../../ports/http";

const WS = workspaceArmId("sub-1", "rg-1", "law-1");

function page(...value: unknown[]): PortHttpResponse {
  return { status: 200, body: { value } };
}

function result(columns: string[], rows: unknown[][], error?: unknown): PortHttpResponse {
  return {
    status: 200,
    body: {
      ...(error === undefined ? {} : { error }),
      tables: [{ name: "PrimaryResult", columns: columns.map((name) => ({ name })), rows }],
    },
  };
}

const USAGE_COLS = ["DataType", "TotalMB", "BillableMB", "DaysWithData", "Solutions"];
const SOURCE_COLS = ["SourceTable", "Source", "Attribution", "Bytes", "Events", "Sources"];

function usage(...tables: Array<[string, number]>): PortHttpResponse {
  return result(
    USAGE_COLS,
    tables.map(([t, mb]) => [t, mb, mb, 30, '["SecurityInsights"]']),
  );
}

function sources(...rows: Array<[string, string, number]>): PortHttpResponse {
  return result(
    SOURCE_COLS,
    rows.map(([t, s, bytes]) => [t, s, s === "" ? "none" : "computer", bytes, 1, 1]),
  );
}

describe("discoverWorkspaces", () => {
  const sub = (id: string, displayName: string) => ({ subscriptionId: id, displayName, state: "Enabled" });
  const ws = (name: string, sub: string) => ({
    name,
    id: workspaceArmId(sub, "rg-1", name),
    location: "eastus",
    properties: {},
  });

  it("lists every subscription's workspaces, marks Sentinel, and sorts Sentinel first", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      page(sub("sub-1", "One")),
      page(ws("plain", "sub-1"), ws("siem", "sub-1")),
      page({
        name: "SecurityInsights(siem)",
        properties: { workspaceResourceId: workspaceArmId("sub-1", "RG-1", "siem") },
      }),
    );
    const found = await discoverWorkspaces(azure);
    expect(listingRows(found.workspaces).map((w) => [w.name, w.sentinel])).toEqual([
      ["siem", "enabled"],
      ["plain", "not-enabled"],
    ]);
    expect(found.subscriptionsSearched).toBe(1);
    expect(azure.calls[2]!.path).toBe(
      "/subscriptions/sub-1/providers/Microsoft.OperationsManagement/solutions",
    );
  });

  it("REPORTS a subscription whose workspace list failed, and keeps going", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      page(sub("sub-1", "Denied"), sub("sub-2", "Two")),
      { status: 403, body: { error: { code: "AuthorizationFailed" } } },
      page(ws("law-2", "sub-2")),
      page(),
    );
    const found = await discoverWorkspaces(azure);
    expect(found.failures).toHaveLength(1);
    expect(found.failures[0]).toMatchObject({ subscriptionId: "sub-1", subscriptionName: "Denied" });
    expect(found.failures[0]!.error).toMatch(/HTTP 403.*AuthorizationFailed/);
    expect(listingRows(found.workspaces).map((w) => w.name)).toEqual(["law-2"]);
  });

  it("says Sentinel is UNKNOWN when the solutions list fails - not that it is off", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      page(sub("sub-1", "One")),
      page(ws("law-1", "sub-1")),
      { status: 403, body: {} },
    );
    const found = await discoverWorkspaces(azure);
    expect(listingRows(found.workspaces)[0]!.sentinel).toBe("unknown");
  });

  it("returns an UNVERIFIED empty listing when nothing was found", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(page(sub("sub-1", "One")), page());
    const found = await discoverWorkspaces(azure);
    expect(found.workspaces).toEqual({ kind: "empty" });
    expect(azure.calls).toHaveLength(2);
  });
});

describe("inventoryWorkspace", () => {
  it("posts the Usage query to the workspace's ARM query passthrough", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(usage(["Syslog", 30]), sources(["Syslog", "host-a", 3_000_000]));
    await inventoryWorkspace(azure, WS);
    expect(azure.calls[0]).toEqual({
      method: "POST",
      path: `${WS}/query`,
      apiVersion: WORKSPACE_QUERY_API_VERSION,
      body: { query: USAGE_QUERY, timespan: INVENTORY_TIMESPAN },
    });
    expect(WORKSPACE_QUERY_API_VERSION).toBe("2017-10-01");
  });

  it("builds tables with sources and a 30-day daily average", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      usage(["Syslog", 30], ["AWSCloudTrail", 60]),
      sources(["Syslog", "host-a", 2_000_000], ["Syslog", "host-b", 1_000_000], ["AWSCloudTrail", "", 60_000_000]),
    );
    const inv = await inventoryWorkspace(azure, WS);
    expect(inv.totals.dailyAverageMB).toBe(3);
    const rows = listingRows(inv.tables);
    expect(rows.map((t) => [t.table, t.dailyAverageMB])).toEqual([
      ["Syslog", 1],
      ["AWSCloudTrail", 2],
    ]);
    expect(rows[0]!.sources).toMatchObject({
      kind: "read",
      sources: [{ source: "host-a" }, { source: "host-b" }],
    });
  });

  it("THROWS when Usage is refused - there is no inventory, and an empty one would lie", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: { code: "InsufficientAccessError" } } });
    await expect(inventoryWorkspace(azure, WS)).rejects.toThrow(
      /read Usage: HTTP 403.*InsufficientAccessError/,
    );
  });

  it("calls a Usage answer with no rows a VERIFIED none, and sends no source query", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(result(USAGE_COLS, []));
    const inv = await inventoryWorkspace(azure, WS);
    expect(inv.tables).toEqual({ kind: "none" });
    expect(azure.calls).toHaveLength(1);
  });

  it("does NOT call a PARTIAL empty Usage answer a verified none", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(result(USAGE_COLS, [], { code: "PartialError", message: "timeout" }));
    const inv = await inventoryWorkspace(azure, WS);
    expect(inv.tables).toEqual({ kind: "empty" });
    expect(inv.usageWarning).toBe("timeout");
  });

  it("batches tables and, when a batch FAILS, retries each table alone", async () => {
    const tables = Array.from({ length: SOURCE_BATCH_SIZE + 1 }, (_, i) => [`T${i}`, 30] as [string, number]);
    const azure = new FakeAzureManagement();
    azure.respondWith(
      usage(...tables),
      { status: 504, body: { error: { code: "GatewayTimeout" } } },
      ...tables.slice(0, SOURCE_BATCH_SIZE).map(([t], i) =>
        i === 3 ? { status: 504, body: {} } : sources([t, "h", 1]),
      ),
      sources([`T${SOURCE_BATCH_SIZE}`, "h", 1]),
    );
    const inv = await inventoryWorkspace(azure, WS);
    // 1 Usage + 1 failed batch + 10 singles + 1 second batch.
    expect(azure.calls).toHaveLength(1 + 1 + SOURCE_BATCH_SIZE + 1);
    const rows = listingRows(inv.tables);
    expect(rows).toHaveLength(SOURCE_BATCH_SIZE + 1);
    expect(rows.filter((t) => t.sources.kind === "failed").map((t) => t.table)).toEqual(["T3"]);
    // The failed table keeps its Usage volume.
    expect(rows[3]!.dailyAverageMB).toBe(1);
  });

  it("exposes the queries that produced the numbers", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(usage(["Syslog", 30]), sources(["Syslog", "h", 1]));
    const inv = await inventoryWorkspace(azure, WS);
    expect(inv.queries.usage).toBe(USAGE_QUERY);
    expect(inv.queries.sourcesExample).toContain("['Syslog']");
  });
});
