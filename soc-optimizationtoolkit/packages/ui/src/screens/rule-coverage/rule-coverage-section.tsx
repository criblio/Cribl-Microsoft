/**
 * RuleCoverageSection - the flagship's Analytics Rule Coverage section
 * (porting-plan Unit 23, ENG-11, GUI-09, plus net-new workbook coverage). It is
 * the UI over the ONE shared content-reference analyzer in @soc/core: alert
 * rules (acquired through the Unit 14 SentinelContent port) and workbooks
 * (read from the SOLUTION REPO's Workbooks folder - deployed subscription
 * copies are deliberately NOT analyzed, user direction 2026-07-12: shared
 * subscriptions carry unrelated dashboards and local copies drift) are TWO
 * SOURCES INTO ONE ENGINE, rendered as two sections of the same panel.
 *
 * What it renders (legacy vocabulary verbatim where the legacy had it,
 * SentinelIntegration.tsx 2580-2793):
 *   - a three-way count header per section (fully covered / partial / no
 *     coverage / total) and the summary line;
 *   - per-rule and per-workbook expandables with a SEVERITY badge, a coverage
 *     %, a CUSTOM badge for uploaded rules, the covered/missing/unknown field
 *     lists, and a "View KQL Query" expandable;
 *   - the aggregated missing-fields-by-frequency chips;
 *   - custom-YAML upload / clear;
 *   - PARSER-FUNCTION resolution (Wave D): Parsers/*.yaml aliases, unioned
 *     tables, and friendly-name renames fold into the availability set, with
 *     a note naming each resolved function (and any unparseable files);
 *   - missing-field INVESTIGATE buttons (close-match suggestions against the
 *     sample fields);
 *   - schemas resolve through the Wave E solution-aware catalog tier.
 *
 * INFORMATIONAL, NOT A GATE: this section never blocks a deploy (the integrate
 * arc's rule-coverage section is always 'complete'; canDeploy /
 * canDeployContentPath never read it). Its one outward coupling is the KEPT Unit
 * 18 contract - it reports the schema-resolvable referenced-field set via
 * onRuleFieldsChange so the mapping table lights its RULE badges.
 *
 * NO STALE-SKIP (Unit 23 pin): coverage re-runs on every analyze / custom
 * upload / clear regardless of whether the availability set is empty - the core
 * shouldRerunCoverage() is unconditionally true and analyzeContentCoverage is
 * well-defined on an empty availability set.
 *
 * All decision logic is the pure @soc/core coverage-analysis plus this package's
 * rule-coverage-state; this component only orchestrates IO through the ports.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  acquireSolutionWorkbooks,
  analyticRuleToContentItem,
  analyzeContentCoverage,
  createBundledSchemaCatalog,
  deriveContentRequirements,
  createSolutionSchemaCatalog,
  mergeCustomContentItems,
  parseAnalyticRuleYaml,
  parseParserYaml,
  parserFieldSynonyms,
  suggestCloseMatches,
} from "@soc/core";
import type { CloseMatchCandidate } from "@soc/core";
import type {
  ContentItem,
  ContentRequirements,
  CoverageReport,
  GapReport,
  ParsedParserFunction,
  SchemaCatalog,
  SentinelContent,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { InfoTip } from "../../components/info-tip";
import {
  ANALYTIC_RULE_DIR_VARIANTS,
  CUSTOM_BADGE_LABEL,
  MISSING_FIELDS_HEADING,
  RULE_COVERAGE_IDLE_NOTE,
  RULE_COVERAGE_NO_REPORTS_NOTE,
  VIEW_KQL_LABEL,
  availableFieldsFromReports,
  customRuleCount,
  deriveCoverageSection,
  destinationTableNamesFromReports,
  isRuleYamlFileName,
  missingFieldChips,
  parseCustomRuleUploads,
  resolveSchemaUnion,
  ruleFieldSet,
} from "./rule-coverage-state";
import type { CoverageSectionView } from "./rule-coverage-state";

export interface RuleCoverageSectionProps {
  /** The selected Sentinel solution name (scopes the rule lookup); "" when none. */
  solutionName: string;
  /**
   * The Gap Analysis reports (Unit 18) - the availability set and the
   * destination-table names are derived from them. Empty until the gap analysis
   * has run.
   */
  reports: GapReport[];
  /**
   * The lazy Sentinel content accessor (ports.content). Absent -> no repo rules
   * are fetched (custom uploads still analyze).
   */
  content?: SentinelContent;
  /** Schema catalog; defaults to the fetch-free bundled adapter. */
  catalog?: SchemaCatalog;
  /**
   * Reports the LOWERCASED schema-resolvable referenced-field set (the kept Unit
   * 18 contract) so the parent can light the mapping table's RULE badges.
   */
  onRuleFieldsChange?: (fields: ReadonlySet<string>) => void;
  /**
   * Which content this instance analyzes and renders. "rules" = analytics rules
   * only (reports RULE-badge fields, offers custom-YAML upload); "workbooks" =
   * workbooks only; undefined = both in one panel (legacy combined view). The
   * integrate page renders two instances - a rules one and a workbooks one - so
   * each is its own numbered section.
   */
  contentFilter?: "rules" | "workbooks";
  /**
   * Extra field names counted AVAILABLE beyond what the mappings produce -
   * the user-added enrichment constants (e.g. DeviceVendor). They close
   * coverage gaps for fields the pipeline adds rather than maps.
   */
  extraAvailableFields?: readonly string[];
  /**
   * Reports what this instance's content REQUIRES (columns, catch-all keys,
   * opaque use) - the parent merges both instances and feeds the mapping
   * review's unused-field drop policy. The RULES instance also reports
   * EARLY (on solution change, before any gap analysis) so the
   * content-first order holds.
   */
  onContentRequirementsChange?: (requirements: ContentRequirements) => void;
  /**
   * The explicit "Drop unneeded fields" action (user direction 2026-07-12):
   * converts overflow fields required by neither analytics rules nor
   * workbooks (the MERGED requirements - a rules-section click still
   * protects workbook-consumed fields) into reviewable DROP edits in the
   * gap analysis. Absent = no button.
   */
  onDropUnneededFields?: () => void;
  /** Why the drop action is unavailable (button disabled with this title). */
  dropDisabledReason?: string;
}


/**
 * Acquire a solution's analytic rules as shared ContentItems through the content
 * port, probing the three dir-name variants and taking the first that yields
 * files (the legacy "first existing dir" rule over the lazy port).
 */
/** Bound on rule files read per analysis (mirrors the other loader caps). */
const RULE_DECODE_CAP = 150;

/**
 * The file list of the FIRST dir-name variant that exists and is non-empty -
 * the shared probe both the rule and parser loaders use.
 */
async function firstPopulatedDir(
  content: SentinelContent,
  solutionName: string,
  variants: readonly string[],
): Promise<Awaited<ReturnType<SentinelContent["listSolutionFiles"]>>> {
  for (const dir of variants) {
    const files = await content.listSolutionFiles(solutionName, dir);
    if (files.length > 0) {
      return files;
    }
  }
  return [];
}

async function fetchRuleContentItems(
  content: SentinelContent | undefined,
  solutionName: string,
): Promise<ContentItem[]> {
  if (content === undefined || solutionName.trim() === "") {
    return [];
  }
  const files = await firstPopulatedDir(
    content,
    solutionName,
    ANALYTIC_RULE_DIR_VARIANTS,
  );
  const items: ContentItem[] = [];
  for (const file of files.slice(0, RULE_DECODE_CAP)) {
    if (!isRuleYamlFileName(file.name)) {
      continue;
    }
    const text = await content.readFile(file.path);
    if (text === null) {
      continue;
    }
    items.push(analyticRuleToContentItem(parseAnalyticRuleYaml(text, file.name)));
  }
  return items;
}

/** Parser-dir name variants, mirroring the rule-dir probe. */
const PARSER_DIR_VARIANTS = ["Parsers", "Parser"] as const;

/** Cap parser files read per analysis (Netskope ships 30). */
const PARSER_DECODE_CAP = 40;

/**
 * Acquire a solution's parser functions (Wave D): probe the Parsers dir
 * variants, read up to PARSER_DECODE_CAP YAML files, and parse each into its
 * alias / tables / renames. Best-effort - unreadable files are skipped and a
 * solution without parsers yields [].
 */
async function fetchParserFunctions(
  content: SentinelContent | undefined,
  solutionName: string,
): Promise<{ parsers: ParsedParserFunction[]; unparsed: number }> {
  if (content === undefined || solutionName.trim() === "") {
    return { parsers: [], unparsed: 0 };
  }
  const files = await firstPopulatedDir(
    content,
    solutionName,
    PARSER_DIR_VARIANTS,
  );
  const parsers: ParsedParserFunction[] = [];
  let unparsed = 0;
  for (const file of files.slice(0, PARSER_DECODE_CAP)) {
    if (!/\.(yaml|yml)$/i.test(file.name)) {
      continue;
    }
    try {
      const text = await content.readFile(file.path);
      if (text === null) {
        unparsed++;
        continue;
      }
      const parsed = parseParserYaml(text);
      if (parsed !== null) {
        parsers.push(parsed);
      } else {
        unparsed++;
      }
    } catch {
      // Counted, never blocking - surfaced through the parser note.
      unparsed++;
    }
  }
  return { parsers, unparsed };
}

/** One expandable coverage section (rule section or workbook section). */
function CoverageSectionBody({
  section,
  onInvestigate,
}: {
  section: CoverageSectionView;
  /** Kick off a close-match review of the sample fields for a missing field. */
  onInvestigate: (field: string) => void;
}) {
  return (
    <div className="coverage-subsection">
      <p className="panel-desc">{section.summaryLine}</p>

      {section.counts.total > 0 && (
        <div className="coverage-counts">
          {section.countChips.map((chip) => (
            <span
              key={chip.text}
              className={`coverage-count coverage-count-${chip.tone}`}
            >
              {chip.text}
            </span>
          ))}
        </div>
      )}

      {section.unparseableQueryCount > 0 && (
        <p className="field-hint coverage-unparseable">
          {section.unparseableQueryCount} query block(s) could not be parsed and
          were excluded from coverage.
        </p>
      )}

      {section.items.map((item) => (
        <details key={item.key} className="coverage-item">
          <summary className="coverage-item-summary">
            {item.severity !== "Unknown" && (
              <span
                className={`coverage-severity coverage-severity-${item.severityTone}`}
              >
                {item.severity}
              </span>
            )}
            <span className="coverage-item-name">
              {item.name}
              {item.custom && (
                <span className="coverage-custom-badge">{CUSTOM_BADGE_LABEL}</span>
              )}
            </span>
            <span className={`coverage-pct coverage-pct-${item.coverageTone}`}>
              {item.coveragePercent}%
            </span>
            {item.missingCount > 0 && (
              <span className="coverage-missing-count">
                {item.missingCount} missing
              </span>
            )}
          </summary>
          <div className="coverage-item-body">
            {item.covered.length > 0 && (
              <div className="coverage-line coverage-line-covered">
                Covered: {item.covered.join(", ")}
              </div>
            )}
            {item.missing.length > 0 && (
              <div className="coverage-line coverage-line-missing">
                Missing:{" "}
                {item.missing.map((field) => (
                  <button
                    key={field}
                    type="button"
                    className="missing-field-button"
                    title="Review the sample fields for close matches to this field"
                    onClick={() => onInvestigate(field)}
                  >
                    {field}
                  </button>
                ))}
              </div>
            )}
            {item.unknown.length > 0 && (
              <div className="coverage-line coverage-line-unknown">
                Unknown (computed or other-table): {item.unknown.join(", ")}
              </div>
            )}
            {item.queries.length > 0 && (
              <details className="coverage-kql">
                <summary>{VIEW_KQL_LABEL}</summary>
                <pre className="result coverage-kql-pre">
                  {item.queries.join("\n\n")}
                </pre>
              </details>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

export function RuleCoverageSection({
  solutionName,
  reports,
  content,
  catalog,
  onRuleFieldsChange,
  contentFilter,
  extraAvailableFields,
  onContentRequirementsChange,
  onDropUnneededFields,
  dropDisabledReason,
}: RuleCoverageSectionProps) {
  const { ports } = usePorts();
  const activeContent = content ?? ports.content;
  // Wave E: same solution-aware schema tier the mapping review resolves with,
  // so both panels see identical columns for a solution's custom tables.
  // Without a content port the base catalog serves alone.
  const activeCatalog = useMemo(() => {
    const base = catalog ?? createBundledSchemaCatalog();
    return activeContent === undefined
      ? base
      : createSolutionSchemaCatalog(activeContent, solutionName, base);
  }, [activeContent, solutionName, catalog]);
  // What this instance covers. Custom-YAML upload and the RULE-badge report are
  // rules-only concerns; workbooks are a separate diagnostic.
  const showRules = contentFilter !== "workbooks";

  // CONTENT-FIRST ORDER (2026-07-12): the RULES instance derives and reports
  // its requirements as soon as the solution is selected - the mapping
  // review's drop policy needs them BEFORE the first gap analysis. The
  // workbooks instance reports from its analyze() (ARM enumeration needs a
  // subscription).
  useEffect(() => {
    if (!showRules || onContentRequirementsChange === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const items = await fetchRuleContentItems(activeContent, solutionName);
        if (!cancelled) {
          onContentRequirementsChange(deriveContentRequirements(items));
        }
      } catch {
        // No early requirements - the policy stays blocked (preserve-all).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showRules, activeContent, solutionName, onContentRequirementsChange]);
  const showWorkbooks = contentFilter !== "rules";

  const [report, setReport] = useState<CoverageReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");
  const [parserNote, setParserNote] = useState("");
  const [parserDetail, setParserDetail] = useState("");
  const [schemaNote, setSchemaNote] = useState("");
  const [customItems, setCustomItems] = useState<ContentItem[]>([]);
  // Close-match review of a missing field (the clickable missing-field
  // buttons): candidates come from the Gap Analysis reports' mapping rows -
  // matched AND overflow - via the core suggester.
  const [investigation, setInvestigation] = useState<{
    field: string;
    candidates: CloseMatchCandidate[];
  } | null>(null);
  const investigate = useCallback(
    (field: string) => {
      const rows = reports.flatMap((r) =>
        r.fieldMappings.map((m) => ({
          sourceName: m.source,
          logType: r.logType,
          disposition:
            m.action === "overflow"
              ? "overflow -> " + m.dest
              : m.action + " -> " + m.dest,
          ...(m.sampleValue !== undefined
            ? { sampleValue: m.sampleValue }
            : {}),
        })),
      );
      setInvestigation({ field, candidates: suggestCloseMatches(field, rows) });
    },
    [reports],
  );

  // The kept Unit 18 contract: the lowercased schema-resolvable referenced-field
  // set, recomputed only when the report changes so the effect is stable.
  const ruleFields = useMemo(
    () => (report !== null ? ruleFieldSet(report.summary) : undefined),
    [report],
  );
  useEffect(() => {
    // Only the rules instance lights the mapping table's RULE badges; a
    // workbooks-only instance never reports (workbook fields are not rules).
    if (ruleFields !== undefined && showRules) {
      onRuleFieldsChange?.(ruleFields);
    }
  }, [ruleFields, onRuleFieldsChange, showRules]);

  const runCoverage = useCallback(
    async (customOverride?: ContentItem[]) => {
      // No gap reports = no destination schema and no availability set. The
      // three-way classifier would put EVERY field in "unknown" and report a
      // 100% built on an empty denominator (live report 2026-07-09) - block
      // instead of lying green.
      if (analyzing || reports.length === 0) {
        return;
      }
      setAnalyzing(true);
      setAnalyzeError("");
      setSchemaNote("");
      try {
        const custom = customOverride ?? customItems;
        const [ruleItems, workbooks] = await Promise.all([
          showRules
            ? fetchRuleContentItems(activeContent, solutionName)
            : Promise.resolve<ContentItem[]>([]),
          showWorkbooks && activeContent !== undefined
            ? acquireSolutionWorkbooks(activeContent, solutionName)
            : Promise.resolve<ContentItem[]>([]),
        ]);
        // Workbook source of record is the SOLUTION REPO only (parallel to
        // rules; user direction 2026-07-12). Deployed subscription workbooks
        // are deliberately NOT analyzed - a shared subscription carries
        // everyone's dashboards (live report 2026-07-09: FortiGate and Cisco
        // dashboards polluted a Zscaler review), local copies drift from the
        // repo templates, and coverage should describe the SOLUTION.
        // Repo rules + workbooks, then merge the custom uploads (last-write-wins
        // by name - the re-upload fix).
        const repoAndWorkbooks = [...ruleItems, ...workbooks];
        const items = mergeCustomContentItems(repoAndWorkbooks, custom);
        onContentRequirementsChange?.(deriveContentRequirements(items));

        // The union includes each report's OWN destSchema, so DERIVED
        // schemas (unresolvable _CL destinations defined by the sample +
        // content references) classify fields here too.
        const schemaUnion = await resolveSchemaUnion(activeCatalog, reports);
        if (schemaUnion.length === 0) {
          // Without a resolvable destination schema every field classifies
          // "unknown" and the percentages are meaningless - say so instead
          // of rendering an empty-denominator 100%.
          setSchemaNote(
            `No schema could be resolved for destination table(s) ${destinationTableNamesFromReports(reports).join(", ")} - fields cannot be classified and coverage percentages would be meaningless. Re-run the DCR Gap Analysis or check the destination table selection.`,
          );
          return;
        }

        // Wave D: resolve PARSER-FUNCTION indirection. Solutions like
        // SentinelOne bind rules to a KQL function whose friendly output
        // names rename underlying columns - an output name counts as
        // available when its source column is.
        const availableFields = [
          ...availableFieldsFromReports(reports),
          ...(extraAvailableFields ?? []),
        ];
        const { parsers, unparsed } = await fetchParserFunctions(
          activeContent,
          solutionName,
        );
        const synonyms = parserFieldSynonyms(
          parsers,
          new Set(availableFields.map((f) => f.toLowerCase())),
        );
        const parserSummary: string[] = [];
        if (parsers.length > 0) {
          parserSummary.push(`${parsers.length} parser function(s) resolved`);
          if (synonyms.length > 0) {
            parserSummary.push(`${synonyms.length} field(s) available via parsers`);
          }
        }
        if (unparsed > 0) {
          parserSummary.push(`${unparsed} parser file(s) skipped`);
        }
        setParserNote(
          parserSummary.length > 0 ? parserSummary.join("; ") + "." : "",
        );
        setParserDetail(
          parsers.length > 0
            ? "Rules that query a KQL parser FUNCTION instead of a table are resolved through it: " +
                parsers
                  .map((p) => `${p.alias} over ${p.tables.join("+") || "?"}`)
                  .join("; ") +
                ". A parser output name counts as available when the source column it renames is available." +
                (unparsed > 0
                  ? ` ${unparsed} parser file(s) could not be read or parsed and were skipped.`
                  : "")
            : "",
        );

        const produced = analyzeContentCoverage({
          items,
          availableFields: [...availableFields, ...synonyms],
          schemaUnion,
        });
        setReport(produced);
        } catch (err) {
        setAnalyzeError(String(err));
      } finally {
        setAnalyzing(false);
      }
    },
    [
      analyzing,
      customItems,
      activeContent,
      activeCatalog,
      solutionName,
      reports,
      showRules,
      showWorkbooks,
      extraAvailableFields,
      onContentRequirementsChange,
    ],
  );

  // Custom-rule upload (YAML detection, portal ARM JSON export, or raw KQL):
  // parse -> merge (re-upload fix) -> re-run coverage.
  const [uploadNote, setUploadNote] = useState("");
  const onUpload = useCallback(
    async (fileList: FileList | null) => {
      if (fileList === null || fileList.length === 0) {
        return;
      }
      const uploads = await Promise.all(
        Array.from(fileList).map(async (file) => ({
          fileName: file.name,
          content: await file.text(),
        })),
      );
      const parsed = parseCustomRuleUploads(uploads);
      setUploadNote(
        parsed.length === 0
          ? `No rules found in ${uploads.map((u) => u.fileName).join(", ")} - expected a rule YAML, a portal ARM JSON export, or a raw KQL query.`
          : "",
      );
      if (parsed.length === 0) {
        return;
      }
      const merged = mergeCustomContentItems(customItems, parsed);
      setCustomItems(merged);
      // NO STALE-SKIP: always re-run, even with an empty availability set.
      await runCoverage(merged);
    },
    [customItems, runCoverage],
  );

  const onClearCustom = useCallback(async () => {
    setCustomItems([]);
    // NO STALE-SKIP: re-run without the custom rules regardless of availability.
    await runCoverage([]);
  }, [runCoverage]);

  const hasReports = reports.length > 0;
  const ruleSection =
    report !== null ? deriveCoverageSection(report, "alert-rule") : null;
  const workbookSection =
    report !== null ? deriveCoverageSection(report, "workbook") : null;
  const missingChips = report !== null ? missingFieldChips(report.summary) : [];
  const customCount = customRuleCount(customItems);

  return (
    <div className="rule-coverage">
      <div className="rule-coverage-controls">
        <button
          className="run-button"
          onClick={() => void runCoverage()}
          disabled={analyzing || !hasReports}
          title={hasReports ? undefined : RULE_COVERAGE_NO_REPORTS_NOTE}
        >
          {analyzing
            ? "Analyzing coverage..."
            : report === null
              ? showRules
                ? "Analyze rule coverage"
                : "Analyze workbook coverage"
              : "Re-analyze coverage"}
        </button>
        {onDropUnneededFields !== undefined && report !== null && (
          <>
            <button
              className="gap-reset-button"
              onClick={onDropUnneededFields}
              disabled={dropDisabledReason !== undefined}
              title={
                dropDisabledReason ??
                "Convert overflow fields required by neither analytics rules nor workbooks into DROP edits in the gap analysis (reviewable and reversible there)."
              }
            >
              Drop unneeded fields
            </button>
            <InfoTip text="Applies the content-driven policy: source fields that landed in the catch-all column and are referenced by neither the analytics rules nor the workbooks become DROP edits in the DCR Gap Analysis section - visible per row, reversible with Restore or Reset All. Fields the content consumes (directly, via KQL transformations, or as key=value pairs mined from the catch-all) are always kept. The action uses BOTH content types' requirements regardless of which section triggers it." />
          </>
        )}
        {showRules && (
          <>
            <span className="field-label">Custom Rules</span>
            <label className="rule-coverage-upload">
              Upload rules
              <input
                type="file"
                accept=".yaml,.yml,.json,.kql,.txt"
                multiple
                onChange={(e) => {
                  void onUpload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <InfoTip text="Include your organization's own analytics rules in the coverage analysis. A rule's detection logic is KQL; the accepted files are the wrappers that KQL ships in: the ARM JSON export from the portal's Analytics blade (Export - can carry several rules per file), a repo-style rule YAML, or a raw .kql/.txt query. They merge with the solution's repo rules; re-uploading a rule of the same name replaces it." />
            {customCount > 0 && (
              <>
                <span className="field-hint">
                  {customCount} custom rule{customCount === 1 ? "" : "s"}
                </span>
                <button
                  className="gap-reset-button"
                  onClick={() => void onClearCustom()}
                >
                  Clear
                </button>
              </>
            )}
          </>
        )}
      </div>

      {!hasReports && (
        <p className="field-hint">
          Run the DCR Gap Analysis first.
          <InfoTip text={RULE_COVERAGE_NO_REPORTS_NOTE} />
        </p>
      )}
      {uploadNote !== "" && (
        <div className="status-bar status-bar-warn">
          <span className="status-bar-dot" />
          <span className="status-bar-text">{uploadNote}</span>
        </div>
      )}
      {analyzeError !== "" && <pre className="result">{analyzeError}</pre>}
      {schemaNote !== "" && (
        <div className="status-bar status-bar-warn">
          <span className="status-bar-dot" />
          <span className="status-bar-text">{schemaNote}</span>
        </div>
      )}
      {parserNote !== "" && (
        <div className="status-bar">
          <span className="status-bar-dot" />
          <span className="status-bar-text">
            {parserNote}
            {parserDetail !== "" && <InfoTip text={parserDetail} />}
          </span>
        </div>
      )}

      {report === null ? (
        <p className="field-hint">{RULE_COVERAGE_IDLE_NOTE}</p>
      ) : (
        <div className="coverage-sections">
          {showRules && ruleSection !== null && (
            <div className="coverage-section">
              <div className="coverage-section-head">Analytics Rules</div>
              <CoverageSectionBody
                section={ruleSection}
                onInvestigate={investigate}
              />
            </div>
          )}
          {showWorkbooks && workbookSection !== null && (
            <div className="coverage-section">
              <div className="coverage-section-head">Workbooks</div>
              <CoverageSectionBody
                section={workbookSection}
                onInvestigate={investigate}
              />
            </div>
          )}

          {missingChips.length > 0 && (
            <div className="coverage-missing">
              <div className="coverage-missing-heading">
                {MISSING_FIELDS_HEADING}
                <InfoTip text="Each missing field is a button: click it to re-review your sample fields for CLOSE matches - near-miss names the automatic mapping deliberately refused (e.g. a base64-encoded URL) or overflow fields worth remapping by hand in the Gap Analysis table." />
              </div>
              <div className="coverage-missing-chips">
                {missingChips.map((field) => (
                  <button
                    key={field}
                    type="button"
                    className="missing-field-button"
                    title="Review the sample fields for close matches to this field"
                    onClick={() => investigate(field)}
                  >
                    {field}
                  </button>
                ))}
              </div>
            </div>
          )}

          {investigation !== null && (
            <div className="close-match-panel">
              <div className="close-match-head">
                <span className="field-label">
                  Close matches for {investigation.field} in your sample fields
                </span>
                <button
                  type="button"
                  className="gap-reset-button"
                  onClick={() => setInvestigation(null)}
                >
                  Dismiss
                </button>
              </div>
              {investigation.candidates.length === 0 ? (
                <p className="field-hint">
                  No sample field looks close to {investigation.field}. The
                  data may genuinely be absent from this feed, or carried
                  under an unrelated name - check the Gap Analysis overflow
                  rows.
                </p>
              ) : (
                <>
                  {investigation.candidates.map((c) => (
                    <div
                      className="close-match-row"
                      key={c.sourceName + "|" + c.logType}
                    >
                      <code className="code-chip">{c.sourceName}</code>
                      <span className="field-hint">({c.logType})</span>
                      <span className="close-match-disposition">
                        {c.disposition}
                      </span>
                      <span className="field-hint">{c.reason}</span>
                      {c.sampleValue !== undefined && (
                        <span className="close-match-sample">
                          e.g. {c.sampleValue.slice(0, 48)}
                        </span>
                      )}
                    </div>
                  ))}
                  <p className="field-hint">
                    To remap one, open the Gap Analysis section and search for
                    the field in its mapping table. A close match with encoded
                    or derived content (for example a base64 URL) needs a
                    pipeline transform, not just a rename.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
