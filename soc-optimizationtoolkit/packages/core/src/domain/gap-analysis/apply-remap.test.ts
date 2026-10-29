/**
 * applyRemap - GEN-19. Every row the reviewer re-points derives its action,
 * destType, coercion flag and confidence from the chosen column. The rows are
 * the PAN-OS UAT's (2026-10-29): PanSrcMac and `in` both sat in
 * AdditionalExtensions as overflow, and re-pointing PanSrcMac at
 * SourceMACAddress used to leave `action: overflow`, so the pack still
 * serialized it into the catch-all.
 */

import { describe, it, expect } from "vitest";
import { applyRemap, landsInColumn } from "./apply-remap";
import type { GapFieldMapping } from "./gap-report";
import type { FieldRef } from "./models";

const SCHEMA: FieldRef[] = [
  { name: "AdditionalExtensions", type: "string" },
  { name: "ReceivedBytes", type: "long" },
  { name: "SourceMACAddress", type: "string" },
  { name: "DestinationMACAddress", type: "string" },
  { name: "DeviceAction", type: "string" },
  { name: "act", type: "string" },
  { name: "cnt", type: "long" },
];

function row(over: Partial<GapFieldMapping>): GapFieldMapping {
  return {
    source: "x",
    dest: "AdditionalExtensions",
    sourceType: "string",
    destType: "string",
    confidence: "unmatched",
    action: "overflow",
    needsCoercion: false,
    description: "Collected into overflow field",
    ...over,
  };
}

const panSrcMac = row({ source: "PanSrcMac" });
const panDstMac = row({ source: "PanDstMac" });
const inBytes = row({ source: "in", sourceType: "int" });
const act = row({
  source: "act",
  dest: "DeviceAction",
  confidence: "alias",
  action: "rename",
  description: "alias act->DeviceAction",
});
const ROWS: GapFieldMapping[] = [panSrcMac, panDstMac, inBytes, act];

const remap = (sourceField: string, destColumn: string, rows = ROWS) =>
  applyRemap(rows, {
    sourceField,
    destColumn,
    destSchema: SCHEMA,
    catchAllColumn: "AdditionalExtensions",
    baseline: ROWS,
  });

describe("applyRemap - the row follows its column", () => {
  it("turns an overflow row pointed at a column into a rename with the column's type", () => {
    const result = remap("PanSrcMac", "SourceMACAddress");
    expect(result.outcome).toBe("applied");
    expect(result.rows[0]).toEqual({
      source: "PanSrcMac",
      dest: "SourceMACAddress",
      sourceType: "string",
      destType: "string",
      confidence: "reviewer",
      action: "rename",
      needsCoercion: false,
      description: "Reviewer choice: PanSrcMac -> SourceMACAddress",
    });
    // Only the edited row changes.
    expect(result.rows.slice(1)).toEqual([panDstMac, inBytes, act]);
    expect(result.displaced).toBeNull();
    expect(result.claimedBy).toBeNull();
  });

  it("flags a rename across types for coercion (in int -> ReceivedBytes long)", () => {
    const next = remap("in", "ReceivedBytes").rows[2];
    expect(next.action).toBe("rename");
    expect(next.destType).toBe("long");
    expect(next.needsCoercion).toBe(true);
  });

  it("gives keep when the source already carries the column's name", () => {
    const rows = [row({ source: "act" })];
    const next = remap("act", "act", rows).rows[0];
    expect(next.action).toBe("keep");
    expect(next.needsCoercion).toBe(false);
  });

  it("gives coerce for a same-named column whose type differs, as the matcher does", () => {
    const rows = [row({ source: "cnt", sourceType: "string" })];
    const next = remap("cnt", "cnt", rows).rows[0];
    expect(next.action).toBe("coerce");
    expect(next.destType).toBe("long");
    expect(next.needsCoercion).toBe(true);
  });

  it("keeps a decode row a decode - its source is encoded", () => {
    const rows = [
      row({ source: "b64mac", dest: "DestinationMACAddress", action: "decode", confidence: "exact" }),
    ];
    const next = remap("b64mac", "SourceMACAddress", rows).rows[0];
    expect(next.action).toBe("decode");
    expect(next.dest).toBe("SourceMACAddress");
    expect(next.needsCoercion).toBe(false);
    expect(next.confidence).toBe("reviewer");
  });

  it("makes a row pointed at the catch-all an overflow row", () => {
    const result = remap("act", "AdditionalExtensions");
    expect(result.rows[3]).toEqual({
      ...act,
      dest: "AdditionalExtensions",
      destType: "string",
      confidence: "unmatched",
      action: "overflow",
      needsCoercion: false,
      description: "Reviewer choice: collected into AdditionalExtensions",
    });
    // The catch-all takes any number of fields, so it is never "claimed".
    expect(result.claimedBy).toBeNull();
  });

  it("matches the column case-insensitively and writes the schema's spelling", () => {
    const next = remap("PanSrcMac", "sourcemacaddress").rows[0];
    expect(next.dest).toBe("SourceMACAddress");
    expect(next.action).toBe("rename");
  });

  it("does not mutate the input rows", () => {
    const copy = structuredClone(ROWS);
    remap("PanSrcMac", "SourceMACAddress");
    expect(ROWS).toEqual(copy);
  });
});

describe("applyRemap - what the remap vacates and collides with", () => {
  it("reports the column the source vacates as displaced", () => {
    const result = remap("act", "SourceMACAddress");
    expect(result.displaced).toEqual({ name: "DeviceAction", type: "string" });
  });

  it("does not report a column another row still lands in", () => {
    const rows = [...ROWS, row({ source: "action", dest: "DeviceAction", action: "rename" })];
    expect(remap("act", "SourceMACAddress", rows).displaced).toBeNull();
  });

  it("reports another row already landing in the chosen column, and leaves it alone", () => {
    const result = remap("PanSrcMac", "DeviceAction");
    expect(result.claimedBy).toBe("act");
    expect(result.rows[3]).toBe(act);
    expect(result.rows[0].dest).toBe("DeviceAction");
  });
});

describe("applyRemap - reverts and no-ops", () => {
  it("restores the baseline row verbatim when its own column is chosen again", () => {
    const edited = remap("PanSrcMac", "SourceMACAddress").rows;
    const result = remap("PanSrcMac", "AdditionalExtensions", edited);
    expect(result.outcome).toBe("reverted");
    expect(result.rows[0]).toEqual(panSrcMac);
    expect(result.displaced).toEqual({ name: "SourceMACAddress", type: "string" });
  });

  it("is unchanged when the row already lands in the chosen column", () => {
    const result = remap("act", "DeviceAction");
    expect(result.outcome).toBe("unchanged");
    expect(result.rows).toEqual(ROWS);
  });

  it("refuses a column the schema does not have", () => {
    const result = remap("PanSrcMac", "NoSuchColumn");
    expect(result.outcome).toBe("unknown-column");
    expect(result.rows).toEqual(ROWS);
  });

  it("refuses a source no row carries", () => {
    expect(remap("nope", "SourceMACAddress").outcome).toBe("unknown-source");
  });
});

describe("landsInColumn", () => {
  it("is true for a column-bound row and false for overflow, drop and empty dest", () => {
    expect(landsInColumn(act)).toBe(true);
    expect(landsInColumn(panSrcMac)).toBe(false);
    expect(landsInColumn(row({ action: "drop", dest: "X" }))).toBe(false);
    expect(landsInColumn(row({ action: "rename", dest: "" }))).toBe(false);
  });
});
