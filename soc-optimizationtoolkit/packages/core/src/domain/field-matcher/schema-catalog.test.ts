/**
 * SchemaCatalog resolution tests - porting-plan Unit 13, deliverable (a).
 *
 * Pins the bundled adapter: catalog size, "Microsoft-" normalization both
 * directions, the verbatim SYSTEM_COLUMNS filter (and its set-equality with
 * schema-mapping's NATIVE_SYSTEM_COLUMNS so the two contracts cannot drift),
 * unresolved -> null, and unresolved -> all-unmatched (never throws).
 */

import { describe, expect, it } from "vitest";

import { NATIVE_SYSTEM_COLUMNS } from "../schema-mapping/index";
import type { ParsedSample } from "../sample-parsing/models";
import {
  DCR_SCHEMA_SYSTEM_COLUMNS,
  bundledCatalogTableNames,
  createBundledSchemaCatalog,
  matchSampleToTable,
  normalizeTableNames,
  resolveSchemaFromCatalog,
} from "./index";

describe("bundled catalog contents", () => {
  it("holds all 50 native + 13 custom schemas (63 entries)", () => {
    expect(bundledCatalogTableNames().length).toBe(63);
  });

  it("includes representative native and custom tables", () => {
    const names = new Set(bundledCatalogTableNames());
    expect(names.has("CommonSecurityLog")).toBe(true);
    expect(names.has("Syslog")).toBe(true);
    expect(names.has("CrowdStrike_DNS_Events_CL")).toBe(true);
    expect(names.has("CloudFlare_CL")).toBe(true);
    expect(names.has("MyCustomApp_CL")).toBe(true);
  });
});

describe("Microsoft- name normalization (both directions)", () => {
  it("adds the prefix when absent", () => {
    expect(normalizeTableNames("CommonSecurityLog")).toEqual([
      "CommonSecurityLog",
      "Microsoft-CommonSecurityLog",
    ]);
  });

  it("strips the prefix when present", () => {
    expect(normalizeTableNames("Microsoft-CommonSecurityLog")).toEqual([
      "Microsoft-CommonSecurityLog",
      "CommonSecurityLog",
    ]);
  });

  it("resolves the prefixed and bare forms to the same columns", () => {
    const bare = resolveSchemaFromCatalog("CommonSecurityLog");
    const prefixed = resolveSchemaFromCatalog("Microsoft-CommonSecurityLog");
    expect(prefixed).not.toBeNull();
    expect(prefixed).toEqual(bare);
  });
});

describe("system-column filter (verbatim from pack-builder, deduplicated)", () => {
  it("is exactly 18 names", () => {
    expect(DCR_SCHEMA_SYSTEM_COLUMNS.length).toBe(18);
  });

  it("equals schema-mapping NATIVE_SYSTEM_COLUMNS as a set (no drift)", () => {
    const a = new Set(DCR_SCHEMA_SYSTEM_COLUMNS);
    const b = new Set(NATIVE_SYSTEM_COLUMNS);
    expect(a.size).toBe(b.size);
    for (const name of b) expect(a.has(name)).toBe(true);
    for (const name of a) expect(b.has(name)).toBe(true);
  });

  it("strips SourceSystem (and any system column) from CommonSecurityLog", () => {
    const columns = resolveSchemaFromCatalog("CommonSecurityLog");
    expect(columns).not.toBeNull();
    const names = new Set(columns!.map((c) => c.name));
    expect(names.has("SourceSystem")).toBe(false);
    expect(names.has("TenantId")).toBe(false);
    expect(columns!.length).toBeGreaterThan(100);
  });

  it("leaves no system column in ANY resolved schema", () => {
    const filter = new Set(DCR_SCHEMA_SYSTEM_COLUMNS);
    for (const table of bundledCatalogTableNames()) {
      const columns = resolveSchemaFromCatalog(table);
      expect(columns).not.toBeNull();
      for (const col of columns!) {
        expect(filter.has(col.name)).toBe(false);
      }
    }
  });
});

describe("unresolved resolution", () => {
  it("returns null for an unknown table (never throws)", () => {
    expect(resolveSchemaFromCatalog("DefinitelyNotATable_ZZZ")).toBeNull();
  });

  it("async resolveSchema returns null for an unknown table", async () => {
    const catalog = createBundledSchemaCatalog();
    await expect(catalog.resolveSchema("DefinitelyNotATable_ZZZ")).resolves.toBeNull();
  });

  it("flows an unresolved schema to an all-unmatched MatchResult", async () => {
    const catalog = createBundledSchemaCatalog();
    const sample: ParsedSample = {
      format: "json",
      records: [{ a: "x", b: "y" }],
      eventCount: 1,
      fields: [
        {
          name: "a",
          type: "string",
          types: ["string"],
          examples: ["x"],
          occurrence: 1,
          required: true,
        },
        {
          name: "b",
          type: "string",
          types: ["string"],
          examples: ["y"],
          occurrence: 1,
          required: true,
        },
      ],
      rawEvents: ['{"a":"x","b":"y"}'],
      sourceName: "test",
      errors: [],
    };

    const result = await matchSampleToTable(sample, catalog, "Unknown_ZZZ_CL");
    expect(result.matched).toHaveLength(0);
    expect(result.overflow).toHaveLength(0);
    expect(result.unmatchedSource).toHaveLength(2);
    expect(result.totalDest).toBe(0);
    expect(result.matchRate).toBe(0);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("Unknown_ZZZ_CL");
  });
});
