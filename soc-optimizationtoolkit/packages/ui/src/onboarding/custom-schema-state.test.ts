import { describe, expect, it } from "vitest";
import { VENDOR_SCHEMAS } from "@soc/core";
import {
  CUSTOM_SCHEMA_SOURCE_OPTIONS,
  defaultVendorIdForTable,
  deriveCustomSchemaPreview,
  formatSchemaPreview,
  resolveRetentionDays,
  RETENTION_CHOICES,
} from "./custom-schema-state";
import type { CustomSchemaInputs } from "./custom-schema-state";

/** A well-formed bare (PS custom-table-schemas) schema file. */
const BARE_SCHEMA = JSON.stringify({
  description: "test schema",
  retentionInDays: 30,
  totalRetentionInDays: 90,
  columns: [
    { name: "TimeGenerated", type: "datetime" },
    { name: "ClientIP", type: "string" },
    { name: "StatusCode", type: "int" },
  ],
});

function inputs(overrides: Partial<CustomSchemaInputs>): CustomSchemaInputs {
  return {
    table: "MyApp_CL",
    source: "file",
    vendorId: "",
    fileText: "",
    ...overrides,
  };
}

describe("deriveCustomSchemaPreview: parse + preview derivation", () => {
  it("derives rows with mapped types from a bare schema file", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({ fileText: BARE_SCHEMA }),
    );
    expect(preview.errors).toEqual([]);
    expect(preview.ready).toBe(true);
    expect(preview.providesSchema).toBe(true);
    expect(preview.variant).toBe("bare");
    expect(preview.rows.map((r) => [r.name, r.declaredType, r.mappedType])).toEqual([
      ["TimeGenerated", "datetime", "datetime"],
      ["ClientIP", "string", "string"],
      ["StatusCode", "int", "int"],
    ]);
    // customSchema carries the raw parsed columns for onboardTable.
    expect(preview.columns.map((c) => c.name)).toEqual([
      "TimeGenerated",
      "ClientIP",
      "StatusCode",
    ]);
  });

  it("parses the properties.schema.columns Sentinel shape", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({
        fileText: JSON.stringify({
          properties: {
            schema: {
              name: "MyApp_CL",
              columns: [{ name: "EventName", type: "string" }],
            },
          },
        }),
      }),
    );
    expect(preview.errors).toEqual([]);
    expect(preview.variant).toBe("schema-columns");
    expect(preview.schemaTableName).toBe("MyApp_CL");
  });

  it("parses the properties.schema.tableDefinition.columns shape with the missing-type -> string default", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({
        fileText: JSON.stringify({
          properties: {
            schema: {
              tableDefinition: {
                name: "MyApp_CL",
                columns: [{ name: "Payload" }],
              },
            },
          },
        }),
      }),
    );
    expect(preview.errors).toEqual([]);
    expect(preview.variant).toBe("table-definition");
    // Legacy-TS `col.type || 'string'` rule surfaces in the preview.
    expect(preview.rows[0]).toMatchObject({
      name: "Payload",
      declaredType: "string",
      mappedType: "string",
      unknownType: false,
    });
  });

  it("appends an injected TimeGenerated row when the schema lacks one", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({
        fileText: JSON.stringify({
          columns: [{ name: "EventName", type: "string" }],
        }),
      }),
    );
    const last = preview.rows[preview.rows.length - 1];
    expect(last).toEqual({
      name: "TimeGenerated",
      declaredType: "datetime",
      mappedType: "datetime",
      unknownType: false,
      injected: true,
      reserved: false,
    });
    // The injected row is a PREVIEW of normalization, never part of the
    // schema sent to the run (core injects it again during creation).
    expect(preview.columns.map((c) => c.name)).toEqual(["EventName"]);
  });

  it("does not duplicate TimeGenerated when the schema declares it", () => {
    const preview = deriveCustomSchemaPreview(inputs({ fileText: BARE_SCHEMA }));
    expect(
      preview.rows.filter((r) => r.name.toLowerCase() === "timegenerated"),
    ).toHaveLength(1);
    expect(preview.rows.some((r) => r.injected)).toBe(false);
  });

  it("flags Azure-managed reserved columns as removed from creation", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({
        fileText: JSON.stringify({
          columns: [
            { name: "TenantId", type: "string" },
            { name: "_ResourceId", type: "string" },
            { name: "EventName", type: "string" },
          ],
        }),
      }),
    );
    expect(preview.rows.map((r) => [r.name, r.reserved])).toEqual([
      ["TenantId", true],
      ["_ResourceId", true],
      ["EventName", false],
      ["TimeGenerated", false],
    ]);
  });

  it("warns (not errors) about unknown types, which map to string", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({
        fileText: JSON.stringify({
          columns: [{ name: "Weird", type: "footype" }],
        }),
      }),
    );
    expect(preview.errors).toEqual([]);
    expect(preview.ready).toBe(true);
    expect(preview.rows[0]).toMatchObject({
      declaredType: "footype",
      mappedType: "string",
      unknownType: true,
    });
    expect(preview.warnings.join(" ")).toContain("Weird ('footype')");
  });

  it("reports invalid JSON as a blocking error", () => {
    const preview = deriveCustomSchemaPreview(inputs({ fileText: "{nope" }));
    expect(preview.ready).toBe(false);
    expect(preview.providesSchema).toBe(false);
    expect(preview.errors).toHaveLength(1);
    expect(preview.errors[0]).toContain("not valid JSON");
  });

  it("reports a schema file without columns as a blocking error", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({ fileText: JSON.stringify({ columns: [] }) }),
    );
    expect(preview.ready).toBe(false);
    expect(preview.errors[0]).toContain("'columns' array");
  });

  it("surfaces the exact-_CL-suffix validation rule inline", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({ table: "MyApp_cl", fileText: BARE_SCHEMA }),
    );
    expect(preview.ready).toBe(false);
    expect(preview.errors.join(" ")).toContain("must end with '_CL'");
  });

  it("rejects a declared TimeGenerated whose type is not datetime", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({
        fileText: JSON.stringify({
          columns: [{ name: "TimeGenerated", type: "string" }],
        }),
      }),
    );
    expect(preview.ready).toBe(false);
    expect(preview.errors.join(" ")).toContain("TimeGenerated");
  });

  it("warns when the schema targets a different table than typed", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({
        table: "Other_CL",
        source: "vendor",
        vendorId: "crowdstrike-dns-events",
      }),
    );
    expect(preview.ready).toBe(true);
    expect(preview.warnings.join(" ")).toContain("Other_CL");
  });

  it("parses every bundled vendor schema without errors against its own table", () => {
    for (const entry of VENDOR_SCHEMAS) {
      const preview = deriveCustomSchemaPreview(
        inputs({ table: entry.table, source: "vendor", vendorId: entry.id }),
      );
      expect(preview.errors).toEqual([]);
      expect(preview.ready).toBe(true);
      expect(preview.rows.length).toBeGreaterThan(0);
    }
  });
});

describe("deriveCustomSchemaPreview: source precedence", () => {
  it("existing source ignores vendor and file inputs and sends no schema", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({
        source: "existing",
        vendorId: "crowdstrike-dns-events",
        fileText: "{definitely not json",
      }),
    );
    expect(preview.ready).toBe(true);
    expect(preview.providesSchema).toBe(false);
    expect(preview.columns).toEqual([]);
    expect(preview.errors).toEqual([]);
  });

  it("vendor source ignores junk in the file textarea", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({
        table: "CrowdStrike_DNS_Events_CL",
        source: "vendor",
        vendorId: "crowdstrike-dns-events",
        fileText: "{definitely not json",
      }),
    );
    expect(preview.errors).toEqual([]);
    expect(preview.ready).toBe(true);
    expect(preview.providesSchema).toBe(true);
  });

  it("file source ignores the vendor selection", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({
        source: "file",
        vendorId: "crowdstrike-dns-events",
        fileText: BARE_SCHEMA,
      }),
    );
    expect(preview.variant).toBe("bare");
    expect(preview.columns.map((c) => c.name)).toContain("ClientIP");
  });

  it("vendor source without a selection is not-ready guidance, not an error", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({ source: "vendor", vendorId: "" }),
    );
    expect(preview.ready).toBe(false);
    expect(preview.errors).toEqual([]);
    expect(preview.notReadyHint).toContain("vendor schema");
  });

  it("file source without content is not-ready guidance, not an error", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({ source: "file", fileText: "   " }),
    );
    expect(preview.ready).toBe(false);
    expect(preview.errors).toEqual([]);
    expect(preview.notReadyHint).toContain("schema JSON");
  });
});

describe("resolveRetentionDays: default and override", () => {
  it("uses the persisted default when no override is chosen", () => {
    expect(resolveRetentionDays("", 30)).toBe(30);
    expect(resolveRetentionDays("", 90)).toBe(90);
  });

  it("lets the per-run override win over the persisted default", () => {
    expect(resolveRetentionDays("30", 90)).toBe(30);
    expect(resolveRetentionDays("90", 30)).toBe(90);
  });

  it("falls back to the persisted default for junk overrides", () => {
    expect(resolveRetentionDays("60", 30)).toBe(30);
    expect(resolveRetentionDays("banana", 90)).toBe(90);
  });

  it("offers exactly the 30/90 contract choices", () => {
    expect(RETENTION_CHOICES.map((c) => c.value)).toEqual(["30", "90"]);
  });
});

describe("defaultVendorIdForTable", () => {
  it("preselects the vendor entry matching the typed table (case-insensitive)", () => {
    expect(defaultVendorIdForTable("CrowdStrike_DNS_Events_CL")).toBe(
      "crowdstrike-dns-events",
    );
    expect(defaultVendorIdForTable("  crowdstrike_dns_events_cl  ")).toBe(
      "crowdstrike-dns-events",
    );
  });

  it("returns '' when no bundled schema targets the table", () => {
    expect(defaultVendorIdForTable("MyApp_CL")).toBe("");
    expect(defaultVendorIdForTable("")).toBe("");
  });
});

describe("formatSchemaPreview", () => {
  it("renders an aligned header plus one line per row with notes", () => {
    const preview = deriveCustomSchemaPreview(
      inputs({
        fileText: JSON.stringify({
          columns: [
            { name: "TenantId", type: "string" },
            { name: "Weird", type: "footype" },
          ],
        }),
      }),
    );
    const text = formatSchemaPreview(preview.rows);
    const lines = text.split("\n");
    expect(lines[0]).toContain("Column");
    expect(lines[0]).toContain("Creates as");
    expect(lines).toHaveLength(1 + preview.rows.length);
    expect(text).toContain("removed from the creation payload");
    expect(text).toContain("unknown type - defaults to string");
    expect(text).toContain("injected automatically");
    // All rows align: the mapped type starts at the same column everywhere.
    const nameWidth = Math.max(...preview.rows.map((r) => r.name.length), 6);
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(nameWidth);
    }
  });
});

describe("CUSTOM_SCHEMA_SOURCE_OPTIONS", () => {
  it("offers the three sources with vendor first", () => {
    expect(CUSTOM_SCHEMA_SOURCE_OPTIONS.map((o) => o.value)).toEqual([
      "vendor",
      "file",
      "existing",
    ]);
  });
});
