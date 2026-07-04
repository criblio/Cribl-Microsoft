/**
 * domain/custom-table - porting-plan Unit 5 (ENG-34).
 *
 * Sources for every pinned expectation:
 *   - Create-TableDCRs.ps1 New-LogAnalyticsCustomTable (lines 435-565):
 *     PUT body shape, plan "Analytics", api-version 2022-10-01, reserved
 *     strip, _CL suffix enforcement, 30/90 retention defaults.
 *   - Create-TableDCRs.ps1 Get-CustomTableSchemaFromFile (lines 702-779):
 *     bare {columns} files, name/type requirement, description -> "".
 *   - IS/azure-deploy.ts generateCustomTableSchemas (lines 333-392): the
 *     properties.schema.columns and properties.schema.tableDefinition.columns
 *     wild shapes, missing type -> "string".
 */
import { describe, expect, it } from "vitest";
import {
  buildTablePutRequest,
  CustomTableError,
  CUSTOM_TABLE_PLAN,
  DEFAULT_CUSTOM_TABLE_RETENTION_DAYS,
  DEFAULT_CUSTOM_TABLE_TOTAL_RETENTION_DAYS,
  isCustomTableName,
  LOG_ANALYTICS_TABLES_API_VERSION,
  parseTableSchemaFile,
  validateCustomTableSchema,
} from "./custom-table";
import { SchemaMappingError } from "../schema-mapping";

// ---------------------------------------------------------------------------
// parseTableSchemaFile - all three wild variants
// ---------------------------------------------------------------------------

describe("parseTableSchemaFile", () => {
  it("parses the bare {columns} shape (the PS custom-table-schemas format)", () => {
    // Shape mirrors Azure/CustomDeploymentTemplates/DCR-Automation/core/
    // custom-table-schemas/CloudFlare_CL.json (plus the top-level "name"
    // the CrowdStrike files carry).
    const raw = JSON.stringify({
      name: "CloudFlare_CL",
      description: "CloudFlare logs from CDN",
      retentionInDays: 30,
      totalRetentionInDays: 90,
      columns: [
        {
          name: "TimeGenerated",
          type: "datetime",
          description: "Timestamp when the record was generated",
        },
        { name: "ClientIP", type: "string", description: "Client IP address" },
      ],
    });

    const parsed = parseTableSchemaFile(raw);
    expect(parsed.variant).toBe("bare");
    expect(parsed.tableName).toBe("CloudFlare_CL");
    expect(parsed.description).toBe("CloudFlare logs from CDN");
    expect(parsed.retentionInDays).toBe(30);
    expect(parsed.totalRetentionInDays).toBe(90);
    expect(parsed.columns).toEqual([
      {
        name: "TimeGenerated",
        type: "datetime",
        description: "Timestamp when the record was generated",
      },
      { name: "ClientIP", type: "string", description: "Client IP address" },
    ]);
  });

  it("parses the properties.schema.columns wild shape (Sentinel table definition)", () => {
    // Shape per IS/azure-deploy.ts line 363: parsed.properties?.schema?.columns
    const raw = JSON.stringify({
      properties: {
        schema: {
          name: "MyVendor_CL",
          columns: [
            { name: "TimeGenerated", type: "datetime" },
            { name: "EventId", type: "int", description: "Event id" },
          ],
        },
      },
    });

    const parsed = parseTableSchemaFile(raw);
    expect(parsed.variant).toBe("schema-columns");
    expect(parsed.tableName).toBe("MyVendor_CL");
    expect(parsed.columns).toEqual([
      { name: "TimeGenerated", type: "datetime", description: "" },
      { name: "EventId", type: "int", description: "Event id" },
    ]);
    expect(parsed.retentionInDays).toBeNull();
    expect(parsed.totalRetentionInDays).toBeNull();
  });

  it("parses the properties.schema.tableDefinition.columns wild shape", () => {
    // Shape per IS/azure-deploy.ts line 364:
    // parsed.properties?.schema?.tableDefinition?.columns
    const raw = JSON.stringify({
      properties: {
        schema: {
          tableDefinition: {
            name: "OtherVendor_CL",
            columns: [{ name: "Message", type: "string" }],
          },
        },
      },
    });

    const parsed = parseTableSchemaFile(raw);
    expect(parsed.variant).toBe("table-definition");
    expect(parsed.tableName).toBe("OtherVendor_CL");
    expect(parsed.columns).toEqual([
      { name: "Message", type: "string", description: "" },
    ]);
  });

  it("prefers properties.schema.columns over tableDefinition over bare (legacy-TS order)", () => {
    const raw = JSON.stringify({
      columns: [{ name: "FromBare", type: "string" }],
      properties: {
        schema: {
          columns: [{ name: "FromSchema", type: "string" }],
          tableDefinition: {
            columns: [{ name: "FromTableDefinition", type: "string" }],
          },
        },
      },
    });
    expect(parseTableSchemaFile(raw).columns[0]!.name).toBe("FromSchema");

    const withoutSchemaColumns = JSON.stringify({
      columns: [{ name: "FromBare", type: "string" }],
      properties: {
        schema: {
          tableDefinition: {
            columns: [{ name: "FromTableDefinition", type: "string" }],
          },
        },
      },
    });
    expect(parseTableSchemaFile(withoutSchemaColumns).columns[0]!.name).toBe(
      "FromTableDefinition",
    );
  });

  it("defaults a missing column type to 'string' (legacy-TS `col.type || 'string'`)", () => {
    const raw = JSON.stringify({
      properties: {
        schema: { columns: [{ name: "Untyped" }, { name: "Empty", type: "" }] },
      },
    });
    expect(parseTableSchemaFile(raw).columns).toEqual([
      { name: "Untyped", type: "string", description: "" },
      { name: "Empty", type: "string", description: "" },
    ]);
  });

  it("throws the PS error when no variant yields a non-empty columns array", () => {
    expect(() => parseTableSchemaFile("{}")).toThrow(CustomTableError);
    expect(() => parseTableSchemaFile("{}")).toThrow(
      /must contain a non-empty 'columns' array/,
    );
    expect(() =>
      parseTableSchemaFile(JSON.stringify({ columns: [] })),
    ).toThrow(/must contain a non-empty 'columns' array/);
  });

  it("throws on invalid JSON and on a column without a name", () => {
    expect(() => parseTableSchemaFile("not json {")).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      parseTableSchemaFile(
        JSON.stringify({ columns: [{ type: "string" }] }),
      ),
    ).toThrow(/each column must have 'name' and 'type' properties/);
  });

  it("ignores junk retention values (strings, negatives, floats) as null", () => {
    const raw = JSON.stringify({
      retentionInDays: "30",
      totalRetentionInDays: -1,
      columns: [{ name: "A", type: "string" }],
    });
    const parsed = parseTableSchemaFile(raw);
    expect(parsed.retentionInDays).toBeNull();
    expect(parsed.totalRetentionInDays).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isCustomTableName
// ---------------------------------------------------------------------------

describe("isCustomTableName", () => {
  it("matches _CL case-insensitively (same regex as the native-mode guard)", () => {
    expect(isCustomTableName("CloudFlare_CL")).toBe(true);
    expect(isCustomTableName("table_cl")).toBe(true);
    expect(isCustomTableName("SecurityEvent")).toBe(false);
    expect(isCustomTableName("CLtable")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCustomTableSchema
// ---------------------------------------------------------------------------

describe("validateCustomTableSchema", () => {
  const goodColumns = [
    { name: "TimeGenerated", type: "datetime" },
    { name: "ClientIP", type: "string" },
  ];

  it("accepts a well-formed _CL schema", () => {
    expect(validateCustomTableSchema("CloudFlare_CL", goodColumns)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("requires the exact '_CL' suffix (case-sensitive: '_cl' would be double-suffixed)", () => {
    const lower = validateCustomTableSchema("table_cl", goodColumns);
    expect(lower.valid).toBe(false);
    expect(lower.errors[0]).toContain("must end with '_CL'");

    const native = validateCustomTableSchema("SecurityEvent", goodColumns);
    expect(native.valid).toBe(false);
  });

  it("rejects an empty column list", () => {
    const result = validateCustomTableSchema("CloudFlare_CL", []);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("at least one column");
  });

  it("rejects columns missing name or type (the PS rule, as named errors)", () => {
    const result = validateCustomTableSchema("CloudFlare_CL", [
      { name: "", type: "string" },
      { name: "Ok", type: "" },
      { name: "Fine", type: "string" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    for (const error of result.errors) {
      expect(error).toContain("Each column must have 'name' and 'type' properties");
    }
  });

  it("rejects a TimeGenerated column whose type does not map to datetime", () => {
    const result = validateCustomTableSchema("CloudFlare_CL", [
      { name: "TimeGenerated", type: "string" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toBe(
      "TimeGenerated must be a datetime column (got type 'string')",
    );
  });

  it("accepts TimeGenerated aliases that MAP to datetime, matched case-insensitively", () => {
    // "timestamp" maps to datetime (RULE 3), and the name check is
    // case-insensitive like the injection check in
    // normalizeCustomSchemaColumns.
    expect(
      validateCustomTableSchema("CloudFlare_CL", [
        { name: "timegenerated", type: "timestamp" },
      ]).valid,
    ).toBe(true);
  });

  it("accepts an ABSENT TimeGenerated (the PS loader injects it at creation)", () => {
    expect(
      validateCustomTableSchema("CloudFlare_CL", [
        { name: "ClientIP", type: "string" },
      ]).valid,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildTablePutRequest - New-LogAnalyticsCustomTable as data
// ---------------------------------------------------------------------------

describe("buildTablePutRequest", () => {
  const scope = {
    subscriptionId: "sub-123",
    resourceGroup: "rg-sec",
    workspaceName: "law-prod",
  };

  it("pins the PUT verbatim: path, api-version 2022-10-01, plan Analytics, retention 30/90 defaults", () => {
    const request = buildTablePutRequest({
      ...scope,
      table: "CloudFlare_CL",
      columns: [
        { name: "ClientIP", type: "string", description: "Client IP address" },
        { name: "EdgeResponseStatus", type: "int" },
      ],
    });

    expect(request.method).toBe("PUT");
    expect(request.path).toBe(
      "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
        "Microsoft.OperationalInsights/workspaces/law-prod/tables/CloudFlare_CL",
    );
    expect(request.apiVersion).toBe(LOG_ANALYTICS_TABLES_API_VERSION);
    expect(request.apiVersion).toBe("2022-10-01");
    expect(request.tableName).toBe("CloudFlare_CL");
    expect(request.strippedReservedColumns).toEqual([]);
    expect(request.body).toEqual({
      properties: {
        plan: "Analytics",
        retentionInDays: 30,
        totalRetentionInDays: 90,
        schema: {
          name: "CloudFlare_CL",
          columns: [
            {
              name: "ClientIP",
              type: "string",
              description: "Client IP address",
            },
            { name: "EdgeResponseStatus", type: "int", description: "" },
            {
              name: "TimeGenerated",
              type: "datetime",
              description: "Timestamp when the record was generated",
            },
          ],
        },
      },
    });
  });

  it("pins the retention 90 contract (Unit 4 customTableRetentionDays feeds this)", () => {
    const request = buildTablePutRequest({
      ...scope,
      table: "CloudFlare_CL",
      columns: [{ name: "TimeGenerated", type: "datetime" }],
      retentionDays: 90,
    });
    expect(request.body.properties.retentionInDays).toBe(90);
    expect(request.body.properties.totalRetentionInDays).toBe(90);
  });

  it("exports the 30/90 defaults as named constants (compatibility contract)", () => {
    expect(DEFAULT_CUSTOM_TABLE_RETENTION_DAYS).toBe(30);
    expect(DEFAULT_CUSTOM_TABLE_TOTAL_RETENTION_DAYS).toBe(90);
    expect(CUSTOM_TABLE_PLAN).toBe("Analytics");
  });

  it("appends _CL when absent (ensureCustomTableSuffix, case-sensitive quirk preserved)", () => {
    const request = buildTablePutRequest({
      ...scope,
      table: "CloudFlare",
      columns: [{ name: "TimeGenerated", type: "datetime" }],
    });
    expect(request.tableName).toBe("CloudFlare_CL");
    expect(request.path.endsWith("/tables/CloudFlare_CL")).toBe(true);
    expect(request.body.properties.schema.name).toBe("CloudFlare_CL");
  });

  it("strips the Azure-managed reserved columns and reports them (PS warning parity)", () => {
    const request = buildTablePutRequest({
      ...scope,
      table: "App_CL",
      columns: [
        { name: "Computer", type: "string" },
        { name: "RawData", type: "string" },
        { name: "Message", type: "string" },
        { name: "TenantId", type: "string" },
      ],
    });
    expect(request.body.properties.schema.columns.map((c) => c.name)).toEqual([
      "Message",
      "TimeGenerated",
    ]);
    expect(request.strippedReservedColumns).toEqual([
      "Computer",
      "RawData",
      "TenantId",
    ]);
  });

  it("maps loose column types through the shared mapColumnType (guid -> string)", () => {
    const request = buildTablePutRequest({
      ...scope,
      table: "App_CL",
      columns: [
        { name: "CorrelationId", type: "guid" },
        { name: "Payload", type: "json" },
        { name: "Seen", type: "datetimeoffset" },
        { name: "TimeGenerated", type: "datetime" },
      ],
    });
    expect(request.body.properties.schema.columns).toEqual([
      { name: "CorrelationId", type: "string", description: "" },
      { name: "Payload", type: "dynamic", description: "" },
      { name: "Seen", type: "datetime", description: "" },
      { name: "TimeGenerated", type: "datetime", description: "" },
    ]);
  });

  it("throws CustomTableError on blank scope inputs and SchemaMappingError on bad columns", () => {
    expect(() =>
      buildTablePutRequest({
        ...scope,
        subscriptionId: " ",
        table: "App_CL",
        columns: [{ name: "A", type: "string" }],
      }),
    ).toThrow(CustomTableError);
    expect(() =>
      buildTablePutRequest({
        ...scope,
        table: "App_CL",
        columns: [{ name: "", type: "string" }],
      }),
    ).toThrow(SchemaMappingError);
  });
});
