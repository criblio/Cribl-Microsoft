/**
 * Tests for the match-preview PURE projection (porting-plan Unit 13 UI). The
 * matcher's truth (scoring, overflow routing, the AdditionalData_d-missing
 * warning) is pinned in @soc/core's field-matcher tests; these pin the
 * BINDING layer this screen adds: stat derivation, per-field row projection,
 * and honest warning surfacing (never fabricating a warning the core did not
 * report). One end-to-end case runs the real matcher so the projection is
 * exercised over an actual MatchResult, including the overflow-loss warning.
 */

import { describe, expect, it } from "vitest";
import { matchParsedSampleToColumns } from "@soc/core";
import type {
  DiscoveredField,
  FieldMatch,
  MatchResult,
  ParsedSample,
} from "@soc/core";
import {
  MATCH_PREVIEW_NO_SAMPLE_REASON,
  MATCH_PREVIEW_NO_TABLE_REASON,
  deriveMatchPreview,
  deriveMatchRows,
  deriveMatchStats,
  deriveMatchWarnings,
  formatRowRoute,
  matchPreviewEmptyReason,
  matchRatePercent,
} from "./match-preview-state";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeMatch(over: Partial<FieldMatch> & Pick<FieldMatch, "sourceName">): FieldMatch {
  return {
    sourceName: over.sourceName,
    sourceType: over.sourceType ?? "string",
    destName: over.destName ?? over.sourceName,
    destType: over.destType ?? "string",
    confidence: over.confidence ?? "exact",
    action: over.action ?? "keep",
    needsCoercion: over.needsCoercion ?? false,
    description: over.description ?? "matched",
    ...(over.sampleValue !== undefined ? { sampleValue: over.sampleValue } : {}),
  };
}

function makeResult(over: Partial<MatchResult>): MatchResult {
  const matched = over.matched ?? [];
  const overflow = over.overflow ?? [];
  const unmatchedSource = over.unmatchedSource ?? [];
  return {
    matched,
    overflow,
    unmatchedSource,
    unmatchedDest: over.unmatchedDest ?? [],
    overflowConfig: over.overflowConfig ?? {
      enabled: overflow.length > 0,
      fieldName: "AdditionalExtensions",
      fieldType: "string",
      sourceFields: overflow.map((o) => o.sourceName),
    },
    totalSource:
      over.totalSource ??
      matched.length + overflow.length + unmatchedSource.length,
    totalDest: over.totalDest ?? 10,
    matchRate: over.matchRate ?? 0,
    warnings: over.warnings ?? [],
  };
}

function makeField(name: string, type: string, example?: string): DiscoveredField {
  return {
    name,
    type: type as DiscoveredField["type"],
    types: [type as DiscoveredField["type"]],
    examples: example !== undefined ? [example] : [],
    occurrence: 1,
    required: true,
  };
}

function makeParsed(fields: DiscoveredField[]): ParsedSample {
  return {
    format: "json",
    records: [],
    eventCount: 1,
    fields,
    rawEvents: [],
    sourceName: "test",
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Stat derivation
// ---------------------------------------------------------------------------

describe("deriveMatchStats", () => {
  it("maps counts onto the legacy vocabulary in a fixed order", () => {
    const result = makeResult({
      matched: [makeMatch({ sourceName: "a" }), makeMatch({ sourceName: "b" })],
      overflow: [makeMatch({ sourceName: "x", action: "overflow" })],
      unmatchedSource: [{ name: "y", type: "string" }],
      totalSource: 4,
      totalDest: 12,
    });
    const stats = deriveMatchStats(result);
    expect(stats.map((s) => s.key)).toEqual([
      "source-fields",
      "dest-columns",
      "passthrough",
      "overflow",
      "unmatched",
    ]);
    expect(stats.map((s) => s.label)).toEqual([
      "Source Fields",
      "Dest Columns",
      "Passthrough",
      "Overflow",
      "Unmatched",
    ]);
    expect(stats.map((s) => s.value)).toEqual([4, 12, 2, 1, 1]);
  });

  it("tints Passthrough ok, and Unmatched warn only when fields are dropped", () => {
    const withDrops = deriveMatchStats(
      makeResult({
        matched: [makeMatch({ sourceName: "a" })],
        unmatchedSource: [{ name: "y", type: "string" }],
      }),
    );
    const byKey = Object.fromEntries(withDrops.map((s) => [s.key, s.tone]));
    expect(byKey["passthrough"]).toBe("ok");
    expect(byKey["unmatched"]).toBe("warn");

    const clean = deriveMatchStats(makeResult({ matched: [], unmatchedSource: [] }));
    expect(Object.fromEntries(clean.map((s) => [s.key, s.tone]))["unmatched"]).toBe(
      "neutral",
    );
  });

  it("tints Overflow warn ONLY when overflow fields exist but cannot be preserved", () => {
    const lossy = deriveMatchStats(
      makeResult({
        overflow: [makeMatch({ sourceName: "x", action: "overflow" })],
        overflowConfig: {
          enabled: false,
          fieldName: "AdditionalData_d",
          fieldType: "dynamic",
          sourceFields: ["x"],
        },
      }),
    );
    expect(Object.fromEntries(lossy.map((s) => [s.key, s.tone]))["overflow"]).toBe(
      "warn",
    );

    const preserved = deriveMatchStats(
      makeResult({
        overflow: [makeMatch({ sourceName: "x", action: "overflow" })],
        overflowConfig: {
          enabled: true,
          fieldName: "AdditionalExtensions",
          fieldType: "string",
          sourceFields: ["x"],
        },
      }),
    );
    expect(
      Object.fromEntries(preserved.map((s) => [s.key, s.tone]))["overflow"],
    ).toBe("neutral");
  });
});

describe("matchRatePercent", () => {
  it("rounds the 0-1 rate to an integer percent", () => {
    expect(matchRatePercent(makeResult({ matchRate: 0 }))).toBe(0);
    expect(matchRatePercent(makeResult({ matchRate: 1 }))).toBe(100);
    expect(matchRatePercent(makeResult({ matchRate: 2 / 3 }))).toBe(67);
  });
});

// ---------------------------------------------------------------------------
// Row projection
// ---------------------------------------------------------------------------

describe("deriveMatchRows", () => {
  it("orders matched, then overflow, then dropped, with stable keys", () => {
    const rows = deriveMatchRows(
      makeResult({
        matched: [makeMatch({ sourceName: "a", destName: "ColA" })],
        overflow: [makeMatch({ sourceName: "x", action: "overflow", destName: "AdditionalExtensions" })],
        unmatchedSource: [{ name: "y", type: "int" }],
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["matched", "overflow", "unmatched"]);
    expect(rows.map((r) => r.key)).toEqual([
      "matched:a",
      "overflow:x",
      "unmatched:y",
    ]);
  });

  it("projects a dropped field with null destination, null action, and unmatched confidence", () => {
    const [row] = deriveMatchRows(
      makeResult({ unmatchedSource: [{ name: "y", type: "int", sampleValue: "5" }] }),
    );
    expect(row.destName).toBeNull();
    expect(row.destType).toBeNull();
    expect(row.action).toBeNull();
    expect(row.confidence).toBe("unmatched");
    expect(row.sampleValue).toBe("5");
    expect(row.sourceType).toBe("int");
  });

  it("carries the matcher's fields through on a matched row (sampleValue defaults to null)", () => {
    const [row] = deriveMatchRows(
      makeResult({
        matched: [
          makeMatch({
            sourceName: "src",
            destName: "Dest",
            confidence: "alias",
            action: "rename",
            needsCoercion: true,
            sourceType: "string",
            destType: "int",
            description: "alias hit",
          }),
        ],
      }),
    );
    expect(row).toMatchObject({
      kind: "matched",
      sourceName: "src",
      destName: "Dest",
      confidence: "alias",
      action: "rename",
      needsCoercion: true,
      description: "alias hit",
      sampleValue: null,
    });
  });
});

describe("formatRowRoute", () => {
  it("renders keep, rename, overflow, and dropped routes with an ASCII arrow", () => {
    const [keep] = deriveMatchRows(
      makeResult({ matched: [makeMatch({ sourceName: "TimeGenerated", destName: "TimeGenerated" })] }),
    );
    const [rename] = deriveMatchRows(
      makeResult({ matched: [makeMatch({ sourceName: "src", destName: "Dest" })] }),
    );
    const [overflow] = deriveMatchRows(
      makeResult({ overflow: [makeMatch({ sourceName: "x", action: "overflow", destName: "AdditionalExtensions" })] }),
    );
    const [dropped] = deriveMatchRows(
      makeResult({ unmatchedSource: [{ name: "junk", type: "string" }] }),
    );
    expect(formatRowRoute(keep)).toBe("TimeGenerated");
    expect(formatRowRoute(rename)).toBe("src -> Dest");
    expect(formatRowRoute(overflow)).toBe("x -> AdditionalExtensions (overflow)");
    expect(formatRowRoute(dropped)).toBe("junk (dropped)");
  });
});

// ---------------------------------------------------------------------------
// Warning surfacing (honest: only what the core reports)
// ---------------------------------------------------------------------------

describe("deriveMatchWarnings", () => {
  it("is empty on a clean match", () => {
    expect(deriveMatchWarnings(makeResult({ warnings: [] }))).toEqual([]);
  });

  it("surfaces the core's text verbatim and classifies the overflow-loss (AdditionalData_d) case", () => {
    const text =
      '1 unmatched field(s) cannot be preserved: the overflow column ' +
      '"AdditionalData_d" is absent from the MyVendor_CL schema, so these ' +
      "fields are dropped.";
    const warnings = deriveMatchWarnings(
      makeResult({
        overflow: [makeMatch({ sourceName: "x", action: "overflow" })],
        overflowConfig: {
          enabled: false,
          fieldName: "AdditionalData_d",
          fieldType: "dynamic",
          sourceFields: ["x"],
        },
        totalDest: 5,
        warnings: [text],
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("overflow-loss");
    expect(warnings[0].text).toBe(text);
  });

  it("classifies the unresolved-schema warning as no-schema", () => {
    const warnings = deriveMatchWarnings(
      makeResult({
        overflow: [],
        totalDest: 0,
        warnings: ['No destination schema resolved for table "Nope".'],
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("no-schema");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("matchPreviewEmptyReason", () => {
  it("asks for a sample first, then a table, then clears", () => {
    expect(matchPreviewEmptyReason({ hasSample: false, tableName: "" })).toBe(
      MATCH_PREVIEW_NO_SAMPLE_REASON,
    );
    expect(
      matchPreviewEmptyReason({ hasSample: false, tableName: "CommonSecurityLog" }),
    ).toBe(MATCH_PREVIEW_NO_SAMPLE_REASON);
    expect(matchPreviewEmptyReason({ hasSample: true, tableName: "   " })).toBe(
      MATCH_PREVIEW_NO_TABLE_REASON,
    );
    expect(
      matchPreviewEmptyReason({ hasSample: true, tableName: "CommonSecurityLog" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Composition + end-to-end over the real matcher
// ---------------------------------------------------------------------------

describe("deriveMatchPreview", () => {
  it("composes stats, rows, warnings, rate, and the overflow config passthrough", () => {
    const result = makeResult({
      matched: [makeMatch({ sourceName: "a" })],
      overflow: [makeMatch({ sourceName: "x", action: "overflow", destName: "AdditionalExtensions" })],
      overflowConfig: {
        enabled: true,
        fieldName: "AdditionalExtensions",
        fieldType: "string",
        sourceFields: ["x"],
      },
      matchRate: 1,
    });
    const view = deriveMatchPreview(result);
    expect(view.stats).toHaveLength(5);
    expect(view.rows).toHaveLength(2);
    expect(view.matchRatePercent).toBe(100);
    expect(view.overflowFieldName).toBe("AdditionalExtensions");
    expect(view.overflowEnabled).toBe(true);
  });

  it("projects a real MatchResult and surfaces the AdditionalData_d loss for a _CL table missing it", () => {
    // A _CL table whose schema lacks AdditionalData_d: an unmatched vendor
    // field routes to overflow, but the column is absent, so the core reports
    // the loss and the projection surfaces it as an overflow-loss warning.
    const sample = makeParsed([
      makeField("TimeGenerated", "datetime", "2026-07-05T00:00:00Z"),
      makeField("weirdVendorField", "string", "abc"),
    ]);
    const columns = [{ name: "TimeGenerated", type: "datetime" }];
    const result = matchParsedSampleToColumns(sample, columns, "MyVendor_CL");
    const view = deriveMatchPreview(result);

    const overflowStat = view.stats.find((s) => s.key === "overflow");
    expect(overflowStat?.value).toBe(1);
    expect(overflowStat?.tone).toBe("warn");
    expect(view.overflowEnabled).toBe(false);
    expect(view.warnings).toHaveLength(1);
    expect(view.warnings[0].kind).toBe("overflow-loss");
    expect(view.warnings[0].text).toContain("AdditionalData_d");
  });

  it("projects an all-unmatched result as a no-schema warning when the table is unknown", () => {
    const sample = makeParsed([makeField("anything", "string", "v")]);
    const result = matchParsedSampleToColumns(sample, null, "DoesNotExist");
    const view = deriveMatchPreview(result);
    expect(view.stats.find((s) => s.key === "dest-columns")?.value).toBe(0);
    expect(view.warnings[0].kind).toBe("no-schema");
    expect(view.rows.every((r) => r.kind === "unmatched")).toBe(true);
  });
});
