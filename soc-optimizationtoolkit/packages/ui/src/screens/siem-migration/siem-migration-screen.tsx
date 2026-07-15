/**
 * SiemMigrationScreen (porting-plan Unit 26, ENG-40 + GUI-22) - the rebuilt
 * SIEM Migration analyzer: upload a Splunk saved-search JSON or QRadar rule
 * CSV export, identify the data sources the detections need, map them to
 * Microsoft Sentinel solutions/tables (static knowledge bases + prefix rules
 * + live fuzzy tier), enrich with the solutions' actual analytics rules, and
 * hand each mapped solution off to Sentinel Integration.
 *
 * IMPROVEMENTS over the legacy Electron screen (user directives 2026-07-14):
 *  - STATE SURVIVES NAVIGATION: the plan persists via the ContentCache port
 *    under SIEM_MIGRATION_PLAN_KEY and restores on mount, so bouncing
 *    between this screen and Sentinel Integration loses nothing (the legacy
 *    kept the plan in volatile React state only).
 *  - SEAMLESS PIVOT: "Open in Sentinel Integration" writes the EXISTING
 *    solution deep link (buildSolutionDeepLink - the contract preserved for
 *    this exact unit) and navigates via the shell callback; the Integrate
 *    page consumes the link once and preselects the solution.
 *  - The report downloads through the ArtifactSink port (both shells)
 *    instead of an Electron-only Downloads write; analysis runs through the
 *    analyzeSiemExport usecase over the SentinelContent port (lazy GitHub,
 *    no repo mirror). The legacy dead build-pack path did not port.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzeSiemExport,
  detectSiemPlatform,
  enrichPlanWithAnalyticRules,
  fetchSolutionAnalyticRules,
  generateMigrationReport,
  migrationReportFileName,
  parseMigrationPlan,
  serializeMigrationPlan,
} from "@soc/core";
import type {
  MigrationPlan,
  SentinelAnalyticRuleMatch,
  SiemPlatform,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { buildSolutionDeepLink } from "../solution-browser/browser-state";
import { InfoTip } from "../../components/info-tip";
import {
  SIEM_MIGRATION_PLAN_KEY,
  confidenceTone,
  identifierSummary,
  mappedSources,
  migrationStatTiles,
  rulesBySolutionFromPlan,
  unmappedSources,
} from "./siem-migration-state";

export interface SiemMigrationScreenProps {
  /**
   * Navigate to the Sentinel Integration route (the shell binds its route
   * id). Called AFTER the solution deep link is written, so the Integrate
   * page preselects the pivoted solution. Absent = the pivot button hides.
   */
  onOpenIntegration?: () => void;
}

export function SiemMigrationScreen({ onOpenIntegration }: SiemMigrationScreenProps) {
  const { ports } = usePorts();
  const [platform, setPlatform] = useState<SiemPlatform>("splunk");
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // LAZY per-solution rule enrichment (the 2026-07-14 stall fix: eager
  // enrichment meant hundreds of sequential GitHub reads before the plan
  // rendered). The accumulated map feeds the pure enrich fold; per-card
  // progress renders AT the control (the twice-learned placement rule).
  const rulesBySolutionRef = useRef(new Map<string, SentinelAnalyticRuleMatch[]>());
  const solutionNamesRef = useRef<string[] | null>(null);
  const [loadedSolutions, setLoadedSolutions] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [enrichProgress, setEnrichProgress] = useState<Record<string, string>>(
    {},
  );

  // Restore the persisted plan once on mount (the bounce-back contract).
  const cache = ports.contentCache;
  useEffect(() => {
    if (cache === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = await cache.get(SIEM_MIGRATION_PLAN_KEY);
        if (cancelled || typeof raw !== "string") return;
        const restored = parseMigrationPlan(raw);
        if (restored !== null) {
          setPlan(restored);
          setPlatform(restored.platform);
          // Re-seed the lazy-enrichment accumulator so already-loaded
          // solutions render their rules (and offer Reload, not Load).
          rulesBySolutionRef.current = rulesBySolutionFromPlan(restored);
          setLoadedSolutions(new Set(rulesBySolutionRef.current.keys()));
          setNotice(`Restored the saved analysis of ${restored.fileName}.`);
        }
      } catch {
        // A failed restore reads as "no saved plan" - upload re-analyzes.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cache]);

  const persist = useCallback(
    (next: MigrationPlan | null) => {
      if (cache === undefined) return;
      void cache
        .set(SIEM_MIGRATION_PLAN_KEY, next === null ? "" : serializeMigrationPlan(next))
        .catch(() => {
          // Best-effort: the analysis still renders; only the bounce-back
          // restore is affected, and the next analyze retries the write.
        });
    },
    [cache],
  );

  const analyze = useCallback(
    async (content: string, fileName: string) => {
      setAnalyzing(true);
      setAnalyzeProgress("Parsing the export and matching Sentinel solutions...");
      setError("");
      setNotice("");
      // A fresh analysis invalidates the lazily-loaded rule enrichment.
      rulesBySolutionRef.current = new Map();
      setLoadedSolutions(new Set());
      setEnrichProgress({});
      try {
        const detected = detectSiemPlatform(fileName, content);
        setPlatform(detected);
        const produced = await analyzeSiemExport(
          { ...(ports.content !== undefined ? { content: ports.content } : {}), ...(ports.logger !== undefined ? { logger: ports.logger } : {}) },
          { content, platform: detected, fileName },
        );
        setPlan(produced);
        persist(produced);
        setNotice(
          "Analysis complete. Load each solution's Sentinel rules on its card below (fetched on demand).",
        );
        ports.logger?.info("siem-migration: analysis complete", {
          fileName,
          platform: detected,
          dataSources: produced.dataSources.length,
        });
      } catch (err) {
        setError(String(err));
        ports.logger?.error(`siem-migration: analysis failed: ${String(err)}`);
      } finally {
        setAnalyzing(false);
        setAnalyzeProgress("");
      }
    },
    [ports, persist],
  );

  // Load ONE solution's Sentinel analytics rules on demand (capped reads,
  // per-card progress). The accumulated map re-folds into the plan purely,
  // so previously loaded solutions keep their rules.
  const loadSolutionRules = useCallback(
    async (solutionName: string) => {
      const contentPort = ports.content;
      if (plan === null || contentPort === undefined) return;
      const key = solutionName.toLowerCase();
      setEnrichProgress((p) => ({ ...p, [key]: "Listing rule files..." }));
      try {
        if (solutionNamesRef.current === null) {
          solutionNamesRef.current = (await contentPort.listSolutions()).map(
            (s) => s.name,
          );
        }
        const matches = await fetchSolutionAnalyticRules(
          contentPort,
          solutionNamesRef.current,
          solutionName,
          (read, total) =>
            setEnrichProgress((p) => ({
              ...p,
              [key]: `Reading rules (${read}/${total})...`,
            })),
        );
        rulesBySolutionRef.current.set(key, matches);
        setLoadedSolutions(new Set(rulesBySolutionRef.current.keys()));
        const next = enrichPlanWithAnalyticRules(plan, rulesBySolutionRef.current);
        setPlan(next);
        persist(next);
        setEnrichProgress((p) => {
          const { [key]: _done, ...rest } = p;
          return rest;
        });
      } catch (err) {
        setEnrichProgress((p) => ({ ...p, [key]: `Failed: ${String(err)}` }));
        ports.logger?.warn("siem-migration: rule load failed", {
          solution: solutionName,
          error: String(err),
        });
      }
    },
    [plan, ports, persist],
  );

  const onFileChosen = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (file === undefined) return;
      const text = await file.text();
      await analyze(text, file.name);
      // Allow re-selecting the same file to re-analyze.
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    },
    [analyze],
  );

  // The SEAMLESS PIVOT: write the preserved deep-link contract, then let the
  // shell navigate. The Integrate page consumes #/?solution= once on mount.
  const openInIntegration = useCallback(
    (solutionName: string) => {
      window.location.hash = buildSolutionDeepLink(solutionName);
      onOpenIntegration?.();
    },
    [onOpenIntegration],
  );

  const exportReport = useCallback(async () => {
    if (plan === null) return;
    const iso = new Date().toISOString();
    try {
      await ports.artifacts.save(
        migrationReportFileName(plan, iso),
        "text/html",
        generateMigrationReport(plan, iso),
      );
      setNotice(`Report download dispatched (${migrationReportFileName(plan, iso)}).`);
    } catch (err) {
      setError(`Report export failed: ${String(err)}`);
    }
  }, [plan, ports]);

  const clearPlan = useCallback(() => {
    setPlan(null);
    rulesBySolutionRef.current = new Map();
    setLoadedSolutions(new Set());
    setEnrichProgress({});
    setNotice("Saved analysis cleared.");
    persist(null);
  }, [persist]);

  return (
    <>
      <section className="panel">
        <h2 className="panel-title">1. Upload detection rules</h2>
        <p className="panel-desc">
          Export your detections from the source SIEM (Splunk: saved-search/alert
          JSON export; IBM QRadar: rule CSV export) and upload the file. The
          platform is detected from the file; the analyzer identifies the data
          sources the rules depend on and maps them to Microsoft Sentinel
          solutions and tables.
        </p>
        <div className="path-options">
          <label className="path-option">
            <input
              type="radio"
              name="siem-platform"
              checked={platform === "splunk"}
              onChange={() => setPlatform("splunk")}
            />
            <span>Splunk (JSON export)</span>
          </label>
          <label className="path-option">
            <input
              type="radio"
              name="siem-platform"
              checked={platform === "qradar"}
              onChange={() => setPlatform("qradar")}
            />
            <span>IBM QRadar (CSV export)</span>
          </label>
        </div>
        <div className="panel-controls">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.csv,.txt"
            disabled={analyzing}
            onChange={(e) => void onFileChosen(e.target.files)}
          />
          <span className={`status status-${analyzing ? "running" : plan !== null ? "ok" : "idle"}`}>
            {analyzing ? "running" : plan !== null ? "ok" : "idle"}
          </span>
          {analyzeProgress !== "" && (
            <span className="field-hint">{analyzeProgress}</span>
          )}
        </div>
        {error !== "" && <pre className="result">{error}</pre>}
        {notice !== "" && <p className="panel-desc">{notice}</p>}
      </section>

      {plan !== null && (
        <section className="panel">
          <h2 className="panel-title">
            2. Data source mapping{" "}
            <InfoTip
              text={
                "Each identified data source groups every detection rule that references it " +
                "(macros, data models, sourcetypes, or QRadar content extensions), mapped to the " +
                "Sentinel solution and destination table via the curated knowledge bases, prefix " +
                "rules, and a fuzzy match against the live solution list. Confidence: high = " +
                "direct curated mapping, medium = prefix/fuzzy, low = partial-word fuzzy."
              }
            />
          </h2>
          <p className="panel-desc">
            {plan.fileName} ({plan.platform === "splunk" ? "Splunk" : "IBM QRadar"})
            {plan.buildingBlocks > 0
              ? ` - ${plan.buildingBlocks} QRadar building block(s) excluded from data-source identification`
              : ""}
          </p>
          <div className="match-stat-grid">
            {migrationStatTiles(plan).map((tile) => (
              <div key={tile.key} className={`match-stat match-stat-${tile.tone}`}>
                <span className="match-stat-value">{tile.value}</span>
                <span className="match-stat-label">{tile.label}</span>
              </div>
            ))}
          </div>

          {mappedSources(plan).map((ds) => (
            <div key={ds.id} className="siem-solution-card">
              <div className="siem-solution-card-head">
                <span className="siem-solution-name">{ds.sentinelSolution}</span>
                <span className={`siem-confidence siem-confidence-${confidenceTone(ds.confidence)}`}>
                  {ds.confidence} confidence
                </span>
                {onOpenIntegration !== undefined && (
                  <button
                    className="run-button"
                    onClick={() => openInIntegration(ds.sentinelSolution)}
                  >
                    Open in Sentinel Integration
                  </button>
                )}
              </div>
              <p className="panel-desc">
                {ds.ruleCount} rule(s) - table{" "}
                <code className="code-chip">{ds.sentinelTable || "(resolved at integration)"}</code>
                {" - sources: "}
                {identifierSummary(ds)}
              </p>
              {ds.sentinelAnalyticRules.length > 0 ? (
                <details className="gap-handles">
                  <summary>
                    {ds.sentinelAnalyticRules.length} Sentinel analytics rule(s) ship with this solution
                  </summary>
                  <div className="gap-handles-body">
                    {ds.sentinelAnalyticRules.map((r) => (
                      <div key={r.name}>
                        {r.name} ({r.severity}
                        {r.tactics.length > 0 ? ` - ${r.tactics.join(", ")}` : ""})
                      </div>
                    ))}
                  </div>
                </details>
              ) : loadedSolutions.has(ds.sentinelSolution.toLowerCase()) &&
                enrichProgress[ds.sentinelSolution.toLowerCase()] === undefined ? (
                <p className="panel-desc">
                  No analytics rules found in the solution repo.
                </p>
              ) : (
                <div className="panel-controls">
                  <button
                    className="run-button"
                    disabled={
                      ports.content === undefined ||
                      enrichProgress[ds.sentinelSolution.toLowerCase()] !==
                        undefined
                    }
                    onClick={() => void loadSolutionRules(ds.sentinelSolution)}
                  >
                    Load Sentinel rules
                  </button>
                  {enrichProgress[ds.sentinelSolution.toLowerCase()] !==
                    undefined && (
                    <span className="field-hint">
                      {enrichProgress[ds.sentinelSolution.toLowerCase()]}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}

          {unmappedSources(plan).length > 0 && (
            <>
              <p className="match-warning match-warning-overflow-loss">
                {unmappedSources(plan).length} data source(s) could not be mapped to a
                Sentinel solution. Review them below and onboard manually, or extend
                the mapping knowledge bases.
              </p>
              <div className="gap-handles-body">
                {unmappedSources(plan).map((ds) => (
                  <div key={ds.id}>
                    {ds.name} ({ds.ruleCount} rule(s))
                  </div>
                ))}
              </div>
            </>
          )}

          {plan.mitreCoverage.length > 0 && (
            <details className="gap-handles">
              <summary>MITRE ATT&amp;CK coverage ({plan.mitreCoverage.length} tactic(s))</summary>
              <div className="gap-handles-body">
                {plan.mitreCoverage.map((t) => (
                  <div key={t.tactic}>
                    {t.tactic}: {t.ruleCount} rule(s), {t.techniqueCount} technique(s)
                  </div>
                ))}
              </div>
            </details>
          )}

          {plan.unmappedRules.length > 0 && (
            <details className="gap-handles">
              <summary>{plan.unmappedRules.length} rule(s) with no identified data source</summary>
              <div className="gap-handles-body">
                {plan.unmappedRules.slice(0, 100).map((r) => (
                  <div key={r.name}>
                    {r.name}: {r.dataSources.join(", ") || "no data source identified"}
                  </div>
                ))}
                {plan.unmappedRules.length > 100 && (
                  <div>... and {plan.unmappedRules.length - 100} more</div>
                )}
              </div>
            </details>
          )}
        </section>
      )}

      {plan !== null && (
        <section className="panel">
          <h2 className="panel-title">3. Export migration report</h2>
          <p className="panel-desc">
            A self-contained HTML report of the mapping: stat tiles, the data-source
            table with confidence badges, matched Sentinel analytics rules, unmapped
            rules, and the next steps. Attach it to the migration ticket.
          </p>
          <div className="panel-controls">
            <button className="run-button" onClick={() => void exportReport()}>
              Download migration report
            </button>
            <button className="run-button" onClick={clearPlan}>
              Clear saved analysis
            </button>
          </div>
        </section>
      )}
    </>
  );
}
