import { describe, it, expect } from "vitest";
import { buildGapReport } from "./gap-report";
import { internalCollisionWarning } from "./analyze-dcr-gap";
import type { MatchResult } from "../field-matcher/models";
import type { DcrGapAnalysis, FieldRef } from "./models";

const MATCH: MatchResult = {
  matched: [
    {
      sourceName: "a",
      sourceType: "string",
      destName: "a",
      destType: "string",
      confidence: "exact",
      action: "keep",
      needsCoercion: false,
      description: "exact match",
      sampleValue: "x",
    },
    {
      sourceName: "b",
      sourceType: "string",
      destName: "DestB",
      destType: "string",
      confidence: "alias",
      action: "rename",
      needsCoercion: false,
      description: "alias b->DestB",
    },
    {
      sourceName: "c",
      sourceType: "real",
      destName: "c",
      destType: "long",
      confidence: "exact",
      action: "coerce",
      needsCoercion: true,
      description: "coerce real->long",
    },
  ],
  overflow: [
    {
      sourceName: "d",
      sourceType: "string",
      destName: "AdditionalData_d",
      destType: "dynamic",
      confidence: "unmatched",
      action: "overflow",
      needsCoercion: false,
      description: "into overflow",
    },
  ],
  unmatchedSource: [],
  unmatchedDest: [],
  overflowConfig: {
    enabled: false,
    fieldName: "AdditionalData_d",
    fieldType: "dynamic",
    sourceFields: ["d"],
  },
  totalSource: 4,
  totalDest: 3,
  matchRate: 1,
  warnings: ["overflow column AdditionalData_d absent - fields dropped"],
};

const GAP: DcrGapAnalysis = {
  tableName: "T_CL",
  dcrHandles: {
    renames: [{ source: "x1", dest: "y1" }],
    coercions: [
      { field: "z1", toType: "long" },
      { field: "z2", toType: "real" },
    ],
    routing: "true",
    timeGenerated: true,
  },
  criblMustHandle: {
    renames: [],
    coercions: [],
    overflow: [],
    drops: [],
    enrichments: [{ field: "Type", value: "'T_CL'" }],
  },
  totalSourceFields: 4,
  totalDestFields: 3,
  passthroughCount: 1,
  dcrHandledCount: 5,
  criblHandledCount: 8,
  overflowCount: 1,
  warnings: ['Source field "source" collides with a Cribl-internal field name'],
};

const DEST_SCHEMA: FieldRef[] = [
  { name: "a", type: "string" },
  { name: "DestB", type: "string" },
  { name: "c", type: "long" },
];

describe("buildGapReport composes the two engines into six tiles", () => {
  const report = buildGapReport({
    tableName: "T_CL",
    logType: "my-log",
    matchResult: MATCH,
    gap: GAP,
    routeCondition: "event_simpleName == 'X'",
    destSchema: DEST_SCHEMA,
  });

  it("emits exactly the six tiles in canonical order with verbatim labels", () => {
    expect(report.stats.map((s) => s.key)).toEqual([
      "source-fields",
      "dest-columns",
      "passthrough",
      "dcr-handles",
      "cribl-handles",
      "overflow",
    ]);
    expect(report.stats.map((s) => s.label)).toEqual([
      "Source Fields",
      "Dest Columns",
      "Passthrough",
      "DCR Handles",
      "Cribl Handles",
      "Overflow",
    ]);
    for (const stat of report.stats) {
      expect(stat.hint.length).toBeGreaterThan(0);
    }
  });

  it("takes user-facing counts from the matcher and DCR Handles from gap analysis", () => {
    const byKey = new Map(report.stats.map((s) => [s.key, s.value]));
    expect(byKey.get("source-fields")).toBe(4); // matcher totalSource
    expect(byKey.get("dest-columns")).toBe(3); // matcher totalDest
    expect(byKey.get("passthrough")).toBe(1); // matcher keep && !coerce
    expect(byKey.get("dcr-handles")).toBe(5); // gap.dcrHandledCount
    expect(byKey.get("cribl-handles")).toBe(2); // matcher rename + coerce
    expect(byKey.get("overflow")).toBe(1); // matcher overflow
  });

  it("tones flag overflow as warn and highlight the active engines", () => {
    const tone = (k: string) => report.stats.find((s) => s.key === k)?.tone;
    expect(tone("passthrough")).toBe("ok");
    expect(tone("dcr-handles")).toBe("info");
    expect(tone("cribl-handles")).toBe("info");
    expect(tone("overflow")).toBe("warn");
  });

  it("builds the verbatim summary strings", () => {
    expect(report.dcrHandlesSummary).toBe("DCR handles: 1 rename(s), 2 coercion(s)");
    expect(report.criblHandlesSummary).toBe(
      "Cribl handles: 1 rename(s), 1 coercion(s)",
    );
  });

  it("projects cribl renames/coercions from the matcher", () => {
    expect(report.criblRenames).toEqual([
      { source: "b", dest: "DestB", reason: "alias b->DestB" },
    ]);
    expect(report.criblCoercions).toEqual([
      { field: "c", fromType: "real", toType: "long" },
    ]);
  });

  it("carries the DCR renames/coercions and the route condition", () => {
    expect(report.dcrRenames).toEqual([{ source: "x1", dest: "y1" }]);
    expect(report.dcrCoercions).toEqual([
      { field: "z1", toType: "long" },
      { field: "z2", toType: "real" },
    ]);
    expect(report.routeCondition).toBe("event_simpleName == 'X'");
  });

  it("field mappings are matched then overflow rows", () => {
    expect(report.fieldMappings.map((m) => m.source)).toEqual(["a", "b", "c", "d"]);
    expect(report.fieldMappings[3].action).toBe("overflow");
    expect(report.fieldMappings[3].confidence).toBe("unmatched");
  });

  it("flags lossy overflow and merges both engines' warnings (deduped)", () => {
    expect(report.overflowLossy).toBe(true);
    expect(report.warnings).toEqual([
      'Source field "source" collides with a Cribl-internal field name',
      "overflow column AdditionalData_d absent - fields dropped",
    ]);
  });

  it("defaults the route condition to 'true' when omitted", () => {
    const r = buildGapReport({
      tableName: "T_CL",
      logType: "my-log",
      matchResult: MATCH,
      gap: GAP,
      destSchema: DEST_SCHEMA,
    });
    expect(r.routeCondition).toBe("true");
  });
});

describe("matcher-claimed internal-name collisions (Zscaler host, 2026-07-12)", () => {
  // The gap engine warns that "host" is dropped as internal metadata, but the
  // vendor pack maps host->DestinationHostName and the rename runs in the
  // enrich group BEFORE the cleanup drop - the value survives. The composed
  // report must resolve the false alarm into the informational note.
  const withHost = (destName: string): MatchResult => ({
    ...MATCH,
    matched: [
      ...MATCH.matched,
      {
        sourceName: "host",
        sourceType: "string",
        destName,
        destType: "string",
        confidence: "alias",
        action: destName === "" ? "drop" : "rename",
        needsCoercion: false,
        description: "Vendor mapping",
      },
    ],
  });
  const gapWithHostWarning: DcrGapAnalysis = {
    ...GAP,
    warnings: [internalCollisionWarning("host")],
  };

  it("resolves the data-loss warning into a preserved note when claimed", () => {
    const report = buildGapReport({
      tableName: "CommonSecurityLog",
      logType: "web",
      matchResult: withHost("DestinationHostName"),
      gap: gapWithHostWarning,
      destSchema: DEST_SCHEMA,
    });
    expect(report.warnings[0]).toBe(
      'Source field "host" shares a Cribl-internal field name, but the ' +
        "pipeline maps it to DestinationHostName before the internal " +
        "cleanup, so the vendor value is preserved.",
    );
    expect(report.warnings.join("\n")).not.toContain("DROPPED as internal");
  });

  it("keeps the data-loss warning when the matcher did NOT claim the field", () => {
    const report = buildGapReport({
      tableName: "CommonSecurityLog",
      logType: "web",
      matchResult: MATCH,
      gap: gapWithHostWarning,
      destSchema: DEST_SCHEMA,
    });
    expect(report.warnings[0]).toBe(internalCollisionWarning("host"));
  });

  it("keeps the warning when the only claim is a reviewer DROP (no column)", () => {
    const report = buildGapReport({
      tableName: "CommonSecurityLog",
      logType: "web",
      matchResult: withHost(""),
      gap: gapWithHostWarning,
      destSchema: DEST_SCHEMA,
    });
    expect(report.warnings[0]).toBe(internalCollisionWarning("host"));
  });
});
