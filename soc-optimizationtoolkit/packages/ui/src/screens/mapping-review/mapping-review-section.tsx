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
 *   - an EDITABLE field-mapping table (with a per-card FIELD SEARCH): a
 *     dest-column dropdown and an action dropdown (incl. base64 decode) per
 *     source field, plus the unmapped destination columns;
 *   - a per-sample DESTINATION-TABLE override (re-analyzes on change);
 *   - the VENDOR IDENTITY block (DeviceVendor/DeviceProduct etc.): sample /
 *     enrichment / forced-input resolution with curated auto-seeding;
 *   - ENRICHMENT editors (global + per-table constants the pipeline adds);
 *   - RULE badges fed by the rule-coverage section's referenced-field set;
 *   - the data-loss warnings surfaced honestly from the report;
 *   - the OVERFLOW TRIAGE line + outranked disclosure (unmappable vs missed);
 *   - the per-table "Vendor mapping documentation" links (every pack backing
 *     the solution's Phase-0 mappings);
 *   - AUTO-SEEDED constants: curated/connector-derived vendor identity and
 *     the CEF cs/cn LABEL constants (pendingIdentitySeeds/pendingLabelSeeds
 *     selectors; one-shot - a user deletion sticks).
 *
 * ANALYSIS INPUTS, priority order (Phase 0 of the matcher): LEARNED reviewer
 * decisions (persisted per solution via learnedCache, saved on Approve) beat
 * the documented VENDOR PACKS (vendorMappingsForSolution). ROUTING and
 * resolution are ONE core usecase (resolveSampleRouting): connector hints,
 * Wave C connector-KQL identity, typed-tier destination resolution, DCR-flow
 * + EventsToTableMapping split routing (override > DCR flow > name match >
 * first table), with soft degradation notes rendered under the banner.
 * Schemas resolve through the Wave E solution-aware catalog tier.
 *
 * The APPROVAL STATE MACHINE lives in the pure mapping-review-state module; this
 * component only drives it: Auto-Approve All / Reset All / per-table Approve,
 * the "Approval Required" / "Approved" badges, the staleness prompt, and the
 * "X mapped, Y unmapped" expander label. Approvals reset on re-analysis; edits
 * survive and re-key on a log-type rename (the Unit 11 seam, threaded via the
 * optional renameEvent prop).
 *
 * All analysis IO flows through @soc/core: resolveSampleRouting then the
 * analyzeSamples usecase (fed the pre-resolved DCR flows - one fetch pass)
 * over the SentinelContent + SchemaCatalog ports produce one GapReport per
 * table. This component owns zero decision logic and zero direct
 * fetch/storage - it calls the usecases and renders.
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
  createSolutionSchemaCatalog,
  detectVendorIdentity,
  dropSavingsLine,
  estimateDropSavings,
  learnedToVendorMappings,
  mergeDropSavings,
  resolveSampleRouting,
  resolveIdentityFields,
  suggestedIdentityValue,
  vendorLabelEnrichments,
  vendorMappingsForSolution,
  vendorPacksForSolution,
} from "@soc/core";
import type {
  ContentCache,
  DestinationTableResolution,
  GapFieldMapping,
  GapReport,
  IdentityFieldStatus,
  MatchAction,
  Logger,
  SchemaCatalog,
  SentinelContent,
  TaggedSample,
  VendorGapProfile,
  VendorIdentity,
} from "@soc/core";
import { InfoTip } from "../../components/info-tip";
import { EnrichmentEditor } from "./enrichment-editor";
import { IdentityBlock } from "./identity-block";
import { useEnrichmentFields, useLearnedMappings } from "./mapping-review-hooks";
import { SearchableSelect } from "../../components/searchable-select";
import {
  isValidEnrichmentFieldName,
  mergeEnrichments,
} from "../pipeline-preview/pipeline-preview-state";
import type { EnrichmentField } from "../pipeline-preview/pipeline-preview-state";
import type { RequirementsForAssessment } from "./mapping-review-state";
import {
  INITIAL_MAPPING_REVIEW_STATE,
  assessUnusedOverflow,
  MAPPING_REVIEW_NO_SAMPLES_REASON,
  MAPPING_REVIEW_STALE_NOTICE,
  OVERFLOW_COVERAGE_NOTE,
  analyzeButtonLabel,
  approvalBarText,
  deriveLiveStats,
  deriveMappingReviewGate,
  effectiveMappings,
  fieldMappingsLabel,
  isApproved,
  isModified,
  isRuleField,
  mappingReviewReducer,
  pendingIdentitySeeds,
  pendingLabelSeeds,
  sortedMappings,
  tablesWithMappings,
  unmappedDestColumns,
} from "./mapping-review-state";

/**
 * The unused-field policy explainer (InfoTip; the bar itself stays terse).
 */
const POLICY_BAR_TIP =
  "Overflow fields required by neither the analytics rules nor the " +
  "workbooks can be DROPPED instead of preserved in the catch-all column. " +
  'Trigger via "Drop unneeded fields" on a coverage section or the button ' +
  "here; every drop is a visible row edit, reversible per row, via " +
  "Restore, or via Reset All. Fields the content consumes - directly, " +
  "through KQL transformations, or as key=value pairs mined from the " +
  "catch-all - are always kept. With no analyzed content there is no " +
  "evidence to drop on; if content parses the catch-all without " +
  "determinable keys, dropping anything could break it, so the action is " +
  "disabled.";

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
   * Rule-referenced field names (lowercased) for the RULE badge, reported by
   * the rule-coverage section. Absent/empty renders no badges.
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
  /**
   * What the solution's analytics rules + workbooks REQUIRE (merged by the
   * parent from both coverage sections). Feeds the unused-field policy:
   * overflow fields no content needs become DROP edits when the operator
   * triggers the drop action. Absent/empty = no evidence, preserve
   * everything.
   */
  contentRequirements?: RequirementsForAssessment | null;
  /**
   * The "Drop unneeded fields" click from a coverage section (nonce bumps
   * per click). Switches the unused-field policy to drop; the policy bar
   * here can restore. Uses the MERGED requirements, so a drop triggered
   * from the rules section still protects workbook-consumed fields.
   */
  dropUnneededEvent?: { nonce: number };
  /** Diagnostics sink - analysis runs narrate into the Logs page. */
  logger?: Logger;
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
  contentRequirements,
  dropUnneededEvent,
  logger,
}: MappingReviewSectionProps) {
  const activeContent = content ?? EMPTY_SENTINEL_CONTENT;
  // Wave E: the solution's OWN table ARM definitions resolve ahead of the
  // bundled snapshot (or the injected catalog) - CCP custom tables work even
  // when absent from the bundle. Degrades to the base catalog on any failure.
  const activeCatalog = useMemo(
    () =>
      createSolutionSchemaCatalog(
        activeContent,
        solutionName,
        catalog ?? createBundledSchemaCatalog(),
      ),
    [activeContent, solutionName, catalog],
  );
  const profile: VendorGapProfile = vendorProfile ?? DEFAULT_GAP_PROFILE;

  const [reports, setReports] = useState<GapReport[]>([]);
  const [resolution, setResolution] =
    useState<DestinationTableResolution | null>(null);
  // Soft routing degradation notes from the usecase (unreadable connectors,
  // broken EventsToTableMapping) - surfaced, never silently swallowed.
  const [routingNotes, setRoutingNotes] = useState<string[]>([]);
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

  // Learned mappings (the reviewer-feedback loop): loaded per solution,
  // replayed into Phase 0 AHEAD of the vendor packs on every analysis,
  // extended with the diffed hand edits on every APPROVE (the hook owns the
  // load/persist mechanics).
  const { learned, persistLearned, clearLearned } = useLearnedMappings(
    learnedCache,
    solutionName,
  );

  // Enrichment constants the pipeline ADDS (DeviceVendor etc.): global +
  // per-table state, merged per log type and reported upward by the hook.
  const {
    globalEnrichments,
    tableEnrichments,
    addEnrichment,
    removeEnrichment,
  } = useEnrichmentFields(reports, isValidEnrichmentFieldName, onEnrichmentsChange);

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

  // Identity derived from the solution's OWN connector KQL filters (Wave C:
  // DeviceVendor == "Fortinet" etc.), captured during analysis. Second tier
  // below the curated list.
  const [connectorIdentity, setConnectorIdentity] =
    useState<VendorIdentity | null>(null);

  // The identity for the selected solution: curated knowledge first, then
  // the connector-KQL derivation (null when neither knows). Drives the
  // auto-seeding below and the one-click choices on the forced-input rows
  // (e.g. Zscaler's NSSWeblog / NSSFWlog products).
  const detectedIdentity = useMemo(
    () => detectVendorIdentity(solutionName) ?? connectorIdentity,
    [solutionName, connectorIdentity],
  );

  // The packs feeding this solution's Phase-0 mappings, for the per-table
  // "Vendor mapping documentation" line (user request 2026-07-12). Generated
  // packs carry no docUrl and render as provenance text.
  const vendorDocPacks = useMemo(
    () => vendorPacksForSolution(solutionName),
    [solutionName],
  );

  // Auto-seed curated solution knowledge (e.g. PaloAlto -> DeviceVendor =
  // Palo Alto Networks) as EDITABLE per-table enrichments, once per
  // logType/table/field. The one-shot guard means a user deletion sticks: the
  // field goes missing and becomes a forced input instead of being re-seeded.
  const seededIdentityRef = useRef(new Set<string>());
  useEffect(() => {
    const identity = detectedIdentity;
    const seeds = pendingIdentitySeeds(
      reports,
      identityStatuses,
      identity,
      (field) =>
        identity === null ? null : suggestedIdentityValue(field, identity),
      seededIdentityRef.current,
    );
    for (const seed of seeds) {
      seededIdentityRef.current.add(seed.key);
      addEnrichment(seed.logType, seed.field, seed.value);
    }
  }, [reports, identityStatuses, detectedIdentity, addEnrichment]);

  // Auto-seed the CEF custom-column LABEL constants the vendor packs demand
  // (cs1Label=dept etc. - a DeviceCustomString column is only interpretable
  // through its companion Label). A label seeds once per logType/column, only
  // when the pack mapping that demands it actually APPLIED in this report and
  // the Label column exists in the resolved schema. Same one-shot guard as
  // identity seeding: a user deletion sticks.
  const seededLabelRef = useRef(new Set<string>());
  useEffect(() => {
    const seeds = pendingLabelSeeds(
      reports,
      vendorLabelEnrichments(solutionName),
      seededLabelRef.current,
    );
    for (const seed of seeds) {
      seededLabelRef.current.add(seed.key);
      addEnrichment(seed.logType, seed.field, seed.value);
    }
  }, [reports, solutionName, addEnrichment]);

  // Unused-field policy (user direction 2026-07-12, revised): everything is
  // PRESERVED until the operator clicks "Drop unneeded fields" on a coverage
  // section (the decision belongs at the evidence). The parent signals that
  // click via dropUnneededEvent; the bar below offers the local toggle too.
  const [unusedPolicy, setUnusedPolicy] = useState<"drop" | "preserve">(
    "preserve",
  );
  useEffect(() => {
    if (dropUnneededEvent !== undefined && dropUnneededEvent.nonce > 0) {
      setUnusedPolicy("drop");
    }
  }, [dropUnneededEvent]);
  const assessments = useMemo(
    () =>
      new Map(
        reports.map((report) => [
          report.logType,
          assessUnusedOverflow(report, contentRequirements ?? null),
        ]),
      ),
    [reports, contentRequirements],
  );
  // Byte savings of the CURRENT drop decisions (reviewer + policy + learned),
  // measured against the actual sample events (user request 2026-07-12).
  const dropSavingsByLogType = useMemo(() => {
    const byLogType = new Map<string, ReturnType<typeof estimateDropSavings>>();
    for (const report of reports) {
      const droppedFields = effectiveMappings(review, report)
        .filter((m) => m.action === "drop")
        .map((m) => m.source);
      const sample = samples.find((s) => s.logType === report.logType);
      byLogType.set(
        report.logType,
        estimateDropSavings(sample?.rawEvents ?? [], droppedFields),
      );
    }
    return byLogType;
  }, [reports, review, samples]);

  // Auto-apply as reviewable EDITS (visible in the mapping table, reverted
  // by Reset All or by switching the policy). autoDroppedRef tracks exactly
  // what this effect set so preserve only reverts machine drops.
  const autoDroppedRef = useRef(new Set<string>());
  useEffect(() => {
    for (const report of reports) {
      const assessment = assessments.get(report.logType);
      if (assessment === undefined) continue;
      const effective = effectiveMappings(review, report);
      if (unusedPolicy === "drop" && assessment.blocked === null) {
        for (const source of assessment.droppable) {
          const key = `${report.logType}|${source}`;
          const row = effective.find((m) => m.source === source);
          if (row === undefined || row.action !== "overflow") continue;
          autoDroppedRef.current.add(key);
          dispatch({
            type: "edit-mapping",
            logType: report.logType,
            sourceField: source,
            field: "action",
            value: "drop",
            baseline: report.fieldMappings,
          });
        }
      }
      if (unusedPolicy === "preserve") {
        for (const source of assessment.droppable) {
          const key = `${report.logType}|${source}`;
          if (!autoDroppedRef.current.has(key)) continue;
          autoDroppedRef.current.delete(key);
          dispatch({
            type: "edit-mapping",
            logType: report.logType,
            sourceField: source,
            field: "action",
            value: "overflow",
            baseline: report.fieldMappings,
          });
        }
      }
    }
  }, [reports, assessments, unusedPolicy, review]);

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
      // ONE routing usecase call (2026-07-12 audit extraction): connector
      // hints + Wave C identity + destination resolution + DCR flows + Wave B
      // EventsToTableMapping + the pinned per-log-type precedence
      // (override > DCR flow > name match > first table). The returned flows
      // feed analyzeSamples so DCR files are fetched ONCE per analysis.
      logger?.info("gap-analysis: starting", {
        solution: solutionName,
        samples: samples.length,
      });
      const routing = await resolveSampleRouting(activeContent, {
        solutionName,
        logTypes: samples.map((sample) => sample.logType),
        overrides: activeOverrides,
        profile,
      });
      for (const note of routing.notes) {
        logger?.warn(`gap-analysis: ${note}`);
      }
      setResolution(routing.resolution);
      setConnectorIdentity(routing.connectorIdentity);
      setRoutingNotes(
        solutionName.trim() === ""
          ? [
              ...routing.notes,
              "No Sentinel solution selected (section 1) - vendor mapping packs, analytics rules, connector-based table detection, and identity detection were ALL disabled for this analysis.",
            ]
          : routing.notes,
      );

      const specs = samples.map((sample) => ({
        logType: sample.logType,
        tableName:
          routing.tableByLogType[sample.logType] ?? "CommonSecurityLog",
        content: sample.rawEvents.join("\n"),
      }));

      // Documented vendor mappings (Phase 0): deterministic, doc-sourced
      // source->column knowledge for curated vendors. The usecase applies an
      // entry only when its source field exists in the sample AND its column
      // exists in the resolved schema.
      const produced = await collectGapReports(
        { content: activeContent, catalog: activeCatalog, logger },
        {
          solutionName,
          samples: specs,
          vendorProfile: profile,
          dcrFlows: routing.dcrFlows,
          // Learned reviewer decisions FIRST: the usecase's per-sample
          // source dedupe is first-wins, so a learned entry beats a pack.
          vendorMappings: [
            ...learnedToVendorMappings(learned),
            ...vendorMappingsForSolution(solutionName),
          ],
          // Canonical rule/workbook column names: consumed only when a
          // custom _CL destination resolves no schema anywhere - the derived
          // schema then accommodates the solution's content references.
          contentColumnNames: [
            ...(contentRequirements?.columnNames?.values() ?? []),
          ],
        },
      );
      setReports(produced);
      logger?.info("gap-analysis: finished", {
        tables: produced.map((r) => r.tableName).join(","),
        reports: produced.length,
      });
      analyzedSigRef.current = inputSignature(solutionName, samples);
      dispatch({ type: "analyzed" });
    } catch (err) {
      logger?.error(`gap-analysis: failed: ${String(err)}`);
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
    contentRequirements,
    logger,
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

  const provenanceDefault = resolution !== null && resolution.tier === "default";

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

      {solutionName.trim() === "" && (
        <div className="status-bar status-bar-warn">
          <span className="status-bar-dot" />
          <span className="status-bar-text">
            No Sentinel solution selected - analysis runs with the generic
            matching ladder only.
            <InfoTip text="Select a solution in section 1 first: the vendor mapping packs, learned decisions, analytics-rule requirements, connector-based destination detection, and vendor identity all key off the selected solution. Without one, this analysis uses only the generic alias/fuzzy ladder." />
          </span>
        </div>
      )}

      {routingNotes.map((note) => (
        <p key={note} className="field-hint gap-routing-note">
          {note}
        </p>
      ))}

      {learned.length > 0 && (
        <div className="status-bar learned-mappings-bar">
          <span className="status-bar-dot" />
          <span className="status-bar-text">
            {learned.length} learned decision(s)
            {learned.filter((l) => l.action === "drop").length > 0
              ? ` (${learned.filter((l) => l.action === "drop").length} drop(s))`
              : ""}{" "}
            replay for this solution.
            <InfoTip text="Approved hand edits persist per solution and replay ahead of the vendor packs on every analysis. Learned DROPS consume their source fields before the mapping table or overflow sees them. Clearing forgets all of them; the next analysis starts from the packs and matching ladder alone." />
          </span>
          <button
            className="link-button"
            onClick={() => {
              clearLearned();
            }}
          >
            Clear learned mappings
          </button>
        </div>
      )}

      {reports.length > 0 &&
        (() => {
          const all = [...assessments.values()];
          const blocked = all.find((a) => a.blocked !== null)?.blocked ?? null;
          const droppable = all.reduce((n, a) => n + a.droppable.length, 0);
          const kept = all.reduce((n, a) => n + a.keptByContent.length, 0);
          const savingsText = dropSavingsLine(
            mergeDropSavings([...dropSavingsByLogType.values()]),
          );
          return (
            <div className="status-bar unused-policy-bar">
              <span className="status-bar-dot" />
              <span className="status-bar-text">
                {blocked === "no-requirements"
                  ? "Unused fields: preserving all (no coverage analysis yet)."
                  : blocked === "opaque-catch-all"
                    ? "Unused fields: preserving all (content parses the catch-all opaquely)."
                    : unusedPolicy === "drop"
                      ? `Unused fields: ${droppable} dropped, ${kept} kept for content.${savingsText !== "" ? ` ${savingsText}.` : ""}`
                      : `Unused fields: preserving all (${droppable} droppable).`}
                <InfoTip text={POLICY_BAR_TIP} />
              </span>
              {blocked === null && (
                <button
                  className="link-button"
                  onClick={() =>
                    setUnusedPolicy(
                      unusedPolicy === "drop" ? "preserve" : "drop",
                    )
                  }
                >
                  {unusedPolicy === "drop"
                    ? "Restore all dropped fields"
                    : "Drop unneeded fields"}
                </button>
              )}
            </div>
          );
        })()}

      {gate.stale && reports.length > 0 && (
        <p className="mapping-review-stale">{MAPPING_REVIEW_STALE_NOTICE}</p>
      )}

      {hasMappings && (
        <div
          className={`gap-approval-bar ${gate.allApproved ? "gap-approval-bar-ok status-bar-ready" : "status-bar-warn"}`}
        >
          <span className="status-bar-dot" aria-hidden="true" />
          <span className="gap-approval-text">
            {gate.allApproved
              ? `All ${gate.total} table mapping(s) approved.`
              : gate.approved > 0
                ? `${gate.approved} of ${gate.total} table mapping(s) approved.`
                : "Field mappings require approval before building."}
            <InfoTip text={approvalBarText(gate)} />
          </span>
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
                persistLearned(withMappings, (r) =>
                  effectiveMappings(review, r)
                    .filter(
                      (m) =>
                        !(
                          m.action === "drop" &&
                          autoDroppedRef.current.has(`${r.logType}|${m.source}`)
                        ),
                    )
                    .map((m) => ({
                      source: m.source,
                      dest: m.dest,
                      action: m.action,
                    })),
                );
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
              {deriveLiveStats(report, effective).map((stat) => (
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

            {report.schemaDerivation !== undefined && (
              <p className="gap-derived-schema">
                {report.schemaDerivation.summary}
                {report.schemaDerivation.notes.length > 0 && (
                  <InfoTip text={report.schemaDerivation.notes.join("\n")} />
                )}
              </p>
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

            {vendorDocPacks.length > 0 && (
              <p className="field-hint vendor-doc-links">
                Mapping docs:{" "}
                {vendorDocPacks.map((pack, i) => (
                  <span key={pack.id}>
                    {i > 0 ? ", " : ""}
                    {pack.docUrl !== undefined ? (
                      <a href={pack.docUrl} target="_blank" rel="noreferrer">
                        {pack.vendor}
                      </a>
                    ) : (
                      <span>{pack.vendor}</span>
                    )}
                  </span>
                ))}
                <InfoTip
                  text={
                    "Documentation backing this solution's Phase-0 vendor mappings: " +
                    vendorDocPacks
                      .map((pack) => `${pack.vendor} - ${pack.provenance}`)
                      .join("; ") +
                    "."
                  }
                />
              </p>
            )}

            {report.overflowCount > 0 && (
              <p className="field-hint gap-overflow-note">
                Overflow: {report.overflowCount} field(s) preserved in the
                catch-all
                {report.overflowTriage.summary !== ""
                  ? ` - ${report.overflowTriage.noEquivalentCount} unmappable, ${report.overflowTriage.outranked.length} outranked`
                  : ""}
                .
                <InfoTip
                  text={
                    OVERFLOW_COVERAGE_NOTE +
                    (report.overflowTriage.summary !== ""
                      ? ` ${report.overflowTriage.summary}`
                      : "")
                  }
                />
              </p>
            )}

            {report.overflowTriage.outranked.length > 0 && (
              <details className="gap-overflow-triage">
                <summary className="field-hint">
                  Overflow fields with a close-named column (
                  {report.overflowTriage.outranked.length})
                </summary>
                <ul className="field-hint">
                  {report.overflowTriage.outranked.map((e) => (
                    <li key={`out-${e.sourceName}`}>
                      {e.sourceName}: closest column {e.column} is already
                      claimed by the better-matching field {e.claimedBy}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {(dropSavingsByLogType.get(report.logType)?.droppedBytes ?? 0) >
              0 && (
              <p className="field-hint gap-drop-savings">
                Volume:{" "}
                {dropSavingsLine(
                  dropSavingsByLogType.get(report.logType) ?? {
                    events: 0,
                    originalBytes: 0,
                    droppedBytes: 0,
                  },
                )}
                .
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
                        persistLearned([report], (r) =>
                          effectiveMappings(review, r)
                            .filter(
                              (m) =>
                                !(
                                  m.action === "drop" &&
                                  autoDroppedRef.current.has(
                                    `${r.logType}|${m.source}`,
                                  )
                                ),
                            )
                            .map((m) => ({
                              source: m.source,
                              dest: m.dest,
                              action: m.action,
                            })),
                        );
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
