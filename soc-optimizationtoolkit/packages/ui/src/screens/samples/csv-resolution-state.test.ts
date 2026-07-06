/**
 * Contract tests for the CSV header-resolution pure decision layer (porting-plan
 * Unit 12 UI, GUI-07). Pins the ones the plan calls out - the CRITICAL FIX
 * (multi-file batch QUEUES every headerless CSV instead of dropping the rest),
 * apply/skip both advance the queue, preview-zip projection, and mismatch
 * derivation - plus the header-file parsing and the re-parse re-key.
 */
import { describe, expect, it } from "vitest";
import type { ParsedSample, TaggedSample } from "@soc/core";
import { parseSampleContent } from "@soc/core";
import { buildTaggedSample, tagSampleFromContent } from "./sample-intake-state";
import {
  advanceQueue,
  buildResolutionQueue,
  currentItem,
  deriveMismatch,
  isHeaderlessCsvSample,
  isQueueDone,
  parseHeaderFileText,
  previewZip,
  queuePosition,
  reconstructCsvLines,
  remainingCount,
  resolveHeaders,
  singleItemQueue,
  splitCsvRow,
  toResolutionItem,
} from "./csv-resolution-state";

/**
 * A headerless-CSV tagged sample: >= 5 columns, no header row (numeric first
 * row), so the Unit 11 detector parses positional _0.._N fields. `logType` keys
 * the store entry the re-parse replaces.
 */
function headerlessCsvSample(
  logType: string,
  rows: string[],
  sourceName = "feed.csv",
): TaggedSample {
  const parsed: ParsedSample = parseSampleContent(rows.join("\n"), {
    sourceName,
  });
  return buildTaggedSample(logType, parsed);
}

// A generic headerless CSV: 6 columns, first row NOT identifier-like, so the
// Unit 11 parse yields positional _0.._5 fields (and, per detectLenient, a
// format label of "unknown" - the positional FIELDS are the resolution signal).
const GENERIC_ROWS = [
  "2026-07-05,10.0.0.1,443,allow,web,200",
  "2026-07-05,10.0.0.2,80,deny,web,403",
];

// A second, distinct headerless CSV for the multi-file batch tests.
const GENERIC_ROWS_2 = [
  "9.9.9.9,53,udp,dns,ok,fast",
  "8.8.8.8,53,tcp,dns,ok,slow",
];

// ---------------------------------------------------------------------------
// headerless-CSV detection
// ---------------------------------------------------------------------------

describe("isHeaderlessCsvSample", () => {
  it("is true for a positional headerless CSV and false for JSON", () => {
    const csv = headerlessCsvSample("Web", GENERIC_ROWS);
    // The positional _N fields are the signal, not the format label (which is
    // "unknown" for a numeric-first-row feed - the parseByFormat fallback path).
    expect(csv.parsed.fields.some((f) => /^_\d+$/.test(f.name))).toBe(true);
    expect(isHeaderlessCsvSample(csv)).toBe(true);

    const json = tagSampleFromContent("J", '{"a":1,"b":2,"c":3,"d":4}');
    expect(isHeaderlessCsvSample(json)).toBe(false);
  });

  it("is false for a CSV that already has a header row", () => {
    const withHeader = tagSampleFromContent(
      "H",
      ["time,src,dst,action,app", ...GENERIC_ROWS].join("\n"),
    );
    // A header row means named fields, not the _0.._N positional pattern.
    expect(isHeaderlessCsvSample(withHeader)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconstruction + item projection
// ---------------------------------------------------------------------------

describe("reconstructCsvLines / toResolutionItem", () => {
  it("recovers comma-joined rows from positional records", () => {
    const csv = headerlessCsvSample("Web", GENERIC_ROWS);
    const lines = reconstructCsvLines(csv.rawEvents);
    expect(lines[0]).toBe("2026-07-05,10.0.0.1,443,allow,web,200");
  });

  it("falls back to the raw string when an event is not JSON", () => {
    expect(reconstructCsvLines(["not json"])).toEqual(["not json"]);
  });

  it("projects a resolution item carrying source, columns, and first rows", () => {
    const csv = headerlessCsvSample("Web", GENERIC_ROWS, "traffic.csv");
    const item = toResolutionItem(csv);
    expect(item.logType).toBe("Web");
    expect(item.sourceName).toBe("traffic.csv");
    expect(item.columnCount).toBe(6);
    expect(item.firstRows.length).toBe(2);
    expect(item.csvContent.split("\n")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// THE CRITICAL FIX: every headerless CSV in a batch is queued, none dropped
// ---------------------------------------------------------------------------

describe("buildResolutionQueue (critical fix - no silent drop)", () => {
  it("queues EVERY headerless CSV in the batch, in order, skipping others", () => {
    const batch: TaggedSample[] = [
      headerlessCsvSample("First", GENERIC_ROWS, "first.csv"),
      tagSampleFromContent("Json", '{"a":1,"b":2,"c":3}'), // not queued
      headerlessCsvSample("Second", GENERIC_ROWS_2, "second.csv"),
    ];
    const queue = buildResolutionQueue(batch);
    // Legacy stopped after "First" and dropped "Second"; both are queued now.
    expect(queue.items.map((i) => i.logType)).toEqual(["First", "Second"]);
    expect(queue.index).toBe(0);
    expect(remainingCount(queue)).toBe(2);
  });

  it("returns an empty (already-done) queue when nothing is headerless", () => {
    const queue = buildResolutionQueue([
      tagSampleFromContent("J", '{"a":1,"b":2,"c":3}'),
    ]);
    expect(queue.items).toHaveLength(0);
    expect(isQueueDone(queue)).toBe(true);
    expect(currentItem(queue)).toBeNull();
  });

  it("single-item queue targets one chip for the per-sample affordance", () => {
    const queue = singleItemQueue(headerlessCsvSample("One", GENERIC_ROWS));
    expect(queue.items).toHaveLength(1);
    expect(currentItem(queue)?.logType).toBe("One");
  });
});

// ---------------------------------------------------------------------------
// queue navigation: apply-advances, skip-advances, next-in-queue
// ---------------------------------------------------------------------------

describe("advanceQueue (apply and skip both advance)", () => {
  const batch = [
    headerlessCsvSample("A", GENERIC_ROWS, "a.csv"),
    headerlessCsvSample("B", GENERIC_ROWS_2, "b.csv"),
  ];

  it("steps to the next item and reports position + done", () => {
    let queue = buildResolutionQueue(batch);
    expect(currentItem(queue)?.logType).toBe("A");
    expect(queuePosition(queue)).toEqual({ current: 1, total: 2 });

    // Apply on A -> advance.
    queue = advanceQueue(queue);
    expect(currentItem(queue)?.logType).toBe("B");
    expect(queuePosition(queue)).toEqual({ current: 2, total: 2 });

    // Skip on B -> advance (same primitive) -> done.
    queue = advanceQueue(queue);
    expect(currentItem(queue)).toBeNull();
    expect(isQueueDone(queue)).toBe(true);
    expect(queuePosition(queue)).toEqual({ current: 0, total: 2 });
  });

  it("is a no-op once the queue is already done", () => {
    let queue = buildResolutionQueue(batch);
    queue = advanceQueue(advanceQueue(advanceQueue(queue)));
    expect(queue.index).toBe(2);
    expect(isQueueDone(queue)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// header-file parsing
// ---------------------------------------------------------------------------

describe("parseHeaderFileText", () => {
  it("splits on commas, strips quotes, and sanitizes to identifiers", () => {
    expect(parseHeaderFileText('"time", src ip , dst-port ,action')).toEqual([
      "time",
      "src_ip",
      "dst_port",
      "action",
    ]);
  });

  it("splits on newlines when there is no comma and drops empties", () => {
    expect(parseHeaderFileText("time\n\nsrc\ndst\n")).toEqual([
      "time",
      "src",
      "dst",
    ]);
  });

  it("strips leading underscores but keeps leading digits (legacy verbatim)", () => {
    // Sanitizing replaces non-word chars with "_"; only LEADING underscores are
    // trimmed, so a leading digit survives (matches the legacy header cleaner).
    expect(parseHeaderFileText("_leadus,123col")).toEqual(["leadus", "123col"]);
  });
});

// ---------------------------------------------------------------------------
// preview zip + mismatch derivation
// ---------------------------------------------------------------------------

describe("previewZip", () => {
  it("aligns each header to its first-row value", () => {
    const rows = previewZip(
      ["time", "src", "dst"],
      "2026-07-05,10.0.0.1,10.0.0.2",
    );
    expect(rows).toEqual([
      { header: "time", value: "2026-07-05", hasValue: true, skipped: false },
      { header: "src", value: "10.0.0.1", hasValue: true, skipped: false },
      { header: "dst", value: "10.0.0.2", hasValue: true, skipped: false },
    ]);
  });

  it("marks a surplus header with no value and a future_use placeholder", () => {
    const rows = previewZip(["future_use1", "a", "b"], "1,alpha");
    expect(rows[0].skipped).toBe(true);
    // "b" has no third value in the row.
    expect(rows[2]).toEqual({
      header: "b",
      value: "",
      hasValue: false,
      skipped: false,
    });
  });

  it("caps the rendered rows at the limit", () => {
    const headers = Array.from({ length: 40 }, (_v, i) => `h${i}`);
    expect(previewZip(headers, "x", 15)).toHaveLength(15);
  });
});

describe("splitCsvRow", () => {
  it("trims and strips surrounding quotes like the core parser", () => {
    expect(splitCsvRow('"a", b ,"c"')).toEqual(["a", "b", "c"]);
  });
});

describe("deriveMismatch", () => {
  it("warns only when headers exist and their count differs", () => {
    expect(deriveMismatch(0, 47).mismatch).toBe(false);
    expect(deriveMismatch(47, 47).mismatch).toBe(false);
    expect(deriveMismatch(40, 47)).toEqual({
      mismatch: true,
      headerCount: 40,
      columnCount: 47,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveHeaders: re-parse via core, re-key onto the same log type
// ---------------------------------------------------------------------------

describe("resolveHeaders", () => {
  it("re-parses the item with named columns under the same log type", () => {
    const item = toResolutionItem(headerlessCsvSample("Web", GENERIC_ROWS));
    const resolved = resolveHeaders(item, [
      "time",
      "src",
      "dport",
      "action",
      "app",
      "status",
    ]);
    // Re-keyed onto the SAME log type so the store upsert replaces the chip.
    expect(resolved.logType).toBe("Web");
    // Detection stays content-first: still CSV, now with named fields.
    expect(resolved.format).toBe("csv");
    const names = resolved.parsed.fields.map((f) => f.name);
    expect(names).toContain("action");
    expect(names).not.toContain("_0");
    const action = resolved.parsed.records[0].action;
    expect(action).toBe("allow");
  });

  it("spills surplus values to _extra_N when fewer headers are supplied", () => {
    const item = toResolutionItem(headerlessCsvSample("Web", GENERIC_ROWS));
    // Only 4 headers for 6 columns -> the last two spill to overflow.
    const resolved = resolveHeaders(item, ["time", "src", "dport", "action"]);
    const names = resolved.parsed.fields.map((f) => f.name);
    expect(names).toContain("_extra_4");
    expect(names).toContain("_extra_5");
  });
});
