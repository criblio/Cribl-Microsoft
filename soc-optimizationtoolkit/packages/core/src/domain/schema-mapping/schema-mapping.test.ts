/**
 * Unit tests for the Log Analytics schema -> DCR column-set compatibility
 * contract, organized by spec rule so they read as documentation of the
 * legacy behavior (Create-TableDCRs.ps1: ConvertTo-DCRColumnType lines
 * 396-432, Get-TableColumns lines 1475-1617, Get-CustomTableSchemaFromFile
 * lines 702-779, New-LogAnalyticsCustomTable lines 452-462).
 *
 * The exhaustive legacy pin is schema-mapping.characterization.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  buildDcrColumnSet,
  buildStreamDeclaration,
  buildTransformKql,
  ensureCustomTableSuffix,
  isKnownColumnType,
  mapColumnType,
  normalizeCustomSchemaColumns,
  selectSchemaColumns,
  stripReservedTableCreationColumns,
  SchemaMappingError,
  CUSTOM_SYSTEM_COLUMNS,
  DEFAULT_TRANSFORM_KQL,
  GUID_LIKE_TYPES,
  LOG_ANALYTICS_DESTINATION_NAME,
  NATIVE_SYSTEM_COLUMNS,
  RESERVED_TABLE_CREATION_COLUMNS,
} from "./index";
import type { LogAnalyticsColumn } from "./index";
// Cross-domain on purpose: ADR 0004 made this module an EMITTER of KQL, and the
// pin that matters is that gap-analysis can read back what we emit.
import { parseTransformKql } from "../gap-analysis/kql-parser";

function col(name: string, type: string): LogAnalyticsColumn {
  return { name, type };
}

describe("RULE 1: input schema column-source selection", () => {
  const standard = [col("TimeGenerated", "dateTime"), col("Computer", "string")];
  const user = [col("Field_A", "string"), col("Field_B", "long")];

  it("native mode prefers standardColumns", () => {
    const picked = selectSchemaColumns(
      { standardColumns: standard, columns: user },
      "native",
    );
    expect(picked).toBe(standard);
  });

  it("native mode falls back to columns when standardColumns is absent", () => {
    expect(selectSchemaColumns({ columns: user }, "native")).toBe(user);
    expect(
      selectSchemaColumns({ standardColumns: null, columns: user }, "native"),
    ).toBe(user);
  });

  it("native mode treats an empty standardColumns array as absent", () => {
    expect(
      selectSchemaColumns({ standardColumns: [], columns: user }, "native"),
    ).toBe(user);
  });

  it("native safety case: lone TenantId standardColumn defers to columns", () => {
    const picked = selectSchemaColumns(
      { standardColumns: [col("TenantId", "string")], columns: user },
      "native",
    );
    expect(picked).toBe(user);
  });

  it("native safety case matches TenantId case-insensitively", () => {
    const picked = selectSchemaColumns(
      { standardColumns: [col("tenantid", "string")], columns: user },
      "native",
    );
    expect(picked).toBe(user);
  });

  it("native safety case requires columns to be present", () => {
    const loneTenantId = [col("TenantId", "string")];
    expect(
      selectSchemaColumns({ standardColumns: loneTenantId }, "native"),
    ).toBe(loneTenantId);
    expect(
      selectSchemaColumns(
        { standardColumns: loneTenantId, columns: [] },
        "native",
      ),
    ).toBe(loneTenantId);
  });

  it("native safety case does not trigger for two standardColumns", () => {
    const two = [col("TenantId", "string"), col("Computer", "string")];
    expect(
      selectSchemaColumns({ standardColumns: two, columns: user }, "native"),
    ).toBe(two);
  });

  it("custom mode prefers columns (DCR-based table)", () => {
    const picked = selectSchemaColumns(
      { standardColumns: standard, columns: user },
      "custom",
    );
    expect(picked).toBe(user);
  });

  it("custom mode falls back to standardColumns (MMA legacy table)", () => {
    expect(
      selectSchemaColumns({ standardColumns: standard, columns: [] }, "custom"),
    ).toBe(standard);
    expect(selectSchemaColumns({ standardColumns: standard }, "custom")).toBe(
      standard,
    );
  });

  it("returns null when no usable column source exists", () => {
    expect(selectSchemaColumns({}, "native")).toBeNull();
    expect(selectSchemaColumns({ columns: [], standardColumns: [] }, "native")).toBeNull();
    expect(selectSchemaColumns({}, "custom")).toBeNull();
  });

  it("defaults to native mode", () => {
    expect(selectSchemaColumns({ standardColumns: standard, columns: user })).toBe(
      standard,
    );
  });
});

describe("RULE 2a: system-name drop lists (case-insensitive)", () => {
  it("native mode drops all 18 system column names", () => {
    expect(NATIVE_SYSTEM_COLUMNS).toHaveLength(18);
    const input = [
      col("Keeper", "string"),
      ...NATIVE_SYSTEM_COLUMNS.map((name) => col(name, "string")),
    ];
    const result = buildDcrColumnSet(input, "native");
    expect(result.columns).toEqual([{ name: "Keeper", type: "string" }]);
    expect(result.dropped).toEqual(
      NATIVE_SYSTEM_COLUMNS.map((name) => ({
        name,
        reason: "system-column",
      })),
    );
  });

  it("matches drop-list names case-insensitively", () => {
    const result = buildDcrColumnSet(
      [col("sourcesystem", "string"), col("TENANTID", "string"), col("Ok", "string")],
      "native",
    );
    expect(result.columns).toEqual([{ name: "Ok", type: "string" }]);
    expect(result.dropped.map((d) => d.name)).toEqual([
      "sourcesystem",
      "TENANTID",
    ]);
  });

  it("custom mode drops only the minimal 6-name list", () => {
    expect(CUSTOM_SYSTEM_COLUMNS).toHaveLength(6);
    const input = CUSTOM_SYSTEM_COLUMNS.map((name) => col(name, "string"));
    const result = buildDcrColumnSet(input, "custom");
    expect(result.columns).toEqual([]);
    expect(result.dropped.map((d) => d.name)).toEqual([...CUSTOM_SYSTEM_COLUMNS]);
  });

  it("custom mode KEEPS TenantId and SourceSystem", () => {
    const result = buildDcrColumnSet(
      [
        col("TenantId", "string"),
        col("SourceSystem", "string"),
        col("MG", "string"),
        col("ManagementGroupName", "string"),
        col("Type", "string"),
      ],
      "custom",
    );
    expect(result.columns.map((c) => c.name)).toEqual([
      "TenantId",
      "SourceSystem",
      "MG",
      "ManagementGroupName",
    ]);
    expect(result.dropped).toEqual([{ name: "Type", reason: "system-column" }]);
  });

  it("defaults to native mode", () => {
    const result = buildDcrColumnSet([col("SourceSystem", "string")]);
    expect(result.columns).toEqual([]);
    expect(result.dropped).toEqual([
      { name: "SourceSystem", reason: "system-column" },
    ]);
  });
});

// RULE 2b INVERTED BY ADR 0004. These tests used to assert the drop, under the
// heading "guid-typed columns are dropped entirely". The drop silently lost
// data - an undeclared field is discarded at the DCR boundary and the
// destination column stays null forever, with the deploy reporting success - so
// the pins now assert the cast. The deliberate divergence from the legacy
// script is recorded in docs/adr/0004-cast-guid-columns.md.
describe("RULE 2b: guid-typed columns are declared string and cast (ADR 0004)", () => {
  it("declares guid, uniqueidentifier, and uuid as string in native mode", () => {
    expect(GUID_LIKE_TYPES).toEqual(["guid", "uniqueidentifier", "uuid"]);
    const result = buildDcrColumnSet(
      [
        col("A", "guid"),
        col("B", "uniqueidentifier"),
        col("C", "uuid"),
        col("D", "string"),
      ],
      "native",
    );
    // All four SURVIVE now, in source order.
    expect(result.columns).toEqual([
      { name: "A", type: "string" },
      { name: "B", type: "string" },
      { name: "C", type: "string" },
      { name: "D", type: "string" },
    ]);
    expect(result.dropped).toEqual([]);
    // And each carries its promotion, with the LA type that required it.
    expect(result.casts).toEqual([
      { name: "A", laType: "guid", cast: "toguid" },
      { name: "B", laType: "uniqueidentifier", cast: "toguid" },
      { name: "C", laType: "uuid", cast: "toguid" },
    ]);
  });

  it("casts guid-typed columns in custom mode too", () => {
    const result = buildDcrColumnSet([col("CorrelationId", "guid")], "custom");
    expect(result.columns).toEqual([
      { name: "CorrelationId", type: "string" },
    ]);
    expect(result.dropped).toEqual([]);
    expect(result.casts).toEqual([
      { name: "CorrelationId", laType: "guid", cast: "toguid" },
    ]);
  });

  it("matches the guid type case-insensitively", () => {
    const result = buildDcrColumnSet([col("A", "GUID"), col("B", "Uuid")], "native");
    expect(result.columns).toEqual([
      { name: "A", type: "string" },
      { name: "B", type: "string" },
    ]);
    // laType is echoed VERBATIM, original casing intact - it is what the
    // workspace said, not what we normalized it to.
    expect(result.casts).toEqual([
      { name: "A", laType: "GUID", cast: "toguid" },
      { name: "B", laType: "Uuid", cast: "toguid" },
    ]);
  });

  it("does not report a cast column as an unknown type", () => {
    // guid IS a recognised type - typeMap has mapped it to string all along.
    // Reporting it as unknown would raise a warning about a column we handled.
    const result = buildDcrColumnSet([col("Id", "guid")], "native");
    expect(result.unknownTypes).toEqual([]);
  });

  it("DROPS a guid-typed system column rather than casting it (precedence)", () => {
    // Load-bearing, and unchanged by ADR 0004. TenantId is guid on essentially
    // every Sentinel table and Azure populates it; casting it would declare a
    // column we must not send. RULE 2a still wins.
    const result = buildDcrColumnSet([col("TenantId", "guid")], "native");
    expect(result.dropped).toEqual([
      { name: "TenantId", reason: "system-column" },
    ]);
    expect(result.columns).toEqual([]);
    expect(result.casts).toEqual([]);
  });

  it("leaves casts EMPTY for a table with no guid columns", () => {
    // The common case, and the one that must stay byte-identical to legacy.
    const result = buildDcrColumnSet(
      [col("A", "string"), col("B", "int")],
      "native",
    );
    expect(result.casts).toEqual([]);
  });
});

describe("buildTransformKql (RULE 5, ADR 0004)", () => {
  it("is EXACTLY 'source' when nothing needs promoting", () => {
    // Byte-for-byte. A transform that merely looked equivalent would still
    // rewrite the payload of every deployed DCR that has no guid columns.
    expect(buildTransformKql([])).toBe("source");
    expect(buildTransformKql()).toBe("source");
  });

  it("emits a self-referential extend for one cast", () => {
    expect(
      buildTransformKql([{ name: "AwsEventId", laType: "guid", cast: "toguid" }]),
    ).toBe("source | extend AwsEventId = toguid(AwsEventId)");
  });

  it("comma-joins several casts in column order", () => {
    expect(
      buildTransformKql([
        { name: "AwsEventId", laType: "guid", cast: "toguid" },
        { name: "SharedEventId", laType: "guid", cast: "toguid" },
      ]),
    ).toBe(
      "source | extend AwsEventId = toguid(AwsEventId), " +
        "SharedEventId = toguid(SharedEventId)",
    );
  });

  it("round-trips through the gap-analysis KQL parser", () => {
    // THE pin that stops us emitting something we cannot read back. Without
    // toguid in the parser this produced a phantom source field named
    // "toguid", and gap analysis reported a field no sample could ever carry.
    const kql = buildTransformKql([
      { name: "AwsEventId", laType: "guid", cast: "toguid" },
    ]);
    const parsed = parseTransformKql(kql);

    expect(parsed.typeConversions).toContainEqual({
      field: "AwsEventId",
      toType: "guid",
    });
    // The phantom-field check, both directions.
    expect(parsed.renames.map((r) => r.source)).not.toContain("toguid");
    expect(parsed.renames.map((r) => r.dest)).not.toContain("toguid");
    expect(parsed.columns.map((c) => c.name)).not.toContain("toguid");
    // The real column is there, typed guid.
    expect(parsed.columns).toContainEqual({
      name: "AwsEventId",
      type: "guid",
    });
  });
});

describe("RULE 2c: TimeGenerated handling", () => {
  it("passes TimeGenerated through as datetime in both modes", () => {
    for (const mode of ["native", "custom"] as const) {
      const result = buildDcrColumnSet([col("TimeGenerated", "dateTime")], mode);
      expect(result.columns).toEqual([
        { name: "TimeGenerated", type: "datetime" },
      ]);
    }
  });

  it("the Azure-schema path never injects TimeGenerated", () => {
    const result = buildDcrColumnSet([col("Message", "string")], "native");
    expect(result.columns).toEqual([{ name: "Message", type: "string" }]);
  });

  it("the schema-file path appends TimeGenerated at the END when absent", () => {
    const normalized = normalizeCustomSchemaColumns([
      { name: "Field_A", type: "string" },
      { name: "Field_B", type: "int" },
    ]);
    expect(normalized).toEqual([
      { name: "Field_A", type: "string", description: "" },
      { name: "Field_B", type: "int", description: "" },
      {
        name: "TimeGenerated",
        type: "datetime",
        description: "Timestamp when the record was generated",
      },
    ]);
  });

  it("the schema-file path detects an existing TimeGenerated case-insensitively", () => {
    const normalized = normalizeCustomSchemaColumns([
      { name: "timegenerated", type: "datetime" },
    ]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.name).toBe("timegenerated");
  });
});

describe("RULE 2d: zero surviving columns fails the table", () => {
  it("buildStreamDeclaration throws SchemaMappingError on an empty column set", () => {
    expect(() => buildStreamDeclaration("Syslog", [], "native")).toThrow(
      SchemaMappingError,
    );
    expect(() => buildStreamDeclaration("Syslog", [], "native")).toThrow(
      /no columns remaining/,
    );
  });
});

describe("RULE 2e: reserved names stripped from the table CREATION payload", () => {
  it("strips all 13 reserved names, preserving order of the rest", () => {
    expect(RESERVED_TABLE_CREATION_COLUMNS).toHaveLength(13);
    const input = [
      { name: "Field_A" },
      ...RESERVED_TABLE_CREATION_COLUMNS.map((name) => ({ name })),
      { name: "Field_B" },
    ];
    expect(stripReservedTableCreationColumns(input)).toEqual([
      { name: "Field_A" },
      { name: "Field_B" },
    ]);
  });

  it("matches reserved names case-insensitively", () => {
    expect(
      stripReservedTableCreationColumns([
        { name: "rawdata" },
        { name: "COMPUTER" },
        { name: "Field_A" },
      ]),
    ).toEqual([{ name: "Field_A" }]);
  });

  it("explicitly allows TimeGenerated", () => {
    expect(
      stripReservedTableCreationColumns([{ name: "TimeGenerated" }]),
    ).toEqual([{ name: "TimeGenerated" }]);
  });

  it("differs from the DCR drop lists (ItemCount/Computer/RawData are DCR-legal)", () => {
    const result = buildDcrColumnSet(
      [col("ItemCount", "int"), col("Computer", "string"), col("RawData", "string")],
      "native",
    );
    expect(result.columns.map((c) => c.name)).toEqual([
      "ItemCount",
      "Computer",
      "RawData",
    ]);
  });
});

describe("RULE 3: type mapping (DCR-08)", () => {
  const mappings: Array<[string, string]> = [
    ["string", "string"],
    ["int", "int"],
    ["int32", "int"],
    ["integer", "int"],
    ["long", "long"],
    ["int64", "long"],
    ["bigint", "long"],
    ["real", "real"],
    ["double", "real"],
    ["float", "real"],
    ["decimal", "real"],
    ["bool", "boolean"],
    ["boolean", "boolean"],
    ["datetime", "datetime"],
    ["timestamp", "datetime"],
    ["date", "datetime"],
    ["time", "datetime"],
    ["dynamic", "dynamic"],
    ["object", "dynamic"],
    ["json", "dynamic"],
    ["guid", "string"],
    ["uniqueidentifier", "string"],
    ["uuid", "string"],
  ];

  for (const [laType, dcrType] of mappings) {
    it(`maps '${laType}' -> '${dcrType}'`, () => {
      expect(mapColumnType(laType)).toBe(dcrType);
      expect(isKnownColumnType(laType)).toBe(true);
    });
  }

  it("matches input types case-insensitively (API casing 'dateTime')", () => {
    expect(mapColumnType("dateTime")).toBe("datetime");
    expect(mapColumnType("STRING")).toBe("string");
    expect(mapColumnType("Boolean")).toBe("boolean");
    expect(mapColumnType("Dynamic")).toBe("dynamic");
  });

  it("maps unknown types to string", () => {
    expect(mapColumnType("sbyte")).toBe("string");
    expect(mapColumnType("")).toBe("string");
    expect(isKnownColumnType("sbyte")).toBe(false);
  });

  it("buildDcrColumnSet surfaces unknown-type fallbacks for warning", () => {
    const result = buildDcrColumnSet(
      [col("Weird", "sbyte"), col("Normal", "string")],
      "native",
    );
    expect(result.columns).toEqual([
      { name: "Weird", type: "string" },
      { name: "Normal", type: "string" },
    ]);
    expect(result.unknownTypes).toEqual([{ name: "Weird", laType: "sbyte" }]);
  });

  it("the guid->string mapping is reachable via the schema-file path", () => {
    const normalized = normalizeCustomSchemaColumns([
      { name: "CorrelationId", type: "guid" },
      { name: "TimeGenerated", type: "datetime" },
    ]);
    expect(normalized[0]).toEqual({
      name: "CorrelationId",
      type: "string",
      description: "",
    });
  });

  it("the schema-file path throws on a column missing name or type", () => {
    expect(() =>
      normalizeCustomSchemaColumns([{ name: "", type: "string" }]),
    ).toThrow(SchemaMappingError);
    expect(() =>
      normalizeCustomSchemaColumns([{ name: "Field_A", type: "" }]),
    ).toThrow(/name.*type/);
  });

  it("the schema-file path carries descriptions through, defaulting to ''", () => {
    const normalized = normalizeCustomSchemaColumns([
      { name: "A", type: "string", description: "described" },
      { name: "B", type: "string", description: null },
      { name: "TimeGenerated", type: "datetime" },
    ]);
    expect(normalized.map((c) => c.description)).toEqual(["described", "", ""]);
  });
});

describe("RULE 4: ordering and identity", () => {
  it("preserves source order exactly after filtering (no sorting)", () => {
    const result = buildDcrColumnSet(
      [
        col("Zulu", "string"),
        col("TenantId", "string"),
        col("Alpha", "int"),
        col("Mike", "guid"),
        col("Echo", "dynamic"),
      ],
      "native",
    );
    // Mike is guid, so since ADR 0004 it SURVIVES - in its original position,
    // which is the claim this test exists to make. Only TenantId drops.
    expect(result.columns.map((c) => c.name)).toEqual([
      "Zulu",
      "Alpha",
      "Mike",
      "Echo",
    ]);
    expect(result.dropped.map((d) => d.name)).toEqual(["TenantId"]);
    // The cast list is in column order too, not append order.
    expect(result.casts.map((c) => c.name)).toEqual(["Mike"]);
  });

  it("does not deduplicate repeated column names", () => {
    const result = buildDcrColumnSet(
      [col("Dup", "string"), col("Dup", "int")],
      "native",
    );
    expect(result.columns).toEqual([
      { name: "Dup", type: "string" },
      { name: "Dup", type: "int" },
    ]);
  });

  it("emits {name, type} entries only - no description, no renaming", () => {
    const result = buildDcrColumnSet([col("MiXeDcAsE", "string")], "native");
    expect(result.columns[0]).toEqual({ name: "MiXeDcAsE", type: "string" });
    expect(Object.keys(result.columns[0] ?? {}).sort()).toEqual([
      "name",
      "type",
    ]);
  });
});

describe("RULE 5: stream declaration and dataFlow assembly", () => {
  const columns = [
    { name: "TimeGenerated", type: "datetime" },
    { name: "Message", type: "string" },
  ] as const;

  it("native table: input Custom-{table}, output Microsoft-{table}", () => {
    const declaration = buildStreamDeclaration("Syslog", [...columns], "native");
    expect(declaration.streamName).toBe("Custom-Syslog");
    expect(declaration.outputStreamName).toBe("Microsoft-Syslog");
  });

  it("custom table: BOTH streams use the Custom- prefix", () => {
    const declaration = buildStreamDeclaration(
      "CloudFlare_CL",
      [...columns],
      "custom",
    );
    expect(declaration.streamName).toBe("Custom-CloudFlare_CL");
    expect(declaration.outputStreamName).toBe("Custom-CloudFlare_CL");
  });

  it("custom table: appends _CL when missing", () => {
    const declaration = buildStreamDeclaration("CloudFlare", [...columns], "custom");
    expect(declaration.streamName).toBe("Custom-CloudFlare_CL");
    expect(declaration.outputStreamName).toBe("Custom-CloudFlare_CL");
  });

  it("custom table: the _CL check is case-sensitive (legacy EndsWith quirk)", () => {
    expect(ensureCustomTableSuffix("table_cl")).toBe("table_cl_CL");
    const declaration = buildStreamDeclaration("table_cl", [...columns], "custom");
    expect(declaration.streamName).toBe("Custom-table_cl_CL");
  });

  it("shapes a single-key streamDeclarations object with the columns verbatim", () => {
    const declaration = buildStreamDeclaration("Syslog", [...columns], "native");
    expect(Object.keys(declaration.streamDeclarations)).toEqual([
      "Custom-Syslog",
    ]);
    expect(declaration.streamDeclarations["Custom-Syslog"]?.columns).toEqual([
      { name: "TimeGenerated", type: "datetime" },
      { name: "Message", type: "string" },
    ]);
  });

  it("shapes exactly one dataFlow with transformKql 'source'", () => {
    expect(DEFAULT_TRANSFORM_KQL).toBe("source");
    expect(LOG_ANALYTICS_DESTINATION_NAME).toBe("logAnalyticsWorkspace");
    const declaration = buildStreamDeclaration("Syslog", [...columns], "native");
    expect(declaration.dataFlows).toEqual([
      {
        streams: ["Custom-Syslog"],
        destinations: ["logAnalyticsWorkspace"],
        transformKql: "source",
        outputStream: "Microsoft-Syslog",
      },
    ]);
  });

  it("defaults to native mode", () => {
    const declaration = buildStreamDeclaration("Syslog", [...columns]);
    expect(declaration.outputStreamName).toBe("Microsoft-Syslog");
  });
});
