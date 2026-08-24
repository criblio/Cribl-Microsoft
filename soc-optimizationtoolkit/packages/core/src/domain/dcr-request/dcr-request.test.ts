import { describe, expect, it } from "vitest";
import {
  buildDceDcrRequest,
  buildDirectDcrRequest,
  parseDcrDeployment,
  DcrRequestError,
  DCE_DCR_API_VERSION,
  DIRECT_DCR_API_VERSION,
} from "./dcr-request";
import { SchemaMappingError } from "../schema-mapping";
import type { LogAnalyticsColumn } from "../schema-mapping";

const WORKSPACE_ID =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.OperationalInsights/workspaces/law-prod";

/**
 * Small SecurityEvent schema fixture (subset of the legacy characterization
 * fixture): one native system column (TenantId, dropped), one guid column
 * (dropped), one unknown type (mapped to string + warned), and survivors
 * covering the common types.
 */
const SECURITY_EVENT_COLUMNS: LogAnalyticsColumn[] = [
  { name: "TenantId", type: "string" }, // RULE 2a: native system column
  { name: "TimeGenerated", type: "dateTime" },
  { name: "Account", type: "string" },
  { name: "EventID", type: "int" },
  { name: "InterfaceUuid", type: "guid" }, // RULE 2b: declared string + cast
  { name: "EventData", type: "mystery" }, // RULE 3: unknown -> string
];

describe("buildDirectDcrRequest", () => {
  it("pins the exact ARM PUT request for SecurityEvent", () => {
    const request = buildDirectDcrRequest({
      table: "SecurityEvent",
      columns: SECURITY_EVENT_COLUMNS,
      location: "eastus",
      workspaceResourceId: WORKSPACE_ID,
      dcrName: "dcr-SecurityEvent-eastus",
    });

    expect(request).toEqual({
      method: "PUT",
      path:
        "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
        "Microsoft.Insights/dataCollectionRules/dcr-SecurityEvent-eastus",
      apiVersion: "2023-03-11",
      body: {
        kind: "Direct",
        location: "eastus",
        properties: {
          streamDeclarations: {
            "Custom-SecurityEvent": {
              columns: [
                { name: "TimeGenerated", type: "datetime" },
                { name: "Account", type: "string" },
                { name: "EventID", type: "int" },
                // ADR 0004: declared string, in source order, rather than
                // absent. Before the ADR this field was silently discarded at
                // the DCR boundary and its column stayed null forever.
                { name: "InterfaceUuid", type: "string" },
                { name: "EventData", type: "string" },
              ],
            },
          },
          destinations: {
            logAnalytics: [
              { workspaceResourceId: WORKSPACE_ID, name: "logAnalyticsWorkspace" },
            ],
          },
          dataFlows: [
            {
              streams: ["Custom-SecurityEvent"],
              destinations: ["logAnalyticsWorkspace"],
              // ...and promoted back on the way into the table.
              transformKql:
                "source | extend InterfaceUuid = toguid(InterfaceUuid)",
              outputStream: "Microsoft-SecurityEvent",
            },
          ],
        },
      },
      streamName: "Custom-SecurityEvent",
      outputStream: "Microsoft-SecurityEvent",
      droppedColumns: [{ name: "TenantId", reason: "system-column" }],
      unknownTypeColumns: [{ name: "EventData", laType: "mystery" }],
      castColumns: [
        { name: "InterfaceUuid", laType: "guid", cast: "toguid" },
      ],
    });
    expect(request.apiVersion).toBe(DIRECT_DCR_API_VERSION);
  });

  it("throws DcrRequestError when the workspace resource id has no subscription/resource group", () => {
    expect(() =>
      buildDirectDcrRequest({
        table: "SecurityEvent",
        columns: SECURITY_EVENT_COLUMNS,
        location: "eastus",
        workspaceResourceId: "garbage",
        dcrName: "dcr-SecurityEvent-eastus",
      }),
    ).toThrow(DcrRequestError);
  });

  it("throws DcrRequestError on blank table, location, or dcrName", () => {
    const base = {
      table: "SecurityEvent",
      columns: SECURITY_EVENT_COLUMNS,
      location: "eastus",
      workspaceResourceId: WORKSPACE_ID,
      dcrName: "dcr-SecurityEvent-eastus",
    };
    expect(() => buildDirectDcrRequest({ ...base, table: " " })).toThrow(
      DcrRequestError,
    );
    expect(() => buildDirectDcrRequest({ ...base, location: "" })).toThrow(
      DcrRequestError,
    );
    expect(() => buildDirectDcrRequest({ ...base, dcrName: "" })).toThrow(
      DcrRequestError,
    );
  });

  it("throws SchemaMappingError when every column is filtered away (RULE 2d)", () => {
    // ALL SYSTEM COLUMNS NOW. This case used to lean on a guid column being
    // dropped too; since ADR 0004 a guid column survives, so leaving it here
    // would have made the test pass for the wrong reason - or, as it did,
    // stop passing at all.
    expect(() =>
      buildDirectDcrRequest({
        table: "SecurityEvent",
        columns: [
          { name: "TenantId", type: "string" },
          { name: "SourceSystem", type: "string" },
        ],
        location: "eastus",
        workspaceResourceId: WORKSPACE_ID,
        dcrName: "dcr-SecurityEvent-eastus",
      }),
    ).toThrow(SchemaMappingError);
  });

  it("does NOT fail a table whose only non-system column is a guid", () => {
    // The other half of the same change: a table like that used to produce
    // zero columns and no DCR at all. Now it produces a one-column DCR that
    // actually carries the field.
    const request = buildDirectDcrRequest({
      table: "SecurityEvent",
      columns: [
        { name: "TenantId", type: "string" },
        { name: "SomeGuid", type: "guid" },
      ],
      location: "eastus",
      workspaceResourceId: WORKSPACE_ID,
      dcrName: "dcr-SecurityEvent-eastus",
    });

    expect(
      request.body.properties.streamDeclarations["Custom-SecurityEvent"]
        ?.columns,
    ).toEqual([{ name: "SomeGuid", type: "string" }]);
    expect(request.body.properties.dataFlows[0]?.transformKql).toBe(
      "source | extend SomeGuid = toguid(SomeGuid)",
    );
  });
});

describe("buildDceDcrRequest", () => {
  const DCE_ID =
    "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
    "Microsoft.Insights/dataCollectionEndpoints/dce-SecurityEvent-eastus";

  it("pins the exact DCE-based ARM PUT for SecurityEvent (NO kind property)", () => {
    // Legacy shape: dcr-template-with-dce.json - apiVersion 2023-03-11,
    // properties.dataCollectionEndpointId from the endpointResourceId
    // parameter, the same streamDeclarations/destinations/dataFlows fragment
    // as Direct mode, and NO "kind" (only dcr-template-direct.json declares
    // kind "Direct").
    const request = buildDceDcrRequest({
      table: "SecurityEvent",
      columns: SECURITY_EVENT_COLUMNS,
      location: "eastus",
      workspaceResourceId: WORKSPACE_ID,
      dcrName: "dcr-SecurityEvent-eastus",
      dataCollectionEndpointId: DCE_ID,
    });

    expect(request).toEqual({
      method: "PUT",
      path:
        "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
        "Microsoft.Insights/dataCollectionRules/dcr-SecurityEvent-eastus",
      apiVersion: "2023-03-11",
      body: {
        location: "eastus",
        properties: {
          dataCollectionEndpointId: DCE_ID,
          streamDeclarations: {
            "Custom-SecurityEvent": {
              columns: [
                { name: "TimeGenerated", type: "datetime" },
                { name: "Account", type: "string" },
                { name: "EventID", type: "int" },
                { name: "InterfaceUuid", type: "string" },
                { name: "EventData", type: "string" },
              ],
            },
          },
          destinations: {
            logAnalytics: [
              { workspaceResourceId: WORKSPACE_ID, name: "logAnalyticsWorkspace" },
            ],
          },
          dataFlows: [
            {
              streams: ["Custom-SecurityEvent"],
              destinations: ["logAnalyticsWorkspace"],
              // ADR 0004 applies identically in DCE mode - the stream fragment
              // is the SAME shared builder, which is the point of this pin.
              transformKql:
                "source | extend InterfaceUuid = toguid(InterfaceUuid)",
              outputStream: "Microsoft-SecurityEvent",
            },
          ],
        },
      },
      streamName: "Custom-SecurityEvent",
      outputStream: "Microsoft-SecurityEvent",
      droppedColumns: [{ name: "TenantId", reason: "system-column" }],
      unknownTypeColumns: [{ name: "EventData", laType: "mystery" }],
      castColumns: [
        { name: "InterfaceUuid", laType: "guid", cast: "toguid" },
      ],
    });
    expect(request.apiVersion).toBe(DCE_DCR_API_VERSION);
    // The load-bearing kind rule: DCE-based DCRs are NOT Kind:Direct.
    expect("kind" in request.body).toBe(false);
  });

  it("uses Custom- for BOTH streams on custom tables, like Direct mode", () => {
    // Create-TableDCRs.ps1 lines 2844-2846: custom tables use "Custom-" for
    // input AND output in every mode - the shared schema-mapping fragment.
    const request = buildDceDcrRequest({
      table: "CloudFlare_CL",
      tableMode: "custom",
      columns: [
        { name: "TimeGenerated", type: "dateTime" },
        { name: "RayID", type: "string" },
      ],
      location: "eastus",
      workspaceResourceId: WORKSPACE_ID,
      dcrName: "dcr-CloudFlare-eastus",
      dataCollectionEndpointId: DCE_ID,
    });
    expect(request.streamName).toBe("Custom-CloudFlare_CL");
    expect(request.outputStream).toBe("Custom-CloudFlare_CL");
    expect(request.body.properties.dataFlows[0].outputStream).toBe(
      "Custom-CloudFlare_CL",
    );
  });

  it("throws DcrRequestError on a blank dataCollectionEndpointId", () => {
    expect(() =>
      buildDceDcrRequest({
        table: "SecurityEvent",
        columns: SECURITY_EVENT_COLUMNS,
        location: "eastus",
        workspaceResourceId: WORKSPACE_ID,
        dcrName: "dcr-SecurityEvent-eastus",
        dataCollectionEndpointId: "  ",
      }),
    ).toThrow(DcrRequestError);
  });

  it("shares the Direct builder's validation (blank inputs, bad workspace id)", () => {
    const base = {
      table: "SecurityEvent",
      columns: SECURITY_EVENT_COLUMNS,
      location: "eastus",
      workspaceResourceId: WORKSPACE_ID,
      dcrName: "dcr-SecurityEvent-eastus",
      dataCollectionEndpointId: DCE_ID,
    };
    expect(() => buildDceDcrRequest({ ...base, table: " " })).toThrow(
      DcrRequestError,
    );
    expect(() =>
      buildDceDcrRequest({ ...base, workspaceResourceId: "garbage" }),
    ).toThrow(DcrRequestError);
  });
});

describe("parseDcrDeployment", () => {
  const FULL_BODY = {
    id: "/subscriptions/sub-123/.../dataCollectionRules/dcr-SecurityEvent-eastus",
    kind: "Direct",
    location: "eastus",
    properties: {
      immutableId: "dcr-0123456789abcdef0123456789abcdef",
      provisioningState: "Succeeded",
      endpoints: {
        logsIngestion:
          "https://dcr-securityevent-eastus-a1b2.eastus-1.ingest.monitor.azure.com",
        metricsIngestion:
          "https://dcr-securityevent-eastus-a1b2.eastus-1.metrics.ingest.monitor.azure.com",
      },
    },
  };

  it("extracts immutableId, logsIngestion endpoint, and provisioningState", () => {
    expect(parseDcrDeployment(FULL_BODY)).toEqual({
      immutableId: "dcr-0123456789abcdef0123456789abcdef",
      logsIngestionEndpoint:
        "https://dcr-securityevent-eastus-a1b2.eastus-1.ingest.monitor.azure.com",
      provisioningState: "Succeeded",
    });
  });

  it("falls back to the legacy properties.logsIngestion.endpoint path", () => {
    const body = {
      properties: {
        immutableId: "dcr-legacy",
        provisioningState: "Succeeded",
        logsIngestion: { endpoint: "https://legacy.ingest.monitor.azure.com" },
      },
    };
    expect(parseDcrDeployment(body).logsIngestionEndpoint).toBe(
      "https://legacy.ingest.monitor.azure.com",
    );
  });

  it("falls back to destinations.logAnalytics[0].endpoint as the last resort", () => {
    const body = {
      properties: {
        destinations: {
          logAnalytics: [{ endpoint: "https://dest.ingest.monitor.azure.com" }],
        },
      },
    };
    expect(parseDcrDeployment(body)).toEqual({
      immutableId: null,
      logsIngestionEndpoint: "https://dest.ingest.monitor.azure.com",
      provisioningState: null,
    });
  });

  it("is total: null, undefined, strings, and empty objects yield all-null info", () => {
    for (const body of [null, undefined, "oops", 42, {}, { properties: {} }]) {
      expect(parseDcrDeployment(body)).toEqual({
        immutableId: null,
        logsIngestionEndpoint: null,
        provisioningState: null,
      });
    }
  });
});
