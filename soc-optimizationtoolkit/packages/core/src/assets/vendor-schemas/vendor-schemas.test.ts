/**
 * Bundled vendor schema library - porting-plan Unit 5 (ENG-34). Every
 * bundled file must survive the SAME parse/validate path a user-uploaded
 * schema file takes, and the registry must stay internally consistent.
 */
import { describe, expect, it } from "vitest";
import { findVendorSchema, VENDOR_SCHEMAS } from "./index";
import {
  parseTableSchemaFile,
  validateCustomTableSchema,
} from "../../domain/custom-table";

describe("VENDOR_SCHEMAS registry", () => {
  it("bundles the CrowdStrike and Cloudflare schema library (12 entries, unique ids)", () => {
    expect(VENDOR_SCHEMAS).toHaveLength(12);
    const ids = VENDOR_SCHEMAS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("cloudflare");
    expect(ids).toContain("cloudflare-v2");
    expect(ids.filter((id) => id.startsWith("crowdstrike-"))).toHaveLength(10);
  });

  it("every entry parses through parseTableSchemaFile as a bare-shape file", () => {
    for (const entry of VENDOR_SCHEMAS) {
      const parsed = parseTableSchemaFile(entry.raw);
      expect(parsed.variant).toBe("bare");
      expect(parsed.columns.length).toBeGreaterThan(0);
      // The legacy files pin the 30/90 retention contract in-file.
      expect(parsed.retentionInDays).toBe(30);
      expect(parsed.totalRetentionInDays).toBe(90);
      // Files that carry a name agree with the registry's table.
      if (parsed.tableName !== null) {
        expect(parsed.tableName).toBe(entry.table);
      }
    }
  });

  it("every entry validates against its registry table name", () => {
    for (const entry of VENDOR_SCHEMAS) {
      expect(entry.table.endsWith("_CL")).toBe(true);
      const parsed = parseTableSchemaFile(entry.raw);
      const validation = validateCustomTableSchema(entry.table, parsed.columns);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
    }
  });

  it("TimeGenerated, where declared, is datetime; only cloudflare-v2 relies on injection", () => {
    const missing: string[] = [];
    for (const entry of VENDOR_SCHEMAS) {
      const parsed = parseTableSchemaFile(entry.raw);
      const timeGenerated = parsed.columns.find(
        (column) => column.name === "TimeGenerated",
      );
      if (timeGenerated === undefined) {
        // Valid: normalizeCustomSchemaColumns injects {TimeGenerated,
        // datetime} at creation (the PS loader rule) - pinned per entry so
        // a new schema missing TimeGenerated is a conscious decision.
        missing.push(entry.id);
      } else {
        expect(timeGenerated.type).toBe("datetime");
      }
    }
    expect(missing).toEqual(["cloudflare-v2"]);
  });

  it("findVendorSchema looks entries up by id", () => {
    expect(findVendorSchema("crowdstrike-dns-events")?.table).toBe(
      "CrowdStrike_DNS_Events_CL",
    );
    expect(findVendorSchema("cloudflare")?.label).toContain("Cloudflare");
    expect(findVendorSchema("nope")).toBeUndefined();
  });
});
