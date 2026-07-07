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
  matchSampleLogTypeToTable,
  resolveDestinationTables,
} from "@soc/core";
import type {
  DestinationTableResolution,
  GapFieldMapping,
  GapReport,
  MatchAction,
  SchemaCatalog,
  SentinelContent,
  SolutionConnector,
  TaggedSample,
  VendorGapProfile,
} from "@soc/core";
import { InfoTip } from "../../components/info-tip";
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
}

/**
 * A degraded content accessor for when no SentinelContent port is bound: every
 * lookup is empty, so the usecase falls back to synthetic no-op DCR flows.
 */
const EMPTY_SENTINEL_CONTENT: SentinelContent = {
  listSolutions: async () => [],
  listSolutionFiles: async () => [],
  listConnectorFiles: async () => [],
  readFile: async () => null,
  rawFetch: async () => null,
  getCommitSha: async () => null,
};

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
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");
  const [review, dispatch] = useReducer(
    mappingReviewReducer,
    INITIAL_MAPPING_REVIEW_STATE,
  );

  const analyzedSigRef = useRef<string>("");
  const currentSig = inputSignature(solutionName, samples);

  // ---- Analyze / Re-Analyze ---------------------------------------------
  const runAnalysis = useCallback(async () => {
    if (analyzing || samples.length === 0) {
      return;
    }
    setAnalyzing(true);
    setAnalyzeError("");
    try {
      // Resolve destination tables (with provenance). Vendor research (Unit 15)
      // is deferred, so the hints are empty: resolution falls to the solution's
      // CustomTables connectors, else the CommonSecurityLog default.
      const loadConnectors = async (): Promise<SolutionConnector[]> => {
        const files = await activeContent.listConnectorFiles(solutionName);
        return files.map((f) => ({ name: f.name, path: f.path }));
      };
      const resolved = await resolveDestinationTables([], loadConnectors);
      setResolution(resolved);
      const defaultTable = resolved.tables[0] ?? "CommonSecurityLog";

      const specs = samples.map((sample) => ({
        logType: sample.logType,
        tableName: matchSampleLogTypeToTable(
          sample.logType,
          [],
          resolved.tables.length,
          defaultTable,
        ),
        content: sample.rawEvents.join("\n"),
      }));

      const produced = await collectGapReports(
        { content: activeContent, catalog: activeCatalog },
        { solutionName, samples: specs, vendorProfile: profile },
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
  ]);

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
              onClick={() =>
                dispatch({
                  type: "auto-approve-all",
                  logTypes: withMappings.map((r) => r.logType),
                })
              }
            >
              Auto-Approve All
            </button>
          )}
        </div>
      )}

      {reports.map((report) => {
        const effective = effectiveMappings(review, report);
        const mappings = sortedMappings(effective);
        const unmapped = unmappedDestColumns(report, effective);
        const approved = isApproved(review, report.logType);
        const modified = isModified(review, report.logType);
        return (
          <div key={report.logType} className="mapping-review-card">
            <div className="mapping-review-card-head">
              <span className="mapping-review-logtype">{report.logType}</span>
              <span className="mapping-review-table">{report.tableName}</span>
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
                      {mappings.map((m) => {
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
                      {unmapped.length > 0 && (
                        <tr className="mapping-unmapped-head">
                          <td colSpan={6}>
                            Unmapped Destination Fields ({unmapped.length})
                            <InfoTip text="These destination schema columns have no corresponding field in your sample data. They will be empty in Sentinel unless populated by a DCR transformation or added to your source data." />
                          </td>
                        </tr>
                      )}
                      {unmapped.map((d) => {
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

                <div className="mapping-review-approve">
                  {approved ? (
                    <span className="gap-approved-line">
                      Approved. You can still edit the mappings above.
                    </span>
                  ) : (
                    <button
                      className="run-button"
                      onClick={() =>
                        dispatch({ type: "approve", logType: report.logType })
                      }
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
