/**
 * Pins for deriveCustomTableSchema (user use case 2026-07-14): the derived
 * schema for a custom _CL destination that resolves nowhere - sample fields
 * become columns under the Unit 11 inference types, content-referenced
 * columns lead under their canonical casing, Azure-refused names are
 * excluded and reported, and TimeGenerated is guaranteed exactly once at
 * the end (mirroring normalizeCustomSchemaColumns).
 */

import { describe, expect, it } from "vitest";
import { parseSampleContent } from "../sample-parsing/index";
import { deriveCustomTableSchema } from "./derive-schema-from-sample";

function sampleOf(record: Record<string, unknown>) {
  return parseSampleContent(JSON.stringify(record), { sourceName: "test" });
}

describe("deriveCustomTableSchema", () => {
  it("projects sample fields with their inferred DCR types and appends TimeGenerated", () => {
    const derived = deriveCustomTableSchema(
      sampleOf({
        ClientIP: "1.2.3.4",
        EdgeResponseStatus: 403,
        BotScore: 12.5,
        IsBot: true,
      }),
    );
    expect(derived.columns).toEqual([
      { name: "ClientIP", type: "string" },
      { name: "EdgeResponseStatus", type: "int" },
      { name: "BotScore", type: "real" },
      { name: "IsBot", type: "boolean" },
      { name: "TimeGenerated", type: "datetime" },
    ]);
    expect(derived.excludedFields).toEqual([]);
    expect(derived.summary).toContain("CREATE the custom table");
  });

  it("adopts the content's canonical casing for case-insensitive sample matches", () => {
    const derived = deriveCustomTableSchema(sampleOf({ clientip: "1.2.3.4" }), [
      "ClientIP",
    ]);
    // The content-referenced column leads, canonical casing, sample-typed.
    expect(derived.columns[0]).toEqual({ name: "ClientIP", type: "string" });
    // The sample field does NOT also become its own column.
    expect(
      derived.columns.filter((c) => c.name.toLowerCase() === "clientip"),
    ).toHaveLength(1);
    expect(derived.contentColumns).toEqual(["ClientIP"]);
  });

  it("creates content-referenced columns no sample field backs (typed string)", () => {
    const derived = deriveCustomTableSchema(sampleOf({ foo: "bar" }), [
      "SrcIP",
    ]);
    expect(derived.columns).toContainEqual({ name: "SrcIP", type: "string" });
    expect(
      derived.notes.some((n) => n.includes("SrcIP") && n.includes("no matching sample")),
    ).toBe(true);
  });

  it("excludes Azure-reserved and invalid column names, and reports them", () => {
    const derived = deriveCustomTableSchema(
      sampleOf({ Type: "http", "Weird-Name": "x", ok_field: "y" }),
    );
    const names = derived.columns.map((c) => c.name);
    expect(names).toEqual(["ok_field", "TimeGenerated"]);
    expect(derived.excludedFields).toEqual(["Type", "Weird-Name"]);
    expect(derived.notes.some((n) => n.includes("Azure-reserved"))).toBe(true);
    expect(derived.notes.some((n) => n.includes("invalid column name"))).toBe(true);
  });

  it("keeps exactly one TimeGenerated (datetime) even when the sample carries one", () => {
    const derived = deriveCustomTableSchema(
      sampleOf({ TimeGenerated: "2024-01-01T00:00:00Z", foo: "bar" }),
      ["timegenerated"],
    );
    const tg = derived.columns.filter(
      (c) => c.name.toLowerCase() === "timegenerated",
    );
    expect(tg).toEqual([{ name: "TimeGenerated", type: "datetime" }]);
    expect(derived.columns[derived.columns.length - 1].name).toBe(
      "TimeGenerated",
    );
  });

  it("skips content names Azure would refuse and dedupes repeated references", () => {
    const derived = deriveCustomTableSchema(sampleOf({ foo: "bar" }), [
      "SourceSystem",
      "Bad Name",
      "GoodColumn",
      "goodcolumn",
    ]);
    const names = derived.columns.map((c) => c.name);
    expect(names).toEqual(["GoodColumn", "foo", "TimeGenerated"]);
    expect(derived.contentColumns).toEqual(["GoodColumn"]);
  });
});
