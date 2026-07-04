/**
 * deployment-preview tests - written from the MINING of the legacy
 * check-existing/preview handlers (both partially uncharacterized), never
 * from the legacy code. The DO-NOT-PORT defects are pinned as fixed:
 * dcr-naming is the single name source, existence truth is live ARM only,
 * matching is exact (never fuzzy/substring), and a preview NEVER writes.
 */
import { describe, expect, it } from "vitest";
import {
  buildDeploymentPreview,
  checkExistingDcrs,
} from "./deployment-preview";
import type { DeploymentPreviewTableSpec } from "./deployment-preview";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { DIRECT_DCR_API_VERSION } from "../../domain/dcr-request";
import { DCE_API_VERSION } from "../../domain/dce-request";
import { buildTablePutRequest } from "../../domain/custom-table";
import type { CustomSchemaFileColumn } from "../../domain/schema-mapping";

const SCOPE = { subscriptionId: "sub-1", resourceGroup: "rg-1" };

const DCR_LIST_PATH =
  "/subscriptions/sub-1/resourceGroups/rg-1" +
  "/providers/Microsoft.Insights/dataCollectionRules";

function dcrId(name: string): string {
  return `${DCR_LIST_PATH}/${name}`;
}

function listResponse(
  names: string[],
  nextLink?: string,
): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      value: names.map((name) => ({ name, id: dcrId(name) })),
      ...(nextLink !== undefined ? { nextLink } : {}),
    },
  };
}

const CLOUDFLARE_SCHEMA: CustomSchemaFileColumn[] = [
  { name: "TimeGenerated", type: "datetime" },
  { name: "ClientIP", type: "string" },
];

describe("checkExistingDcrs", () => {
  it("matches exactly by full predicted name and GETs details only for matches", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      listResponse(["dcr-SecurityEvent-eastus"]),
      {
        status: 200,
        body: {
          properties: {
            immutableId: "dcr-imm-1",
            endpoints: { logsIngestion: "https://ep.eastus-1.ingest.monitor.azure.com" },
          },
        },
      },
    );

    const results = await checkExistingDcrs(
      azure,
      SCOPE,
      ["SecurityEvent", "Syslog"],
      { mode: "direct", location: "eastus" },
    );

    expect(results).toEqual([
      {
        table: "SecurityEvent",
        dcrName: "dcr-SecurityEvent-eastus",
        exists: true,
        immutableId: "dcr-imm-1",
        ingestionEndpoint: "https://ep.eastus-1.ingest.monitor.azure.com",
      },
      { table: "Syslog", dcrName: "dcr-Syslog-eastus", exists: false },
    ]);

    // ONE list + ONE per-match GET; NO GET for the miss (pinned call count).
    expect(azure.calls).toHaveLength(2);
    expect(azure.calls[0]).toEqual({
      method: "GET",
      path: DCR_LIST_PATH,
      apiVersion: DIRECT_DCR_API_VERSION,
    });
    expect(azure.calls[1]).toEqual({
      method: "GET",
      path: dcrId("dcr-SecurityEvent-eastus"),
      apiVersion: DIRECT_DCR_API_VERSION,
    });
  });

  it("never cross-matches shared-prefix names (Cloudflare vs CloudflareAudit)", async () => {
    // The legacy fuzzy matcher (`name.includes(stripped)`) matched the
    // deployed dcr-CloudflareAudit-eastus for table Cloudflare_CL. Exact
    // full-name matching must not.
    const azure = new FakeAzureManagement();
    azure.respondWith(listResponse(["dcr-CloudflareAudit-eastus"]));

    const results = await checkExistingDcrs(azure, SCOPE, ["Cloudflare_CL"], {
      mode: "direct",
      location: "eastus",
    });

    expect(results).toEqual([
      { table: "Cloudflare_CL", dcrName: "dcr-Cloudflare-eastus", exists: false },
    ]);
    // No per-match GET happened: the list was the only call.
    expect(azure.calls).toHaveLength(1);
  });

  it("never cross-matches within the ASimAudit family", async () => {
    // dcr-ASimAu-eastus is the ABBREVIATED deployed name of
    // ASimAuthenticationEventLogs (over the 30-char direct limit);
    // ASimAuditEventLogs composes under the limit and shares the prefix.
    const azure = new FakeAzureManagement();
    azure.respondWith(
      listResponse(["dcr-ASimAu-eastus"]),
      { status: 200, body: { properties: { immutableId: "dcr-imm-asim" } } },
    );

    const results = await checkExistingDcrs(
      azure,
      SCOPE,
      ["ASimAuditEventLogs", "ASimAuthenticationEventLogs"],
      { mode: "direct", location: "eastus" },
    );

    expect(results[0]).toEqual({
      table: "ASimAuditEventLogs",
      dcrName: "dcr-ASimAuditEventLogs-eastus",
      exists: false,
    });
    expect(results[1]).toEqual({
      table: "ASimAuthenticationEventLogs",
      dcrName: "dcr-ASimAu-eastus",
      exists: true,
      immutableId: "dcr-imm-asim",
    });
    expect(azure.calls).toHaveLength(2);
  });

  it("compares the WHOLE name case-insensitively (ARM names are case-insensitive)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      listResponse(["DCR-SECURITYEVENT-EASTUS"]),
      { status: 200, body: { properties: { immutableId: "dcr-imm-1" } } },
    );

    const results = await checkExistingDcrs(azure, SCOPE, ["SecurityEvent"], {
      mode: "direct",
      location: "eastus",
    });

    expect(results[0].exists).toBe(true);
    // The reported name is the PREDICTION (dcr-naming, the single source).
    expect(results[0].dcrName).toBe("dcr-SecurityEvent-eastus");
  });

  it("follows nextLink pagination across two pages", async () => {
    const azure = new FakeAzureManagement();
    const nextLink =
      "https://management.azure.com" + DCR_LIST_PATH + "?skipToken=page-2";
    azure.respondWith(
      listResponse(["dcr-Unrelated-eastus"], nextLink),
      listResponse(["dcr-SecurityEvent-eastus"]),
      { status: 200, body: { properties: { immutableId: "dcr-imm-1" } } },
    );

    const results = await checkExistingDcrs(azure, SCOPE, ["SecurityEvent"], {
      mode: "direct",
      location: "eastus",
    });

    expect(results[0].exists).toBe(true);
    expect(azure.urlCalls).toEqual([{ method: "GET", url: nextLink }]);
  });

  it("reports a failed per-match detail GET honestly (exists, detailError, no enrichment)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      listResponse(["dcr-SecurityEvent-eastus"]),
      { status: 500, body: { error: { message: "boom" } } },
    );

    const results = await checkExistingDcrs(azure, SCOPE, ["SecurityEvent"], {
      mode: "direct",
      location: "eastus",
    });

    expect(results[0].exists).toBe(true);
    expect(results[0].detailError).toContain("HTTP 500");
    expect(results[0]).not.toHaveProperty("immutableId");
    expect(results[0]).not.toHaveProperty("ingestionEndpoint");
  });

  it("reports a failed DCE endpoint follow-up honestly (exists, immutableId kept, detailError, no endpoint)", async () => {
    // The legacy handler swallowed this failure into a silent empty string;
    // the honesty rule of the per-match GET applies to the DCE follow-up too.
    const dceResourceId =
      "/subscriptions/sub-1/resourceGroups/rg-1" +
      "/providers/Microsoft.Insights/dataCollectionEndpoints/dce-ws-1-eastus";
    const azure = new FakeAzureManagement();
    azure.respondWith(
      listResponse(["dcr-SecurityEvent-eastus"]),
      {
        status: 200,
        body: {
          properties: {
            immutableId: "dcr-imm-1",
            dataCollectionEndpointId: dceResourceId,
          },
        },
      },
      { status: 403, body: { error: { code: "AuthorizationFailed" } } },
    );

    const results = await checkExistingDcrs(azure, SCOPE, ["SecurityEvent"], {
      mode: "dce",
      location: "eastus",
    });

    expect(results[0].exists).toBe(true);
    expect(results[0].immutableId).toBe("dcr-imm-1");
    expect(results[0]).not.toHaveProperty("ingestionEndpoint");
    expect(results[0].detailError).toContain("fetch DCE for DCR 'dcr-SecurityEvent-eastus'");
    expect(results[0].detailError).toContain("HTTP 403");
  });

  it("resolves a DCE-based DCR's ingestion endpoint through its DCE, VERBATIM", async () => {
    const dceResourceId =
      "/subscriptions/sub-1/resourceGroups/rg-1" +
      "/providers/Microsoft.Insights/dataCollectionEndpoints/dce-ws-1-eastus";
    const azure = new FakeAzureManagement();
    azure.respondWith(
      listResponse(["dcr-SecurityEvent-eastus"]),
      {
        status: 200,
        body: {
          properties: {
            immutableId: "dcr-imm-1",
            dataCollectionEndpointId: dceResourceId,
          },
        },
      },
      {
        status: 200,
        body: {
          properties: {
            logsIngestion: {
              // The handler.control anomaly is returned VERBATIM here: the
              // ingest.monitor rewrite is a sentinel-destination composition
              // concern (Unit 6 follow-up note), never a preview one.
              endpoint: "https://dce.eastus-1.handler.control.monitor.azure.com",
            },
          },
        },
      },
    );

    const results = await checkExistingDcrs(azure, SCOPE, ["SecurityEvent"], {
      mode: "dce",
      location: "eastus",
    });

    expect(results[0]).toEqual({
      table: "SecurityEvent",
      dcrName: "dcr-SecurityEvent-eastus",
      exists: true,
      immutableId: "dcr-imm-1",
      ingestionEndpoint: "https://dce.eastus-1.handler.control.monitor.azure.com",
    });
    expect(azure.calls[2]).toEqual({
      method: "GET",
      path: dceResourceId,
      apiVersion: DCE_API_VERSION,
    });
  });

  it("throws raw greppable text when the DCR list fails (the legacy catch could never run)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: { code: "AuthorizationFailed" } } });

    await expect(
      checkExistingDcrs(azure, SCOPE, ["SecurityEvent"], {
        mode: "direct",
        location: "eastus",
      }),
    ).rejects.toThrow(/HTTP 403.*AuthorizationFailed/);
  });

  it("issues no calls at all for an empty table list", async () => {
    const azure = new FakeAzureManagement();
    const results = await checkExistingDcrs(azure, SCOPE, [], {
      mode: "direct",
      location: "eastus",
    });
    expect(results).toEqual([]);
    expect(azure.calls).toHaveLength(0);
  });
});

describe("buildDeploymentPreview", () => {
  const scope = {
    subscriptionId: "sub-1",
    resourceGroup: "rg-1",
    workspaceName: "ws-1",
  };
  const workspaceId =
    "/subscriptions/sub-1/resourceGroups/rg-1" +
    "/providers/Microsoft.OperationalInsights/workspaces/ws-1";
  const workspaceResponse = {
    status: 200,
    body: { id: workspaceId, location: "eastus" },
  };
  const nativeSchemaResponse = {
    status: 200,
    body: {
      properties: {
        schema: {
          standardColumns: [
            { name: "TimeGenerated", type: "dateTime" },
            { name: "Activity", type: "string" },
          ],
        },
      },
    },
  };

  it("composes exists/not-exists rows for native + custom in direct mode", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      workspaceResponse,
      // checkExistingDcrs: list + per-match GET (SecurityEvent matches)
      listResponse(["dcr-SecurityEvent-eastus"]),
      {
        status: 200,
        body: {
          properties: {
            immutableId: "dcr-imm-1",
            endpoints: { logsIngestion: "https://ep.eastus-1.ingest.monitor.azure.com" },
          },
        },
      },
      // per-table schema GETs, input order
      nativeSchemaResponse,
      { status: 404, body: {} },
    );

    const tables: DeploymentPreviewTableSpec[] = [
      { table: "SecurityEvent" },
      { table: "CloudFlare_CL", customSchema: CLOUDFLARE_SCHEMA },
    ];
    const preview = await buildDeploymentPreview(azure, {
      scope,
      tables,
      options: {
        createDCE: false,
        customTableRetentionDays: 90,
        dcePublicNetworkAccess: true,
      },
      generatedAtToken: "opaque-token-from-the-shell",
    });

    // The staleness token is echoed verbatim - core never mints one.
    expect(preview.generatedAtToken).toBe("opaque-token-from-the-shell");
    expect(preview.mode).toBe("direct");
    expect(preview.location).toBe("eastus");
    expect(preview.dce).toBeNull();

    const [native, custom] = preview.tables;
    expect(native.table).toBe("SecurityEvent");
    expect(native.kind).toBe("native");
    expect(native.dcrName).toBe("dcr-SecurityEvent-eastus");
    expect(native.tableResource).toBeNull();
    expect(native.dcrResource.exists).toBe(true);
    expect(native.dcrResource.immutableId).toBe("dcr-imm-1");
    expect(native.dcrResource.ingestionEndpoint).toBe(
      "https://ep.eastus-1.ingest.monitor.azure.com",
    );
    expect(native.dcrResource.request.method).toBe("PUT");
    expect(native.dcrResource.request.apiVersion).toBe(DIRECT_DCR_API_VERSION);
    expect(native.dcrResource.request.path).toBe(
      dcrId("dcr-SecurityEvent-eastus"),
    );
    const nativeBody = native.dcrResource.request.body as {
      kind: string;
      properties: { streamDeclarations: Record<string, unknown> };
    };
    expect(nativeBody.kind).toBe("Direct");

    expect(custom.table).toBe("CloudFlare_CL");
    expect(custom.kind).toBe("custom");
    expect(custom.dcrName).toBe("dcr-CloudFlare-eastus");
    expect(custom.dcrResource.exists).toBe(false);
    expect(custom.dcrResource).not.toHaveProperty("immutableId");
    // The tables PUT that WOULD be sent is exactly buildTablePutRequest's.
    const expectedTablePut = buildTablePutRequest({
      subscriptionId: "sub-1",
      resourceGroup: "rg-1",
      workspaceName: "ws-1",
      table: "CloudFlare_CL",
      columns: CLOUDFLARE_SCHEMA,
      retentionDays: 90,
    });
    expect(custom.tableResource).toEqual({
      exists: false,
      request: {
        method: "PUT",
        path: expectedTablePut.path,
        apiVersion: expectedTablePut.apiVersion,
        body: expectedTablePut.body,
      },
    });
    const tableBody = custom.tableResource?.request?.body as {
      properties: { retentionInDays: number; totalRetentionInDays: number };
    };
    expect(tableBody.properties.retentionInDays).toBe(90);
    expect(tableBody.properties.totalRetentionInDays).toBe(90);

    // Read-only audit: every ARM call was a GET.
    expect(azure.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("previews the shared DCE (not exists) and wires its predicted id into DCE-based DCR bodies", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      workspaceResponse,
      { status: 404, body: {} }, // DCE existence GET
      listResponse([]), // no DCRs deployed
      nativeSchemaResponse,
    );

    const preview = await buildDeploymentPreview(azure, {
      scope,
      tables: [{ table: "SecurityEvent" }],
      options: {
        createDCE: true,
        customTableRetentionDays: 30,
        dcePublicNetworkAccess: true,
      },
      generatedAtToken: "t-1",
    });

    expect(preview.mode).toBe("dce");
    expect(preview.dce).not.toBeNull();
    const dce = preview.dce;
    if (dce === null) {
      throw new Error("expected a DCE preview entry");
    }
    // Shared DCE named over the WORKSPACE name (mode "dce-endpoint").
    expect(dce.name).toBe("dce-ws-1-eastus");
    expect(dce.exists).toBe(false);
    expect(dce.request).not.toBeNull();
    expect(dce.request?.path).toBe(
      "/subscriptions/sub-1/resourceGroups/rg-1" +
        "/providers/Microsoft.Insights/dataCollectionEndpoints/dce-ws-1-eastus",
    );
    // Predicted resource id IS the PUT path (real subscription, never a
    // zeroed placeholder).
    expect(dce.resourceId).toBe(dce.request?.path);
    expect(dce.request?.body).toEqual({
      location: "eastus",
      properties: { networkAcls: { publicNetworkAccess: "Enabled" } },
    });
    // The DCE existence check used the pinned api-version.
    expect(azure.calls[1]).toEqual({
      method: "GET",
      path: dce.resourceId,
      apiVersion: DCE_API_VERSION,
    });

    const dcrBody = preview.tables[0].dcrResource.request.body as {
      kind?: string;
      properties: { dataCollectionEndpointId: string };
    };
    expect(dcrBody.properties.dataCollectionEndpointId).toBe(dce.resourceId);
    // DCE-based DCRs carry NO kind (never Kind:Direct).
    expect(dcrBody).not.toHaveProperty("kind");
  });

  it("reuses an EXISTING DCE: exists true, request null, its live id referenced", async () => {
    const liveDceId =
      "/subscriptions/sub-1/resourceGroups/rg-1" +
      "/providers/Microsoft.Insights/dataCollectionEndpoints/dce-ws-1-eastus";
    const azure = new FakeAzureManagement();
    azure.respondWith(
      workspaceResponse,
      {
        status: 200,
        body: {
          id: liveDceId,
          properties: {
            provisioningState: "Succeeded",
            logsIngestion: { endpoint: "https://dce.eastus-1.ingest.monitor.azure.com" },
          },
        },
      },
      listResponse([]),
      nativeSchemaResponse,
    );

    const preview = await buildDeploymentPreview(azure, {
      scope,
      tables: [{ table: "SecurityEvent" }],
      options: {
        createDCE: true,
        customTableRetentionDays: 30,
        dcePublicNetworkAccess: true,
      },
      generatedAtToken: "t-2",
    });

    expect(preview.dce).toEqual({
      name: "dce-ws-1-eastus",
      exists: true,
      resourceId: liveDceId,
      // ensure-dce REUSES an existing DCE: nothing would be sent.
      request: null,
    });
    const dcrBody = preview.tables[0].dcrResource.request.body as {
      properties: { dataCollectionEndpointId: string };
    };
    expect(dcrBody.properties.dataCollectionEndpointId).toBe(liveDceId);
  });

  it("lets the EXISTING custom table's live schema win over a supplied customSchema", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      workspaceResponse,
      listResponse([]),
      {
        status: 200,
        body: {
          properties: {
            schema: {
              columns: [
                { name: "TimeGenerated", type: "dateTime" },
                { name: "LiveOnlyColumn", type: "string" },
              ],
            },
          },
        },
      },
    );

    const preview = await buildDeploymentPreview(azure, {
      scope,
      tables: [{ table: "CloudFlare_CL", customSchema: CLOUDFLARE_SCHEMA }],
      options: {
        createDCE: false,
        customTableRetentionDays: 30,
        dcePublicNetworkAccess: true,
      },
      generatedAtToken: "t-3",
    });

    const custom = preview.tables[0];
    // Creation would be skipped: exists, and nothing would be sent.
    expect(custom.tableResource).toEqual({ exists: true, request: null });
    // The DCR body is built from the LIVE schema, not the supplied file.
    const body = custom.dcrResource.request.body as {
      properties: {
        streamDeclarations: Record<string, { columns: Array<{ name: string }> }>;
      };
    };
    const declarations = Object.values(body.properties.streamDeclarations);
    expect(declarations).toHaveLength(1);
    const columnNames = declarations[0].columns.map((column) => column.name);
    expect(columnNames).toContain("LiveOnlyColumn");
    expect(columnNames).not.toContain("ClientIP");
  });

  it("rejects a missing custom table without a schema - the condition a deploy run fails on", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      workspaceResponse,
      listResponse([]),
      { status: 404, body: {} },
    );

    await expect(
      buildDeploymentPreview(azure, {
        scope,
        tables: [{ table: "CloudFlare_CL" }],
        options: {
          createDCE: false,
          customTableRetentionDays: 30,
          dcePublicNetworkAccess: true,
        },
        generatedAtToken: "t-4",
      }),
    ).rejects.toThrow(/no customSchema/);
  });

  it("throws raw greppable text when the workspace fetch fails", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: { code: "AuthorizationFailed" } } });

    await expect(
      buildDeploymentPreview(azure, {
        scope,
        tables: [{ table: "SecurityEvent" }],
        options: {
          createDCE: false,
          customTableRetentionDays: 30,
          dcePublicNetworkAccess: true,
        },
        generatedAtToken: "t-5",
      }),
    ).rejects.toThrow(/fetch workspace 'ws-1': HTTP 403/);
  });

  it("NEVER writes: a full dce-mode run with pagination and endpoint resolution issues only GETs", async () => {
    const liveDceId =
      "/subscriptions/sub-1/resourceGroups/rg-1" +
      "/providers/Microsoft.Insights/dataCollectionEndpoints/dce-ws-1-eastus";
    const nextLink =
      "https://management.azure.com" + DCR_LIST_PATH + "?skipToken=page-2";
    const azure = new FakeAzureManagement();
    azure.respondWith(
      workspaceResponse,
      {
        status: 200,
        body: { id: liveDceId, properties: { provisioningState: "Succeeded" } },
      },
      listResponse(["dcr-Unrelated-eastus"], nextLink),
      listResponse(["dcr-SecurityEvent-eastus"]),
      {
        // Matched DCR is DCE-based: no endpoint of its own.
        status: 200,
        body: {
          properties: {
            immutableId: "dcr-imm-1",
            dataCollectionEndpointId: liveDceId,
          },
        },
      },
      {
        status: 200,
        body: {
          properties: {
            logsIngestion: {
              endpoint: "https://dce.eastus-1.handler.control.monitor.azure.com",
            },
          },
        },
      },
      nativeSchemaResponse,
      { status: 404, body: {} },
    );

    const preview = await buildDeploymentPreview(azure, {
      scope,
      tables: [
        { table: "SecurityEvent" },
        { table: "CloudFlare_CL", customSchema: CLOUDFLARE_SCHEMA },
      ],
      options: {
        createDCE: true,
        customTableRetentionDays: 30,
        dcePublicNetworkAccess: true,
      },
      generatedAtToken: "t-6",
    });

    // THE Unit 7 invariant: a preview never sends anything but GET.
    expect(azure.calls.length).toBeGreaterThan(0);
    expect(azure.urlCalls.length).toBeGreaterThan(0);
    expect(azure.calls.every((call) => call.method === "GET")).toBe(true);
    expect(azure.urlCalls.every((call) => call.method === "GET")).toBe(true);

    // Endpoint carried VERBATIM (no handler.control rewrite here).
    expect(preview.tables[0].dcrResource.ingestionEndpoint).toBe(
      "https://dce.eastus-1.handler.control.monitor.azure.com",
    );
    expect(preview.tables[0].dcrResource.exists).toBe(true);
    expect(preview.tables[1].dcrResource.exists).toBe(false);
    expect(preview.tables[1].tableResource?.exists).toBe(false);
  });
});
