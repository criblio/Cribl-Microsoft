/**
 * Contract tests for the sample-intake pure decision layer (porting-plan Unit
 * 11 UI). Covers the three the plan calls out - chip derivation, rename re-key
 * (the legacy orphaning-bug fix), and dedupe-by-logType - plus the storage cap,
 * the field-table/raw-preview projections, and content-based format detection
 * (Cribl capture unwrap).
 */
import { describe, expect, it } from "vitest";
import { RAW_EVENTS_CAP } from "@soc/core";
import type { ParsedSample, TaggedSample } from "@soc/core";
import {
  buildTaggedSample,
  chipFromTagged,
  dedupeByLogType,
  fieldRows,
  normalizeLogType,
  rawPreviewLines,
  reKeyByLogType,
  removeByLogType,
  renameInList,
  suggestLogType,
  tagFileContent,
  tagSampleFromContent,
  upsertSample,
  validateLogType,
  validateRename,
} from "./sample-intake-state";

/** A minimal parsed sample for list/re-key tests (shape only, not realism). */
function parsedOf(overrides: Partial<ParsedSample> = {}): ParsedSample {
  return {
    format: "json",
    records: [{ a: 1 }],
    eventCount: 1,
    fields: [],
    rawEvents: ['{"a":1}'],
    sourceName: "pasted",
    errors: [],
    ...overrides,
  };
}

/** A minimal tagged sample keyed by logType, for the list/re-key tests. */
function tagged(logType: string): TaggedSample {
  return {
    logType,
    format: "json",
    rawEvents: ['{"a":1}'],
    parsed: parsedOf(),
  };
}

// ---------------------------------------------------------------------------
// log-type validation
// ---------------------------------------------------------------------------

describe("normalizeLogType / validateLogType", () => {
  it("trims and rejects empty/whitespace names", () => {
    expect(normalizeLogType("  Traffic  ")).toBe("Traffic");
    expect(validateLogType("   ")).toMatch(/log type/i);
    expect(validateLogType("Traffic")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// chip derivation (from real parse results)
// ---------------------------------------------------------------------------

describe("chip derivation", () => {
  it("summarises format, event count, field count, and timestamp field", () => {
    const content = [
      '{"Timestamp":"2026-07-04T10:00:00Z","src":"1.2.3.4","action":"allow"}',
      '{"Timestamp":"2026-07-04T10:00:01Z","src":"5.6.7.8","action":"deny"}',
    ].join("\n");
    const sample = tagSampleFromContent("Traffic", content, "traffic.log");
    const chip = chipFromTagged(sample);
    expect(chip.logType).toBe("Traffic");
    expect(chip.format).toBe("ndjson");
    expect(chip.eventCount).toBe(2);
    expect(chip.fieldCount).toBe(3);
    expect(chip.timestampField).toBe("Timestamp");
  });

  it("omits timestampField when the sample has none", () => {
    const sample = tagSampleFromContent("Nums", '{"x":"1","y":"2"}');
    const chip = chipFromTagged(sample);
    expect(chip.timestampField).toBeUndefined();
  });

  it("detects the format FROM CONTENT - a Cribl capture unwraps to its inner _raw", () => {
    // A capture wrapper (NDJSON with a _raw field) carrying inner CEF: the
    // detected format must be the INNER vendor format, never the wrapper's.
    const content = [
      '{"_raw":"CEF:0|Vendor|Product|1.0|100|Login|3|src=1.2.3.4 dst=5.6.7.8 act=allow","_time":1}',
      '{"_raw":"CEF:0|Vendor|Product|1.0|100|Login|3|src=9.9.9.9 dst=8.8.8.8 act=deny","_time":2}',
    ].join("\n");
    const chip = chipFromTagged(tagSampleFromContent("Auth", content));
    expect(chip.format).toBe("cef");
    expect(chip.format).not.toBe("ndjson");
  });
});

// ---------------------------------------------------------------------------
// field-table + raw-preview projections
// ---------------------------------------------------------------------------

describe("field rows and raw preview", () => {
  it("projects discovered fields to name + inferred type + example rows", () => {
    const sample = tagSampleFromContent(
      "T",
      '{"count":"42","name":"alpha"}',
    );
    const rows = fieldRows(sample.parsed);
    const count = rows.find((r) => r.name === "count");
    const name = rows.find((r) => r.name === "name");
    expect(count?.type).toBe("int");
    expect(count?.example).toBe("42");
    expect(name?.type).toBe("string");
    expect(name?.example).toBe("alpha");
    expect(count?.required).toBe(true);
  });

  it("caps the field-table rows at the requested limit", () => {
    const parsed = parsedOf({
      fields: Array.from({ length: 10 }, (_v, i) => ({
        name: `f${i}`,
        type: "string" as const,
        types: ["string" as const],
        examples: [`e${i}`],
        occurrence: 1,
        required: true,
      })),
    });
    expect(fieldRows(parsed, 3)).toHaveLength(3);
  });

  it("previews the stored raw events, bounded by maxLines", () => {
    const content = ["one", "two", "three", "four"]
      .map((w) => `{"w":"${w}"}`)
      .join("\n");
    const sample = tagSampleFromContent("W", content);
    expect(rawPreviewLines(sample, 2)).toHaveLength(2);
    expect(rawPreviewLines(sample)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// buildTaggedSample storage cap
// ---------------------------------------------------------------------------

describe("buildTaggedSample storage cap", () => {
  it("caps stored records to RAW_EVENTS_CAP while preserving the true event count", () => {
    const total = RAW_EVENTS_CAP + 5;
    const content = Array.from(
      { length: total },
      (_v, i) => `{"i":${i}}`,
    ).join("\n");
    const sample = tagSampleFromContent("Big", content);
    expect(sample.parsed.eventCount).toBe(total);
    expect(sample.parsed.records.length).toBe(RAW_EVENTS_CAP);
    expect(sample.rawEvents.length).toBe(RAW_EVENTS_CAP);
  });

  it("normalises the log type and carries the detected format", () => {
    const parsed = parsedOf({ format: "csv" });
    const sample = buildTaggedSample("  Web  ", parsed);
    expect(sample.logType).toBe("Web");
    expect(sample.format).toBe("csv");
  });
});

// ---------------------------------------------------------------------------
// suggestLogType
// ---------------------------------------------------------------------------

describe("suggestLogType", () => {
  it("derives a name from a filename keyword", () => {
    const parsed = parsedOf();
    expect(suggestLogType(parsed, "cloudflare-dns-2026.json")).toBe("Dns");
  });
});

describe("tagFileContent", () => {
  it("parses a file and tags it with a suggested log type from the filename", () => {
    const sample = tagFileContent('{"a":1,"b":2}', "vendor-firewall.json");
    expect(sample.logType).toBe("Firewall");
    // Format comes from the CONTENT, never the .json extension: a bare object
    // line detects as ndjson.
    expect(sample.format).toBe("ndjson");
  });
});

// ---------------------------------------------------------------------------
// dedupe-by-logType
// ---------------------------------------------------------------------------

describe("dedupeByLogType", () => {
  it("keeps one entry per log type, last value wins at the first position", () => {
    const first = tagged("A");
    const second = { ...tagged("A"), format: "csv" as const };
    const other = tagged("B");
    const deduped = dedupeByLogType([first, other, second]);
    expect(deduped.map((s) => s.logType)).toEqual(["A", "B"]);
    // last "A" value wins, but at the first "A" position (Map.set semantics)
    expect(deduped[0].format).toBe("csv");
  });
});

// ---------------------------------------------------------------------------
// upsert / remove
// ---------------------------------------------------------------------------

describe("upsertSample / removeByLogType", () => {
  it("appends a new log type and replaces an existing one in place", () => {
    const list = [tagged("A"), tagged("B")];
    const appended = upsertSample(list, tagged("C"));
    expect(appended.map((s) => s.logType)).toEqual(["A", "B", "C"]);

    const replacement = { ...tagged("B"), format: "kv" as const };
    const replaced = upsertSample(list, replacement);
    expect(replaced.map((s) => s.logType)).toEqual(["A", "B"]);
    expect(replaced[1].format).toBe("kv");
    // pure: the input list is not mutated
    expect(list[1].format).toBe("json");
  });

  it("removes by log type and is a no-op for an unknown one", () => {
    const list = [tagged("A"), tagged("B")];
    expect(removeByLogType(list, "A").map((s) => s.logType)).toEqual(["B"]);
    expect(removeByLogType(list, "Z")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// rename re-key (list + downstream edits) - the legacy orphaning-bug fix
// ---------------------------------------------------------------------------

describe("renameInList", () => {
  it("re-keys a sample's log type, keeping its position", () => {
    const list = [tagged("Old"), tagged("Keep")];
    const renamed = renameInList(list, "Old", "New");
    expect(renamed.map((s) => s.logType)).toEqual(["New", "Keep"]);
  });

  it("replaces a colliding target (one chip per log type) at the source position", () => {
    const from = { ...tagged("Old"), format: "csv" as const };
    const list = [from, tagged("Existing")];
    const renamed = renameInList(list, "Old", "Existing");
    expect(renamed.map((s) => s.logType)).toEqual(["Existing"]);
    // the renamed sample wins the collision
    expect(renamed[0].format).toBe("csv");
  });

  it("is a no-op when the source is absent or the name is unchanged", () => {
    const list = [tagged("A")];
    expect(renameInList(list, "Z", "New").map((s) => s.logType)).toEqual(["A"]);
    expect(renameInList(list, "A", "A").map((s) => s.logType)).toEqual(["A"]);
  });
});

describe("reKeyByLogType (downstream mapping-edit re-key - orphaning fix)", () => {
  it("moves the value to the new key and drops the old one", () => {
    const edits = { Old: { rename: "x" }, Keep: { rename: "y" } };
    const rekeyed = reKeyByLogType(edits, "Old", "New");
    // FIX: the edit follows the rename instead of being orphaned under "Old"
    expect(rekeyed).toEqual({ New: { rename: "x" }, Keep: { rename: "y" } });
    expect(Object.prototype.hasOwnProperty.call(rekeyed, "Old")).toBe(false);
  });

  it("overwrites a pre-existing target and preserves other keys", () => {
    const edits = { Old: 1, Existing: 2, Other: 3 };
    const rekeyed = reKeyByLogType(edits, "Old", "Existing");
    expect(rekeyed).toEqual({ Existing: 1, Other: 3 });
  });

  it("trims the target and is a no-op copy when the source is absent or unchanged", () => {
    const edits = { A: 1 };
    expect(reKeyByLogType(edits, "Z", "New")).toEqual({ A: 1 });
    expect(reKeyByLogType(edits, "A", "A")).toEqual({ A: 1 });
    expect(reKeyByLogType({ Old: 1 }, "Old", "  New  ")).toEqual({ New: 1 });
    // pure: the input is not mutated
    expect(edits).toEqual({ A: 1 });
  });
});

// ---------------------------------------------------------------------------
// rename validation
// ---------------------------------------------------------------------------

describe("validateRename", () => {
  it("rejects empty and unchanged names, flags collisions", () => {
    const list = [tagged("A"), tagged("B")];
    expect(validateRename(list, "A", "  ")).toEqual({
      ok: false,
      reason: expect.stringMatching(/new log type/i),
    });
    expect(validateRename(list, "A", "A")).toEqual({
      ok: false,
      reason: expect.stringMatching(/matches/i),
    });
    expect(validateRename(list, "A", "C")).toEqual({ ok: true, collision: false });
    expect(validateRename(list, "A", "B")).toEqual({ ok: true, collision: true });
  });
});
