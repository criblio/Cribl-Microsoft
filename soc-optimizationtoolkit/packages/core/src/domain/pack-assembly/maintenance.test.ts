/**
 * Pins for pack maintenance (user request 2026-07-13): reconstruct a built
 * pack's mapping table from its stored definition, apply edits, and produce
 * the next build definition with the overflow serialize list resynced.
 */

import { describe, expect, it } from "vitest";
import { buildPipelinePlan } from "../pipeline-generation";
import { applyMaintenanceEdits, maintenanceRows } from "./maintenance";
import type { PackScaffoldInput } from "./scaffold";

function definition(): PackScaffoldInput {
  const plan = buildPipelinePlan({
    solutionName: "Zscaler Internet",
    packName: "MS-Sentinel",
    tables: [
      {
        sentinelTable: "CommonSecurityLog",
        logType: "web-BLOCKED",
        sourceFormat: "cef",
        passthroughFields: [
          { name: "urlcategory", type: "string" },
          { name: "clientip", type: "string" },
        ],
      },
    ],
  });
  // Hand the plan a mixed field set: one rename, one overflow.
  plan.tables[0].fields = [
    {
      source: "clientip",
      target: "SourceIP",
      action: "rename",
      sourceType: "string",
      targetType: "string",
    },
    {
      source: "urlcategory",
      target: "AdditionalExtensions",
      action: "overflow",
      sourceType: "string",
      targetType: "string",
    },
  ] as unknown as typeof plan.tables[0]["fields"];
  plan.tables[0].overflowConfig = {
    ...plan.tables[0].overflowConfig,
    enabled: true,
    sourceFields: ["urlcategory"],
  };
  return { plan, builtAtMs: 1000 };
}

describe("maintenanceRows", () => {
  it("reconstructs the mapping table from the stored definition", () => {
    const rows = maintenanceRows(definition());
    expect(rows).toEqual([
      {
        logType: "web-BLOCKED",
        sentinelTable: "CommonSecurityLog",
        source: "clientip",
        target: "SourceIP",
        action: "rename",
      },
      {
        logType: "web-BLOCKED",
        sentinelTable: "CommonSecurityLog",
        source: "urlcategory",
        target: "AdditionalExtensions",
        action: "overflow",
      },
    ]);
  });
});

describe("applyMaintenanceEdits", () => {
  it("applies action/target edits, resyncs overflow sources, stamps version", () => {
    const next = applyMaintenanceEdits(
      definition(),
      [
        // Promote the overflow field to a real column...
        { logType: "web-BLOCKED", source: "urlcategory", action: "rename", target: "DeviceEventCategory" },
        // ...and drop the previously-renamed one.
        { logType: "web-BLOCKED", source: "clientip", action: "drop" },
      ],
      { version: "1.0.4", builtAtMs: 2000 },
    );
    const table = next.plan.tables[0];
    expect(table.fields.find((f) => f.source === "urlcategory")).toMatchObject({
      action: "rename",
      target: "DeviceEventCategory",
    });
    expect(table.fields.find((f) => f.source === "clientip")?.action).toBe("drop");
    // The serialize list follows the edited actions.
    expect(table.overflowConfig.sourceFields).toEqual([]);
    expect(next.plan.version).toBe("1.0.4");
    expect(next.builtAtMs).toBe(2000);
  });

  it("leaves untouched rows, tables, and the original definition intact", () => {
    const original = definition();
    const next = applyMaintenanceEdits(
      original,
      [{ logType: "web-BLOCKED", source: "clientip", target: "SourceAddress" }],
      { version: "1.0.1", builtAtMs: 2000 },
    );
    // Edited copy: target changed, action kept.
    expect(next.plan.tables[0].fields[0]).toMatchObject({
      action: "rename",
      target: "SourceAddress",
    });
    // Untouched row unchanged; overflow list still carries it.
    expect(next.plan.tables[0].fields[1].action).toBe("overflow");
    expect(next.plan.tables[0].overflowConfig.sourceFields).toEqual(["urlcategory"]);
    // The ORIGINAL definition is never mutated (records stay rebuildable).
    expect(original.plan.version).toBe("1.0.0");
    expect(original.plan.tables[0].fields[0].target).toBe("SourceIP");
  });
});
