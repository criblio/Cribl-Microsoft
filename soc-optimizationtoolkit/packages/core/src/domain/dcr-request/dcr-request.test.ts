import { describe, expect, it } from "vitest";
import {
  buildDceDcrRequest,
  buildDirectDcrRequest,
  describeColumnDiagnostics,
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

describe("describeColumnDiagnostics - making silent column loss audible", () => {
  const none = { droppedColumns: [], unknownTypeColumns: [], castColumns: [] };

  it("says NOTHING when there is nothing to say", () => {
    // A deploy that dropped nothing must not grow a reassurance line; noise
    // here is what trains people to stop reading step detail.
    expect(describeColumnDiagnostics(none)).toBeNull();
  });

  it("names dropped columns and says they will NOT arrive", () => {
    const text = describeColumnDiagnostics({
      ...none,
      droppedColumns: [{ name: "TenantId", reason: "system-column" }],
    });

    expect(text).toContain("TenantId");
    expect(text).toContain("NOT arrive");
    expect(text).toContain("1 column(s)");
  });

  it("names an unrecognised type and says the column became a string", () => {
    // A fidelity loss, not a data loss - the wording has to keep them apart.
    const text = describeColumnDiagnostics({
      ...none,
      unknownTypeColumns: [{ name: "EventData", laType: "mystery" }],
    });

    expect(text).toContain("EventData (mystery)");
    expect(text).toContain("declared as string");
    expect(text).not.toContain("NOT arrive");
  });

  it("reports a CAST as arriving intact, never as missing", () => {
    // CastColumn's own docblock: "a caller surfacing diagnostics must not
    // report them as missing". ADR 0004 RULE 2b promotes these on purpose, and
    // a successful promotion reading as a problem is the failure mode.
    const text = describeColumnDiagnostics({
      ...none,
      castColumns: [{ name: "RequestId", laType: "guid", cast: "toguid" }],
    });

    expect(text).toContain("arrive intact");
    expect(text).not.toContain("NOT arrive");
    expect(text).not.toContain("dropped");
  });

  it("keeps the three channels separate when all three fire", () => {
    const text = describeColumnDiagnostics({
      droppedColumns: [{ name: "TenantId", reason: "system-column" }],
      unknownTypeColumns: [{ name: "EventData", laType: "mystery" }],
      castColumns: [{ name: "RequestId", laType: "guid", cast: "toguid" }],
    });

    // Order is loss-first: the thing that costs data leads.
    expect(text).not.toBeNull();
    const line = text as string;
    expect(line.indexOf("NOT arrive")).toBeLessThan(line.indexOf("declared as string"));
    expect(line.indexOf("declared as string")).toBeLessThan(line.indexOf("arrive intact"));
  });

  it("counts every entry, not just the distinct names", () => {
    // unknownTypes is one entry PER OCCURRENCE by contract; collapsing them
    // would under-report how much of the schema fell back.
    const text = describeColumnDiagnostics({
      ...none,
      unknownTypeColumns: [
        { name: "A", laType: "x" },
        { name: "B", laType: "x" },
      ],
    });

    expect(text).toContain("2 column(s)");
  });

  it("is fed by a real built request, not just hand-made input", () => {
    // The seam that actually mattered: buildDirectDcrRequest has always
    // produced these and every caller discarded them. If its output shape ever
    // stops satisfying this function, that is the regression to catch.
    const request = buildDirectDcrRequest({
      table: "SecurityEvent",
      columns: [
        { name: "TimeGenerated", type: "datetime" },
        { name: "TenantId", type: "string" },
      ],
      location: "eastus",
      workspaceResourceId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/w",
      dcrName: "dcr-securityevent",
    });

    expect(() => describeColumnDiagnostics(request)).not.toThrow();
    expect(describeColumnDiagnostics(request)).toContain("TenantId");
  });
});
