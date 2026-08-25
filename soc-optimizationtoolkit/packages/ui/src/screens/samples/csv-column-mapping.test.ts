/**
 * Contract tests for the interactive column-mapping tab's pure state
 * (vendor-field-definition-plan "Gap 2").
 *
 * The three properties the plan makes binding, pinned here as behaviour rather
 * than as shape:
 *
 * 1. PARTIAL IS LEGITIMATE. Naming 2 of 6 columns yields 2 named columns and 4
 *    still positional - not an error, not a refusal to apply, and above all not
 *    four deleted columns. The "" contrast test below shows exactly what would
 *    have happened without the positional fill-in, which is why it exists.
 * 2. NOTHING IS INVENTED. No name is derived from a value's shape anywhere; an
 *    unnamed position keeps the core positionalFieldName and is counted as
 *    unmapped.
 * 3. AN UNNAMED POSITION SURVIVES THE ROUND TRIP. Apply and the re-parse leave
 *    it positional, still carrying its value, and still recognisable to
 *    isHeaderlessCsv so the sample can be resolved again later.
 *
 * Duplicate handling is pinned against what core parseCsvWithHeaders ACTUALLY
 * does (last position with the name wins, the earlier column is lost) rather
 * than against a rule invented for this tab.
 */

import { describe, expect, it } from "vitest";
import type { ParsedSample, TaggedSample } from "@soc/core";
import { isPositionalFieldName, parseSampleContent } from "@soc/core";
import { buildTaggedSample } from "./sample-intake-state";
import {
  isHeaderlessCsvSample,
  parseHeaderFileText,
  resolveHeaders,
  sanitizeColumnName,
  toResolutionItem,
} from "./csv-resolution-state";
import {
  EMPTY_COLUMN_DRAFTS,
  buildColumnMappingRows,
  clearColumnDrafts,
  columnExamples,
  columnMappingProgressLabel,
  deriveColumnMappingSummary,
  resolvedColumnNames,
  setColumnDraft,
} from "./csv-column-mapping";
import type { ColumnDrafts, MappableItem } from "./csv-column-mapping";

// A 6-column headerless feed. The port column repeats a value and the flag
// column is mostly zeros - the exact shape the design argues about, where one
// row's value is ambiguous and four rows' values are not.
const GENERIC_ROWS = [
  "2026-07-05,10.0.0.1,443,allow,web,0",
  "2026-07-05,10.0.0.2,80,deny,web,0",
  "2026-07-05,10.0.0.3,443,allow,web,1",
  "2026-07-05,10.0.0.4,22,allow,ssh,0",
];

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

/** The item under test, straight from a real headerless parse. */
function genericItem() {
  return toResolutionItem(headerlessCsvSample("Web", GENERIC_ROWS));
}

/** Build drafts from an index -> typed-text map. */
function draftsOf(entries: Record<number, string>): ColumnDrafts {
  let drafts = EMPTY_COLUMN_DRAFTS;
  for (const [index, text] of Object.entries(entries)) {
    drafts = setColumnDraft(drafts, Number(index), text);
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe("setColumnDraft", () => {
  it("records a typed name at its position without touching the others", () => {
    const drafts = draftsOf({ 1: "src_ip", 3: "action" });
    expect(Object.keys(drafts)).toHaveLength(2);
    expect(drafts[1]).toBe("src_ip");
    expect(drafts[3]).toBe("action");
    expect(drafts[0]).toBeUndefined();
  });

  it("REMOVES the key when the input is cleared, so the position is unmapped again", () => {
    const drafts = setColumnDraft(draftsOf({ 1: "src_ip" }), 1, "");
    // Not stored as "" - the position returns to genuinely unnamed.
    expect(Object.keys(drafts)).toHaveLength(0);
    expect(Object.prototype.hasOwnProperty.call(drafts, 1)).toBe(false);
  });

  it("does not mutate the drafts it was given", () => {
    const before = draftsOf({ 0: "time" });
    const after = setColumnDraft(before, 1, "src");
    expect(Object.keys(before)).toHaveLength(1);
    expect(Object.keys(after)).toHaveLength(2);
  });

  it("clearColumnDrafts returns to nothing named", () => {
    expect(Object.keys(clearColumnDrafts())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Example values - the affordance
// ---------------------------------------------------------------------------

describe("columnExamples", () => {
  it("gives several rows' values for one position, in row order", () => {
    // The whole point: `443, 80, 443, 22` identifies a port column where a lone
    // `443` merely hints at one.
    expect(columnExamples(GENERIC_ROWS, 2)).toEqual(["443", "80", "443", "22"]);
  });

  it("KEEPS repeats, because the repetition is the signal", () => {
    // A flag column reads as a flag column precisely because it is mostly one
    // value; deduping to ["0","1"] would throw that away.
    expect(columnExamples(GENERIC_ROWS, 5)).toEqual(["0", "0", "1", "0"]);
  });

  it("yields empty strings for a position no row reaches", () => {
    expect(columnExamples(GENERIC_ROWS, 99)).toEqual(["", "", "", ""]);
  });

  it("splits the way the core parser will (quotes stripped, values trimmed)", () => {
    expect(columnExamples(['"a", b ,"c"'], 1)).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// Row derivation
// ---------------------------------------------------------------------------

describe("buildColumnMappingRows", () => {
  it("offers EVERY position a name, each carrying its own real values", () => {
    const rows = buildColumnMappingRows(genericItem(), EMPTY_COLUMN_DRAFTS);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows.map((r) => r.positionalName)).toEqual([
      "_0",
      "_1",
      "_2",
      "_3",
      "_4",
      "_5",
    ]);
    expect(rows[1].examples).toEqual([
      "10.0.0.1",
      "10.0.0.2",
      "10.0.0.3",
      "10.0.0.4",
    ]);
  });

  it("NEVER invents a name: an untouched mapping names nothing", () => {
    const rows = buildColumnMappingRows(genericItem(), EMPTY_COLUMN_DRAFTS);
    // Values that look exactly like IP addresses, dates, ports and verbs, and
    // still not one guessed name among them.
    expect(rows.filter((r) => r.mapped)).toHaveLength(0);
    expect(rows.every((r) => r.name === "")).toBe(true);
  });

  it("cleans a typed name with the SAME rules as the pasted header row", () => {
    const rows = buildColumnMappingRows(
      genericItem(),
      draftsOf({ 0: " dst-port ", 1: '"src ip"', 2: "_leadus" }),
    );
    expect(rows[0].name).toBe("dst_port");
    expect(rows[1].name).toBe("src_ip");
    expect(rows[2].name).toBe("leadus");
    // ...and they are the same rules because it is the same function.
    expect(parseHeaderFileText("dst-port")).toEqual([
      sanitizeColumnName("dst-port"),
    ]);
  });

  it("keeps the raw draft so the input never fights the operator mid-word", () => {
    const rows = buildColumnMappingRows(genericItem(), draftsOf({ 0: "src " }));
    expect(rows[0].draft).toBe("src ");
    expect(rows[0].name).toBe("src");
  });

  it("marks a name that sanitizes away as invalid and leaves the position unmapped", () => {
    const rows = buildColumnMappingRows(
      genericItem(),
      draftsOf({ 0: "!!!", 1: "   " }),
    );
    expect(rows[0].invalid).toBe(true);
    expect(rows[0].mapped).toBe(false);
    expect(rows[0].name).toBe("");
    // Whitespace alone is not an error, it is just an untouched position.
    expect(rows[1].invalid).toBe(false);
    expect(rows[1].mapped).toBe(false);
  });

  it("an operator CANNOT type a name that collides with the positional namespace", () => {
    // Leading underscores are stripped, so "_3" becomes "3" - a named column is
    // never mistaken for an unnamed one.
    const rows = buildColumnMappingRows(genericItem(), draftsOf({ 0: "_3" }));
    expect(rows[0].name).toBe("3");
    // The shared preview decides "unmapped" from the NAME via core's predicate,
    // so this property is what keeps a named column out of the unmapped count.
    expect(isPositionalFieldName(rows[0].name)).toBe(false);
    expect(isPositionalFieldName(rows[0].positionalName)).toBe(true);
  });

  it("still returns one row per position when the sample has no example rows", () => {
    const bare: MappableItem = { columnCount: 3, firstRows: [] };
    const rows = buildColumnMappingRows(bare, EMPTY_COLUMN_DRAFTS);
    expect(rows).toHaveLength(3);
    expect(rows[0].examples).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Summary: partial naming is the normal case
// ---------------------------------------------------------------------------

describe("deriveColumnMappingSummary", () => {
  it("counts a PARTIAL definition as partial, not as broken", () => {
    const rows = buildColumnMappingRows(
      genericItem(),
      draftsOf({ 1: "src_ip", 3: "action" }),
    );
    const summary = deriveColumnMappingSummary(rows);
    expect(summary).toEqual({
      namedCount: 2,
      unnamedCount: 4,
      totalCount: 6,
      duplicateNames: [],
      invalidPositions: [],
      ready: true,
    });
  });

  it("is not ready with nothing named (applying would equal skipping)", () => {
    const rows = buildColumnMappingRows(genericItem(), EMPTY_COLUMN_DRAFTS);
    const summary = deriveColumnMappingSummary(rows);
    expect(summary.namedCount).toBe(0);
    expect(summary.unnamedCount).toBe(6);
    expect(summary.ready).toBe(false);
  });

  it("reports each duplicated name once and every colliding position", () => {
    const rows = buildColumnMappingRows(
      genericItem(),
      draftsOf({ 1: "src", 3: "src", 4: "app", 5: "app" }),
    );
    const summary = deriveColumnMappingSummary(rows);
    expect(summary.duplicateNames).toEqual(["src", "app"]);
    expect(rows.filter((r) => r.duplicate).map((r) => r.index)).toEqual([
      1, 3, 4, 5,
    ]);
    // The colliding positions are still counted as named - the collapse is
    // surfaced, not prevented by silently discarding one of them.
    expect(summary.namedCount).toBe(4);
    expect(summary.ready).toBe(true);
  });

  it("treats names that only collide AFTER cleaning as duplicates", () => {
    const rows = buildColumnMappingRows(
      genericItem(),
      draftsOf({ 0: "src ip", 1: "src-ip" }),
    );
    // Both clean to src_ip, so both would key the same field.
    expect(deriveColumnMappingSummary(rows).duplicateNames).toEqual(["src_ip"]);
  });

  it("lists the positions whose typed text sanitized away", () => {
    const rows = buildColumnMappingRows(
      genericItem(),
      draftsOf({ 0: "ok", 2: "!!!", 4: "###" }),
    );
    const summary = deriveColumnMappingSummary(rows);
    expect(summary.invalidPositions).toEqual([2, 4]);
    expect(summary.namedCount).toBe(1);
  });
});

describe("columnMappingProgressLabel", () => {
  it("says how much of the definition is covered", () => {
    const rows = buildColumnMappingRows(
      genericItem(),
      draftsOf({ 1: "src_ip", 3: "action" }),
    );
    expect(columnMappingProgressLabel(deriveColumnMappingSummary(rows))).toBe(
      "2 of 6 columns named, 4 stay positional.",
    );
  });

  it("says nothing is named when nothing is", () => {
    const rows = buildColumnMappingRows(genericItem(), EMPTY_COLUMN_DRAFTS);
    expect(
      columnMappingProgressLabel(deriveColumnMappingSummary(rows)),
    ).toContain("No columns named yet");
  });
});

// ---------------------------------------------------------------------------
// Resolved names: one per column, positional where unnamed
// ---------------------------------------------------------------------------

describe("resolvedColumnNames", () => {
  it("fills every unnamed position with its positional name", () => {
    const rows = buildColumnMappingRows(
      genericItem(),
      draftsOf({ 1: "src_ip", 3: "action" }),
    );
    expect(resolvedColumnNames(rows)).toEqual([
      "_0",
      "src_ip",
      "_2",
      "action",
      "_4",
      "_5",
    ]);
  });

  it("always produces exactly one name per column, so this path never mismatches", () => {
    const item = genericItem();
    const rows = buildColumnMappingRows(item, draftsOf({ 0: "time" }));
    expect(resolvedColumnNames(rows)).toHaveLength(item.columnCount);
  });
});

// ---------------------------------------------------------------------------
// ROUND TRIP through the real core parser
// ---------------------------------------------------------------------------

describe("apply round trip (core parseCsvWithHeaders)", () => {
  it("names the mapped columns and leaves the rest POSITIONAL WITH THEIR VALUES", () => {
    const item = genericItem();
    const rows = buildColumnMappingRows(
      item,
      draftsOf({ 1: "src_ip", 3: "action" }),
    );
    const resolved = resolveHeaders(item, resolvedColumnNames(rows));

    const names = resolved.parsed.fields.map((f) => f.name);
    // Nothing lost: 6 columns in, 6 fields out.
    expect(names).toHaveLength(6);
    expect(names).toEqual(["_0", "src_ip", "_2", "action", "_4", "_5"]);

    const first = resolved.parsed.records[0];
    expect(first.src_ip).toBe("10.0.0.1");
    expect(first.action).toBe("allow");
    // The unnamed positions still carry their data.
    expect(first._2).toBe("443");
    expect(first._5).toBe("0");
    // Re-keyed onto the same log type, still CSV.
    expect(resolved.logType).toBe("Web");
    expect(resolved.format).toBe("csv");
  });

  it("leaves the re-parsed sample RESOLVABLE AGAIN, since most columns are still unnamed", () => {
    const item = genericItem();
    const rows = buildColumnMappingRows(item, draftsOf({ 1: "src_ip" }));
    const resolved = resolveHeaders(item, resolvedColumnNames(rows));
    // 5 of 6 fields are still positional, so the dialog will offer itself again
    // and the operator can finish the definition later.
    expect(isHeaderlessCsvSample(resolved)).toBe(true);
    const again = toResolutionItem(resolved);
    expect(again.columnCount).toBe(6);
    const reRows = buildColumnMappingRows(again, EMPTY_COLUMN_DRAFTS);
    expect(deriveColumnMappingSummary(reRows).unnamedCount).toBe(6);
  });

  it("CONTRAST: blank names would delete the columns nobody named", () => {
    // This is why resolvedColumnNames fills in positional names rather than "".
    // parseCsvWithHeaders discards the value under an empty header, so a partial
    // definition expressed with blanks silently destroys 4 of the 6 columns.
    const item = genericItem();
    const withBlanks = resolveHeaders(item, [
      "",
      "src_ip",
      "",
      "action",
      "",
      "",
    ]);
    expect(withBlanks.parsed.fields.map((f) => f.name)).toEqual([
      "src_ip",
      "action",
    ]);
    expect(withBlanks.parsed.records[0]._2).toBeUndefined();
  });

  it("duplicate names COLLAPSE - the later position wins and the earlier column is lost", () => {
    const item = genericItem();
    const rows = buildColumnMappingRows(
      item,
      draftsOf({ 1: "src", 3: "src" }),
    );
    const resolved = resolveHeaders(item, resolvedColumnNames(rows));
    const names = resolved.parsed.fields.map((f) => f.name);
    // 6 columns, 5 fields: two positions keyed one field.
    expect(names).toHaveLength(5);
    expect(names.filter((n) => n === "src")).toHaveLength(1);
    // Position 3 won; position 1's 10.0.0.1 is gone. Pinned as the REASON the
    // duplicate warning exists, not as behaviour anyone wants.
    expect(resolved.parsed.records[0].src).toBe("allow");
    expect(deriveColumnMappingSummary(rows).duplicateNames).toEqual(["src"]);
  });

  it("naming ALL of them leaves nothing positional", () => {
    const item = genericItem();
    const rows = buildColumnMappingRows(
      item,
      draftsOf({
        0: "ts",
        1: "src_ip",
        2: "dport",
        3: "action",
        4: "app",
        5: "flag",
      }),
    );
    const summary = deriveColumnMappingSummary(rows);
    expect(summary.unnamedCount).toBe(0);
    const resolved = resolveHeaders(item, resolvedColumnNames(rows));
    expect(resolved.parsed.fields.map((f) => f.name)).toEqual([
      "ts",
      "src_ip",
      "dport",
      "action",
      "app",
      "flag",
    ]);
    expect(isHeaderlessCsvSample(resolved)).toBe(false);
  });
});
