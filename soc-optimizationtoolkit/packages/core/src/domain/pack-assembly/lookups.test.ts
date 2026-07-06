import { describe, expect, it } from "vitest";

import type { MatchResult } from "../field-matcher";
import {
  escapeCsvCell,
  generateLookupsYml,
  LOOKUP_CSV_HEADER,
  lookupFileName,
  lookupRowsFromMatch,
  lookupRowsFromOverrides,
  renderLookupCsv,
} from "./lookups";

describe("escapeCsvCell", () => {
  it("quotes and doubles quotes only when needed", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell("has,comma")).toBe('"has,comma"');
    expect(escapeCsvCell('has"quote')).toBe('"has""quote"');
    expect(escapeCsvCell(undefined)).toBe("");
  });
});

describe("lookupRowsFromMatch", () => {
  const match: MatchResult = {
    matched: [
      {
        sourceName: "src",
        sourceType: "string",
        destName: "SourceIP",
        destType: "string",
        confidence: "alias",
        action: "rename",
        needsCoercion: false,
        description: "aliased",
      },
    ],
    overflow: [
      {
        sourceName: "weird",
        sourceType: "string",
        destName: "",
        destType: "string",
        confidence: "unmatched",
        action: "overflow",
        needsCoercion: false,
        description: "",
      },
    ],
    unmatchedSource: [],
    unmatchedDest: [],
    overflowConfig: { enabled: true, fieldName: "AdditionalExtensions", fieldType: "string", sourceFields: ["weird"] },
    totalSource: 2,
    totalDest: 1,
    matchRate: 1,
    warnings: [],
  };

  it("produces 8-column matched + overflow rows", () => {
    const rows = lookupRowsFromMatch(match);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(["src", "string", "SourceIP", "string", "alias", "rename", "false", "aliased"]);
    expect(rows[1]).toEqual(["weird", "string", "", "string", "unmatched", "overflow", "false", "Collected into overflow field"]);
  });

  it("renders a CSV with the fixed header", () => {
    const csv = renderLookupCsv(lookupRowsFromMatch(match))!;
    expect(csv.split("\n")[0]).toBe(LOOKUP_CSV_HEADER);
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("returns null for no rows", () => {
    expect(renderLookupCsv([])).toBeNull();
  });
});

describe("lookupRowsFromOverrides", () => {
  it("maps override fields into the 8-column shape", () => {
    const rows = lookupRowsFromOverrides([
      {
        source: "s",
        dest: "d",
        sourceType: "string",
        destType: "int",
        confidence: "manual",
        action: "coerce",
        needsCoercion: true,
        description: "user",
      },
    ]);
    expect(rows[0]).toEqual(["s", "string", "d", "int", "manual", "coerce", "true", "user"]);
  });
});

describe("generateLookupsYml", () => {
  it("emits a registry entry per CSV, or null when empty", () => {
    expect(generateLookupsYml([])).toBeNull();
    const yml = generateLookupsYml(["TRAFFIC_field_mapping.csv"])!;
    expect(yml).toContain("TRAFFIC_field_mapping:");
    expect(yml).toContain("  filename: TRAFFIC_field_mapping.csv");
    expect(yml).toContain('  description: "Field mapping lookup for TRAFFIC"');
  });

  it("names lookup files by suffix", () => {
    expect(lookupFileName("TRAFFIC")).toBe("TRAFFIC_field_mapping.csv");
  });
});
