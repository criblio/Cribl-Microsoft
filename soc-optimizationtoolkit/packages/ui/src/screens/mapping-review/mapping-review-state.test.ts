/**
 * Tests for the mapping-review approval state machine (porting-plan Unit 18).
 * The gap-analysis TRUTH (tiles, mappings, handles split) is pinned in
 * @soc/core; these pin the REVIEW STATE this package owns:
 *   - approvals reset on re-analysis; staleness clears; edits survive,
 *     re-based onto the new rows, and an edit whose row is gone is dropped
 *     and counted (DBT-210)
 *   - edits are keyed by logType and re-key on rename (the Unit 11 seam)
 *   - approvals re-key on rename too (no orphaned approval)
 *   - the content-path deploy gate (blocks until every table approved and
 *     fresh) - and its strict separation from the native path
 */
import { EMPTY_OVERFLOW_TRIAGE } from "@soc/core";
import { describe, expect, it } from "vitest";
import type {
  GapFieldMapping,
  GapReport,
  MatchAction,
  TaggedSample,
} from "@soc/core";
import type { UnusedFieldAssessment } from "./mapping-review-state";
import {
  INITIAL_MAPPING_REVIEW_STATE,
  MAPPING_REVIEW_STALE_NOTICE,
  OVERFLOW_COVERAGE_NOTE,
  analyzeButtonLabel,
  approvalBarText,
  autoDropPlan,
  columnSuggestions,
  deriveMappingReviewGate,
  destClaim,
  droppedEditsNotice,
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
  assessUnusedOverflow,
  deriveLiveStats,
  formatExampleValue,
  EXAMPLE_VALUE_MAX_CHARS,
  EMPTY_ANALYSIS_SIGNATURE,
  analysisSignature,
  forgetLogTypeKeys,
  isSignatureStale,
  signatureWithout,
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
    droppedEdits: [],
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
      previous: [],
      reports: [],
    });
    expect(next.analysisRevision).toBe(1);
    expect(next.stale).toBe(false);
  });

  // DBT-210 changed this pin: it asserted the edit store came through as the
  // SAME reference, which is the defect - edits made against the old rows were
  // applied to the new analysis as they stood. Edits still survive a re-run
  // (hand edits are not discarded), now re-based onto the new rows.
  it("RESETS approvals but PRESERVES an edit whose source the new analysis still has", () => {
    const old = report("Firewall", [mapping({ source: "a" })]);
    const fresh = report("Firewall", [mapping({ source: "a", sampleValue: "new" })]);
    const edits = { Firewall: [mapping({ source: "a", action: "drop" })] };
    const start = analyzed({ approvals: { Firewall: true }, mappingEdits: edits });
    const next = mappingReviewReducer(start, {
      type: "analyzed",
      previous: [old],
      reports: [fresh],
    });
    expect(next.approvals).toEqual({});
    expect(next.mappingEdits.Firewall).toEqual([
      mapping({ source: "a", sampleValue: "new", action: "drop" }),
    ]);
    expect(next.droppedEdits).toEqual([]);
    expect(next.analysisRevision).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DBT-210: the edit store is re-based onto a re-analysis, not carried over
// ---------------------------------------------------------------------------

describe("analyzed - edits re-based onto the new analysis (DBT-210)", () => {
  const schema = [
    { name: "AdditionalExtensions", type: "string" },
    { name: "DestColumn", type: "string" },
    { name: "SourceMACAddress", type: "string" },
  ];
  const overflow = (source: string, extra: Partial<GapFieldMapping> = {}) =>
    mapping({
      source,
      dest: "AdditionalExtensions",
      confidence: "unmatched",
      action: "overflow",
      description: "Collected into overflow field",
      ...extra,
    });
  const kept = mapping({ source: "kept", dest: "DestColumn" });
  const old = report("PanOS", [kept, overflow("mac"), overflow("gone")], {
    destSchema: schema,
  });
  const editDest = (sourceField: string, value: string): MappingReviewAction => ({
    type: "edit-mapping",
    logType: "PanOS",
    sourceField,
    field: "dest",
    value,
    baseline: old.fieldMappings,
    destSchema: old.destSchema,
    catchAllColumn: "AdditionalExtensions",
  });
  const editAction = (sourceField: string, value: string): MappingReviewAction => ({
    type: "edit-mapping",
    logType: "PanOS",
    sourceField,
    field: "action",
    value,
    baseline: old.fieldMappings,
    catchAllColumn: "AdditionalExtensions",
  });
  // Two edits: mac re-pointed at SourceMACAddress, `gone` dropped.
  const edited = reduce(
    analyzed(),
    editDest("mac", "SourceMACAddress"),
    editAction("gone", "drop"),
  );

  it("keeps the edit whose source survives, drops the one whose source is gone, and names it", () => {
    // The new sample no longer carries `gone`, and its values changed.
    const fresh = report(
      "PanOS",
      [{ ...kept, sampleValue: "v2" }, overflow("mac", { sampleValue: "v2" })],
      { destSchema: schema },
    );
    const next = reduce(edited, { type: "analyzed", previous: [old], reports: [fresh] });
    expect(next.droppedEdits).toEqual([{ logType: "PanOS", source: "gone" }]);
    const rows = effectiveMappings(next, fresh);
    expect(rows.map((m) => m.source)).toEqual(["kept", "mac"]);
    // The surviving edit, on the NEW row (its new sample value).
    expect(rows[1]).toMatchObject({
      source: "mac",
      dest: "SourceMACAddress",
      action: "rename",
      confidence: "reviewer",
      sampleValue: "v2",
    });
    // An unedited row is the new analysis's, not the old copy in the store.
    expect(rows[0]).toEqual(fresh.fieldMappings[0]);
    expect(isModified(next, fresh)).toBe(true);
  });

  it("takes the new analysis's decision for a row the reviewer never edited", () => {
    // The stored copy of `kept` is the OLD analysis's row, not an edit.
    const movedKept = mapping({
      source: "kept",
      dest: "SourceMACAddress",
      action: "rename",
      confidence: "alias",
    });
    const fresh = report("PanOS", [movedKept, overflow("mac"), overflow("gone")], {
      destSchema: schema,
    });
    const next = reduce(edited, { type: "analyzed", previous: [old], reports: [fresh] });
    expect(effectiveMappings(next, fresh)[0]).toEqual(movedKept);
    // mac's edit now collides with the new analysis's kept -> SourceMACAddress.
    expect(next.droppedEdits).toEqual([{ logType: "PanOS", source: "mac" }]);
  });

  it("reads as unmodified when no edit survives, and clears the store for that table", () => {
    const fresh = report("PanOS", [kept], { destSchema: schema });
    const next = reduce(edited, { type: "analyzed", previous: [old], reports: [fresh] });
    expect(next.droppedEdits).toEqual([
      { logType: "PanOS", source: "mac" },
      { logType: "PanOS", source: "gone" },
    ]);
    expect(next.mappingEdits.PanOS).toBeUndefined();
    expect(isModified(next, fresh)).toBe(false);
  });

  it("drops every edit when the log type now goes to a different table", () => {
    const fresh = report("PanOS", old.fieldMappings, {
      destSchema: schema,
      tableName: "Syslog",
    });
    const next = reduce(edited, { type: "analyzed", previous: [old], reports: [fresh] });
    expect(next.droppedEdits).toHaveLength(2);
    expect(isModified(next, fresh)).toBe(false);
  });

  it("drops an edit whose column the new schema no longer has", () => {
    const fresh = report("PanOS", old.fieldMappings, {
      destSchema: schema.filter((c) => c.name !== "SourceMACAddress"),
    });
    const next = reduce(edited, { type: "analyzed", previous: [old], reports: [fresh] });
    expect(next.droppedEdits).toEqual([{ logType: "PanOS", source: "mac" }]);
    expect(effectiveMappings(next, fresh).find((m) => m.source === "gone")?.action).toBe(
      "drop",
    );
  });

  it("drops the whole edit, not just its column, when that column is gone", () => {
    // mac re-pointed at SourceMACAddress and then dropped: the row the reviewer
    // decided on names a column the new schema lacks, so none of it is applied.
    const repointedThenDropped = reduce(edited, editAction("mac", "drop"));
    const fresh = report("PanOS", old.fieldMappings, {
      destSchema: schema.filter((c) => c.name !== "SourceMACAddress"),
    });
    const next = reduce(repointedThenDropped, {
      type: "analyzed",
      previous: [old],
      reports: [fresh],
    });
    expect(next.droppedEdits).toEqual([{ logType: "PanOS", source: "mac" }]);
    expect(effectiveMappings(next, fresh).find((m) => m.source === "mac")).toEqual(
      overflow("mac"),
    );
  });

  it("drops a stored column action on a catch-all row rather than replaying it (DBT-209)", () => {
    // The live reducer refuses mac as `rename` onto the catch-all, so this store
    // is built by hand: the replay checks the action itself rather than trust
    // the store. Replayed as it stands it is a Rename onto AdditionalExtensions.
    const stale = analyzed({
      mappingEdits: { PanOS: [kept, overflow("mac", { action: "rename" }), overflow("gone")] },
    });
    const next = reduce(stale, { type: "analyzed", previous: [old], reports: [old] });
    expect(next.droppedEdits).toEqual([{ logType: "PanOS", source: "mac" }]);
    expect(next.mappingEdits.PanOS).toBeUndefined();
  });

  it("keeps a chain of moves whatever order the rows are stored in", () => {
    // b moved ColY -> ColZ, then a moved ColX -> the ColY b had vacated. a's
    // row comes first, so replaying in row order puts a onto ColY while the
    // new analysis still has b there: neither edit is lost, both replay.
    const chainSchema = ["ColX", "ColY", "ColZ"].map((name) => ({ name, type: "string" }));
    const a = mapping({ source: "a", dest: "ColX", action: "rename" });
    const b = mapping({ source: "b", dest: "ColY", action: "rename" });
    const base = report("Chain", [a, b], { destSchema: chainSchema });
    const remap = (sourceField: string, value: string): MappingReviewAction => ({
      type: "edit-mapping",
      logType: "Chain",
      sourceField,
      field: "dest",
      value,
      baseline: base.fieldMappings,
      destSchema: chainSchema,
    });
    const chained = reduce(analyzed(), remap("b", "ColZ"), remap("a", "ColY"));
    const fresh = report("Chain", [a, b], { destSchema: chainSchema });
    const next = reduce(chained, { type: "analyzed", previous: [base], reports: [fresh] });
    expect(next.droppedEdits).toEqual([]);
    expect(effectiveMappings(next, fresh).map((m) => [m.source, m.dest])).toEqual([
      ["a", "ColY"],
      ["b", "ColZ"],
    ]);
  });

  it("drops an edit onto a column the new analysis already fills from another field", () => {
    const fresh = report(
      "PanOS",
      [kept, overflow("mac"), overflow("gone"), mapping({ source: "srcmac", dest: "SourceMACAddress", action: "rename" })],
      { destSchema: schema },
    );
    const next = reduce(edited, { type: "analyzed", previous: [old], reports: [fresh] });
    expect(next.droppedEdits).toEqual([{ logType: "PanOS", source: "mac" }]);
  });

  it("drops the edits of a log type the new analysis has no report for", () => {
    const next = reduce(edited, { type: "analyzed", previous: [old], reports: [] });
    expect(next.droppedEdits).toHaveLength(2);
    expect(next.mappingEdits).toEqual({});
  });

  it("keeps edits re-keyed by a log-type rename (no previous report under the new name)", () => {
    const renamed = reduce(edited, { type: "rename-log-type", from: "PanOS", to: "Traffic" });
    const fresh = report("Traffic", old.fieldMappings, { destSchema: schema });
    const next = reduce(renamed, { type: "analyzed", previous: [old], reports: [fresh] });
    expect(next.droppedEdits).toEqual([]);
    expect(effectiveMappings(next, fresh).map((m) => [m.source, m.action])).toEqual([
      ["kept", "keep"],
      ["mac", "rename"],
      ["gone", "drop"],
    ]);
  });

  it("says how many were dropped in one sentence", () => {
    expect(droppedEditsNotice([])).toBe("");
    expect(droppedEditsNotice([{ logType: "PanOS", source: "gone" }])).toBe(
      "1 mapping edit no longer matches a field in the new analysis and was dropped.",
    );
    expect(
      droppedEditsNotice([
        { logType: "PanOS", source: "gone" },
        { logType: "PanOS", source: "mac" },
      ]),
    ).toBe("2 mapping edits no longer match a field in the new analysis and were dropped.");
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
      { type: "analyzed", previous: [], reports: [] },
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
  const destSchema = ["ColA", "ColB", "ColZ", "ColA2", "Mutated?"].map(
    (name) => ({ name, type: "string" }),
  );

  it("seeds the edit store from the baseline on first edit and updates one field", () => {
    const next = mappingReviewReducer(analyzed(), {
      type: "edit-mapping",
      logType: "Firewall",
      sourceField: "srcB",
      field: "dest",
      value: "ColZ",
      baseline,
      destSchema,
    });
    const rows = next.mappingEdits.Firewall;
    expect(rows).toHaveLength(2);
    expect(rows[1].dest).toBe("ColZ");
    expect(rows[0].dest).toBe("ColA"); // untouched row preserved
    expect(isModified(next, report("Firewall", baseline))).toBe(true);
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
      destSchema,
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
      destSchema,
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
      destSchema,
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
// remove-log-type and the per-log-type staleness signature (DBT-143)
// ---------------------------------------------------------------------------

function tagged(logType: string, fieldCount: number, format = "json"): TaggedSample {
  return {
    logType,
    format,
    parsed: { fields: Array.from({ length: fieldCount }, () => ({})) },
  } as unknown as TaggedSample;
}

describe("remove-log-type", () => {
  it("drops exactly the removed log type's approval and edits", () => {
    const start = analyzed({
      approvals: { Gone: true, Keep: true },
      mappingEdits: { Gone: [mapping({ source: "x" })], Keep: [mapping()] },
    });
    const next = mappingReviewReducer(start, {
      type: "remove-log-type",
      logType: "Gone",
    });
    expect(next.approvals).toEqual({ Keep: true });
    expect(Object.keys(next.mappingEdits)).toEqual(["Keep"]);
    // The other table's review is untouched, and nothing is marked stale.
    expect(next.stale).toBe(false);
    expect(next.analysisRevision).toBe(start.analysisRevision);
  });

  it("stops counting the removed log type's dropped edits (DBT-210)", () => {
    const start = analyzed({
      droppedEdits: [
        { logType: "Gone", source: "x" },
        { logType: "Keep", source: "y" },
      ],
    });
    const next = mappingReviewReducer(start, { type: "remove-log-type", logType: "Gone" });
    expect(next.droppedEdits).toEqual([{ logType: "Keep", source: "y" }]);
  });

  it("leaves the content gate READY when every remaining table is approved", () => {
    const keep = report("Keep", [mapping()]);
    const start = analyzed({ approvals: { Keep: true } });
    const next = mappingReviewReducer(start, {
      type: "remove-log-type",
      logType: "Gone",
    });
    expect(deriveMappingReviewGate(next, [keep]).ready).toBe(true);
  });
});

describe("analysis signature", () => {
  const analyzedSig = analysisSignature("PaloAlto", [
    tagged("Traffic", 10),
    tagged("Decryption", 7),
  ]);

  it("is NOT stale when a sample is removed", () => {
    const current = analysisSignature("PaloAlto", [tagged("Traffic", 10)]);
    expect(isSignatureStale(analyzedSig, current)).toBe(false);
  });

  it("is stale when a sample is added, changed, or the solution changes", () => {
    const added = analysisSignature("PaloAlto", [
      tagged("Traffic", 10),
      tagged("Decryption", 7),
      tagged("Threat", 4),
    ]);
    const changed = analysisSignature("PaloAlto", [
      tagged("Traffic", 11),
      tagged("Decryption", 7),
    ]);
    const reformatted = analysisSignature("PaloAlto", [
      tagged("Traffic", 10, "csv"),
      tagged("Decryption", 7),
    ]);
    const otherSolution = analysisSignature("Zscaler", [
      tagged("Traffic", 10),
      tagged("Decryption", 7),
    ]);
    expect(isSignatureStale(analyzedSig, added)).toBe(true);
    expect(isSignatureStale(analyzedSig, changed)).toBe(true);
    expect(isSignatureStale(analyzedSig, reformatted)).toBe(true);
    expect(isSignatureStale(analyzedSig, otherSolution)).toBe(true);
  });

  it("treats a sample re-added after removal as unanalyzed", () => {
    // Its report was pruned, so an identical re-add must prompt a run rather
    // than read as already analyzed and leave the sample with no card.
    const pruned = signatureWithout(analyzedSig, "Decryption");
    const readded = analysisSignature("PaloAlto", [
      tagged("Traffic", 10),
      tagged("Decryption", 7),
    ]);
    expect(isSignatureStale(pruned, readded)).toBe(true);
    expect(isSignatureStale(analyzedSig, readded)).toBe(false);
  });

  it("starts empty", () => {
    expect(EMPTY_ANALYSIS_SIGNATURE.byLogType).toEqual({});
  });
});

describe("forgetLogTypeKeys", () => {
  it("drops only keys for that log type, not a log type sharing its prefix", () => {
    const keys = new Set([
      "Decryption|CommonSecurityLog|DeviceVendor",
      "Decryption|CommonSecurityLog|DeviceProduct",
      "DecryptionV2|CommonSecurityLog|DeviceVendor",
      "Traffic|CommonSecurityLog|DeviceVendor",
    ]);
    expect(forgetLogTypeKeys(keys, "Decryption")).toBe(2);
    expect([...keys].sort()).toEqual([
      "DecryptionV2|CommonSecurityLog|DeviceVendor",
      "Traffic|CommonSecurityLog|DeviceVendor",
    ]);
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

  // DBT-193: the header's three counts must agree. A dropped row is not
  // "mapped", so the column it pointed at is empty and must read as unmapped -
  // otherwise dropping a rename row lowers "mapped" without raising
  // "unmapped", and the column silently disappears from the list.
  it("lists the column of a DROPPED row as unmapped; an overflow row fills the catch-all", () => {
    const r = report("A", [
      mapping({ source: "s", dest: "DestColumn", action: "drop" }),
      mapping({ source: "o", dest: "OtherColumn", action: "overflow" }),
    ]);
    const unmapped = unmappedDestColumns(r, r.fieldMappings);
    expect(unmapped.map((d) => d.name)).toEqual(["DestColumn", "TimeGenerated"]);
  });

  it("formats the expander label with no overflow or drop to name", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      mapping({ source: `s${i}`, dest: `C${i}` }),
    );
    expect(fieldMappingsLabel(rows, 2)).toBe(
      "Field Mappings (5 mapped, 2 unmapped)",
    );
  });

  // DBT-193: the PAN-OS UAT (2026-10-29) read "115 mapped, 96 unmapped" while
  // the tiles said 4 passthrough + 55 renames + 56 overflow. Same row mix here.
  it("counts only rows landing in a column as mapped, and names overflow (UAT numbers)", () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) =>
        mapping({ source: `k${i}`, dest: `k${i}`, action: "keep" }),
      ),
      ...Array.from({ length: 55 }, (_, i) =>
        mapping({ source: `r${i}`, dest: `R${i}`, action: "rename" }),
      ),
      ...Array.from({ length: 56 }, (_, i) =>
        mapping({
          source: `o${i}`,
          dest: "AdditionalExtensions",
          action: "overflow",
          confidence: "unmatched",
        }),
      ),
    ];
    expect(rows).toHaveLength(115);
    expect(fieldMappingsLabel(rows, 96)).toBe(
      "Field Mappings (59 mapped, 56 to overflow, 96 unmapped)",
    );
  });

  it("names dropped rows separately and never counts them as mapped", () => {
    const rows = [
      mapping({ source: "a", dest: "A", action: "rename" }),
      mapping({ source: "b", dest: "B", action: "decode" }),
      mapping({ source: "c", dest: "AdditionalExtensions", action: "overflow" }),
      mapping({ source: "d", dest: "", action: "drop" }),
      mapping({ source: "e", dest: "AdditionalExtensions", action: "drop" }),
    ];
    expect(fieldMappingsLabel(rows, 7)).toBe(
      "Field Mappings (2 mapped, 1 to overflow, 2 dropped, 7 unmapped)",
    );
  });
});

// ---------------------------------------------------------------------------
// GEN-19 / DBT-194: a Dest Field edit re-derives the row; a revert is unmodified
// ---------------------------------------------------------------------------

describe("edit-mapping dest - the PAN-OS UAT rows (GEN-19, DBT-194)", () => {
  const panSrcMac = mapping({
    source: "PanSrcMac",
    dest: "AdditionalExtensions",
    sourceType: "string",
    destType: "string",
    confidence: "unmatched",
    action: "overflow",
    description: "Collected into overflow field",
  });
  const inBytes = mapping({
    source: "in",
    dest: "AdditionalExtensions",
    sourceType: "int",
    destType: "string",
    confidence: "unmatched",
    action: "overflow",
    description: "Collected into overflow field",
  });
  const baseline = [panSrcMac, inBytes];
  const cslReport = report("PanOS", baseline, {
    destSchema: [
      { name: "AdditionalExtensions", type: "string" },
      { name: "ReceivedBytes", type: "long" },
      { name: "SourceMACAddress", type: "string" },
    ],
  });
  const editDest = (
    sourceField: string,
    value: string,
  ): MappingReviewAction => ({
    type: "edit-mapping",
    logType: "PanOS",
    sourceField,
    field: "dest",
    value,
    baseline: cslReport.fieldMappings,
    destSchema: cslReport.destSchema,
    catchAllColumn: "AdditionalExtensions",
  });

  it("turns an overflow row pointed at a column into a rename with the column's type", () => {
    const next = reduce(analyzed(), editDest("PanSrcMac", "SourceMACAddress"));
    expect(next.mappingEdits.PanOS[0]).toEqual({
      source: "PanSrcMac",
      dest: "SourceMACAddress",
      sourceType: "string",
      destType: "string",
      confidence: "reviewer",
      action: "rename",
      needsCoercion: false,
      description: "Reviewer choice: PanSrcMac -> SourceMACAddress",
    });
    expect(next.mappingEdits.PanOS[1]).toBe(inBytes);
    expect(isModified(next, cslReport)).toBe(true);
  });

  it("marks a rename across types as needing coercion (in int -> ReceivedBytes long)", () => {
    const next = reduce(analyzed(), editDest("in", "ReceivedBytes"));
    const row = next.mappingEdits.PanOS[1];
    expect(row.action).toBe("rename");
    expect(row.destType).toBe("long");
    expect(row.needsCoercion).toBe(true);
  });

  it("edit then revert reads as NOT modified (DBT-194)", () => {
    const next = reduce(
      analyzed(),
      editDest("PanSrcMac", "SourceMACAddress"),
      editDest("PanSrcMac", "AdditionalExtensions"),
    );
    expect(next.mappingEdits.PanOS[0]).toEqual(panSrcMac);
    expect(isModified(next, cslReport)).toBe(false);
  });

  it("an action edit set back to its original value also reads as not modified", () => {
    const toDrop: MappingReviewAction = {
      type: "edit-mapping",
      logType: "PanOS",
      sourceField: "in",
      field: "action",
      value: "drop",
      baseline: cslReport.fieldMappings,
    };
    const dropped = reduce(analyzed(), toDrop);
    expect(isModified(dropped, cslReport)).toBe(true);
    const restored = reduce(dropped, { ...toDrop, value: "overflow" });
    expect(isModified(restored, cslReport)).toBe(false);
  });

  it("is not modified with no edit store at all", () => {
    expect(isModified(analyzed(), cslReport)).toBe(false);
  });

  it("is a no-op for a column the schema does not have", () => {
    const state = analyzed();
    expect(reduce(state, editDest("PanSrcMac", "NoSuchColumn"))).toBe(state);
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

describe("assessUnusedOverflow (content-driven drop policy, 2026-07-12)", () => {
  const REPORT = {
    logType: "web",
    tableName: "CommonSecurityLog",
    fieldMappings: [
      { source: "act", dest: "DeviceAction", action: "rename" },
      { source: "dept", dest: "AdditionalExtensions", action: "overflow" },
      { source: "noise1", dest: "AdditionalExtensions", action: "overflow" },
      { source: "noise2", dest: "AdditionalExtensions", action: "overflow" },
    ],
    destSchema: [],
  } as unknown as GapReport;

  const REQ = {
    columns: new Set(["deviceaction"]),
    catchAllKeys: new Set(["dept"]),
    opaqueCatchAll: false,
    itemCount: 3,
  };

  it("drops overflow fields no content needs; keeps catch-all keys", () => {
    const a = assessUnusedOverflow(REPORT, REQ);
    expect(a.blocked).toBeNull();
    expect(a.droppable).toEqual(["noise1", "noise2"]);
    expect(a.keptByContent).toEqual(["dept"]);
  });

  it("mapped rows are never drop candidates", () => {
    const a = assessUnusedOverflow(REPORT, REQ);
    expect(a.droppable).not.toContain("act");
  });

  it("blocks without analyzed content (no evidence, no drops)", () => {
    expect(assessUnusedOverflow(REPORT, null).blocked).toBe("no-requirements");
    expect(
      assessUnusedOverflow(REPORT, { ...REQ, itemCount: 0 }).blocked,
    ).toBe("no-requirements");
  });

  it("blocks on opaque catch-all use (dropping could break content)", () => {
    const a = assessUnusedOverflow(REPORT, { ...REQ, opaqueCatchAll: true });
    expect(a.blocked).toBe("opaque-catch-all");
    expect(a.droppable).toEqual([]);
  });
});

describe("deriveLiveStats (live tiles + the Dropped tile, 2026-07-12)", () => {
  const STAT = (key: string, value: number) =>
    ({ key, label: key, value, hint: "h", tone: "neutral" }) as never;
  const REPORT = {
    logType: "web",
    tableName: "CommonSecurityLog",
    stats: [
      STAT("source-fields", 4),
      STAT("dest-columns", 10),
      STAT("passthrough", 1),
      STAT("dcr-handles", 2),
      STAT("cribl-handles", 1),
      STAT("overflow", 2),
    ],
    fieldMappings: [
      { source: "a", dest: "a", action: "keep", needsCoercion: false },
      { source: "b", dest: "B", action: "rename", needsCoercion: false },
      { source: "c", dest: "AdditionalExtensions", action: "overflow", needsCoercion: false },
      { source: "d", dest: "AdditionalExtensions", action: "overflow", needsCoercion: false },
    ],
  } as unknown as GapReport;

  it("reproduces the report tiles exactly when nothing is edited", () => {
    const live = deriveLiveStats(REPORT, REPORT.fieldMappings);
    expect(live.map((s) => [s.key, s.value])).toEqual([
      ["source-fields", 4],
      ["dest-columns", 10],
      ["passthrough", 1],
      ["dcr-handles", 2],
      ["cribl-handles", 1],
      ["overflow", 2],
      ["dropped", 0],
    ]);
  });

  it("dropping every overflow field zeroes Overflow and fills Dropped", () => {
    const effective = REPORT.fieldMappings.map((m) =>
      m.action === "overflow" ? { ...m, action: "drop" } : m,
    );
    const live = deriveLiveStats(REPORT, effective as never);
    const byKey = new Map(live.map((s) => [s.key, s]));
    expect(byKey.get("overflow")?.value).toBe(0);
    expect(byKey.get("overflow")?.tone).toBe("neutral");
    expect(byKey.get("dropped")?.value).toBe(2);
    expect(byKey.get("dropped")?.tone).toBe("info");
    // Analysis facts pass through untouched.
    expect(byKey.get("source-fields")?.value).toBe(4);
    expect(byKey.get("dcr-handles")?.value).toBe(2);
  });
});

/**
 * Pins for the unused-field auto-drop plan.
 *
 * The defect these exist for (2026-08-26): the restore branch consulted the
 * already-dropped set and the drop branch did not. The effect around it re-ran
 * on every mapping edit, so a field the operator moved back to overflow was
 * seen at overflow again and re-dropped. The row snapped back under them with
 * no message, and there was no way to keep the field while the policy was on.
 */
describe("autoDropPlan", () => {
  const row = (source: string, action: MatchAction): GapFieldMapping => ({
    source,
    dest: `${source}_dest`,
    sourceType: "string",
    destType: "string",
    confidence: "exact",
    action,
    needsCoercion: false,
    description: "",
  });

  const assessment = (droppable: string[]): UnusedFieldAssessment => ({
    droppable,
    keptByContent: [],
    blocked: null,
  });

  it("drops an overflow field nothing has dropped yet", () => {
    const plan = autoDropPlan(
      "drop",
      "traffic",
      assessment(["spare"]),
      [row("spare", "overflow")],
      new Set(),
    );

    expect(plan.drop).toEqual(["spare"]);
    expect(plan.restore).toEqual([]);
  });

  it("does NOT re-drop a field the operator moved back to overflow", () => {
    // THE DEFECT. The field reads as overflow again - that is exactly what an
    // operator restoring it looks like - and the only thing separating that
    // from a fresh field is the memory of having dropped it once.
    const plan = autoDropPlan(
      "drop",
      "traffic",
      assessment(["spare"]),
      [row("spare", "overflow")],
      new Set(["traffic|spare"]),
    );

    expect(plan.drop).toEqual([]);
  });

  it("does NOT drop a field the reviewer moved into overflow (DBT-208 Move)", () => {
    // The claim panel promises the moved field's value is kept; the policy
    // has never dropped it, so only `reviewerKept` separates it from a fresh
    // overflow field. Preserve has nothing of its to restore.
    const kept = new Set(["traffic|spare"]);
    expect(
      autoDropPlan("drop", "traffic", assessment(["spare", "other"]), [
        row("spare", "overflow"),
        row("other", "overflow"),
      ], new Set(), kept).drop,
    ).toEqual(["other"]);
    expect(
      autoDropPlan("preserve", "traffic", assessment(["spare"]), [
        row("spare", "overflow"),
      ], new Set(), kept).restore,
    ).toEqual([]);
  });

  it("keys the memory per LOG TYPE, not per field name", () => {
    // Two tables can carry the same source field. Dropping it in one must not
    // silently exempt it in the other.
    const plan = autoDropPlan(
      "drop",
      "threat",
      assessment(["spare"]),
      [row("spare", "overflow")],
      new Set(["traffic|spare"]),
    );

    expect(plan.drop).toEqual(["spare"]);
  });

  it("restores only what the policy itself dropped", () => {
    const plan = autoDropPlan(
      "preserve",
      "traffic",
      assessment(["mine", "theirs"]),
      [row("mine", "drop"), row("theirs", "drop")],
      new Set(["traffic|mine"]),
    );

    // "theirs" was dropped by hand, so preserve does not reach into it.
    expect(plan.restore).toEqual(["mine"]);
  });

  it("lets a policy round-trip ask again", () => {
    // Switching to preserve forgets the field, so switching back may re-drop
    // it. That is the deliberate way to re-run the machine's decision, and it
    // is what keeps the fix above from making the policy a one-shot.
    const forgotten = new Set<string>();
    const plan = autoDropPlan(
      "drop",
      "traffic",
      assessment(["spare"]),
      [row("spare", "overflow")],
      forgotten,
    );

    expect(plan.drop).toEqual(["spare"]);
  });

  it("drops nothing at all when the assessment is blocked", () => {
    // No requirements, or an opaque catch-all: the evidence cannot support a
    // drop, so nothing is dropped regardless of the policy.
    for (const blocked of ["no-requirements", "opaque-catch-all"] as const) {
      const plan = autoDropPlan(
        "drop",
        "traffic",
        { droppable: ["spare"], keptByContent: [], blocked },
        [row("spare", "overflow")],
        new Set(),
      );

      expect(plan.drop).toEqual([]);
    }
  });

  it("leaves a row alone when it is not at overflow", () => {
    // Only overflow rows are droppable. A field that already maps to a column
    // is carrying data, and the policy has no business touching it.
    const plan = autoDropPlan(
      "drop",
      "traffic",
      assessment(["mapped"]),
      [row("mapped", "keep")],
      new Set(),
    );

    expect(plan.drop).toEqual([]);
  });
});

describe("formatExampleValue (DBT-122, the Example Value column)", () => {
  it("shows a short value verbatim with the same full value in the tip", () => {
    expect(formatExampleValue("81.2.69.192")).toEqual({
      kind: "value",
      text: "81.2.69.192",
      title: "81.2.69.192",
    });
  });

  it("caps a long value at EXAMPLE_VALUE_MAX_CHARS and keeps the full value in the tip", () => {
    // A 200-char path must not stretch the table; the operator still reads the
    // whole thing on hover, so nothing is hidden, only shortened.
    const long = "/".concat("a".repeat(199));
    const cell = formatExampleValue(long);
    expect(EXAMPLE_VALUE_MAX_CHARS).toBe(80);
    expect(cell.kind).toBe("value");
    expect(cell.text).toBe("/".concat("a".repeat(76), "..."));
    expect(cell.text.length).toBe(80);
    expect(cell.title).toBe(long);
  });

  it("does not truncate a value of exactly the cap", () => {
    const exact = "x".repeat(80);
    expect(formatExampleValue(exact).text).toBe(exact);
  });

  it("renders a dash for a field with no example, without claiming the sample had no value", () => {
    // collectFields keeps no example of 200+ characters, so a field holding
    // only long values (command lines, URLs) arrives here undefined too. The
    // tip says what is known rather than "no value" (audit follow-up, DBT-122).
    expect(formatExampleValue(undefined)).toEqual({
      kind: "none",
      text: "--",
      title:
        "No example captured: the sample had no value for this field, or " +
        "every value was 200 characters or longer",
    });
  });

  it("names an empty string rather than rendering a blank cell", () => {
    // ContextData in the CrowdStrike Process corpus is "" - a blank cell would
    // read as "no value", which is a different fact.
    expect(formatExampleValue("")).toEqual({
      kind: "empty",
      text: '""',
      title: "Empty string in the sample",
    });
  });

  it("keeps leading and trailing whitespace (never trims)", () => {
    expect(formatExampleValue("  padded ")).toEqual({
      kind: "value",
      text: "  padded ",
      title: "  padded ",
    });
  });

  it("escapes line breaks and tabs in the cell so one row stays one line", () => {
    const cell = formatExampleValue("a\nb\tc\r");
    expect(cell.text).toBe("a\\nb\\tc\\r");
    expect(cell.title).toBe("a\nb\tc\r");
  });
});

// ---------------------------------------------------------------------------
// DBT-202: applying a suggested field to an unmapped column
// ---------------------------------------------------------------------------

describe("apply-suggestion (DBT-202)", () => {
  const SCHEMA = [
    { name: "AdditionalExtensions", type: "string" },
    { name: "ReceivedBytes", type: "long" },
    { name: "SourceMACAddress", type: "string" },
  ];
  const baseline = [
    mapping({
      source: "in",
      sourceType: "int",
      dest: "AdditionalExtensions",
      destType: "string",
      confidence: "unmatched",
      action: "overflow",
    }),
  ];
  const apply = (
    state: MappingReviewState,
    destColumn: string,
    sourceField = "in",
  ): MappingReviewState =>
    mappingReviewReducer(state, {
      type: "apply-suggestion",
      logType: "PanOS",
      sourceField,
      destColumn,
      baseline,
      destSchema: SCHEMA,
      catchAllColumn: "AdditionalExtensions",
    });

  it("re-points the row through applyRemap and withdraws only that table's approval", () => {
    const before = analyzed({ approvals: { PanOS: true, Other: true } });
    const next = apply(before, "ReceivedBytes");
    expect(next.mappingEdits.PanOS).toEqual([
      {
        source: "in",
        sourceType: "int",
        dest: "ReceivedBytes",
        destType: "long",
        confidence: "reviewer",
        action: "rename",
        needsCoercion: true,
        description: "Reviewer choice: in -> ReceivedBytes",
      },
    ]);
    expect(next.approvals).toEqual({ Other: true });
  });

  it("changes nothing - approval included - when the remap does not apply", () => {
    const before = analyzed({ approvals: { PanOS: true } });
    expect(apply(before, "NoSuchColumn")).toBe(before);
    expect(apply(before, "ReceivedBytes", "nosuchfield")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// DBT-213 / DBT-208: a Dest Field re-point and an applied suggestion are one
// path - same approval effect, and neither leaves two rows in one column
// ---------------------------------------------------------------------------

describe("Dest Field re-point and apply-suggestion agree (DBT-213, DBT-208)", () => {
  const SCHEMA = [
    { name: "AdditionalExtensions", type: "string" },
    { name: "ReceivedBytes", type: "long" },
    { name: "SourceMACAddress", type: "string" },
  ];
  // `in` already fills ReceivedBytes (GEN-20's alias); qqbytes sits in overflow.
  const inBytes = mapping({
    source: "in",
    sourceType: "int",
    dest: "ReceivedBytes",
    destType: "long",
    confidence: "alias",
    action: "rename",
    needsCoercion: true,
  });
  const qqbytes = mapping({
    source: "qqbytes",
    sourceType: "int",
    dest: "AdditionalExtensions",
    confidence: "unmatched",
    action: "overflow",
  });
  const baseline = [inBytes, qqbytes];
  const editDest = (
    sourceField: string,
    value: string,
    moveClaimed?: boolean,
  ): MappingReviewAction => ({
    type: "edit-mapping",
    logType: "PanOS",
    sourceField,
    field: "dest",
    value,
    baseline,
    destSchema: SCHEMA,
    catchAllColumn: "AdditionalExtensions",
    ...(moveClaimed === undefined ? {} : { moveClaimed }),
  });
  const suggest = (sourceField: string, destColumn: string): MappingReviewAction => ({
    type: "apply-suggestion",
    logType: "PanOS",
    sourceField,
    destColumn,
    baseline,
    destSchema: SCHEMA,
    catchAllColumn: "AdditionalExtensions",
  });

  it("withdraws only that table's approval on an applied Dest edit, as apply-suggestion does (F1-c)", () => {
    const before = analyzed({ approvals: { PanOS: true, Other: true } });
    const viaDest = reduce(before, editDest("qqbytes", "SourceMACAddress"));
    const viaSuggestion = reduce(before, suggest("qqbytes", "SourceMACAddress"));
    expect(viaDest.approvals).toEqual({ Other: true });
    expect(viaDest).toEqual(viaSuggestion);
  });

  it("withdraws approval on a reverted Dest edit too - the deployed row changes", () => {
    const edited = reduce(analyzed(), editDest("qqbytes", "SourceMACAddress"));
    const approved = reduce(edited, { type: "approve", logType: "PanOS" });
    const reverted = reduce(approved, editDest("qqbytes", "AdditionalExtensions"));
    expect(reverted.mappingEdits.PanOS?.[1]).toEqual(qqbytes);
    expect(reverted.approvals).toEqual({});
  });

  it("keeps approval when the Dest edit changes nothing", () => {
    const before = analyzed({ approvals: { PanOS: true } });
    expect(reduce(before, editDest("in", "ReceivedBytes"))).toBe(before);
    expect(reduce(before, editDest("qqbytes", "NoSuchColumn"))).toBe(before);
  });

  it("refuses a Dest edit onto a column another row fills until the reviewer moves it", () => {
    const before = analyzed({ approvals: { PanOS: true } });
    expect(reduce(before, editDest("qqbytes", "ReceivedBytes"))).toBe(before);
    expect(reduce(before, suggest("qqbytes", "ReceivedBytes"))).toBe(before);
  });

  it("refuses the move too when the table has no catch-all to move the other row into", () => {
    const before = analyzed({ approvals: { PanOS: true } });
    const noCatchAll: MappingReviewAction = {
      ...editDest("qqbytes", "ReceivedBytes", true),
      catchAllColumn: "NotInTheSchema",
    } as MappingReviewAction;
    expect(reduce(before, noCatchAll)).toBe(before);
  });

  it("moves the column on the reviewer's answer: one row lands there, the other falls back to overflow", () => {
    const before = analyzed({ approvals: { PanOS: true } });
    const next = reduce(before, editDest("qqbytes", "ReceivedBytes", true));
    const rows = next.mappingEdits.PanOS!;
    expect(rows.find((m) => m.source === "qqbytes")).toMatchObject({
      dest: "ReceivedBytes",
      action: "rename",
    });
    expect(rows.find((m) => m.source === "in")).toMatchObject({
      dest: "AdditionalExtensions",
      action: "overflow",
    });
    expect(
      rows.filter((m) => m.action === "rename" && m.dest === "ReceivedBytes"),
    ).toHaveLength(1);
    expect(next.approvals).toEqual({});
  });
});

describe("destClaim (DBT-208)", () => {
  const SCHEMA = [
    { name: "AdditionalExtensions", type: "string" },
    { name: "ReceivedBytes", type: "long" },
    { name: "SourceMACAddress", type: "string" },
    { name: "DestinationMACAddress", type: "string" },
  ];
  const rows = [
    mapping({ source: "in", dest: "ReceivedBytes", action: "rename" }),
    mapping({ source: "mac", dest: "SourceMACAddress", action: "keep" }),
    mapping({ source: "qq", dest: "AdditionalExtensions", action: "overflow" }),
  ];
  const claim = (
    sourceField: string,
    destColumn: string,
    opts: { schema?: typeof SCHEMA; ruleFields?: ReadonlySet<string> } = {},
  ) =>
    destClaim(
      rows,
      {
        sourceField,
        destColumn,
        destSchema: opts.schema ?? SCHEMA,
        catchAllColumn: "AdditionalExtensions",
      },
      opts.ruleFields,
    );

  it("is null when the chosen column is free or is the catch-all", () => {
    expect(claim("qq", "DestinationMACAddress")).toBeNull();
    expect(claim("in", "AdditionalExtensions")).toBeNull();
    expect(claim("in", "NoSuchColumn")).toBeNull();
  });

  it("names the row that fills the column, where it would go, and the move label", () => {
    expect(claim("qq", "ReceivedBytes")).toEqual({
      column: "ReceivedBytes",
      claimedBy: "in",
      fallback: "AdditionalExtensions",
      actionLabel: "Move ReceivedBytes from in",
      moveWarning: null,
      moves: ["in"],
    });
  });

  it("lists every row Move would send to the catch-all, and none without one", () => {
    const doubled = [
      ...rows,
      mapping({ source: "in2", dest: "ReceivedBytes", action: "rename" }),
    ];
    const ask = (schema: typeof SCHEMA) =>
      destClaim(doubled, {
        sourceField: "qq",
        destColumn: "ReceivedBytes",
        destSchema: schema,
        catchAllColumn: "AdditionalExtensions",
      });
    expect(ask(SCHEMA)?.moves).toEqual(["in", "in2"]);
    expect(
      ask(SCHEMA.filter((c) => c.name !== "AdditionalExtensions"))?.moves,
    ).toEqual([]);
  });

  it("carries the DBT-202 move warning when the moving row leaves a rule column empty", () => {
    expect(
      claim("mac", "ReceivedBytes", {
        ruleFields: new Set(["sourcemacaddress"]),
      })?.moveWarning,
    ).toBe(
      "SourceMACAddress is used by analytics rules and nothing else fills it: moving mac leaves it empty.",
    );
  });

  it("has no fallback when the schema has no catch-all to move into", () => {
    const out = claim("qq", "ReceivedBytes", {
      schema: SCHEMA.filter((c) => c.name !== "AdditionalExtensions"),
    });
    expect(out?.claimedBy).toBe("in");
    expect(out?.fallback).toBeNull();
  });
});

describe("columnSuggestions (DBT-202)", () => {
  const rows = [
    mapping({
      source: "in",
      sourceType: "int",
      dest: "AdditionalExtensions",
      action: "overflow",
      confidence: "unmatched",
      sampleValue: "4242",
    }),
    mapping({
      source: "PanOSPacketsReceived",
      sourceType: "int",
      dest: "AdditionalExtensions",
      action: "overflow",
      confidence: "unmatched",
      sampleValue: "7",
    }),
    mapping({
      source: "SourceMACAddress",
      dest: "SourceMACAddress",
      action: "keep",
      sampleValue: "00:11:22:33:44:55",
    }),
  ];

  it("ranks the documented field first and renders its disposition, type and example", () => {
    const out = columnSuggestions(
      { name: "ReceivedBytes", type: "long" },
      "PanOS",
      rows,
    );
    expect(out.map((s) => s.source)).toEqual(["in", "PanOSPacketsReceived"]);
    expect(out[0]).toEqual({
      source: "in",
      example: { kind: "value", text: "4242", title: "4242" },
      // GEN-20: the alias ladder now names `in` (score 90) before the CEF
      // citation could, so the reason is the alias, not the citation.
      reason: "Known alias: in -> ReceivedBytes",
      disposition: "now: overflow into AdditionalExtensions",
      typeNote: "int to long",
      typeMismatch: false,
      lowConfidence: false,
      moveFrom: null,
      moveWarning: null,
      actionLabel: "Use this field",
    });
    // Token overlap only: shown, but marked (F1-d).
    expect(out[1]!.lowConfidence).toBe(true);
  });

  it("marks a type mismatch instead of hiding the candidate", () => {
    const out = columnSuggestions(
      { name: "ReceivedBytes", type: "long" },
      "PanOS",
      [
        mapping({
          source: "in",
          sourceType: "string",
          action: "overflow",
          dest: "AdditionalExtensions",
        }),
      ],
    );
    expect(out[0]!.typeMismatch).toBe(true);
    expect(out[0]!.typeNote).toBe(
      "string to long: the types differ - check the example value fits the column",
    );
  });

  it("offers a mapped field as a move, warning only when the rule column is left empty", () => {
    const column = { name: "DestinationMACAddress", type: "string" };
    const rules = new Set(["sourcemacaddress"]);
    const [move] = columnSuggestions(column, "PanOS", rows, rules);
    expect(move!.source).toBe("SourceMACAddress");
    expect(move!.moveFrom).toBe("SourceMACAddress");
    expect(move!.actionLabel).toBe("Move from SourceMACAddress");
    expect(move!.disposition).toBe("now: fills SourceMACAddress (keep)");
    expect(move!.moveWarning).toBe(
      "SourceMACAddress is used by analytics rules and nothing else fills it: moving SourceMACAddress leaves it empty.",
    );
    // Not a rule column: no warning.
    expect(columnSuggestions(column, "PanOS", rows)[0]!.moveWarning).toBeNull();
    // Another row still fills it: the move empties nothing.
    const shared = [
      ...rows,
      mapping({ source: "smac", dest: "SourceMACAddress", action: "rename" }),
    ];
    const sharedMove = columnSuggestions(column, "PanOS", shared, rules).find(
      (s) => s.source === "SourceMACAddress",
    );
    expect(sharedMove!.moveFrom).toBe("SourceMACAddress");
    expect(sharedMove!.moveWarning).toBeNull();
  });
});
