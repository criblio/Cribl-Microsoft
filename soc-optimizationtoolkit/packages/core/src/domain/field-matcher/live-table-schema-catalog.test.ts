/**
 * Pins for the live-table catalog tier.
 *
 * The decision under test is REPLACEMENT, not merging (user 2026-08-10), and
 * the failure it guards is quiet: a tier that fell back for the picked table
 * would analyse against the derived schema while the UI reports the live one,
 * and every mapping verdict would be about a table that does not exist.
 */

import { describe, expect, it } from "vitest";
import { createLiveTableSchemaCatalog } from "./live-table-schema-catalog";
import type { DcrSchemaColumn, SchemaCatalog } from "../../ports/schema-catalog";

const DERIVED: DcrSchemaColumn[] = [
  { name: "DerivedOnly", type: "string" },
  { name: "TimeGenerated", type: "datetime" },
];
const LIVE: DcrSchemaColumn[] = [{ name: "LiveOnly", type: "string" }];

const fallback: SchemaCatalog = {
  resolveSchema: async (name) =>
    name.toLowerCase() === "securityevent" ? [...DERIVED] : null,
};

describe("createLiveTableSchemaCatalog", () => {
  it("REPLACES the derived schema for the picked table", async () => {
    // Not a merge: nothing derived survives for this table.
    const catalog = createLiveTableSchemaCatalog("SecurityEvent", LIVE, fallback);
    const resolved = await catalog.resolveSchema("SecurityEvent");
    expect(resolved).toEqual([{ name: "LiveOnly", type: "string" }]);
    expect(resolved?.some((c) => c.name === "DerivedOnly")).toBe(false);
  });

  it("matches the table name case-insensitively", async () => {
    // ARM says SecurityEvent, a solution may say securityevent; the operator
    // picked one table either way.
    const catalog = createLiveTableSchemaCatalog("securityevent", LIVE, fallback);
    expect(await catalog.resolveSchema("SecurityEvent")).toEqual(LIVE);
  });

  it("leaves every OTHER table to the fallback", async () => {
    // Picking one table says nothing about the others, and the derived path is
    // still correct for tables that do not exist until a connector is enabled.
    const catalog = createLiveTableSchemaCatalog("App_CL", LIVE, fallback);
    expect(await catalog.resolveSchema("SecurityEvent")).toEqual(DERIVED);
    expect(await catalog.resolveSchema("Unknown_CL")).toBeNull();
  });

  it("treats an EMPTY live schema as an override, not a miss", async () => {
    // A provisioned-but-unmaterialized table really has no columns. Falling
    // back here would analyse against the derived schema while the UI claims
    // the live table is in use.
    const catalog = createLiveTableSchemaCatalog("SecurityEvent", [], fallback);
    expect(await catalog.resolveSchema("SecurityEvent")).toEqual([]);
  });

  it("does not let a blank table name swallow every lookup", async () => {
    // Guard against "" matching a trimmed empty name and overriding the world.
    const catalog = createLiveTableSchemaCatalog("  ", LIVE, fallback);
    expect(await catalog.resolveSchema("SecurityEvent")).toEqual(DERIVED);
  });

  it("cannot be mutated through the value it returns", async () => {
    const catalog = createLiveTableSchemaCatalog("SecurityEvent", LIVE, fallback);
    const first = await catalog.resolveSchema("SecurityEvent");
    first?.push({ name: "Injected", type: "string" });
    expect(await catalog.resolveSchema("SecurityEvent")).toEqual(LIVE);
  });
});
