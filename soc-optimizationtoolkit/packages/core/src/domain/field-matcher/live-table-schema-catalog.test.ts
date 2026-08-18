/**
 * Pins for the live-table catalog tier.
 *
 * Two decisions are under test. REPLACEMENT, not merging (user 2026-08-10) -
 * the failure it guards is quiet, since a tier that fell back for a picked
 * table would analyse against the derived schema while the UI reports the live
 * one. And PER LOG TYPE (user 2026-08-18): a solution's log types can land in
 * different tables, each its own DCR, so the tier holds a map rather than one
 * override.
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
    const catalog = createLiveTableSchemaCatalog({ SecurityEvent: LIVE }, fallback);
    const resolved = await catalog.resolveSchema("SecurityEvent");
    expect(resolved).toEqual([{ name: "LiveOnly", type: "string" }]);
    expect(resolved?.some((c) => c.name === "DerivedOnly")).toBe(false);
  });

  it("matches the table name case-insensitively", async () => {
    // ARM says SecurityEvent, a solution may say securityevent; the operator
    // picked one table either way.
    const catalog = createLiveTableSchemaCatalog({ securityevent: LIVE }, fallback);
    expect(await catalog.resolveSchema("SecurityEvent")).toEqual(LIVE);
  });

  it("leaves every OTHER table to the fallback", async () => {
    // Picking one table says nothing about the others, and the derived path is
    // still correct for tables that do not exist until a connector is enabled.
    const catalog = createLiveTableSchemaCatalog({ App_CL: LIVE }, fallback);
    expect(await catalog.resolveSchema("SecurityEvent")).toEqual(DERIVED);
    expect(await catalog.resolveSchema("Unknown_CL")).toBeNull();
  });

  it("treats an EMPTY live schema as an override, not a miss", async () => {
    // A provisioned-but-unmaterialized table really has no columns. Falling
    // back here would analyse against the derived schema while the UI claims
    // the live table is in use.
    const catalog = createLiveTableSchemaCatalog({ SecurityEvent: [] }, fallback);
    expect(await catalog.resolveSchema("SecurityEvent")).toEqual([]);
  });

  it("does not let a blank table name swallow every lookup", async () => {
    // Guard against "" matching a trimmed empty name and overriding the world.
    const catalog = createLiveTableSchemaCatalog({ "  ": LIVE }, fallback);
    expect(await catalog.resolveSchema("SecurityEvent")).toEqual(DERIVED);
  });

  it("cannot be mutated through the value it returns", async () => {
    const catalog = createLiveTableSchemaCatalog({ SecurityEvent: LIVE }, fallback);
    const first = await catalog.resolveSchema("SecurityEvent");
    first?.push({ name: "Injected", type: "string" });
    expect(await catalog.resolveSchema("SecurityEvent")).toEqual(LIVE);
  });
});

/**
 * The per-log-type requirement (user 2026-08-18): a CrowdStrike-shaped solution
 * spreads its log types across several tables, each its own DCR and schema.
 */
describe("createLiveTableSchemaCatalog - several tables at once", () => {
  it("gives each picked table its OWN live schema", async () => {
    // The shape a single-table override could not express: two log types,
    // two destinations, two schemas, in one analysis.
    const fdr: DcrSchemaColumn[] = [{ name: "FdrOnly", type: "string" }];
    const alerts: DcrSchemaColumn[] = [{ name: "AlertOnly", type: "string" }];
    const catalog = createLiveTableSchemaCatalog(
      { CrowdStrikeFalconEventStream_CL: fdr, CrowdStrikeAlerts_CL: alerts },
      fallback,
    );
    expect(await catalog.resolveSchema("CrowdStrikeFalconEventStream_CL")).toEqual(fdr);
    expect(await catalog.resolveSchema("CrowdStrikeAlerts_CL")).toEqual(alerts);
    // And a table nobody pointed at is still the fallback's business.
    expect(await catalog.resolveSchema("SecurityEvent")).toEqual(DERIVED);
  });

  it("keeps the tables independent - one empty override does not affect another", async () => {
    const alerts: DcrSchemaColumn[] = [{ name: "AlertOnly", type: "string" }];
    const catalog = createLiveTableSchemaCatalog(
      { Unmaterialized_CL: [], CrowdStrikeAlerts_CL: alerts },
      fallback,
    );
    expect(await catalog.resolveSchema("Unmaterialized_CL")).toEqual([]);
    expect(await catalog.resolveSchema("CrowdStrikeAlerts_CL")).toEqual(alerts);
  });
});
