/**
 * Mapping-review state - the PURE approval STATE MACHINE behind the crown-jewel
 * DCR Gap Analysis / mapping review screen (porting-plan Unit 18, ENG-12,
 * GUI-08, GUI-32). Kept out of the component so the approval semantics, the
 * survive-and-re-key edit store, the staleness rule, and the deploy-gate
 * partition are unit-testable without a DOM.
 *
 * @soc/core owns the gap-analysis TRUTH: the six stat tiles, the field
 * mappings, the DCR/Cribl handles split, and the destination-resolution
 * provenance all arrive as a {@link GapReport} per table from the analyzeSamples
 * usecase. This module only tracks the operator's REVIEW STATE over those
 * reports:
 *
 *   1. APPROVALS - the consent moment. A table's mappings must be approved
 *      before the content/mapping-driven flagship path builds and deploys it.
 *      Approvals RESET on re-analysis (a fresh analysis invalidates a prior
 *      approval - the operator must re-consent to the new mapping).
 *   2. MAPPING EDITS - the reviewer's dest/action overrides, keyed by logType.
 *      They SURVIVE re-analysis (a re-run must not discard hand edits) and
 *      RE-KEY on a log-type rename via the Unit 11 reKeyByLogType primitive -
 *      the SAME re-key seam sample intake built for exactly this (never orphan
 *      an edit under the old key, the legacy renderer bug).
 *   3. STALENESS - a flag raised when the underlying samples / solution / schema
 *      changed AFTER the last analysis. Stale approvals cannot gate a deploy
 *      (the mapping they approved no longer reflects the inputs); the UI prompts
 *      a re-analyze. The legacy `analysisStale` flag, made explicit.
 *
 * DEPLOY-GATE PARTITION (task item 3, the critical MVP guard): the approval
 * gate here applies ONLY to the content/mapping-driven path. It NEVER touches
 * the native quick-onboard deploy (that path's readiness stays scope + worker
 * group + pack name, in @soc/core canDeploy). {@link deriveMappingReviewGate}
 * produces the content-path readiness; the native path never consults it.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto, no Math.random. It reuses
 * the Unit 11 reKeyByLogType primitive (the shared re-key seam) verbatim.
 */

import type { GapFieldMapping, GapReport } from "@soc/core";
import { reKeyByLogType } from "../samples/sample-intake-state";

// ---------------------------------------------------------------------------
// State + actions
// ---------------------------------------------------------------------------

/**
 * The operator's review state over the current set of {@link GapReport}s. Kept
 * minimal and serializable: approvals and edits are plain records so the whole
 * state can persist and re-key with one primitive.
 */
export interface MappingReviewState {
  /**
   * The set of approved logTypes, as a record used as a set (a `true` value per
   * approved logType). A record, not a Set, so it re-keys with the Unit 11
   * primitive and serializes cleanly.
   */
  approvals: Readonly<Record<string, true>>;
  /**
   * Per-logType edited mapping rows. Present only for tables the operator
   * hand-edited; a table with no entry uses its report's mappings verbatim.
   * SURVIVES re-analysis and RE-KEYS on rename.
   */
  mappingEdits: Readonly<Record<string, GapFieldMapping[]>>;
  /**
   * True when the samples / solution / schema changed after the last analysis,
   * so the current approvals no longer reflect the inputs (prompts re-analyze).
   */
  stale: boolean;
  /** Monotonic count of completed analyses (provenance / debug; never a key). */
  analysisRevision: number;
}

/** The pristine review state, before any analysis or approval. */
export const INITIAL_MAPPING_REVIEW_STATE: MappingReviewState = {
  approvals: {},
  mappingEdits: {},
  stale: false,
  analysisRevision: 0,
};

/** Which column of a mapping row an edit targets. */
export type MappingEditField = "dest" | "action";

/** The events that drive the approval state machine. */
export type MappingReviewAction =
  /**
   * A fresh analysis completed. Approvals RESET (the operator must re-consent to
   * the new mapping); edits SURVIVE (hand edits are not discarded); staleness
   * clears; the revision advances.
   */
  | { type: "analyzed" }
  /**
   * The underlying samples / solution / schema changed after the last analysis.
   * Raises the staleness flag (approvals and edits are kept but can no longer
   * gate a deploy). Idempotent and a no-op before the first analysis.
   */
  | { type: "inputs-changed" }
  /** Approve one table's mappings (the per-table consent). */
  | { type: "approve"; logType: string }
  /** Withdraw one table's approval. */
  | { type: "unapprove"; logType: string }
  /** Auto-Approve All - approve every table currently under review at once. */
  | { type: "auto-approve-all"; logTypes: readonly string[] }
  /** Reset All - clear every approval (edits and staleness untouched). */
  | { type: "reset-approvals" }
  /**
   * Edit one mapping row's dest column or action. `baseline` is the report's
   * current mappings for the table, used to seed the edit store on first edit
   * (mirrors the legacy `mappingEdits[logType] || a.fieldMappings`). A no-op
   * when no row matches `sourceField`.
   */
  | {
      type: "edit-mapping";
      logType: string;
      sourceField: string;
      field: MappingEditField;
      value: string;
      baseline: readonly GapFieldMapping[];
    }
  /**
   * A log type was renamed (the Unit 11 onRenameLogType seam). Re-keys the
   * approval and the edit store from `from` to `to` with the shared primitive,
   * so neither is orphaned under the old key.
   */
  | { type: "rename-log-type"; from: string; to: string };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Drop one key from a record, returning a new record (never mutates). */
function withoutKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== key) next[k] = v;
  }
  return next;
}

/** Apply one review action, returning the next state (pure; never mutates). */
export function mappingReviewReducer(
  state: MappingReviewState,
  action: MappingReviewAction,
): MappingReviewState {
  switch (action.type) {
    case "analyzed":
      // Approvals reset on re-analysis; edits survive; staleness clears.
      return {
        approvals: {},
        mappingEdits: state.mappingEdits,
        stale: false,
        analysisRevision: state.analysisRevision + 1,
      };

    case "inputs-changed":
      // Only meaningful once something has been analyzed; idempotent otherwise.
      if (state.analysisRevision === 0 || state.stale) {
        return state;
      }
      return { ...state, stale: true };

    case "approve":
      if (state.approvals[action.logType] === true) {
        return state;
      }
      return {
        ...state,
        approvals: { ...state.approvals, [action.logType]: true },
      };

    case "unapprove":
      if (state.approvals[action.logType] !== true) {
        return state;
      }
      return { ...state, approvals: withoutKey(state.approvals, action.logType) };

    case "auto-approve-all": {
      const approvals: Record<string, true> = { ...state.approvals };
      for (const logType of action.logTypes) {
        approvals[logType] = true;
      }
      return { ...state, approvals };
    }

    case "reset-approvals":
      if (Object.keys(state.approvals).length === 0) {
        return state;
      }
      return { ...state, approvals: {} };

    case "edit-mapping": {
      const current = state.mappingEdits[action.logType] ?? [
        ...action.baseline,
      ];
      const index = current.findIndex((m) => m.source === action.sourceField);
      if (index === -1) {
        return state;
      }
      const nextRows = current.map((row, i) =>
        i === index ? { ...row, [action.field]: action.value } : row,
      );
      return {
        ...state,
        mappingEdits: { ...state.mappingEdits, [action.logType]: nextRows },
      };
    }

    case "rename-log-type":
      // The Unit 11 re-key primitive, reused verbatim for BOTH stores.
      return {
        ...state,
        approvals: reKeyByLogType(state.approvals, action.from, action.to),
        mappingEdits: reKeyByLogType(
          state.mappingEdits,
          action.from,
          action.to,
        ),
      };

    default: {
      // Exhaustiveness: a new action type must be handled above.
      const never: never = action;
      return never;
    }
  }
}

// ---------------------------------------------------------------------------
// Selectors over one report / one table
// ---------------------------------------------------------------------------

/** Whether the operator has approved this table's mappings. */
export function isApproved(
  state: MappingReviewState,
  logType: string,
): boolean {
  return state.approvals[logType] === true;
}

/** Whether the operator has hand-edited this table's mappings. */
export function isModified(
  state: MappingReviewState,
  logType: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(state.mappingEdits, logType);
}

/**
 * The mapping rows to render/build for a table: the operator's edits when
 * present, otherwise the report's mappings verbatim (the legacy
 * `mappingEdits[logType] || a.fieldMappings`).
 */
export function effectiveMappings(
  state: MappingReviewState,
  report: GapReport,
): GapFieldMapping[] {
  return state.mappingEdits[report.logType] ?? report.fieldMappings;
}

/** The mapping rows sorted by destination column (the legacy render order). */
export function sortedMappings(
  mappings: readonly GapFieldMapping[],
): GapFieldMapping[] {
  return [...mappings].sort((a, b) => a.dest.localeCompare(b.dest));
}

/**
 * Destination columns of the report's schema that no source field maps to (the
 * legacy "Unmapped Destination Fields" section). Compared case-insensitively.
 */
export function unmappedDestColumns(
  report: GapReport,
  mappings: readonly GapFieldMapping[],
): Array<{ name: string; type: string }> {
  const mapped = new Set(mappings.map((m) => m.dest.toLowerCase()));
  return report.destSchema
    .filter((d) => !mapped.has(d.name.toLowerCase()))
    .map((d) => ({ name: d.name, type: d.type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The verbatim "Field Mappings (X mapped, Y unmapped)" expander label. */
export function fieldMappingsLabel(
  mappedCount: number,
  unmappedCount: number,
): string {
  return `Field Mappings (${mappedCount} mapped, ${unmappedCount} unmapped)`;
}

/**
 * RULE-badge lookup: a field is a rule field only when it is in the supplied
 * set. LIVE wiring: RuleCoverageSection computes the referenced-field set and
 * reports it via onRuleFieldsChange; the integrate screen threads it into the
 * mapping review's ruleFields prop, which lights the badge per mapping row.
 * An absent/empty set renders no badges. Case-insensitive, mirroring the
 * legacy lookup.
 */
export function isRuleField(
  name: string,
  ruleFields?: ReadonlySet<string>,
): boolean {
  if (ruleFields === undefined || ruleFields.size === 0) {
    return false;
  }
  return ruleFields.has(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// The content-path deploy gate (the partition from the native path)
// ---------------------------------------------------------------------------

/** The tables under review that actually have mappings needing approval. */
export function tablesWithMappings(
  reports: readonly GapReport[],
): GapReport[] {
  return reports.filter((r) => r.fieldMappings.length > 0);
}

/**
 * The content/mapping-driven path's readiness over the current reports and
 * review state. This is the ADDITIVE gate that blocks the CONTENT path until
 * every table with mappings is approved - it NEVER participates in the native
 * quick-onboard deploy gate (@soc/core canDeploy).
 */
export interface MappingReviewGate {
  /** How many tables under review have mappings (need approval). */
  total: number;
  /** How many of those are approved. */
  approved: number;
  /** Every table-with-mappings is approved (and there is at least one). */
  allApproved: boolean;
  /** Approvals no longer reflect the inputs (a re-analyze is required). */
  stale: boolean;
  /**
   * The content path is ready to deploy: every table-with-mappings is approved
   * AND the analysis is not stale. False when nothing has mappings (there is no
   * content path to deploy) - the native path is unaffected either way.
   */
  ready: boolean;
}

/** Derive the content-path readiness from the reports and the review state. */
export function deriveMappingReviewGate(
  state: MappingReviewState,
  reports: readonly GapReport[],
): MappingReviewGate {
  const withMappings = tablesWithMappings(reports);
  const total = withMappings.length;
  const approved = withMappings.filter((r) =>
    isApproved(state, r.logType),
  ).length;
  const allApproved = total > 0 && approved === total;
  return {
    total,
    approved,
    allApproved,
    stale: state.stale,
    ready: allApproved && !state.stale,
  };
}

// ---------------------------------------------------------------------------
// User-facing copy (verbatim legacy vocabulary)
// ---------------------------------------------------------------------------

/**
 * The approval-bar sentence, matching the legacy flagship verbatim. Progresses
 * none -> some -> all approved.
 */
export function approvalBarText(gate: MappingReviewGate): string {
  if (gate.allApproved) {
    return (
      `All ${gate.total} table mapping(s) approved. You can still expand and ` +
      `edit individual mappings below.`
    );
  }
  if (gate.approved > 0) {
    return (
      `${gate.approved} of ${gate.total} table mapping(s) approved. Approve ` +
      `each individually or auto-approve all.`
    );
  }
  return (
    "Field mappings require approval before building. Expand each table below " +
    "to review, or auto-approve to accept all mappings as-is."
  );
}

/** The Analyze/Re-Analyze button label (legacy: stale -> Analyze, else Re-Analyze). */
export function analyzeButtonLabel(
  reportCount: number,
  stale: boolean,
  analyzing: boolean,
): string {
  if (analyzing) {
    return "Analyzing...";
  }
  return reportCount === 0 || stale ? "Analyze Samples" : "Re-Analyze";
}

/** The staleness notice shown when approvals no longer match the inputs. */
export const MAPPING_REVIEW_STALE_NOTICE =
  "Samples or the solution changed after this analysis - re-analyze to refresh " +
  "the gap analysis and re-approve the mappings.";

/**
 * The overflow coverage explainer (task item 1): an overflow field is NOT
 * dropped data - it is counted as covered on BOTH sides. It contributes to
 * source coverage (the source field is handled, folded into the catch-all) and
 * to destination coverage (the catch-all column receives it).
 */
export const OVERFLOW_COVERAGE_NOTE =
  "Overflow fields count toward coverage on both sides: the source field is " +
  "handled (folded into the catch-all column, not dropped) and the catch-all " +
  "destination column receives it.";

/** The empty-state reason when there is nothing to analyze yet. */
export const MAPPING_REVIEW_NO_SAMPLES_REASON =
  "Tag at least one sample in the Sample Data section, then analyze to compare " +
  "its fields against the destination table schema.";

// ---------------------------------------------------------------------------
// Auto-seeding selectors (2026-07-12 audit: the "when to seed" decisions were
// embedded in useEffect bodies - pure and pinned here, the effects just loop)
// ---------------------------------------------------------------------------

/** One enrichment constant an auto-seeding pass should add. */
export interface PendingSeed {
  logType: string;
  /** The one-shot guard key - a user deletion sticks because the key stays. */
  key: string;
  field: string;
  value: string;
}

/** The subset of a detected identity the seed selector reads. */
interface IdentityForSeeding {
  vendor: string;
  product?: string;
}

/** The identity-status subset the seed selector reads. */
interface IdentityStatusRow {
  field: string;
  status: string;
}

/**
 * The identity constants to seed NOW: for every report, every REQUIRED
 * identity field that is missing, not yet seeded (alreadySeeded holds the
 * one-shot keys), and has a suggested value (vendor always; product only
 * when the identity carries a single stable one).
 */
export function pendingIdentitySeeds(
  reports: readonly GapReport[],
  statusesByLogType: Readonly<Record<string, readonly IdentityStatusRow[]>>,
  identity: IdentityForSeeding | null,
  suggestValue: (field: string) => string | null,
  alreadySeeded: ReadonlySet<string>,
): PendingSeed[] {
  if (identity === null) return [];
  const seeds: PendingSeed[] = [];
  for (const report of reports) {
    for (const status of statusesByLogType[report.logType] ?? []) {
      if (status.status !== "missing") continue;
      const key = `${report.logType}|${report.tableName}|${status.field}`;
      if (alreadySeeded.has(key)) continue;
      const value = suggestValue(status.field);
      if (value === null) continue;
      seeds.push({ logType: report.logType, key, field: status.field, value });
    }
  }
  return seeds;
}

/** The vendor-label demand subset the seed selector reads. */
interface LabelDemand {
  sourceName: string;
  destName: string;
  field: string;
  value: string;
}

/**
 * The CEF label constants to seed NOW: a label seeds only when the pack
 * mapping that demands it actually APPLIED in the report (source -> dest
 * present with a real destination), the Label column exists in the resolved
 * schema, and the one-shot key has not been used.
 */
export function pendingLabelSeeds(
  reports: readonly GapReport[],
  labels: readonly LabelDemand[],
  alreadySeeded: ReadonlySet<string>,
): PendingSeed[] {
  if (labels.length === 0) return [];
  const seeds: PendingSeed[] = [];
  for (const report of reports) {
    const appliedPairs = new Set(
      report.fieldMappings
        .filter((m) => m.dest !== "")
        .map((m) => `${m.source.toLowerCase()}|${m.dest.toLowerCase()}`),
    );
    const schemaColumns = new Set(
      report.destSchema.map((c) => c.name.toLowerCase()),
    );
    for (const label of labels) {
      const pair = `${label.sourceName.toLowerCase()}|${label.destName.toLowerCase()}`;
      if (!appliedPairs.has(pair)) continue;
      if (!schemaColumns.has(label.field.toLowerCase())) continue;
      const key = `${report.logType}|${report.tableName}|${label.field}`;
      if (alreadySeeded.has(key)) continue;
      seeds.push({ logType: report.logType, key, field: label.field, value: label.value });
    }
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// Unused-field disposition (user direction 2026-07-12: fields required by
// neither analytics rules nor workbooks default to DROP, not catch-all)
// ---------------------------------------------------------------------------

/** The content-requirements subset the assessor reads (core shape). */
export interface RequirementsForAssessment {
  columns: ReadonlySet<string>;
  catchAllKeys: ReadonlySet<string>;
  opaqueCatchAll: boolean;
  itemCount: number;
}

/** One table's unused-overflow assessment. */
export interface UnusedFieldAssessment {
  /** Overflow sources required by neither rules nor workbooks - droppable. */
  droppable: string[];
  /** Overflow sources content consumes (catch-all keys / same-named refs). */
  keptByContent: string[];
  /** Why auto-drop is disabled (null = safe to drop the droppable list). */
  blocked: "no-requirements" | "opaque-catch-all" | null;
}

/**
 * Assess a report's OVERFLOW rows against the content requirements. Mapped
 * rows are never candidates (their destination column is the requirement
 * surface); only catch-all overflow is. Honesty gates: with no analyzed
 * content there is no evidence to drop on, and with OPAQUE catch-all use
 * (content parses AdditionalExtensions without determinable keys) dropping
 * anything could break that content.
 */
export function assessUnusedOverflow(
  report: GapReport,
  requirements: RequirementsForAssessment | null,
): UnusedFieldAssessment {
  if (requirements === null || requirements.itemCount === 0) {
    return { droppable: [], keptByContent: [], blocked: "no-requirements" };
  }
  if (requirements.opaqueCatchAll) {
    return { droppable: [], keptByContent: [], blocked: "opaque-catch-all" };
  }
  const droppable: string[] = [];
  const keptByContent: string[] = [];
  for (const mapping of report.fieldMappings) {
    if (mapping.action !== "overflow") continue;
    const source = mapping.source.toLowerCase();
    if (
      requirements.catchAllKeys.has(source) ||
      requirements.columns.has(source)
    ) {
      keptByContent.push(mapping.source);
    } else {
      droppable.push(mapping.source);
    }
  }
  return { droppable, keptByContent, blocked: null };
}
