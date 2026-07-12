/**
 * Tests for the mapping-review approval state machine (porting-plan Unit 18).
 * The gap-analysis TRUTH (tiles, mappings, handles split) is pinned in
 * @soc/core; these pin the REVIEW STATE this package owns:
 *   - approvals reset on re-analysis; edits survive; staleness clears
 *   - edits are keyed by logType and re-key on rename (the Unit 11 seam)
 *   - approvals re-key on rename too (no orphaned approval)
 *   - the content-path deploy gate (blocks until every table approved and
 *     fresh) - and its strict separation from the native path
 */
import { EMPTY_OVERFLOW_TRIAGE } from "@soc/core";
import { describe, expect, it } from "vitest";
import type { GapFieldMapping, GapReport } from "@soc/core";
import {
  INITIAL_MAPPING_REVIEW_STATE,
  MAPPING_REVIEW_STALE_NOTICE,
  OVERFLOW_COVERAGE_NOTE,
  analyzeButtonLabel,
  approvalBarText,
  deriveMappingReviewGate,
  effectiveMappings,
  fieldMappingsLabel,
  isApproved,
  isModified,
  isRuleField,
  mappingReviewReducer,
  sortedMappings,
  tablesWithMappings,
  unmappedDestColumns,
  pendingIdentitySeeds,
  pendingLabelSeeds,
} from "./mapping-review-state";
import type {
  MappingReviewAction,
  MappingReviewState,
} from "./mapping-review-state";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mapping(overrides: Partial<GapFieldMapping> = {}): GapFieldMapping {
  return {
    source: "src",
    dest: "DestColumn",
    sourceType: "string",
    destType: "string",
    confidence: "exact",
    action: "keep",
    needsCoercion: false,
    description: "exact match",
    ...overrides,
  };
}

function report(
  logType: string,
  mappings: GapFieldMapping[],
  overrides: Partial<GapReport> = {},
): GapReport {
  return {
    tableName: overrides.tableName ?? "CommonSecurityLog",
    logType,
    stats: [],
    sourceFieldCount: mappings.length,
    destFieldCount: 3,
    passthroughCount: 0,
    dcrHandledCount: 0,
    criblHandledCount: 0,
    overflowCount: 0,
    dcrRenames: [],
    dcrCoercions: [],
    criblRenames: [],
    criblCoercions: [],
    dcrHandlesSummary: "DCR handles: 0 rename(s), 0 coercion(s)",
    criblHandlesSummary: "Cribl handles: 0 rename(s), 0 coercion(s)",
    routeCondition: "true",
    fieldMappings: mappings,
    destSchema: [
      { name: "DestColumn", type: "string" },
      { name: "OtherColumn", type: "int" },
      { name: "TimeGenerated", type: "datetime" },
    ],
    overflowLossy: false,
    overflowTriage: EMPTY_OVERFLOW_TRIAGE,
    warnings: [],
    ...overrides,
  };
}

/** A state that has already been analyzed once (revision 1). */
function analyzed(
  overrides: Partial<MappingReviewState> = {},
): MappingReviewState {
  return {
    approvals: {},
    mappingEdits: {},
    stale: false,
    analysisRevision: 1,
    ...overrides,
  };
}

function reduce(
  state: MappingReviewState,
  ...actions: MappingReviewAction[]
): MappingReviewState {
  return actions.reduce(mappingReviewReducer, state);
}

// ---------------------------------------------------------------------------
// analyzed / inputs-changed
// ---------------------------------------------------------------------------

describe("analyzed", () => {
  it("advances the revision and clears staleness", () => {
    const next = mappingReviewReducer(INITIAL_MAPPING_REVIEW_STATE, {
      type: "analyzed",
    });
    expect(next.analysisRevision).toBe(1);
    expect(next.stale).toBe(false);
  });

  it("RESETS approvals but PRESERVES edits", () => {
    const edits = { Firewall: [mapping({ source: "a" })] };
    const start = analyzed({ approvals: { Firewall: true }, mappingEdits: edits });
    const next = mappingReviewReducer(start, { type: "analyzed" });
    expect(next.approvals).toEqual({});
    expect(next.mappingEdits).toBe(edits); // same reference: survived untouched
    expect(next.analysisRevision).toBe(2);
  });
});

describe("inputs-changed", () => {
  it("is a no-op before the first analysis", () => {
    const next = mappingReviewReducer(INITIAL_MAPPING_REVIEW_STATE, {
      type: "inputs-changed",
    });
    expect(next).toBe(INITIAL_MAPPING_REVIEW_STATE);
  });

  it("raises staleness after an analysis and is idempotent", () => {
    const start = analyzed({ approvals: { A: true } });
    const stale = mappingReviewReducer(start, { type: "inputs-changed" });
    expect(stale.stale).toBe(true);
    // approvals are kept (still visible) but the gate will not trust them
    expect(stale.approvals).toEqual({ A: true });
    // idempotent
    expect(mappingReviewReducer(stale, { type: "inputs-changed" })).toBe(stale);
  });

  it("re-analysis clears the staleness a change raised", () => {
    const start = analyzed({ approvals: { A: true } });
    const next = reduce(
      start,
      { type: "inputs-changed" },
      { type: "analyzed" },
    );
    expect(next.stale).toBe(false);
    expect(next.approvals).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// approve / unapprove / auto-approve-all / reset
// ---------------------------------------------------------------------------

describe("approve / unapprove", () => {
  it("approves and withdraws a single table", () => {
    const approved = mappingReviewReducer(analyzed(), {
      type: "approve",
      logType: "Firewall",
    });
    expect(isApproved(approved, "Firewall")).toBe(true);
    const withdrawn = mappingReviewReducer(approved, {
      type: "unapprove",
      logType: "Firewall",
    });
    expect(isApproved(withdrawn, "Firewall")).toBe(false);
  });

  it("approve is idempotent (same reference when already approved)", () => {
    const approved = mappingReviewReducer(analyzed(), {
      type: "approve",
      logType: "A",
    });
    expect(mappingReviewReducer(approved, { type: "approve", logType: "A" })).toBe(
      approved,
    );
  });

  it("auto-approve-all approves every listed table", () => {
    const next = mappingReviewReducer(analyzed(), {
      type: "auto-approve-all",
      logTypes: ["A", "B", "C"],
    });
    expect(next.approvals).toEqual({ A: true, B: true, C: true });
  });

  it("reset-approvals clears everything and is idempotent when empty", () => {
    const approved = mappingReviewReducer(analyzed(), {
      type: "auto-approve-all",
      logTypes: ["A", "B"],
    });
    const reset = mappingReviewReducer(approved, { type: "reset-approvals" });
    expect(reset.approvals).toEqual({});
    expect(mappingReviewReducer(reset, { type: "reset-approvals" })).toBe(reset);
  });
});

// ---------------------------------------------------------------------------
// edit-mapping
// ---------------------------------------------------------------------------

describe("edit-mapping", () => {
  const baseline = [
    mapping({ source: "srcA", dest: "ColA", action: "keep" }),
    mapping({ source: "srcB", dest: "ColB", action: "rename" }),
  ];

  it("seeds the edit store from the baseline on first edit and updates one field", () => {
    const next = mappingReviewReducer(analyzed(), {
      type: "edit-mapping",
      logType: "Firewall",
      sourceField: "srcB",
      field: "dest",
      value: "ColZ",
      baseline,
    });
    const rows = next.mappingEdits.Firewall;
    expect(rows).toHaveLength(2);
    expect(rows[1].dest).toBe("ColZ");
    expect(rows[0].dest).toBe("ColA"); // untouched row preserved
    expect(isModified(next, "Firewall")).toBe(true);
  });

  it("edits the action column", () => {
    const next = mappingReviewReducer(analyzed(), {
      type: "edit-mapping",
      logType: "Firewall",
      sourceField: "srcA",
      field: "action",
      value: "drop",
      baseline,
    });
    expect(next.mappingEdits.Firewall[0].action).toBe("drop");
  });

  it("edits accumulate over an already-edited table (uses the stored rows, not the baseline)", () => {
    const first = mappingReviewReducer(analyzed(), {
      type: "edit-mapping",
      logType: "Firewall",
      sourceField: "srcA",
      field: "dest",
      value: "ColA2",
      baseline,
    });
    const second = mappingReviewReducer(first, {
      type: "edit-mapping",
      logType: "Firewall",
      sourceField: "srcB",
      field: "action",
      value: "coerce",
      baseline: [], // ignored: the stored edits are the source of truth now
    });
    expect(second.mappingEdits.Firewall[0].dest).toBe("ColA2");
    expect(second.mappingEdits.Firewall[1].action).toBe("coerce");
  });

  it("is a no-op when no row matches the source field", () => {
    const state = analyzed();
    const next = mappingReviewReducer(state, {
      type: "edit-mapping",
      logType: "Firewall",
      sourceField: "does-not-exist",
      field: "dest",
      value: "X",
      baseline,
    });
    expect(next).toBe(state);
  });

  it("does not mutate the baseline array", () => {
    const original = baseline.map((m) => ({ ...m }));
    mappingReviewReducer(analyzed(), {
      type: "edit-mapping",
      logType: "Firewall",
      sourceField: "srcA",
      field: "dest",
      value: "Mutated?",
      baseline,
    });
    expect(baseline).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// rename-log-type: the Unit 11 re-key seam
// ---------------------------------------------------------------------------

describe("rename-log-type", () => {
  it("re-keys BOTH the approval and the edit store, orphaning neither", () => {
    const start = analyzed({
      approvals: { Old: true, Keep: true },
      mappingEdits: { Old: [mapping({ source: "x" })], Keep: [] },
    });
    const next = mappingReviewReducer(start, {
      type: "rename-log-type",
      from: "Old",
      to: "New",
    });
    // approval moved
    expect(isApproved(next, "New")).toBe(true);
    expect(isApproved(next, "Old")).toBe(false);
    expect(isApproved(next, "Keep")).toBe(true);
    // edit moved
    expect(next.mappingEdits.New).toEqual([mapping({ source: "x" })]);
    expect(next.mappingEdits.Old).toBeUndefined();
    expect(next.mappingEdits.Keep).toEqual([]);
  });

  it("normalizes the target key the same way sample intake does", () => {
    const start = analyzed({ approvals: { Old: true } });
    const next = mappingReviewReducer(start, {
      type: "rename-log-type",
      from: "Old",
      to: "  New Name  ",
    });
    // reKeyByLogType normalizes: trimmed, internal run kept as-is by the shared
    // primitive. The old key is gone and exactly one approval remains.
    expect(next.approvals.Old).toBeUndefined();
    expect(Object.keys(next.approvals)).toHaveLength(1);
  });

  it("is a harmless copy when the from key is absent", () => {
    const start = analyzed({ approvals: { A: true } });
    const next = mappingReviewReducer(start, {
      type: "rename-log-type",
      from: "missing",
      to: "other",
    });
    expect(next.approvals).toEqual({ A: true });
  });
});

// ---------------------------------------------------------------------------
// Selectors over reports
// ---------------------------------------------------------------------------

describe("effectiveMappings", () => {
  it("returns the report's mappings when the table is unedited", () => {
    const r = report("A", [mapping({ source: "orig" })]);
    expect(effectiveMappings(analyzed(), r)).toBe(r.fieldMappings);
  });

  it("returns the operator's edits when the table is edited", () => {
    const edits = [mapping({ source: "edited" })];
    const state = analyzed({ mappingEdits: { A: edits } });
    const r = report("A", [mapping({ source: "orig" })]);
    expect(effectiveMappings(state, r)).toBe(edits);
  });
});

describe("sortedMappings / unmappedDestColumns / fieldMappingsLabel", () => {
  it("sorts mappings by destination column name", () => {
    const rows = [
      mapping({ source: "b", dest: "Zeta" }),
      mapping({ source: "a", dest: "Alpha" }),
    ];
    expect(sortedMappings(rows).map((m) => m.dest)).toEqual(["Alpha", "Zeta"]);
  });

  it("lists destination columns with no source mapping, case-insensitively", () => {
    const r = report("A", [mapping({ source: "s", dest: "destcolumn" })]);
    const unmapped = unmappedDestColumns(r, r.fieldMappings);
    // DestColumn is covered case-insensitively; OtherColumn + TimeGenerated remain
    expect(unmapped.map((d) => d.name)).toEqual(["OtherColumn", "TimeGenerated"]);
  });

  it("formats the verbatim expander label", () => {
    expect(fieldMappingsLabel(5, 2)).toBe("Field Mappings (5 mapped, 2 unmapped)");
  });
});

describe("isRuleField (inert until Unit 23)", () => {
  it("is always false with no rule set", () => {
    expect(isRuleField("SourceIP")).toBe(false);
    expect(isRuleField("SourceIP", new Set())).toBe(false);
  });

  it("matches case-insensitively when a set is supplied (the future Unit 23 wiring)", () => {
    expect(isRuleField("SourceIP", new Set(["sourceip"]))).toBe(true);
    expect(isRuleField("Other", new Set(["sourceip"]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The content-path deploy gate, and its separation from the native path
// ---------------------------------------------------------------------------

describe("deriveMappingReviewGate", () => {
  const reports = [
    report("Firewall", [mapping({ source: "a" })]),
    report("Auth", [mapping({ source: "b" })]),
    report("Empty", []), // no mappings: not a table that needs approval
  ];

  it("counts only tables that have mappings", () => {
    expect(tablesWithMappings(reports).map((r) => r.logType)).toEqual([
      "Firewall",
      "Auth",
    ]);
    const gate = deriveMappingReviewGate(analyzed(), reports);
    expect(gate.total).toBe(2);
  });

  it("is NOT ready until every table with mappings is approved", () => {
    const none = deriveMappingReviewGate(analyzed(), reports);
    expect(none.ready).toBe(false);
    expect(none.allApproved).toBe(false);

    const partial = deriveMappingReviewGate(
      analyzed({ approvals: { Firewall: true } }),
      reports,
    );
    expect(partial.approved).toBe(1);
    expect(partial.ready).toBe(false);

    const all = deriveMappingReviewGate(
      analyzed({ approvals: { Firewall: true, Auth: true } }),
      reports,
    );
    expect(all.allApproved).toBe(true);
    expect(all.ready).toBe(true);
  });

  it("a stale analysis is NOT ready even when everything is approved", () => {
    const gate = deriveMappingReviewGate(
      analyzed({ approvals: { Firewall: true, Auth: true }, stale: true }),
      reports,
    );
    expect(gate.allApproved).toBe(true);
    expect(gate.stale).toBe(true);
    expect(gate.ready).toBe(false);
  });

  it("is not ready when there are no tables with mappings (no content path)", () => {
    const gate = deriveMappingReviewGate(analyzed(), [report("Empty", [])]);
    expect(gate.total).toBe(0);
    expect(gate.ready).toBe(false);
  });

  it("content path blocks until approved; the native path never consults it", () => {
    // The pinned separation: with mappings present but unapproved, the content
    // gate is NOT ready. The native quick-onboard path does not read this gate
    // at all (it is @soc/core canDeploy = scope + worker group + pack), so a
    // native deploy proceeds with ZERO approvals here. This test pins the
    // partition on THIS module's side: an unapproved content gate is the ONLY
    // thing this module blocks, and it is orthogonal to native readiness.
    const blocked = deriveMappingReviewGate(analyzed(), reports);
    expect(blocked.ready).toBe(false);
    const approvedAll = deriveMappingReviewGate(
      analyzed({ approvals: { Firewall: true, Auth: true } }),
      reports,
    );
    expect(approvedAll.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

describe("copy helpers", () => {
  it("progresses the approval-bar sentence none -> some -> all", () => {
    const reports = [
      report("A", [mapping()]),
      report("B", [mapping()]),
    ];
    expect(approvalBarText(deriveMappingReviewGate(analyzed(), reports))).toMatch(
      /require approval before building/,
    );
    expect(
      approvalBarText(
        deriveMappingReviewGate(analyzed({ approvals: { A: true } }), reports),
      ),
    ).toMatch(/1 of 2 table mapping\(s\) approved/);
    expect(
      approvalBarText(
        deriveMappingReviewGate(
          analyzed({ approvals: { A: true, B: true } }),
          reports,
        ),
      ),
    ).toMatch(/All 2 table mapping\(s\) approved/);
  });

  it("labels the analyze button by state", () => {
    expect(analyzeButtonLabel(0, false, false)).toBe("Analyze Samples");
    expect(analyzeButtonLabel(3, true, false)).toBe("Analyze Samples");
    expect(analyzeButtonLabel(3, false, false)).toBe("Re-Analyze");
    expect(analyzeButtonLabel(3, false, true)).toBe("Analyzing...");
  });

  it("exposes the stale + overflow coverage notices as non-empty ASCII copy", () => {
    for (const text of [MAPPING_REVIEW_STALE_NOTICE, OVERFLOW_COVERAGE_NOTE]) {
      expect(text.length).toBeGreaterThan(0);
      // ASCII-only guard (repo rule): no code point above 0x7F.
      const maxCode = Math.max(...[...text].map((c) => c.codePointAt(0) ?? 0));
      expect(maxCode).toBeLessThanOrEqual(0x7f);
    }
  });
});

describe("auto-seeding selectors (2026-07-12 audit extraction)", () => {
  const REPORT = {
    logType: "web",
    tableName: "CommonSecurityLog",
    fieldMappings: [
      { source: "dept", dest: "DeviceCustomString1", action: "rename" },
      { source: "noise", dest: "", action: "drop" },
    ],
    destSchema: [
      { name: "DeviceCustomString1", type: "string" },
      { name: "DeviceCustomString1Label", type: "string" },
      { name: "DeviceVendor", type: "string" },
    ],
  } as unknown as GapReport;

  it("pendingIdentitySeeds seeds missing fields once, with suggested values", () => {
    const statuses = {
      web: [
        { field: "DeviceVendor", status: "missing" },
        { field: "DeviceProduct", status: "missing" },
        { field: "DeviceVendor", status: "sample" },
      ],
    };
    const suggest = (field: string) =>
      field === "DeviceVendor" ? "Zscaler" : null;
    const seeds = pendingIdentitySeeds(
      [REPORT],
      statuses,
      { vendor: "Zscaler" },
      suggest,
      new Set(),
    );
    expect(seeds).toEqual([
      {
        logType: "web",
        key: "web|CommonSecurityLog|DeviceVendor",
        field: "DeviceVendor",
        value: "Zscaler",
      },
    ]);
    // The one-shot guard: an already-seeded key never re-seeds (a user
    // deletion sticks).
    expect(
      pendingIdentitySeeds(
        [REPORT],
        statuses,
        { vendor: "Zscaler" },
        suggest,
        new Set(["web|CommonSecurityLog|DeviceVendor"]),
      ),
    ).toEqual([]);
    expect(
      pendingIdentitySeeds([REPORT], statuses, null, suggest, new Set()),
    ).toEqual([]);
  });

  it("pendingLabelSeeds seeds only APPLIED mappings whose Label column exists", () => {
    const labels = [
      {
        sourceName: "dept",
        destName: "DeviceCustomString1",
        field: "DeviceCustomString1Label",
        value: "dept",
      },
      // Not applied in the report - never seeded.
      {
        sourceName: "riskscore",
        destName: "DeviceCustomNumber1",
        field: "DeviceCustomNumber1Label",
        value: "riskscore",
      },
    ];
    expect(pendingLabelSeeds([REPORT], labels, new Set())).toEqual([
      {
        logType: "web",
        key: "web|CommonSecurityLog|DeviceCustomString1Label",
        field: "DeviceCustomString1Label",
        value: "dept",
      },
    ]);
    expect(
      pendingLabelSeeds(
        [REPORT],
        labels,
        new Set(["web|CommonSecurityLog|DeviceCustomString1Label"]),
      ),
    ).toEqual([]);
  });
});
