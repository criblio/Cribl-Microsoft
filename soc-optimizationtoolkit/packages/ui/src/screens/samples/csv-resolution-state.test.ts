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
  PREVIEW_ROW_LIMIT,
  advanceQueue,
  buildFieldPreview,
  buildResolutionQueue,
  coverageLine,
  currentItem,
  deriveMismatch,
  isHeaderlessCsvSample,
  isQueueDone,
  parseHeaderFileText,
  previewZip,
  queuePosition,
  reconstructCsvLines,
  remainingCount,
  resolveDefinitionSource,
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
  it("aligns each name to its value and stamps the position", () => {
    const rows = previewZip(
      ["time", "src", "dst"],
      "2026-07-05,10.0.0.1,10.0.0.2",
      3,
    );
    expect(rows).toEqual([
      {
        position: 0,
        header: "time",
        value: "2026-07-05",
        hasValue: true,
        skipped: false,
        unmapped: false,
      },
      {
        position: 1,
        header: "src",
        value: "10.0.0.1",
        hasValue: true,
        skipped: false,
        unmapped: false,
      },
      {
        position: 2,
        header: "dst",
        value: "10.0.0.2",
        hasValue: true,
        skipped: false,
        unmapped: false,
      },
    ]);
  });

  it("marks a surplus header with no value and a future_use placeholder", () => {
    const rows = previewZip(["future_use1", "a", "b"], "1,alpha", 2);
    expect(rows[0].skipped).toBe(true);
    // "b" has no third value in the row.
    expect(rows[2]).toEqual({
      position: 2,
      header: "b",
      value: "",
      hasValue: false,
      skipped: false,
      unmapped: false,
    });
  });

  it("emits a row for EVERY data column, not just the named ones", () => {
    // The whole point of the surface: 2 names for 6 columns must still produce
    // 6 rows, so the four nobody has named are visible with their values.
    const rows = previewZip(["time", "src"], "t,1.1.1.1,443,allow,web,200", 6);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.header)).toEqual([
      "time",
      "src",
      "_2",
      "_3",
      "_4",
      "_5",
    ]);
    expect(rows.map((r) => r.unmapped)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
    // The unnamed positions still show their real values - that is what makes
    // them nameable at all (naming "443" is possible; naming "_2" is guesswork).
    expect(rows[2].value).toBe("443");
  });

  it("NEVER invents a name from a value that looks obvious", () => {
    // "192.168.0.2" is unmistakably an IP and "443" unmistakably a port. A
    // guess here would be confidently wrong often enough to poison a schema,
    // so both stay positional until a human says otherwise.
    const rows = previewZip([], "192.168.0.2,443", 2);
    expect(rows.map((r) => r.header)).toEqual(["_0", "_1"]);
    expect(rows.every((r) => r.unmapped)).toBe(true);
  });

  it("treats a positional name in the supplied array as still unmapped", () => {
    // The interactive mapper holds ONE full-length array and parks un-named
    // positions at their positional name, so "is this named?" is answered from
    // the NAME (core isPositionalFieldName), never from the array's length.
    const rows = previewZip(["time", "_1", "dst"], "a,b,c", 3);
    expect(rows.map((r) => r.unmapped)).toEqual([false, true, false]);
    expect(rows[1].header).toBe("_1");
  });

  it("treats a blank supplied name as unmapped and re-positional", () => {
    // parseCsvWithHeaders drops a blank name's value, so a blank entry maps
    // nothing; the preview says so rather than rendering an empty label.
    const rows = previewZip(["time", "   ", "dst"], "a,b,c", 3);
    expect(rows[1]).toEqual({
      position: 1,
      header: "_1",
      value: "b",
      hasValue: true,
      skipped: false,
      unmapped: true,
    });
  });

  it("contributes no positions for a blank row", () => {
    // "".split(",") is [""], which would otherwise invent a column zero.
    expect(previewZip([], "", 0)).toEqual([]);
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
// THE LIVE PREVIEW (field-definition plan step 2): the shared surface every
// input path renders into. Two jobs - name beside real value, and the unmapped
// remainder COUNTED - and the tests below are the specification for both.
// ---------------------------------------------------------------------------

/** A synthetic 38-column row, the width of a real PAN-OS TRAFFIC log. */
const WIDE_ROW = Array.from({ length: 38 }, (_v, i) => `v${i}`).join(",");
const wideItem = { columnCount: 38, firstRows: [WIDE_ROW] };

describe("buildFieldPreview - the unmapped remainder is COUNTED", () => {
  it("reports 12 of 38 as 12 of 38, not as success", () => {
    const twelve = Array.from({ length: 12 }, (_v, i) => `c${i}`);
    const preview = buildFieldPreview(twelve, wideItem);

    // The counts, which are the whole reason this exists. A definition that
    // names a third of the columns must be arithmetically visible as such.
    expect(preview.columnCount).toBe(38);
    expect(preview.mappedCount).toBe(12);
    expect(preview.unmappedCount).toBe(26);
    expect(preview.totalPositions).toBe(38);
  });

  it("keeps the count honest when the display cap hides most of the rows", () => {
    const twelve = Array.from({ length: 12 }, (_v, i) => `c${i}`);
    const preview = buildFieldPreview(twelve, wideItem);

    // Only 15 of the 38 positions are rendered...
    expect(preview.rows).toHaveLength(PREVIEW_ROW_LIMIT);
    expect(preview.hiddenCount).toBe(38 - PREVIEW_ROW_LIMIT);
    // ...but 26 unmapped is still 26 unmapped. Deriving the count from the
    // RENDERED rows would report 3 and turn the cap into a lie.
    expect(preview.unmappedCount).toBe(26);
    // The three unmapped positions that do fit carry their positional names.
    expect(
      preview.rows.filter((r) => r.unmapped).map((r) => r.header),
    ).toEqual(["_12", "_13", "_14"]);
    // ...and their real values, which is what makes them nameable.
    expect(preview.rows[12].value).toBe("v12");
  });

  it("counts a future_use placeholder as mapped, not as a gap", () => {
    // Declaring a column meaningless is a decision, not an omission.
    const preview = buildFieldPreview(
      ["future_use", "receive_time", "serial"],
      { columnCount: 3, firstRows: ["1,2021/10/25 20:25:39,0123"] },
    );
    expect(preview.mappedCount).toBe(3);
    expect(preview.unmappedCount).toBe(0);
    expect(preview.rows[0].skipped).toBe(true);
    expect(preview.rows[0].unmapped).toBe(false);
  });

  it("does not let surplus names inflate coverage, and still warns", () => {
    // 4 names for 3 columns: coverage is 3 of 3 (the fourth maps nothing), and
    // the mismatch warning SURVIVES alongside the counts rather than being
    // replaced by them - the two say different things.
    const preview = buildFieldPreview(["a", "b", "c", "d"], {
      columnCount: 3,
      firstRows: ["1,2,3"],
    });
    expect(preview.mappedCount).toBe(3);
    expect(preview.unmappedCount).toBe(0);
    expect(preview.mismatch).toEqual({
      mismatch: true,
      headerCount: 4,
      columnCount: 3,
    });
    // The surplus name is still rendered, marked as holding nothing.
    expect(preview.totalPositions).toBe(4);
    expect(preview.rows[3]).toEqual({
      position: 3,
      header: "d",
      value: "",
      hasValue: false,
      skipped: false,
      unmapped: false,
    });
  });

  it("reports every column unmapped when there is no definition yet", () => {
    const preview = buildFieldPreview([], wideItem);
    expect(preview.mappedCount).toBe(0);
    expect(preview.unmappedCount).toBe(38);
    expect(preview.mismatch.mismatch).toBe(false); // nothing to compare yet
    expect(preview.rows[0].header).toBe("_0");
  });
});

// The PAN-OS CONFIG line from the plan: an EMPTY serial at position 2. This is
// the case the whole preview exists for.
const PANOS_CONFIG_ROW = "1,2021/10/25 20:25:39,,CONFIG,0,2021/10/25 20:25:44";
const panosItem = { columnCount: 6, firstRows: [PANOS_CONFIG_ROW] };
const rowFor = (
  preview: ReturnType<typeof buildFieldPreview>,
  header: string,
) => preview.rows.find((r) => r.header === header);

describe("buildFieldPreview - an off-by-one is VISIBLE in the values", () => {
  it("pairs each name with the value it will actually take", () => {
    const correct = [
      "future_use",
      "receive_time",
      "serial",
      "type",
      "subtype",
      "generated_time",
    ];
    const preview = buildFieldPreview(correct, panosItem);
    expect(rowFor(preview, "receive_time")?.value).toBe("2021/10/25 20:25:39");
    expect(rowFor(preview, "type")?.value).toBe("CONFIG");
    // The empty serial is shown as PRESENT-but-empty, not as absent: the column
    // exists, it just carries nothing on this row.
    expect(rowFor(preview, "serial")).toEqual({
      position: 2,
      header: "serial",
      value: "",
      hasValue: true,
      skipped: false,
      unmapped: false,
    });
  });

  it("shows the shift when a definition omits the empty column", () => {
    // A definition written from the vendor doc that skips the always-empty
    // serial. Every name after position 1 slides left by one.
    const shifted = [
      "future_use",
      "receive_time",
      "type",
      "subtype",
      "config_version",
      "generated_time",
    ];
    const preview = buildFieldPreview(shifted, panosItem);

    // THE COUNTS SAY IT IS FINE - 6 names, 6 columns, nothing unmapped, no
    // mismatch. This is exactly why a name list cannot catch this class of
    // defect and why values are non-negotiable on this surface.
    expect(preview.mappedCount).toBe(6);
    expect(preview.unmappedCount).toBe(0);
    expect(preview.mismatch.mismatch).toBe(false);

    // THE VALUES SAY IT IS WRONG: `type` lands on the empty serial slot, and
    // the log type "CONFIG" turns up under `subtype`.
    expect(rowFor(preview, "type")?.value).toBe("");
    expect(rowFor(preview, "subtype")?.value).toBe("CONFIG");
    expect(rowFor(preview, "config_version")?.value).toBe("0");
    // The correct definition puts "CONFIG" under `type`; the shifted one does
    // not. Same row, same count, different meaning.
    expect(rowFor(preview, "type")?.value).not.toBe("CONFIG");
  });
});

describe("coverageLine", () => {
  it("names the remainder and an example of what it stays called", () => {
    const twelve = Array.from({ length: 12 }, (_v, i) => `c${i}`);
    expect(coverageLine(buildFieldPreview(twelve, wideItem))).toBe(
      "Names 12 of 38 columns - 26 still unmapped (_12 and so on).",
    );
  });

  it("says so explicitly when nothing is left, rather than going quiet", () => {
    // Silence is what let a part-finished definition read as finished.
    expect(
      coverageLine(
        buildFieldPreview(["a", "b", "c"], {
          columnCount: 3,
          firstRows: ["1,2,3"],
        }),
      ),
    ).toBe("Names all 3 columns.");
  });

  it("counts every column when there is no definition yet", () => {
    expect(coverageLine(buildFieldPreview([], wideItem))).toBe(
      "Names 0 of 38 columns - 38 still unmapped (_0 and so on).",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveDefinitionSource: BOTH tabs feed the one preview, live
// ---------------------------------------------------------------------------

// A Zscaler NSS feed format string - the feed-config tab's bread and butter.
const NSS_FORMAT =
  "%s{datetime},%s{cloudname},%s{host},%d{action},%s{url}";

describe("resolveDefinitionSource", () => {
  it("derives names from the header-row text with no parse button", () => {
    const source = resolveDefinitionSource("row", "time, src ip ,dst", "");
    expect(source.headers).toEqual(["time", "src_ip", "dst"]);
    expect(source.label).toBe("Header row (3 columns)");
    expect(source.hasInput).toBe(true);
  });

  it("derives names from the feed-config text through the core parser", () => {
    const source = resolveDefinitionSource("config", "", NSS_FORMAT);
    expect(source.headers).toEqual([
      "datetime",
      "cloudname",
      "host",
      "action",
      "url",
    ]);
    expect(source.label).toBe("Zscaler nss (5 fields)");
  });

  it("says nothing at all before there is input", () => {
    const source = resolveDefinitionSource("row", "   ", NSS_FORMAT);
    expect(source).toEqual({
      tab: "row",
      headers: [],
      label: "",
      hasInput: false,
    });
  });

  it("warns when text was supplied but nothing was recognized", () => {
    const rowSource = resolveDefinitionSource("row", "!!!", "");
    expect(rowSource.headers).toEqual([]);
    expect(rowSource.label).toBe("No column names found - check the header row.");

    const cfgSource = resolveDefinitionSource("config", "", "nothing useful");
    expect(cfgSource.headers).toEqual([]);
    expect(cfgSource.label).toBe("No fields detected - check the config format.");
  });

  it("puts the ACTIVE tab in force, so the preview matches what is on screen", () => {
    // Both texts are held (switching tabs must not destroy a paste) but only
    // one is the definition - what is visible is what Apply applies.
    const row = resolveDefinitionSource("row", "a,b", NSS_FORMAT);
    const cfg = resolveDefinitionSource("config", "a,b", NSS_FORMAT);
    expect(row.headers).toEqual(["a", "b"]);
    expect(cfg.headers).toHaveLength(5);
    expect(row.tab).toBe("row");
    expect(cfg.tab).toBe("config");
  });

  it("feeds the SAME preview surface from either tab", () => {
    const item = { columnCount: 5, firstRows: ["t,cloud,h,1,http://x"] };
    const fromConfig = buildFieldPreview(
      resolveDefinitionSource("config", "", NSS_FORMAT).headers,
      item,
    );
    const fromRow = buildFieldPreview(
      resolveDefinitionSource(
        "row",
        "datetime,cloudname,host,action,url",
        "",
      ).headers,
      item,
    );
    // Same names, same values, same counts - the surface does not branch on
    // where the names came from.
    expect(fromRow.rows).toEqual(fromConfig.rows);
    expect(fromRow.mappedCount).toBe(5);
    expect(fromConfig.mappedCount).toBe(5);
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
