/**
 * RuleCoverageSection - the flagship's Analytics Rule Coverage section
 * (porting-plan Unit 23, ENG-11, GUI-09, plus net-new workbook coverage). It is
 * the UI over the ONE shared content-reference analyzer in @soc/core: alert
 * rules (acquired through the Unit 14 SentinelContent port) and workbooks
 * (enumerated through the AzureManagement port - net-new) are TWO SOURCES INTO
 * ONE ENGINE, rendered as two sections of the same panel.
 *
 * What it renders (legacy vocabulary verbatim where the legacy had it,
 * SentinelIntegration.tsx 2580-2793):
 *   - a three-way count header per section (fully covered / partial / no
 *     coverage / total) and the summary line;
 *   - per-rule and per-workbook expandables with a SEVERITY badge, a coverage
 *     %, a CUSTOM badge for uploaded rules, the covered/missing/unknown field
 *     lists, and a "View KQL Query" expandable;
 *   - the aggregated missing-fields-by-frequency chips;
 *   - custom-YAML upload / clear.
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
  extractWorkbookQueries,
  matchSolutionName,
  mergeCustomContentItems,
  parseAnalyticRuleYaml,
  suggestCloseMatches,
  unionSchemaColumns,
  workbookToContentItem,
} from "@soc/core";
import type { CloseMatchCandidate } from "@soc/core";
import type {
  AzureManagement,
  ContentItem,
  CoverageReport,
  GapReport,
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
  ruleFieldSet,
} from "./rule-coverage-state";
import type { CoverageSectionView } from "./rule-coverage-state";

/** The Microsoft.Insights/workbooks ARM api-version used for enumeration. */
const WORKBOOK_API_VERSION = "2023-06-01";

/**
 * Bound on ARM `nextLink` pages the workbook enumeration will follow before it
 * stops (fail-safe against a cyclic/absurd nextLink chain). Mirrors the core
 * listAllPages guard; workbook lists are small, so this is generous headroom.
 */
const WORKBOOK_MAX_PAGES = 50;

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
  /** The ARM client for workbook enumeration; defaults to ports.azure. */
  azure?: AzureManagement;
  /** The subscription to enumerate workbooks in; defaults to the active config. */
  subscriptionId?: string;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Acquire a solution's analytic rules as shared ContentItems through the content
 * port, probing the three dir-name variants and taking the first that yields
 * files (the legacy "first existing dir" rule over the lazy port).
 */
async function fetchRuleContentItems(
  content: SentinelContent | undefined,
  solutionName: string,
): Promise<ContentItem[]> {
  if (content === undefined || solutionName.trim() === "") {
    return [];
  }
  for (const dir of ANALYTIC_RULE_DIR_VARIANTS) {
    const files = await content.listSolutionFiles(solutionName, dir);
    if (files.length === 0) {
      continue;
    }
    const items: ContentItem[] = [];
    for (const file of files) {
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
  return [];
}

/**
 * Enumerate the workspace's Sentinel workbooks through ARM and mine the KQL out
 * of each workbook's serializedData (DEFENSIVELY - a workbook whose
 * serializedData is absent or unreadable is counted as one unparseable unit,
 * never silently dropped). Best-effort: a non-200 or a transport failure yields
 * no workbooks plus a soft note, never breaking the rule section.
 */
async function fetchWorkbookContentItems(
  azure: AzureManagement | undefined,
  subscriptionId: string,
): Promise<{ items: ContentItem[]; note: string }> {
  if (azure === undefined || subscriptionId.trim() === "") {
    return { items: [], note: "" };
  }
  const pageValue = (body: unknown): { value: unknown[]; nextLink: string } => {
    const value =
      isRecord(body) && Array.isArray(body["value"])
        ? (body["value"] as unknown[])
        : [];
    const nextLink =
      isRecord(body) && typeof body["nextLink"] === "string"
        ? (body["nextLink"] as string)
        : "";
    return { value, nextLink };
  };
  try {
    const res = await azure.request({
      method: "GET",
      path: `/subscriptions/${subscriptionId}/providers/Microsoft.Insights/workbooks`,
      apiVersion: WORKBOOK_API_VERSION,
      query: { category: "sentinel", canFetchContent: "true" },
    });
    if (res.status !== 200) {
      return {
        items: [],
        note: `Azure returned status ${res.status} enumerating workbooks - showing rules only.`,
      };
    }
    // Accumulate every ARM page. A workbook list carries nextLink (an absolute
    // management.azure.com URL) when it spans pages; follow it via the optional
    // requestUrl exactly as the core listAllPages does, so a large workspace's
    // workbooks are not SILENTLY DROPPED past the first page. Adapters without
    // requestUrl degrade to single-page (the documented fallback).
    const raws: unknown[] = [];
    let note = "";
    let { value, nextLink } = pageValue(res.body);
    raws.push(...value);
    let pages = 0;
    while (nextLink !== "" && typeof azure.requestUrl === "function") {
      if (pages >= WORKBOOK_MAX_PAGES) {
        note = `Stopped after ${WORKBOOK_MAX_PAGES} workbook pages - some workbooks may be omitted.`;
        break;
      }
      pages += 1;
      const page = await azure.requestUrl({ method: "GET", url: nextLink });
      if (page.status !== 200) {
        note = `Azure returned status ${page.status} paging workbooks - showing the workbooks read so far.`;
        break;
      }
      ({ value, nextLink } = pageValue(page.body));
      raws.push(...value);
    }
    const items: ContentItem[] = [];
    for (const raw of raws) {
      if (!isRecord(raw)) {
        continue;
      }
      const id =
        typeof raw["id"] === "string"
          ? raw["id"]
          : typeof raw["name"] === "string"
            ? raw["name"]
            : "workbook";
      const props = isRecord(raw["properties"]) ? raw["properties"] : {};
      const name =
        typeof props["displayName"] === "string" ? props["displayName"] : id;
      const serialized = props["serializedData"];
      const extraction =
        typeof serialized === "string"
          ? extractWorkbookQueries(serialized)
          : { queries: [], unparseableCount: 1 };
      items.push(workbookToContentItem(id, name, extraction));
    }
    return { items, note };
  } catch (err) {
    return {
      items: [],
      note: `Could not enumerate workbooks: ${String(err)} - showing rules only.`,
    };
  }
}

/** Union every destination table's schema columns via the catalog port. */
async function resolveSchemaUnion(
  catalog: SchemaCatalog,
  tableNames: readonly string[],
): Promise<string[]> {
  const schemas: Array<Array<{ name: string }>> = [];
  for (const table of tableNames) {
    const columns = await catalog.resolveSchema(table);
    if (columns !== null) {
      schemas.push(columns.map((c) => ({ name: c.name })));
    }
  }
  return unionSchemaColumns(schemas);
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
  azure,
  subscriptionId,
  catalog,
  onRuleFieldsChange,
  contentFilter,
  extraAvailableFields,
}: RuleCoverageSectionProps) {
  const { ports, config } = usePorts();
  const activeContent = content ?? ports.content;
  const activeAzure = azure ?? ports.azure;
  const activeSubscription = subscriptionId ?? config.subscriptionId;
  const activeCatalog = useMemo(
    () => catalog ?? createBundledSchemaCatalog(),
    [catalog],
  );
  // What this instance covers. Custom-YAML upload and the RULE-badge report are
  // rules-only concerns; workbooks are a separate diagnostic.
  const showRules = contentFilter !== "workbooks";
  const showWorkbooks = contentFilter !== "rules";

  const [report, setReport] = useState<CoverageReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");
  const [workbookNote, setWorkbookNote] = useState("");
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
      setWorkbookNote("");
      setSchemaNote("");
      try {
        const custom = customOverride ?? customItems;
        const [ruleItems, repoWorkbooks, workbookResult] = await Promise.all([
          showRules
            ? fetchRuleContentItems(activeContent, solutionName)
            : Promise.resolve<ContentItem[]>([]),
          showWorkbooks && activeContent !== undefined
            ? acquireSolutionWorkbooks(activeContent, solutionName)
            : Promise.resolve<ContentItem[]>([]),
          showWorkbooks
            ? fetchWorkbookContentItems(activeAzure, activeSubscription)
            : Promise.resolve({ items: [] as ContentItem[], note: "" }),
        ]);
        // Workbook source of record is the SOLUTION REPO (parallel to rules).
        // Deployed subscription workbooks (ARM) fold in ONLY when their name
        // relates to the selected solution: a shared subscription carries
        // everyone's workbooks (live report 2026-07-09: FortiGate and Cisco
        // dashboards polluted a Zscaler review), and coverage of unrelated
        // content is noise. The repo template wins a name collision.
        const relatedArm = workbookResult.items.filter((item) =>
          matchSolutionName(item.name, solutionName),
        );
        const excludedArm = workbookResult.items.length - relatedArm.length;
        const workbooks = mergeCustomContentItems(relatedArm, repoWorkbooks);
        // Repo rules + workbooks, then merge the custom uploads (last-write-wins
        // by name - the re-upload fix).
        const repoAndWorkbooks = [...ruleItems, ...workbooks];
        const items = mergeCustomContentItems(repoAndWorkbooks, custom);

        const schemaUnion = await resolveSchemaUnion(
          activeCatalog,
          destinationTableNamesFromReports(reports),
        );
        if (schemaUnion.length === 0) {
          // Without a resolvable destination schema every field classifies
          // "unknown" and the percentages are meaningless - say so instead
          // of rendering an empty-denominator 100%.
          setSchemaNote(
            `No schema could be resolved for destination table(s) ${destinationTableNamesFromReports(reports).join(", ")} - fields cannot be classified and coverage percentages would be meaningless. Re-run the DCR Gap Analysis or check the destination table selection.`,
          );
          return;
        }

        const produced = analyzeContentCoverage({
          items,
          availableFields: [
            ...availableFieldsFromReports(reports),
            ...(extraAvailableFields ?? []),
          ],
          schemaUnion,
        });
        setReport(produced);
        setWorkbookNote(
          [
            workbookResult.note,
            excludedArm > 0
              ? `${excludedArm} deployed workbook(s) in the subscription do not relate to ${solutionName} and were excluded.`
              : "",
          ]
            .filter((n) => n !== "")
            .join(" "),
        );
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
      activeAzure,
      activeSubscription,
      activeCatalog,
      solutionName,
      reports,
      showRules,
      showWorkbooks,
      extraAvailableFields,
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
    report !== null
      ? deriveCoverageSection(
          report,
          "alert-rule",
          report.summary.missingFieldsAcrossRules.length,
        )
      : null;
  const workbookSection =
    report !== null
      ? deriveCoverageSection(
          report,
          "workbook",
          report.summary.missingFieldsAcrossRules.length,
        )
      : null;
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
        <p className="field-hint">{RULE_COVERAGE_NO_REPORTS_NOTE}</p>
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
      {workbookNote !== "" && (
        <div className="status-bar status-bar-warn">
          <span className="status-bar-dot" />
          <span className="status-bar-text">{workbookNote}</span>
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
