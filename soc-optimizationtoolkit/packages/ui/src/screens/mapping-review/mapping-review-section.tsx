/**
 * MappingReviewSection - THE CROWN-JEWEL approval moment: the DCR Gap Analysis
 * section of the single-page Integrate arc (porting-plan Unit 18, ENG-12,
 * GUI-08, GUI-32). It grows the Unit 13 match-preview SEED into the full
 * mapping review the legacy Sentinel Integration flagship had
 * (SentinelIntegration.tsx 2193-2578).
 *
 * What it renders, per tagged log type:
 *   - the SIX STAT TILES (Source Fields / Dest Columns / Passthrough / DCR
 *     Handles / Cribl Handles / Overflow) with their VERBATIM InfoTip domain
 *     text, straight off the @soc/core GapReport;
 *   - the "DCR handles: N rename(s), M coercion(s)" and "Cribl handles: ..."
 *     summaries;
 *   - an EDITABLE field-mapping table: a dest-column dropdown and an action
 *     dropdown per source field, plus the unmapped destination columns;
 *   - RULE badges in the markup, INERT until Unit 23 wires a rule-field set;
 *   - the data-loss warnings surfaced honestly (the source/host/port collision
 *     footgun and the overflow-loss case) from the report.
 *
 * The APPROVAL STATE MACHINE lives in the pure mapping-review-state module; this
 * component only drives it: Auto-Approve All / Reset All / per-table Approve,
 * the "Approval Required" / "Approved" badges, the staleness prompt, and the
 * "X mapped, Y unmapped" expander label. Approvals reset on re-analysis; edits
 * survive and re-key on a log-type rename (the Unit 11 seam, threaded via the
 * optional renameEvent prop).
 *
 * All analysis IO flows through @soc/core: the analyzeSamples usecase over the
 * SentinelContent + SchemaCatalog ports produces one GapReport per table. This
 * component owns zero decision logic and zero direct fetch/storage - it resolves
 * destinations (with provenance), runs the usecase, and renders.
 *
 * DEPLOY-GATE PARTITION: onGateChange reports the CONTENT-path readiness
 * (deriveMappingReviewGate().ready). The parent feeds it to the arc as
 * mappingsApproved, which lights the Mappings pill and gates the content path
 * WITHOUT ever touching the native quick-onboard deploy (@soc/core canDeploy).
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  DEFAULT_GAP_PROFILE,
  collectGapReports,
  createBundledSchemaCatalog,
  decodeConnector,
  detectVendorIdentity,
  diffLearnedMappings,
  hintsFromConnectorTables,
  identityValueOptions,
  learnedMappingsCacheKey,
  learnedToVendorMappings,
  matchSampleLogTypeToTable,
  mergeLearnedMappings,
  parseLearnedMappings,
  resolveDestinationTables,
  resolveIdentityFields,
  suggestedIdentityValue,
  vendorMappingsForSolution,
} from "@soc/core";
import type {
  ContentCache,
  DestinationTableResolution,
  GapFieldMapping,
  GapReport,
  LearnedMapping,
  IdentityFieldStatus,
  MatchAction,
  SchemaCatalog,
  SentinelContent,
  SolutionConnector,
  TaggedSample,
  VendorGapProfile,
  VendorIdentity,
} from "@soc/core";
import { InfoTip } from "../../components/info-tip";
import { SearchableSelect } from "../../components/searchable-select";
import {
  isValidEnrichmentFieldName,
  mergeEnrichments,
} from "../pipeline-preview/pipeline-preview-state";
import type { EnrichmentField } from "../pipeline-preview/pipeline-preview-state";
import {
  INITIAL_MAPPING_REVIEW_STATE,
  MAPPING_REVIEW_NO_SAMPLES_REASON,
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
} from "./mapping-review-state";

/** The action-dropdown options (the Cribl pipeline dispositions). */
const ACTION_OPTIONS: readonly MatchAction[] = [
  "keep",
  "rename",
  "coerce",
  "decode",
  "overflow",
  "drop",
];

/** A rename signal from the Sample Data section (the Unit 11 seam). */
export interface MappingReviewRenameEvent {
  from: string;
  to: string;
  /** Bumped on every rename so a repeated from/to still fires the effect. */
  nonce: number;
}

export interface MappingReviewSectionProps {
  /** The selected Sentinel solution name (scopes the DCR lookup); "" when none. */
  solutionName: string;
  /** The tagged samples to analyze (from the Sample Data section). */
  samples: TaggedSample[];
  /**
   * The lazy Sentinel content accessor (ports.content). Absent -> the analysis
   * degrades to synthetic no-op DCR flows (still produces reports from the
   * bundled schema + field matcher), exactly as the usecase degrades.
   */
  content?: SentinelContent;
  /** Schema catalog; defaults to the fetch-free bundled adapter. */
  catalog?: SchemaCatalog;
  /** Vendor quirks for the gap analysis (defaults to the generic profile). */
  vendorProfile?: VendorGapProfile;
  /**
   * Rule-referenced field names (lowercased) for the RULE badge. Absent/empty
   * keeps the badge INERT until Unit 23 wires rule coverage.
   */
  ruleFields?: ReadonlySet<string>;
  /** Reports the CONTENT-path readiness (every table approved and fresh). */
  onGateChange?: (ready: boolean) => void;
  /** Surfaces the produced reports (e.g. for the pipeline-generation section). */
  onReportsChange?: (reports: GapReport[]) => void;
  /**
   * Surfaces the reviewer's EFFECTIVE (edited) mappings keyed by logType, so the
   * Unit 17 pipeline preview reflects hand edits (not just the analyzed
   * baseline). Additive; absent -> the preview falls back to report baselines.
   */
  onEffectiveMappingsChange?: (
    byLogType: Readonly<Record<string, GapFieldMapping[]>>,
  ) => void;
  /** A log-type rename to re-key approvals + edits by (the Unit 11 seam). */
  renameEvent?: MappingReviewRenameEvent;
  /**
   * Surfaces the user-added ENRICHMENT constants (merged global + per-table)
   * keyed by logType - fields the source does not carry that the pipeline
   * adds (e.g. DeviceVendor for PAN-OS). Feeds the pipeline preview, the pack
   * build, and the coverage availability set.
   */
  onEnrichmentsChange?: (
    byLogType: Readonly<Record<string, EnrichmentField[]>>,
  ) => void;
  /**
   * Plain-KV store for LEARNED mappings (the reviewer-feedback loop): every
   * approved hand edit persists per solution and replays on future analyses
   * as the highest-priority tier, ahead of the vendor packs. Absent = the
   * loop is off (analysis still works).
   */
  learnedCache?: ContentCache;
}

/**
 * A degraded content accessor for when no SentinelContent port is bound: every
 * lookup is empty, so the usecase falls back to synthetic no-op DCR flows.
 */
const EMPTY_SENTINEL_CONTENT: SentinelContent = {
  listSolutions: async () => [],
  listSolutionFiles: async () => [],
  listRepoFiles: async () => [],
  listConnectorFiles: async () => [],
  readFile: async () => null,
  rawFetch: async () => null,
  getCommitSha: async () => null,
};

/**
 * Common Sentinel native destination tables offered in the per-sample table
 * override (in addition to the solution's resolved tables), so the operator can
 * realign a sample to a standard table the detection did not pick.
 */
const COMMON_NATIVE_TABLES: readonly string[] = [
  "CommonSecurityLog",
  "SecurityEvent",
  "Syslog",
  "WindowsEvent",
];

/**
 * How many of a solution's connector files are read and decoded for the
 * destination-table hints (each is one raw fetch; matches the solution
 * browser's decode cap).
 */
const CONNECTOR_TABLE_DECODE_CAP = 5;

/** A stable signature of the analysis inputs (drives staleness detection). */
function inputSignature(solutionName: string, samples: TaggedSample[]): string {
  const parts = samples.map(
    (s) => `${s.logType}#${s.parsed.fields.length}#${s.format}`,
  );
  return `${solutionName}||${parts.join("|")}`;
}

export function MappingReviewSection({
  solutionName,
  samples,
  content,
  catalog,
  vendorProfile,
  ruleFields,
  onGateChange,
  onReportsChange,
  onEffectiveMappingsChange,
  renameEvent,
  onEnrichmentsChange,
  learnedCache,
}: MappingReviewSectionProps) {
  const activeCatalog = useMemo(
    () => catalog ?? createBundledSchemaCatalog(),
    [catalog],
  );
  const activeContent = content ?? EMPTY_SENTINEL_CONTENT;
  const profile: VendorGapProfile = vendorProfile ?? DEFAULT_GAP_PROFILE;

  const [reports, setReports] = useState<GapReport[]>([]);
  const [resolution, setResolution] =
    useState<DestinationTableResolution | null>(null);
  // Per-logType destination-table OVERRIDES: the operator can reassign which
  // native table a sample aligns to when the default detection is wrong.
  const [tableOverrides, setTableOverrides] = useState<Record<string, string>>(
    {},
  );
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");
  // Per-card field search (user request 2026-07-09): filters the mapping
  // table's rows (source OR destination name) and the unmapped-column list,
  // so a field flagged by the coverage sections can be found by hand.
  const [mappingSearch, setMappingSearch] = useState<Record<string, string>>(
    {},
  );

  // ---- Learned mappings (the reviewer-feedback loop) ----------------------
  // Loaded per solution; replayed into Phase 0 AHEAD of the vendor packs on
  // every analysis; extended with the diffed hand edits on every APPROVE.
  const [learned, setLearned] = useState<LearnedMapping[]>([]);
  useEffect(() => {
    let cancelled = false;
    setLearned([]);
    if (learnedCache === undefined || solutionName === "") {
      return;
    }
    void (async () => {
      try {
        const raw = await learnedCache.get(learnedMappingsCacheKey(solutionName));
        if (!cancelled) {
          setLearned(parseLearnedMappings(raw));
        }
      } catch {
        // A failed load only disables replay for this session.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [learnedCache, solutionName]);

  // Persist the hand edits of the given reports (diffed against their
  // analyzed baselines) into the learned store. Fire-and-forget: a failed
  // save never blocks the approval.
  const persistLearned = useCallback(
    (toLearn: readonly GapReport[], reviewState: typeof review) => {
      if (learnedCache === undefined || solutionName === "") {
        return;
      }
      const fresh = toLearn.flatMap((report) =>
        diffLearnedMappings(
          report.fieldMappings.map((m) => ({
            source: m.source,
            dest: m.dest,
            action: m.action,
          })),
          effectiveMappings(reviewState, report).map((m) => ({
            source: m.source,
            dest: m.dest,
            action: m.action,
          })),
        ),
      );
      if (fresh.length === 0) {
        return;
      }
      const merged = mergeLearnedMappings(learned, fresh);
      setLearned(merged);
      void learnedCache
        .set(learnedMappingsCacheKey(solutionName), merged)
        .catch(() => undefined);
    },
    [learnedCache, solutionName, learned],
  );

  // ---- User-added enrichment fields --------------------------------------
  // Constants the pipeline ADDS because the source never carries them (the
  // DeviceVendor/DeviceProduct case): a GLOBAL list applied to every table
  // plus per-table additions (per-table wins on a field-name collision).
  const [globalEnrichments, setGlobalEnrichments] = useState<EnrichmentField[]>(
    [],
  );
  const [tableEnrichments, setTableEnrichments] = useState<
    Record<string, EnrichmentField[]>
  >({});

  const mergedEnrichments = useMemo(() => {
    const byLogType: Record<string, EnrichmentField[]> = {};
    for (const report of reports) {
      const merged = mergeEnrichments(
        globalEnrichments,
        tableEnrichments[report.logType] ?? [],
      );
      if (merged.length > 0) {
        byLogType[report.logType] = merged;
      }
    }
    return byLogType;
  }, [reports, globalEnrichments, tableEnrichments]);

  useEffect(() => {
    onEnrichmentsChange?.(mergedEnrichments);
  }, [mergedEnrichments, onEnrichmentsChange]);

  const addEnrichment = useCallback(
    (logType: string | null, field: string, value: string) => {
      const name = field.trim();
      // Values are emitted inside a single-quoted Eval expression - strip
      // quotes so a paste cannot break the generated YAML.
      const safeValue = value.trim().replace(/['"]/g, "");
      if (!isValidEnrichmentFieldName(name) || safeValue === "") {
        return false;
      }
      const entry: EnrichmentField = { field: name, value: safeValue };
      if (logType === null) {
        setGlobalEnrichments((prev) => [
          ...prev.filter((e) => e.field !== name),
          entry,
        ]);
      } else {
        setTableEnrichments((prev) => ({
          ...prev,
          [logType]: [
            ...(prev[logType] ?? []).filter((e) => e.field !== name),
            entry,
          ],
        }));
      }
      return true;
    },
    [],
  );

  const removeEnrichment = useCallback(
    (logType: string | null, field: string) => {
      if (logType === null) {
        setGlobalEnrichments((prev) => prev.filter((e) => e.field !== field));
      } else {
        setTableEnrichments((prev) => ({
          ...prev,
          [logType]: (prev[logType] ?? []).filter((e) => e.field !== field),
        }));
      }
    },
    [],
  );
  const [review, dispatch] = useReducer(
    mappingReviewReducer,
    INITIAL_MAPPING_REVIEW_STATE,
  );

  // ---- Required vendor identity (DeviceVendor/DeviceProduct) --------------
  // Per-logType resolution of the identity fields the destination table
  // REQUIRES: sample-provided (CEF headers), enrichment-covered, or MISSING.
  // Missing fields render a forced-input row on the card and block the pack
  // build (the parent gates on the same core resolver).
  const identityStatuses = useMemo(() => {
    const byLogType: Record<string, IdentityFieldStatus[]> = {};
    for (const report of reports) {
      const statuses = resolveIdentityFields(
        report.tableName,
        effectiveMappings(review, report),
        mergeEnrichments(
          globalEnrichments,
          tableEnrichments[report.logType] ?? [],
        ),
      );
      if (statuses.length > 0) {
        byLogType[report.logType] = statuses;
      }
    }
    return byLogType;
  }, [reports, review, globalEnrichments, tableEnrichments]);

  // The curated identity for the selected solution (null when uncurated):
  // drives the auto-seeding below and the one-click choices on the
  // forced-input rows (e.g. Zscaler's NSSWeblog / NSSFWlog products).
  const detectedIdentity = useMemo(
    () => detectVendorIdentity(solutionName),
    [solutionName],
  );

  // Auto-seed curated solution knowledge (e.g. PaloAlto -> DeviceVendor =
  // Palo Alto Networks) as EDITABLE per-table enrichments, once per
  // logType/table/field. The one-shot guard means a user deletion sticks: the
  // field goes missing and becomes a forced input instead of being re-seeded.
  const seededIdentityRef = useRef(new Set<string>());
  useEffect(() => {
    const identity = detectedIdentity;
    if (identity === null) {
      return;
    }
    for (const report of reports) {
      for (const status of identityStatuses[report.logType] ?? []) {
        if (status.status !== "missing") {
          continue;
        }
        const key = `${report.logType}|${report.tableName}|${status.field}`;
        if (seededIdentityRef.current.has(key)) {
          continue;
        }
        const value = suggestedIdentityValue(status.field, identity);
        if (value === null) {
          continue;
        }
        seededIdentityRef.current.add(key);
        addEnrichment(report.logType, status.field, value);
      }
    }
  }, [reports, identityStatuses, detectedIdentity, addEnrichment]);

  const analyzedSigRef = useRef<string>("");
  const currentSig = inputSignature(solutionName, samples);

  // ---- Analyze / Re-Analyze ---------------------------------------------
  const runAnalysis = useCallback(async (overrides?: Record<string, string>) => {
    if (analyzing || samples.length === 0) {
      return;
    }
    const activeOverrides = overrides ?? tableOverrides;
    setAnalyzing(true);
    setAnalyzeError("");
    try {
      // Resolve destination tables (with provenance). The FIRST tier is fed
      // from the solution's OWN connector definitions: read and decode up to
      // CONNECTOR_TABLE_DECODE_CAP connector files and turn the table names
      // they declare (including name-only dataTypes labels like
      // "CommonSecurityLog (Zscaler)") into hints. Only when the connectors
      // declare nothing does resolution fall to CustomTables filenames, then
      // the CommonSecurityLog default.
      const files = await activeContent.listConnectorFiles(solutionName);
      const hints: ReturnType<typeof hintsFromConnectorTables> = [];
      for (const file of files.slice(0, CONNECTOR_TABLE_DECODE_CAP)) {
        try {
          const text = await activeContent.readFile(file.path);
          if (text === null) continue;
          const decoded = decodeConnector(JSON.parse(text), file.path);
          hints.push(
            ...hintsFromConnectorTables(
              decoded.tables.map((t) => t.tableName),
            ),
          );
        } catch {
          // Unreadable/unparseable connector: the next one may still declare
          // the tables; resolution degrades to the later tiers otherwise.
        }
      }
      const loadConnectors = async (): Promise<SolutionConnector[]> =>
        files.map((f) => ({ name: f.name, path: f.path }));
      const resolved = await resolveDestinationTables(
        hints,
        loadConnectors,
        "Sentinel solution connectors",
      );
      setResolution(resolved);
      const defaultTable = resolved.tables[0] ?? "CommonSecurityLog";

      const specs = samples.map((sample) => ({
        logType: sample.logType,
        tableName:
          activeOverrides[sample.logType] ??
          matchSampleLogTypeToTable(
            sample.logType,
            hints,
            resolved.tables.length,
            defaultTable,
          ),
        content: sample.rawEvents.join("\n"),
      }));

      // Documented vendor mappings (Phase 0): deterministic, doc-sourced
      // source->column knowledge for curated vendors. The usecase applies an
      // entry only when its source field exists in the sample AND its column
      // exists in the resolved schema.
      const produced = await collectGapReports(
        { content: activeContent, catalog: activeCatalog },
        {
          solutionName,
          samples: specs,
          vendorProfile: profile,
          // Learned reviewer decisions FIRST: the usecase's per-sample
          // source dedupe is first-wins, so a learned entry beats a pack.
          vendorMappings: [
            ...learnedToVendorMappings(learned),
            ...vendorMappingsForSolution(solutionName),
          ],
        },
      );
      setReports(produced);
      analyzedSigRef.current = inputSignature(solutionName, samples);
      dispatch({ type: "analyzed" });
    } catch (err) {
      setAnalyzeError(String(err));
    } finally {
      setAnalyzing(false);
    }
  }, [
    analyzing,
    samples,
    solutionName,
    activeContent,
    activeCatalog,
    profile,
    tableOverrides,
    learned,
  ]);

  // Candidate destination tables for the per-sample override dropdown: the
  // solution's resolved tables, the tables already in the reports, and a few
  // common natives - deduped and sorted.
  const candidateTables = useMemo(() => {
    const set = new Set<string>();
    for (const t of resolution?.tables ?? []) set.add(t);
    for (const r of reports) set.add(r.tableName);
    for (const t of COMMON_NATIVE_TABLES) set.add(t);
    return [...set].filter((t) => t !== "").sort();
  }, [resolution, reports]);

  // Reassign a logType to a different destination table, then re-analyze so its
  // gap report reflects the new table's schema.
  const changeTable = useCallback(
    (logType: string, newTable: string) => {
      if (newTable === "" || analyzing) return;
      const next = { ...tableOverrides, [logType]: newTable };
      setTableOverrides(next);
      void runAnalysis(next);
    },
    [tableOverrides, runAnalysis, analyzing],
  );

  // ---- Staleness: inputs changed after the last analysis ----------------
  useEffect(() => {
    if (reports.length === 0) {
      return;
    }
    if (currentSig !== analyzedSigRef.current) {
      dispatch({ type: "inputs-changed" });
    }
  }, [currentSig, reports.length]);

  // ---- Rename re-key (the Unit 11 seam) ---------------------------------
  const lastRenameNonce = useRef<number>(renameEvent?.nonce ?? -1);
  useEffect(() => {
    if (renameEvent === undefined) {
      return;
    }
    if (renameEvent.nonce === lastRenameNonce.current) {
      return;
    }
    lastRenameNonce.current = renameEvent.nonce;
    dispatch({
      type: "rename-log-type",
      from: renameEvent.from,
      to: renameEvent.to,
    });
  }, [renameEvent]);

  // ---- Content-path gate + reports surfacing ----------------------------
  const gate = deriveMappingReviewGate(review, reports);
  const withMappings = tablesWithMappings(reports);
  const hasMappings = withMappings.length > 0;

  useEffect(() => {
    onGateChange?.(gate.ready);
  }, [gate.ready, onGateChange]);

  useEffect(() => {
    onReportsChange?.(reports);
  }, [reports, onReportsChange]);

  // Surface the reviewer's EFFECTIVE (edited) mappings per logType (the Unit 17
  // pipeline preview seam). Recomputed from the reports + edit store so the
  // preview mirrors hand edits, not just the analyzed baseline.
  useEffect(() => {
    if (onEffectiveMappingsChange === undefined) {
      return;
    }
    const byLogType: Record<string, GapFieldMapping[]> = {};
    for (const report of reports) {
      byLogType[report.logType] = effectiveMappings(review, report);
    }
    onEffectiveMappingsChange(byLogType);
  }, [reports, review, onEffectiveMappingsChange]);

  const updateMapping = useCallback(
    (
      report: GapReport,
      sourceField: string,
      field: "dest" | "action",
      value: string,
    ) => {
      dispatch({
        type: "edit-mapping",
        logType: report.logType,
        sourceField,
        field,
        value,
        baseline: report.fieldMappings,
      });
    },
    [],
  );

  const provenanceDefault =
    resolution !== null && resolution.source.includes("Default");

  // ---- Render ------------------------------------------------------------
  return (
    <div className="mapping-review">
      <div className="mapping-review-analyze">
        <button
          className="run-button"
          onClick={() => void runAnalysis()}
          disabled={analyzing || samples.length === 0}
        >
          {analyzeButtonLabel(reports.length, gate.stale, analyzing)}
        </button>
        <span className="field-hint">
          {samples.length === 0
            ? MAPPING_REVIEW_NO_SAMPLES_REASON
            : analyzing
              ? "Analyzing sample data against the DCR schemas..."
              : reports.length === 0
                ? `${samples.length} sample(s) ready - run the DCR gap analysis.`
                : gate.stale
                  ? "Samples or the solution changed - re-analyze to refresh."
                  : "Analysis complete. Re-analyze after changing samples or the solution."}
        </span>
      </div>

      {analyzeError !== "" && <pre className="result">{analyzeError}</pre>}

      {resolution !== null && (
        <div
          className={`gap-provenance${provenanceDefault ? " gap-provenance-default" : ""}`}
        >
          <span className="gap-provenance-label">Destination: </span>
          <span className="gap-provenance-tables">
            {resolution.tables.join(", ")}
          </span>
          <span className="gap-provenance-source"> - {resolution.source}</span>
        </div>
      )}

      {gate.stale && reports.length > 0 && (
        <p className="mapping-review-stale">{MAPPING_REVIEW_STALE_NOTICE}</p>
      )}

      {hasMappings && (
        <div
          className={`gap-approval-bar ${gate.allApproved ? "gap-approval-bar-ok status-bar-ready" : "status-bar-warn"}`}
        >
          <span className="status-bar-dot" aria-hidden="true" />
          <span className="gap-approval-text">{approvalBarText(gate)}</span>
          {gate.allApproved ? (
            <button
              className="gap-reset-button"
              onClick={() => dispatch({ type: "reset-approvals" })}
            >
              Reset All
            </button>
          ) : (
            <button
              className="next-action-button"
              onClick={() => {
                persistLearned(withMappings, review);
                dispatch({
                  type: "auto-approve-all",
                  logTypes: withMappings.map((r) => r.logType),
                });
              }}
            >
              Auto-Approve All
            </button>
          )}
        </div>
      )}

      {reports.length > 0 && (
        <div className="discovery-result">
          <span className="field-label">
            Enrichment fields (added to every table)
            <InfoTip text="Fields the source does NOT carry that the Cribl pipeline ADDS as constants - e.g. DeviceVendor = Palo Alto Networks and DeviceProduct = PAN-OS for a PAN-OS feed. Sentinel content filters on them, but raw vendor logs never include them. Global entries apply to every table below; each table can add its own (a per-table entry wins on the same field name). They appear in the pipeline preview, ship in the built pack, and count as available fields in the coverage sections." />
          </span>
          <EnrichmentEditor
            entries={globalEnrichments}
            onAdd={(field, value) => addEnrichment(null, field, value)}
            onRemove={(field) => removeEnrichment(null, field)}
          />
        </div>
      )}

      {reports.map((report) => {
        const effective = effectiveMappings(review, report);
        const mappings = sortedMappings(effective);
        const unmapped = unmappedDestColumns(report, effective);
        const query = (mappingSearch[report.logType] ?? "")
          .trim()
          .toLowerCase();
        const shownMappings =
          query === ""
            ? mappings
            : mappings.filter(
                (m) =>
                  m.source.toLowerCase().includes(query) ||
                  m.dest.toLowerCase().includes(query),
              );
        const shownUnmapped =
          query === ""
            ? unmapped
            : unmapped.filter((d) => d.name.toLowerCase().includes(query));
        const approved = isApproved(review, report.logType);
        const modified = isModified(review, report.logType);
        return (
          <div key={report.logType} className="mapping-review-card">
            <div className="mapping-review-card-head">
              <span className="mapping-review-logtype">{report.logType}</span>
              <div className="mapping-review-table-select">
                <span className="mapping-review-table-label">
                  Destination table
                  <InfoTip text="The native table this log sample aligns to - detected from the solution. Override it to realign this sample to a different DCR/table; re-analysis runs against the new table's schema." />
                </span>
                <SearchableSelect
                  options={candidateTables.map((t) => ({ value: t, label: t }))}
                  value={report.tableName}
                  onChange={(t) => changeTable(report.logType, t)}
                  disabled={analyzing}
                  ariaLabel="Filter destination tables"
                />
              </div>
            </div>

            <div className="match-stat-grid">
              {report.stats.map((stat) => (
                <div
                  key={stat.key}
                  className={`match-stat match-stat-${stat.tone}`}
                >
                  <span className="match-stat-value">{stat.value}</span>
                  <span className="match-stat-label">
                    {stat.label}
                    <InfoTip text={stat.hint} />
                  </span>
                </div>
              ))}
            </div>

            {(report.dcrRenames.length > 0 ||
              report.dcrCoercions.length > 0) && (
              <details className="gap-handles gap-handles-dcr">
                <summary>{report.dcrHandlesSummary}</summary>
                <div className="gap-handles-body">
                  {report.dcrRenames.map((r) => (
                    <div key={`dr-${r.source}`}>
                      {r.source} -&gt; {r.dest}
                    </div>
                  ))}
                  {report.dcrCoercions.map((c) => (
                    <div key={`dc-${c.field}`}>
                      {c.field} -&gt; {c.toType}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {(report.criblRenames.length > 0 ||
              report.criblCoercions.length > 0) && (
              <details className="gap-handles gap-handles-cribl">
                <summary>{report.criblHandlesSummary}</summary>
                <div className="gap-handles-body">
                  {report.criblRenames.map((r) => (
                    <div key={`cr-${r.source}`}>
                      {r.source} -&gt; {r.dest} ({r.reason})
                    </div>
                  ))}
                  {report.criblCoercions.map((c) => (
                    <div key={`cc-${c.field}`}>
                      {c.field}: {c.fromType} -&gt; {c.toType}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {report.routeCondition !== "true" && (
              <div className="gap-route">Route: {report.routeCondition}</div>
            )}

            {report.warnings.map((warning, index) => (
              <p
                key={`warn-${index}`}
                className="match-warning match-warning-overflow-loss"
              >
                {warning}
              </p>
            ))}

            {(identityStatuses[report.logType] ?? []).length > 0 && (
              <IdentityBlock
                tableName={report.tableName}
                statuses={identityStatuses[report.logType]}
                identity={detectedIdentity}
                onAdd={(field, value) =>
                  addEnrichment(report.logType, field, value)
                }
              />
            )}

            {report.overflowCount > 0 && (
              <p className="field-hint gap-overflow-note">
                {OVERFLOW_COVERAGE_NOTE}
              </p>
            )}

            {effective.length > 0 && (
              <details className="mapping-review-fields">
                <summary className="mapping-review-fields-summary">
                  <span>
                    {fieldMappingsLabel(mappings.length, unmapped.length)}
                  </span>
                  {approved ? (
                    <span className="gap-badge gap-badge-approved">
                      Approved
                    </span>
                  ) : (
                    <span className="gap-badge gap-badge-required">
                      Approval Required
                    </span>
                  )}
                  {modified && (
                    <span className="gap-badge gap-badge-modified">
                      Modified
                    </span>
                  )}
                </summary>

                <div className="mapping-search">
                  <input
                    type="text"
                    value={mappingSearch[report.logType] ?? ""}
                    onChange={(e) =>
                      setMappingSearch((prev) => ({
                        ...prev,
                        [report.logType]: e.target.value,
                      }))
                    }
                    placeholder="Search fields (source or destination)..."
                    aria-label="Search field mappings"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {query !== "" && (
                    <span className="field-hint">
                      {shownMappings.length} of {mappings.length} mapped rows,{" "}
                      {shownUnmapped.length} of {unmapped.length} unmapped
                      columns
                    </span>
                  )}
                </div>

                <div className="mapping-review-table-wrap">
                  <table className="match-field-table mapping-review-grid">
                    <thead>
                      <tr>
                        <th>
                          Source Field
                          <InfoTip text="The field name as it appears in your sample data. Fields with a RULE badge are referenced by Sentinel analytics rules and should not be dropped." />
                        </th>
                        <th>
                          Type
                          <InfoTip text="The data type detected from the sample values (string, int, real, boolean, dynamic)." />
                        </th>
                        <th>
                          Dest Field
                          <InfoTip text="The destination column in the Sentinel table schema. Change this dropdown to reassign where a source field maps to." />
                        </th>
                        <th>
                          Type
                          <InfoTip text="The expected data type in the destination schema. If it differs from the source type, a type coercion is applied." />
                        </th>
                        <th>
                          Confidence
                          <InfoTip text="How the match was determined: exact (identical names), alias (known alias, e.g. src to SourceIP), fuzzy (similar names), or unmatched (collected into overflow)." />
                        </th>
                        <th>
                          Action
                          <InfoTip text="What the Cribl pipeline will do with this field: keep (pass through), rename, coerce (convert type), overflow (collect into the catch-all), or drop." />
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownMappings.map((m) => {
                        const ruleField = isRuleField(m.dest, ruleFields);
                        return (
                          <tr
                            key={m.source}
                            className={`mapping-row mapping-row-${m.action}`}
                          >
                            <td title={m.description}>
                              {m.source}
                              {ruleField && (
                                <span
                                  className="rule-badge"
                                  title="Referenced by analytics rule(s)"
                                >
                                  RULE
                                </span>
                              )}
                            </td>
                            <td className="match-field-type">{m.sourceType}</td>
                            <td>
                              <select
                                className="mapping-select"
                                value={m.dest}
                                onChange={(e) =>
                                  updateMapping(
                                    report,
                                    m.source,
                                    "dest",
                                    e.target.value,
                                  )
                                }
                              >
                                <option value={m.dest}>{m.dest}</option>
                                {report.destSchema
                                  .filter((d) => d.name !== m.dest)
                                  .map((d) => (
                                    <option key={d.name} value={d.name}>
                                      {d.name}
                                    </option>
                                  ))}
                              </select>
                            </td>
                            <td className="match-field-type">{m.destType}</td>
                            <td>
                              <span
                                className={`match-conf match-conf-${m.confidence}`}
                              >
                                {m.confidence}
                              </span>
                            </td>
                            <td>
                              <select
                                className="mapping-select"
                                value={m.action}
                                onChange={(e) =>
                                  updateMapping(
                                    report,
                                    m.source,
                                    "action",
                                    e.target.value,
                                  )
                                }
                              >
                                {ACTION_OPTIONS.map((act) => (
                                  <option key={act} value={act}>
                                    {act}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                      {shownUnmapped.length > 0 && (
                        <tr className="mapping-unmapped-head">
                          <td colSpan={6}>
                            Unmapped Destination Fields ({shownUnmapped.length})
                            <InfoTip text="These destination schema columns have no corresponding field in your sample data. They will be empty in Sentinel unless populated by a DCR transformation or added to your source data." />
                          </td>
                        </tr>
                      )}
                      {shownUnmapped.map((d) => {
                        const ruleField = isRuleField(d.name, ruleFields);
                        return (
                          <tr
                            key={`unmapped-${d.name}`}
                            className="mapping-row mapping-row-unmapped"
                          >
                            <td className="match-field-type">--</td>
                            <td className="match-field-type">--</td>
                            <td>
                              {d.name}
                              {ruleField && (
                                <span
                                  className="rule-badge rule-badge-missing"
                                  title="Referenced by analytics rule(s) - needed for detection"
                                >
                                  RULE
                                </span>
                              )}
                            </td>
                            <td className="match-field-type">{d.type}</td>
                            <td>
                              <span className="match-conf">none</span>
                            </td>
                            <td className="match-field-type">no source</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="enrich-table-block">
                  <span className="field-label">
                    Enrichment fields for {report.logType}
                  </span>
                  <EnrichmentEditor
                    entries={tableEnrichments[report.logType] ?? []}
                    inherited={globalEnrichments}
                    onAdd={(field, value) =>
                      addEnrichment(report.logType, field, value)
                    }
                    onRemove={(field) =>
                      removeEnrichment(report.logType, field)
                    }
                  />
                </div>

                <div className="mapping-review-approve">
                  {approved ? (
                    <span className="gap-approved-line">
                      Approved. You can still edit the mappings above.
                    </span>
                  ) : (
                    <button
                      className="run-button"
                      onClick={() => {
                        persistLearned([report], review);
                        dispatch({ type: "approve", logType: report.logType });
                      }}
                    >
                      Approve {report.logType}
                    </button>
                  )}
                  {modified && (
                    <span className="gap-modified-line">
                      Modified - your edits are applied when the pack is built.
                    </span>
                  )}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The required vendor-identity block for one table card: how each required
 * field (DeviceVendor/DeviceProduct or the ASim Event pair) is satisfied -
 * sample, enrichment, or MISSING with a forced-input row. Rendered OUTSIDE
 * the collapsed field-mapping details so a missing requirement is visible
 * without expanding anything.
 */
function IdentityBlock({
  tableName,
  statuses,
  identity,
  onAdd,
}: {
  tableName: string;
  statuses: readonly IdentityFieldStatus[];
  identity: VendorIdentity | null;
  onAdd: (field: string, value: string) => boolean;
}) {
  const missing = statuses.filter((s) => s.status === "missing");
  return (
    <div
      className={`identity-block${missing.length > 0 ? " identity-block-missing" : ""}`}
    >
      <span className="field-label">
        Vendor identity for {tableName}
        <InfoTip text="Sentinel analytics rules and workbooks filter this table on these fields, but raw vendor logs often do not carry them. When the sample provides one (CEF headers do), nothing is added. Otherwise the Cribl pipeline must add it as a constant - detected vendors are pre-filled from the selected solution (editable below); anything still missing must be entered before the pack can be built. Where a vendor emits several known products (e.g. Zscaler NSSWeblog vs NSSFWlog), the candidates are offered but never auto-picked - the wrong constant silently breaks the content filters." />
      </span>
      {statuses.map((s) =>
        s.status === "missing" ? (
          <RequiredIdentityInput
            key={s.field}
            field={s.field}
            options={identityValueOptions(s.field, identity)}
            onAdd={onAdd}
          />
        ) : (
          <div className="identity-row" key={s.field}>
            <code className="code-chip">{s.field}</code>
            <span className="enrich-row-eq">=</span>
            <span className="enrich-row-value">
              {s.value ?? "(from sample)"}
            </span>
            <span className="field-hint">
              {s.status === "sample"
                ? "provided by the sample data"
                : "enrichment constant (editable in the enrichment fields)"}
            </span>
          </div>
        ),
      )}
      {missing.length > 0 && (
        <span className="field-hint identity-missing-hint">
          Required before the pack can be built: the sample does not carry{" "}
          {missing.map((s) => s.field).join(" or ")} and no enrichment sets
          {missing.length === 1 ? " it" : " them"}. Enter the constant the
          pipeline should add.
        </span>
      )}
    </div>
  );
}

/**
 * One forced-input row for a missing required identity field. When the
 * curated identity KNOWS the candidate values (Zscaler's NSSWeblog vs
 * NSSFWlog), they render as one-click choices - offered, never auto-picked.
 */
function RequiredIdentityInput({
  field,
  options,
  onAdd,
}: {
  field: string;
  options: readonly string[];
  onAdd: (field: string, value: string) => boolean;
}) {
  const [value, setValue] = useState("");
  const placeholder =
    options.length > 0
      ? `e.g. ${options[0]}`
      : field.endsWith("Vendor")
        ? "e.g. Palo Alto Networks"
        : "e.g. PAN-OS";
  return (
    <div className="identity-required">
      <div className="enrich-add identity-required-row">
        <code className="code-chip">{field}</code>
        <span className="gap-badge gap-badge-required">Required</span>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          className="run-button"
          onClick={() => {
            if (onAdd(field, value)) {
              setValue("");
            }
          }}
          disabled={value.trim() === ""}
        >
          Add
        </button>
      </div>
      {options.length > 0 && (
        <div className="identity-suggestions">
          <span className="field-hint">
            Known {field} values for this vendor - pick the one matching your
            feed:
          </span>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="identity-suggestion-chip"
              onClick={() => onAdd(field, option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The enrichment add/list editor (used globally and per table): field name +
 * constant value inputs, an Add button (validated - Eval-safe names, quotes
 * stripped from values), and the current entries with Remove. `inherited`
 * renders the global entries a table already receives, read-only.
 */
function EnrichmentEditor({
  entries,
  inherited,
  onAdd,
  onRemove,
}: {
  entries: readonly EnrichmentField[];
  inherited?: readonly EnrichmentField[];
  onAdd: (field: string, value: string) => boolean;
  onRemove: (field: string) => void;
}) {
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [issue, setIssue] = useState("");

  const submit = () => {
    if (!isValidEnrichmentFieldName(field.trim())) {
      setIssue(
        "Field names must start with a letter/underscore and use only letters, digits, and underscores.",
      );
      return;
    }
    if (value.trim() === "") {
      setIssue("Enter the constant value the pipeline should add.");
      return;
    }
    if (onAdd(field, value)) {
      setField("");
      setValue("");
      setIssue("");
    }
  };

  return (
    <div className="enrich-editor">
      {inherited !== undefined && inherited.length > 0 && (
        <div className="enrich-rows">
          {inherited.map((e) => (
            <div className="enrich-row enrich-row-inherited" key={`g:${e.field}`}>
              <code className="code-chip">{e.field}</code>
              <span className="enrich-row-eq">=</span>
              <span className="enrich-row-value">{e.value}</span>
              <span className="field-hint">(global)</span>
            </div>
          ))}
        </div>
      )}
      {entries.length > 0 && (
        <div className="enrich-rows">
          {entries.map((e) => (
            <div className="enrich-row" key={e.field}>
              <code className="code-chip">{e.field}</code>
              <span className="enrich-row-eq">=</span>
              <span className="enrich-row-value">{e.value}</span>
              <button
                className="gap-reset-button"
                onClick={() => onRemove(e.field)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="enrich-add">
        <input
          type="text"
          value={field}
          onChange={(e) => {
            setField(e.target.value);
            setIssue("");
          }}
          placeholder="Field name (e.g. DeviceVendor)"
          autoComplete="off"
          spellCheck={false}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setIssue("");
          }}
          placeholder="Constant value (e.g. Palo Alto Networks)"
          autoComplete="off"
          spellCheck={false}
        />
        <button className="run-button" onClick={submit}>
          Add field
        </button>
      </div>
      {issue !== "" && <span className="field-hint enrich-issue">{issue}</span>}
    </div>
  );
}
