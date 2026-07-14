/**
 * Pins for the KQL-validation schema tier (user direction 2026-07-14): the
 * Azure-Sentinel repo's CI-validated table schemas
 * (.script/tests/KqlvalidationsTests/CustomTables) resolve FIRST when a
 * table is defined there. Fixture shape mirrors the live Cloudflare_CL.json
 * (verified 2026-07-14: {Name, Properties[{Name,Type}]}, Pascal-ish types
 * with casing drift - Datetime AND DateTime in one file).
 */

import { describe, expect, it } from "vitest";
import { FakeSentinelContent } from "../../testing/index";
import type { SchemaCatalog } from "../../ports/schema-catalog";
import {
  KQL_VALIDATION_TABLES_DIR,
  createKqlValidationSchemaCatalog,
  mapValidationColumnType,
  parseKqlValidationTable,
} from "./kql-validation-schema-catalog";

const CLOUDFLARE_FIXTURE = JSON.stringify({
  Name: "Cloudflare_CL",
  Properties: [
    { Name: "TimeGenerated", Type: "Datetime" },
    { Name: "BotScore_d", Type: "Double" },
    { Name: "BotScoreSrc_s", Type: "String" },
    { Name: "EdgeStartTimestamp_t", Type: "DateTime" },
    { Name: "CacheTieredFill_b", Type: "Bool" },
    { Name: "TenantId", Type: "String" },
    { Name: "Type", Type: "String" },
  ],
});

const BASE_MISS: SchemaCatalog = { resolveSchema: async () => null };

function baseWith(columns: Array<{ name: string; type: string }>): SchemaCatalog {
  return { resolveSchema: async () => columns };
}

describe("parseKqlValidationTable / mapValidationColumnType", () => {
  it("maps the Pascal-ish validation types (casing drift included) to the DCR vocabulary", () => {
    expect(mapValidationColumnType("Datetime")).toBe("datetime");
    expect(mapValidationColumnType("DateTime")).toBe("datetime");
    expect(mapValidationColumnType("Double")).toBe("real");
    expect(mapValidationColumnType("Bool")).toBe("boolean");
    expect(mapValidationColumnType("Dynamic")).toBe("dynamic");
    expect(mapValidationColumnType("Guid")).toBe("string");
    expect(mapValidationColumnType("SomethingNew")).toBe("string");
  });

  it("parses the file shape, keeps TimeGenerated, filters system columns", () => {
    const columns = parseKqlValidationTable(CLOUDFLARE_FIXTURE);
    expect(columns).toEqual([
      { name: "TimeGenerated", type: "datetime" },
      { name: "BotScore_d", type: "real" },
      { name: "BotScoreSrc_s", type: "string" },
      { name: "EdgeStartTimestamp_t", type: "datetime" },
      { name: "CacheTieredFill_b", type: "boolean" },
    ]);
  });

  it("reads junk and foreign shapes as null", () => {
    expect(parseKqlValidationTable("not json")).toBeNull();
    expect(parseKqlValidationTable('{"columns": []}')).toBeNull();
    expect(parseKqlValidationTable('{"Name":"X","Properties":[]}')).toBeNull();
  });
});

describe("createKqlValidationSchemaCatalog", () => {
  const content = new FakeSentinelContent({
    files: {
      [`${KQL_VALIDATION_TABLES_DIR}/Cloudflare_CL.json`]: CLOUDFLARE_FIXTURE,
    },
  });

  it("resolves a defined table from the validation dir, AHEAD of the base", async () => {
    const base = baseWith([{ name: "FromBase", type: "string" }]);
    const catalog = createKqlValidationSchemaCatalog(content, base);
    const columns = await catalog.resolveSchema("Cloudflare_CL");
    expect(columns?.map((c) => c.name)).toContain("BotScore_d");
    expect(columns?.map((c) => c.name)).not.toContain("FromBase");
  });

  it("falls through to the base for tables the dir does not define", async () => {
    const base = baseWith([{ name: "CommonSecurityLog_Col", type: "string" }]);
    const catalog = createKqlValidationSchemaCatalog(content, base);
    const columns = await catalog.resolveSchema("CommonSecurityLog");
    expect(columns?.map((c) => c.name)).toEqual(["CommonSecurityLog_Col"]);
  });

  it("matches case-insensitively via the directory listing fallback", async () => {
    const catalog = createKqlValidationSchemaCatalog(content, BASE_MISS);
    const columns = await catalog.resolveSchema("CLOUDFLARE_cl");
    expect(columns?.map((c) => c.name)).toContain("BotScore_d");
  });

  it("returns fresh column copies per resolve (cache is never aliased)", async () => {
    const catalog = createKqlValidationSchemaCatalog(content, BASE_MISS);
    const first = await catalog.resolveSchema("Cloudflare_CL");
    first![0].name = "MUTATED";
    const second = await catalog.resolveSchema("Cloudflare_CL");
    expect(second?.[0].name).toBe("TimeGenerated");
  });
});
