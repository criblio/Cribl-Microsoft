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
 *      a re-analyze. The legacy `analysisStale` flag, made explicit. Judged PER
 *      LOG TYPE (DBT-143): removing one sample is not a change to the others,
 *      so it does not make their analysis stale - the removed log type is
 *      pruned instead (`remove-log-type`), and every other approval stands.
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

import type {
  FieldRef,
  GapFieldMapping,
  GapReport,
  GapReportStat,
  MatchAction,
  TaggedSample,
} from "@soc/core";
import { applyRemap, FIELD_EXAMPLE_MAX_CHARS, landsInColumn } from "@soc/core";
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
   * Edit one mapping row's action. `baseline` is the report's current mappings
   * for the table, used to seed the edit store on first edit (mirrors the
   * legacy `mappingEdits[logType] || a.fieldMappings`). A no-op when no row
   * matches `sourceField`.
   */
  | {
      type: "edit-mapping";
      logType: string;
      sourceField: string;
      field: "action";
      value: string;
      baseline: readonly GapFieldMapping[];
    }
  /**
   * Point one mapping row at another destination column (GEN-19). Delegates to
   * @soc/core applyRemap, so the row's action, destType, coercion flag and
   * confidence follow the column instead of staying what the matcher left: an
   * overflow row pointed at SourceMACAddress becomes a rename the pipeline
   * emits. Choosing the baseline column restores the baseline row. A no-op
   * when no row matches or the column is not in `destSchema`.
   */
  | {
      type: "edit-mapping";
      logType: string;
      sourceField: string;
      field: "dest";
      value: string;
      baseline: readonly GapFieldMapping[];
      /** The report's resolved schema: the chosen column's type comes from it. */
      destSchema: readonly FieldRef[];
      /** The table's catch-all column; choosing it makes the row overflow. */
      catchAllColumn?: string;
    }
  /**
   * A log type was renamed (the Unit 11 onRenameLogType seam). Re-keys the
   * approval and the edit store from `from` to `to` with the shared primitive,
   * so neither is orphaned under the old key.
   */
  | { type: "rename-log-type"; from: string; to: string }
  /**
   * A log type's sample was removed (DBT-143). Drops its approval and its edit
   * store and touches nothing else: the other tables' approvals stand, and
   * staleness is unchanged, because the remaining analysis is still about
   * exactly the samples it was run on.
   */
  | { type: "remove-log-type"; logType: string };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Drop one key from a record, returning a new record (never mutates). */
export function withoutKey<T>(
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
      if (action.field === "dest") {
        const remap = applyRemap(current, {
          sourceField: action.sourceField,
          destColumn: action.value,
          destSchema: action.destSchema,
          catchAllColumn: action.catchAllColumn,
          baseline: action.baseline,
        });
        if (remap.outcome !== "applied" && remap.outcome !== "reverted") {
          return state;
        }
        return {
          ...state,
          mappingEdits: { ...state.mappingEdits, [action.logType]: remap.rows },
        };
      }
      const index = current.findIndex((m) => m.source === action.sourceField);
      if (index === -1) {
        return state;
      }
      const nextRows = current.map((row, i) =>
        // The action dropdown offers only MatchAction values (ACTION_OPTIONS).
        i === index ? { ...row, action: action.value as MatchAction } : row,
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

    case "remove-log-type":
      return {
        ...state,
        approvals: withoutKey(state.approvals, action.logType),
        mappingEdits: withoutKey(state.mappingEdits, action.logType),
      };

    default: {
      // Exhaustiveness: a new action type must be handled above.
      const never: never = action;
      return never;
    }
  }
}

// ---------------------------------------------------------------------------
// Staleness signature (per log type)
// ---------------------------------------------------------------------------

/**
 * What an analysis was run on: the solution, and one fingerprint per log type.
 *
 * PER LOG TYPE, NOT ONE STRING (DBT-143). This was a single joined string, so
 * removing any sample changed it and marked the whole analysis stale - and the
 * only way out, Re-analyze, resets every approval. Keyed by log type, a
 * removed sample simply has no current counterpart to disagree with.
 */
export interface AnalysisSignature {
  solutionName: string;
  byLogType: Readonly<Record<string, string>>;
}

/** The empty signature: nothing analyzed yet. */
export const EMPTY_ANALYSIS_SIGNATURE: AnalysisSignature = {
  solutionName: "",
  byLogType: {},
};

/** Fingerprint the analysis inputs (same three facets the string form used). */
export function analysisSignature(
  solutionName: string,
  samples: readonly TaggedSample[],
): AnalysisSignature {
  const byLogType: Record<string, string> = {};
  for (const s of samples) {
    byLogType[s.logType] = `${s.parsed.fields.length}#${s.format}`;
  }
  return { solutionName, byLogType };
}

/**
 * Whether `current` asks for an analysis `analyzed` did not do: the solution
 * changed, or a current log type was never analyzed or has changed since. A
 * log type present only in `analyzed` - a removed sample - is NOT staleness;
 * the caller prunes its report instead.
 */
export function isSignatureStale(
  analyzed: AnalysisSignature,
  current: AnalysisSignature,
): boolean {
  if (analyzed.solutionName !== current.solutionName) {
    return true;
  }
  return Object.entries(current.byLogType).some(
    ([logType, fingerprint]) => analyzed.byLogType[logType] !== fingerprint,
  );
}

/**
 * Forget one log type from an analyzed signature, so a sample re-added under
 * the same name after a removal reads as NEW (stale) rather than as already
 * analyzed - its report was pruned and nothing would otherwise prompt a run.
 */
export function signatureWithout(
  signature: AnalysisSignature,
  logType: string,
): AnalysisSignature {
  return {
    solutionName: signature.solutionName,
    byLogType: withoutKey(signature.byLogType, logType),
  };
}

/**
 * Drop every `${logType}|...` key from a one-shot guard set (the identity and
 * label seed guards, the auto-drop ledger). Mutates the set, which is what
 * those refs are for. Returns how many keys went.
 */
export function forgetLogTypeKeys(keys: Set<string>, logType: string): number {
  const prefix = `${logType}|`;
  let removed = 0;
  for (const key of [...keys]) {
    if (key.startsWith(prefix)) {
      keys.delete(key);
      removed += 1;
    }
  }
  return removed;
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

/** The row fields that carry a mapping DECISION, compared by isModified. */
const DECISION_FIELDS = [
  "dest",
  "destType",
  "action",
  "needsCoercion",
  "confidence",
] as const;

/**
 * Whether the operator's edits for this table differ from the analysis
 * (DBT-194). Compared row by row, field by field: the edit store exists from
 * the first edit on, so asking only whether it exists kept "Modified" up after
 * every edit had been set back. Rows are matched by source. The description
 * and the example value are display, not decision, and a re-analysis may
 * legitimately refresh them.
 */
export function isModified(
  state: MappingReviewState,
  report: GapReport,
): boolean {
  const edits = state.mappingEdits[report.logType];
  if (edits === undefined) {
    return false;
  }
  if (edits.length !== report.fieldMappings.length) {
    return true;
  }
  const baseline = new Map(report.fieldMappings.map((m) => [m.source, m]));
  return edits.some((edit) => {
    const original = baseline.get(edit.source);
    return (
      original === undefined ||
      DECISION_FIELDS.some((field) => edit[field] !== original[field])
    );
  });
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
 * A dropped row fills nothing, so its column stays unmapped (DBT-193: the
 * header's mapped and unmapped counts must agree); an overflow row's column
 * is the catch-all, which the serialize does fill.
 */
export function unmappedDestColumns(
  report: GapReport,
  mappings: readonly GapFieldMapping[],
): Array<{ name: string; type: string }> {
  const mapped = new Set(
    mappings.filter((m) => m.action !== "drop").map((m) => m.dest.toLowerCase()),
  );
  return report.destSchema
    .filter((d) => !mapped.has(d.name.toLowerCase()))
    .map((d) => ({ name: d.name, type: d.type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The "Field Mappings (...)" expander label (DBT-193). "Mapped" counts only the
 * rows that land in a dedicated column; overflow and dropped rows are named
 * separately, each only when there are any. It used to print every row as
 * mapped, so the PAN-OS UAT read "115 mapped" while 56 of those went to
 * AdditionalExtensions and only 59 reached a column.
 */
export function fieldMappingsLabel(
  mappings: readonly GapFieldMapping[],
  unmappedCount: number,
): string {
  const mapped = mappings.filter(landsInColumn).length;
  const overflow = mappings.filter((m) => m.action === "overflow").length;
  const dropped = mappings.filter((m) => m.action === "drop").length;
  const parts = [`${mapped} mapped`];
  if (overflow > 0) parts.push(`${overflow} to overflow`);
  if (dropped > 0) parts.push(`${dropped} dropped`);
  parts.push(`${unmappedCount} unmapped`);
  return `Field Mappings (${parts.join(", ")})`;
}

/**
 * DBT-122: the longest Example Value the Field Mappings table prints before
 * shortening it. CSS also ellipsizes the cell at its max width; this cap keeps
 * a multi-kilobyte value (a command line, a JSON blob) out of the table text
 * entirely. The FULL value always stays in the cell's title.
 */
export const EXAMPLE_VALUE_MAX_CHARS = 80;

/** The Example Value tip for a field with no captured example. */
const NO_EXAMPLE_TITLE =
  "No example captured: the sample had no value for this field, or every " +
  `value was ${FIELD_EXAMPLE_MAX_CHARS} characters or longer`;

/** One rendered Example Value cell: what to print, and what the tip says. */
export interface ExampleValueCell {
  /**
   * "none" = no example was captured (no value, or every value was at least
   * FIELD_EXAMPLE_MAX_CHARS long); "empty" = it had the empty string.
   */
  kind: "value" | "empty" | "none";
  text: string;
  title: string;
}

/**
 * Format a mapping row's `sampleValue` (the FIRST value seen for the field in
 * the sample) for the Example Value column (DBT-122). Never trims - leading or
 * trailing whitespace is part of the value and is exactly the kind of thing the
 * operator is checking for. Line breaks and tabs are escaped in the cell text
 * only (so a row stays one line); the title keeps the raw value. An empty
 * string and a missing value are different facts and render differently.
 *
 * A missing value is NOT proof the sample had none: collectFields keeps no
 * example of FIELD_EXAMPLE_MAX_CHARS or more, so a field holding only long
 * values (command lines, URLs, JSON blobs) arrives undefined too. The tip says
 * both, rather than "no value" (audit follow-up to DBT-122).
 */
export function formatExampleValue(value: string | undefined): ExampleValueCell {
  if (value === undefined) {
    return {
      kind: "none",
      text: "--",
      title: NO_EXAMPLE_TITLE,
    };
  }
  if (value === "") {
    return { kind: "empty", text: '""', title: "Empty string in the sample" };
  }
  const escaped = value
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  const text =
    escaped.length > EXAMPLE_VALUE_MAX_CHARS
      ? `${escaped.slice(0, EXAMPLE_VALUE_MAX_CHARS - 3)}...`
      : escaped;
  return { kind: "value", text, title: value };
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
  /**
   * OPTIONAL canonical casing per lowercased column (core
   * ContentRequirements.columnNames): schema derivation for unresolved _CL
   * destinations creates columns under these spellings.
   */
  columnNames?: ReadonlyMap<string, string>;
}

/** One table's unused-overflow assessment. */
/**
 * What the unused-field policy wants to change, for ONE table, as data.
 *
 * Pure so the rule can be argued with directly. It was previously inlined in an
 * effect that also dispatched, which is how the asymmetry below survived: the
 * restore branch consulted the already-dropped set and the drop branch did not.
 * Since the effect re-ran on every mapping edit, a field the operator moved back
 * to overflow was seen at overflow again and re-dropped, so it could not be
 * kept - the row snapped back with no message. Fixed 2026-08-26.
 *
 * `alreadyDropped` is the memory that makes this idempotent: drop acts once per
 * field, and only a switch to preserve (which forgets the field) lets it act
 * again. Keys are `logType|source`.
 */
export function autoDropPlan(
  policy: "drop" | "preserve",
  logType: string,
  assessment: UnusedFieldAssessment,
  effective: readonly GapFieldMapping[],
  alreadyDropped: ReadonlySet<string>,
): { drop: string[]; restore: string[] } {
  const drop: string[] = [];
  const restore: string[] = [];

  if (policy === "drop" && assessment.blocked === null) {
    for (const source of assessment.droppable) {
      if (alreadyDropped.has(`${logType}|${source}`)) continue;
      const row = effective.find((m) => m.source === source);
      if (row === undefined || row.action !== "overflow") continue;
      drop.push(source);
    }
  }

  if (policy === "preserve") {
    for (const source of assessment.droppable) {
      // Only what THIS policy dropped. A field the operator dropped by hand is
      // their decision and preserve does not reach into it.
      if (!alreadyDropped.has(`${logType}|${source}`)) continue;
      restore.push(source);
    }
  }

  return { drop, restore };
}

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

// ---------------------------------------------------------------------------
// LIVE stat tiles (user request 2026-07-12: a Dropped tile, and Overflow
// reaching ZERO when every overflow field is dropped)
// ---------------------------------------------------------------------------

/** InfoTip for the UI-only Dropped tile (parallel to the report's hints). */
const HINT_DROPPED =
  "Source fields the pipeline DROPS - via the unused-field policy, a " +
  "reviewer edit, or a learned decision. Dropped fields are removed before " +
  "serialization: they reach neither a destination column nor the catch-all.";

/**
 * The stat tiles derived from the reviewer's EFFECTIVE mappings, so edits
 * move the numbers live: dropping an overflow field decrements Overflow and
 * increments the appended Dropped tile. With no edits the six report tiles
 * are reproduced exactly (same counting rules as buildGapReport); Source
 * Fields, Dest Columns, and DCR Handles are analysis facts and pass through.
 */
export function deriveLiveStats(
  report: GapReport,
  effective: readonly GapFieldMapping[],
): GapReportStat[] {
  const passthrough = effective.filter(
    (m) => m.action === "keep" && !m.needsCoercion,
  ).length;
  const renames = effective.filter((m) => m.action === "rename").length;
  const coerces = effective.filter(
    (m) => m.action === "coerce" || (m.action === "keep" && m.needsCoercion),
  ).length;
  const overflow = effective.filter((m) => m.action === "overflow").length;
  const dropped = effective.filter((m) => m.action === "drop").length;

  const live = report.stats.map((stat): GapReportStat => {
    switch (stat.key) {
      case "passthrough":
        return {
          ...stat,
          value: passthrough,
          tone: passthrough > 0 ? "ok" : "neutral",
        };
      case "cribl-handles": {
        const value = renames + coerces;
        return { ...stat, value, tone: value > 0 ? "info" : "neutral" };
      }
      case "overflow":
        return {
          ...stat,
          value: overflow,
          tone: overflow > 0 ? "warn" : "neutral",
        };
      default:
        return stat;
    }
  });
  live.push({
    key: "dropped",
    label: "Dropped",
    value: dropped,
    hint: HINT_DROPPED,
    tone: dropped > 0 ? "info" : "neutral",
  });
  return live;
}
