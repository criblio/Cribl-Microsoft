/**
 * ContentInstallSection (user feature 2026-07-14) - the Integrate page's
 * "Enable Sentinel Content" section: install the Content Hub solution, its
 * analytics rules, and its workbooks into the workspace, choosing which of
 * each. It checks what is ALREADY installed (so only installable items are
 * offered), accepts custom analytics-rule and workbook uploads, and reports
 * a per-item success/failure outcome for every install (user requirement).
 *
 * Parsers the rules/workbooks depend on are installed AUTOMATICALLY as a
 * dependency (they are queried by alias; a missing function breaks the rule),
 * indicated but never asked - mirroring Content Hub (user direction).
 *
 * INFORMATIONAL and Sentinel-side: it never gates the Cribl deploy. All IO
 * rides the existing AzureManagement port (management.azure.com) and the
 * SentinelContent port (repo rules/workbooks/parsers) - no new external
 * surface. Pure decisions live in content-install-state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  availableAnalyticRules,
  availableParsers,
  availableWorkbooks,
  alertRuleResourceFromParsed,
  onboardSentinelWorkspace,
  fetchWorkspaceLocation,
  findSolutionCatalogEntry,
  installAnalyticRule,
  installParser,
  installSolution,
  installWorkbook,
  installedContentState,
  parseWorkbookUpload,
  parseRuleUploadFile,
  parseAnalyticRuleYaml,
  summarizeInstallOutcomes,
} from "@soc/core";
import type {
  AvailableWorkbook,
  ContentInstallOutcome,
  InstalledContentState,
  ParsedAnalyticRule,
  ParserResource,
  SolutionCatalogEntry,
  WorkspaceScope,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { InfoTip } from "../../components/info-tip";
import {
  partitionOutcomes,
  selectAll,
  splitRules,
  splitWorkbooks,
  toggleName,
} from "./content-install-state";

export interface ContentInstallSectionProps {
  /** The selected Sentinel solution (scopes the content lookup); "" when none. */
  solutionName: string;
  /** Whether a full Azure target scope is committed (needed to install). */
  scopeCommitted: boolean;
  /** Diagnostics sink (optional). */
}

/** Reused across renders; the shell's GUID minter is required to install. */
export function ContentInstallSection({
  solutionName,
  scopeCommitted,
}: ContentInstallSectionProps) {
  const { ports, config } = usePorts();
  const mintId = ports.mintAssignmentName;
  const content = ports.content;

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [catalog, setCatalog] = useState<SolutionCatalogEntry | null>(null);
  const [installed, setInstalled] = useState<InstalledContentState | null>(null);
  const [rules, setRules] = useState<ParsedAnalyticRule[]>([]);
  const [workbooks, setWorkbooks] = useState<AvailableWorkbook[]>([]);
  const [parsers, setParsers] = useState<ParserResource[]>([]);
  const [location, setLocation] = useState<string | null>(null);

  // Custom uploads merged into the installable pools.
  const [customRules, setCustomRules] = useState<ParsedAnalyticRule[]>([]);
  const [customWorkbooks, setCustomWorkbooks] = useState<AvailableWorkbook[]>([]);

  // Selections (by display name) and per-group busy/outcome state.
  const [ruleSel, setRuleSel] = useState<Set<string>>(new Set());
  const [wbSel, setWbSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"" | "solution" | "rules" | "workbooks" | "onboard">("");
  const [outcomes, setOutcomes] = useState<ContentInstallOutcome[]>([]);
  const [progress, setProgress] = useState("");
  const [onboardError, setOnboardError] = useState("");
  const ruleFileRef = useRef<HTMLInputElement | null>(null);
  const wbFileRef = useRef<HTMLInputElement | null>(null);

  const scope = useMemo<WorkspaceScope>(
    () => ({
      subscriptionId: config.subscriptionId,
      resourceGroup: config.resourceGroup,
      workspaceName: config.workspaceName,
      location: location ?? "",
    }),
    [config, location],
  );

  const canInstall =
    scopeCommitted &&
    mintId !== undefined &&
    config.subscriptionId !== "" &&
    config.resourceGroup !== "" &&
    config.workspaceName !== "";

  // Load the catalog entry, installed state, and available content on demand.
  const load = useCallback(async () => {
    if (content === undefined || solutionName.trim() === "") return;
    setLoading(true);
    setLoadError("");
    setOutcomes([]);
    try {
      const entry = scopeCommitted
        ? await findSolutionCatalogEntry(ports.azure, scope, solutionName, ports.logger)
        : null;
      setCatalog(entry);
      const state = scopeCommitted
        ? await installedContentState(ports.azure, scope, entry?.contentId, ports.logger)
        : null;
      setInstalled(state);
      const [repoRules, repoWorkbooks, repoParsers] = await Promise.all([
        availableAnalyticRules(content, solutionName),
        availableWorkbooks(content, solutionName),
        availableParsers(content, solutionName),
      ]);
      setRules(repoRules);
      setWorkbooks(repoWorkbooks);
      setParsers(repoParsers);
      if (scopeCommitted) {
        setLocation(
          await fetchWorkspaceLocation(
            ports.azure,
            config.subscriptionId,
            config.resourceGroup,
            config.workspaceName,
          ),
        );
      }
    } catch (err) {
      setLoadError(String(err));
    } finally {
      setLoading(false);
    }
  }, [content, solutionName, scopeCommitted, ports, scope, config]);

  // Reset when the solution changes (the section is keyed by solution too).
  useEffect(() => {
    setCatalog(null);
    setInstalled(null);
    setRules([]);
    setWorkbooks([]);
    setParsers([]);
    setCustomRules([]);
    setCustomWorkbooks([]);
    setRuleSel(new Set());
    setWbSel(new Set());
    setOutcomes([]);
  }, [solutionName]);

  const allRules = useMemo(() => [...rules, ...customRules], [rules, customRules]);
  const allWorkbooks = useMemo(
    () => [...workbooks, ...customWorkbooks],
    [workbooks, customWorkbooks],
  );
  const ruleSplit = useMemo(
    () =>
      installed !== null
        ? splitRules(allRules, installed)
        : { installed: [], installable: allRules },
    [allRules, installed],
  );
  const wbSplit = useMemo(
    () =>
      installed !== null
        ? splitWorkbooks(allWorkbooks, installed)
        : { installed: [], installable: allWorkbooks },
    [allWorkbooks, installed],
  );

  // Custom rule uploads: parse each file as a Sentinel rule YAML (the full
  // install-field extraction - scheduling block, entity mappings). Files that
  // yield no query are dropped. Portal ARM JSON / raw KQL are surfaced via
  // parseRuleUploadFile only when the YAML parse finds nothing installable,
  // so a KQL-only upload still installs as a minimal scheduled rule.
  const onUploadRules = useCallback(async (files: FileList | null) => {
    const parsed: ParsedAnalyticRule[] = [];
    for (const file of files ?? []) {
      const text = await file.text();
      const lower = file.name.toLowerCase();
      // YAML: the full install-field extraction (scheduling, entity mappings).
      // Everything else (portal ARM JSON, raw KQL) rides parseRuleUploadFile,
      // which also returns ParsedAnalyticRules.
      if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
        const yaml = parseAnalyticRuleYaml(text, file.name);
        if (yaml.query.trim() !== "") parsed.push(yaml);
      } else {
        parsed.push(...parseRuleUploadFile(file.name, text).filter((r) => r.query.trim() !== ""));
      }
    }
    if (parsed.length > 0) setCustomRules((prev) => [...prev, ...parsed]);
    if (ruleFileRef.current !== null) ruleFileRef.current.value = "";
  }, []);

  const onUploadWorkbooks = useCallback(async (files: FileList | null) => {
    const parsed: AvailableWorkbook[] = [];
    for (const file of files ?? []) {
      const text = await file.text();
      const wb = parseWorkbookUpload(file.name, text);
      if (wb !== null) {
        parsed.push({ displayName: wb.displayName, serializedData: wb.serializedData });
      }
    }
    if (parsed.length > 0) setCustomWorkbooks((prev) => [...prev, ...parsed]);
    if (wbFileRef.current !== null) wbFileRef.current.value = "";
  }, []);

  // Install the referenced parsers as a dependency (best-effort, reported).
  const installParsers = useCallback(async (): Promise<ContentInstallOutcome[]> => {
    if (mintId === undefined || parsers.length === 0) return [];
    const out: ContentInstallOutcome[] = [];
    for (const parser of parsers) {
      setProgress(`Installing parser ${parser.displayName}...`);
      out.push(await installParser(ports.azure, scope, parser));
    }
    return out;
  }, [parsers, ports, scope, mintId]);

  const doInstallSolution = useCallback(async () => {
    if (catalog === null || !canInstall) return;
    setBusy("solution");
    setOutcomes([]);
    try {
      setProgress(`Installing solution ${catalog.displayName}...`);
      const outcome = await installSolution(
        ports.azure,
        scope,
        catalog.packageId,
        catalog.displayName,
        ports.logger,
      );
      setOutcomes([outcome]);
    } finally {
      setBusy("");
      setProgress("");
      void load();
    }
  }, [catalog, canInstall, ports, scope, load]);

  const doInstallRules = useCallback(async () => {
    if (mintId === undefined || !canInstall) return;
    setBusy("rules");
    setOutcomes([]);
    try {
      const selected = ruleSplit.installable.filter((r) => ruleSel.has(r.name));
      const parserOutcomes = await installParsers();
      const ruleOutcomes: ContentInstallOutcome[] = [];
      let done = 0;
      for (const rule of selected) {
        setProgress(`Installing rule ${++done}/${selected.length}: ${rule.name}...`);
        ruleOutcomes.push(await installAnalyticRule(ports.azure, scope, rule, mintId));
      }
      setOutcomes([...parserOutcomes, ...ruleOutcomes]);
    } finally {
      setBusy("");
      setProgress("");
      void load();
    }
  }, [mintId, canInstall, ruleSplit, ruleSel, installParsers, ports, scope, load]);

  const doInstallWorkbooks = useCallback(async () => {
    if (mintId === undefined || !canInstall) return;
    setBusy("workbooks");
    setOutcomes([]);
    try {
      const selected = wbSplit.installable.filter((w) => wbSel.has(w.displayName));
      const parserOutcomes = await installParsers();
      const wbOutcomes: ContentInstallOutcome[] = [];
      let done = 0;
      for (const wb of selected) {
        setProgress(`Installing workbook ${++done}/${selected.length}: ${wb.displayName}...`);
        wbOutcomes.push(
          await installWorkbook(
            ports.azure,
            scope,
            { displayName: wb.displayName, serializedData: wb.serializedData },
            mintId,
          ),
        );
      }
      setOutcomes([...parserOutcomes, ...wbOutcomes]);
    } finally {
      setBusy("");
      setProgress("");
      void load();
    }
  }, [mintId, canInstall, wbSplit, wbSel, installParsers, ports, scope, load]);

  // Enable Microsoft Sentinel on the workspace (the not-onboarded remedy):
  // the SecurityInsights provider rejects every content call until Sentinel
  // is onboarded. Uses the MODERN onboardingStates PUT (the method the error
  // itself recommends), reports the outcome, and reloads on success. The
  // legacy OperationsManagement/solutions method silently no-ops in many
  // regions, which is why the old Enable "did nothing".
  const doEnableSentinel = useCallback(async () => {
    if (!canInstall) return;
    setBusy("onboard");
    setOnboardError("");
    setProgress("Enabling Microsoft Sentinel on the workspace...");
    try {
      const outcome = await onboardSentinelWorkspace(ports.azure, scope, ports.logger);
      if (outcome.ok) {
        setProgress(outcome.detail);
        await load();
      } else {
        setProgress("");
        setOnboardError(`Enable failed: ${outcome.detail}`);
      }
    } catch (err) {
      setProgress("");
      setOnboardError(String(err));
    } finally {
      setBusy("");
    }
  }, [canInstall, ports, scope, load]);

  if (content === undefined) {
    return (
      <p className="panel-desc">
        GitHub content access is not available in this build - the Repositories
        surface binds it. Solution content cannot be listed here.
      </p>
    );
  }

  if (solutionName.trim() === "") {
    return (
      <p className="panel-desc">
        Select a Sentinel solution in section 1 to enable its content.
      </p>
    );
  }

  const grouped = partitionOutcomes(outcomes);

  return (
    <div className="content-install">
      {!scopeCommitted && (
        <p className="connection-notice">
          Commit an Azure target scope (Select Azure Resources) to check what is
          installed and to install content. You can still preview the solution&apos;s
          rules and workbooks below.
        </p>
      )}

      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void load()}
          disabled={loading || busy !== ""}
        >
          {loading ? "Loading..." : "Load solution content"}
        </button>
        {mintId === undefined && (
          <span className="field-hint">
            Installs are unavailable: the shell did not provide an id minter.
          </span>
        )}
      </div>
      {loadError !== "" && <pre className="result">{loadError}</pre>}
      {installed !== null && installed.notOnboarded && (
        <div className="connection-notice">
          <p>
            This workspace is not onboarded to Microsoft Sentinel, so its
            content cannot be read or installed yet. Enable Sentinel (a
            one-time, idempotent step) to continue - or do it in Select Azure
            Resources.
          </p>
          <div className="panel-controls">
            <button
              className="run-button"
              onClick={() => void doEnableSentinel()}
              disabled={!canInstall || busy !== ""}
            >
              {busy === "onboard" ? "Enabling..." : "Enable Microsoft Sentinel"}
            </button>
          </div>
          {onboardError !== "" && <pre className="result">{onboardError}</pre>}
        </div>
      )}
      {installed !== null &&
        installed.notes.map((note, i) => (
          <p key={i} className="field-hint">{note}</p>
        ))}

      {/* SOLUTION */}
      <section className="content-install-group">
        <h3 className="content-install-title">
          Solution{" "}
          <InfoTip text="Install the Content Hub solution package itself (its ARM template, deployed to your workspace). This brings in the solution's own rule/workbook/parser definitions the same way the portal Content Hub does." />
        </h3>
        {catalog === null ? (
          <p className="panel-desc">
            {scopeCommitted
              ? "Load to look up this solution in Content Hub."
              : "Commit a target scope, then load to look up the Content Hub package."}
          </p>
        ) : catalog.installedVersion !== null ? (
          <p className="content-install-installed">
            Installed (version {catalog.installedVersion}). Latest available:{" "}
            {catalog.version}.
          </p>
        ) : (
          <div className="panel-controls">
            <span className="panel-desc">
              {catalog.displayName} {catalog.version} - not installed.
            </span>
            <button
              className="run-button"
              onClick={() => void doInstallSolution()}
              disabled={!canInstall || busy !== ""}
            >
              {busy === "solution" ? "Installing..." : "Install solution"}
            </button>
          </div>
        )}
      </section>

      {/* ANALYTICS RULES */}
      <ContentGroup
        title="Analytics rules"
        tip="Install the solution's analytics rules (Scheduled and NRT). Already-installed rules are shown for reference; only installable ones are selectable. Parsers the rules query are installed automatically."
        installable={ruleSplit.installable.map((r) => ({
          name: r.name,
          detail: alertRuleResourceFromParsed(r).supported
            ? (r.severity || "")
            : "not installable (managed rule type)",
          disabled: !alertRuleResourceFromParsed(r).supported,
        }))}
        installedNames={ruleSplit.installed.map((r) => r.name)}
        selection={ruleSel}
        onToggle={(name) => setRuleSel((s) => toggleName(s, name))}
        onSelectAll={() =>
          setRuleSel(
            selectAll(
              ruleSplit.installable
                .filter((r) => alertRuleResourceFromParsed(r).supported)
                .map((r) => r.name),
            ),
          )
        }
        onClear={() => setRuleSel(new Set())}
        onInstall={() => void doInstallRules()}
        installing={busy === "rules"}
        canInstall={canInstall}
        uploadRef={ruleFileRef}
        uploadAccept=".yaml,.yml,.json,.kql,.txt"
        onUpload={onUploadRules}
        uploadLabel="Upload custom rules"
      />

      {/* WORKBOOKS */}
      <ContentGroup
        title="Workbooks"
        tip="Install the solution's workbooks, linked to your workspace. Upload custom workbooks (gallery-template JSON or a portal ARM export) to install alongside."
        installable={wbSplit.installable.map((w) => ({ name: w.displayName, detail: "" }))}
        installedNames={wbSplit.installed.map((w) => w.displayName)}
        selection={wbSel}
        onToggle={(name) => setWbSel((s) => toggleName(s, name))}
        onSelectAll={() =>
          setWbSel(selectAll(wbSplit.installable.map((w) => w.displayName)))
        }
        onClear={() => setWbSel(new Set())}
        onInstall={() => void doInstallWorkbooks()}
        installing={busy === "workbooks"}
        canInstall={canInstall}
        uploadRef={wbFileRef}
        uploadAccept=".json"
        onUpload={onUploadWorkbooks}
        uploadLabel="Upload custom workbooks"
      />

      {parsers.length > 0 && (
        <p className="field-hint">
          {parsers.length} solution parser(s) will be installed automatically
          with any rules or workbooks that depend on them.
        </p>
      )}

      {progress !== "" && <p className="panel-desc">{progress}</p>}
      {outcomes.length > 0 && (
        <div className="content-install-outcomes">
          <p className="panel-desc">
            <strong>{summarizeInstallOutcomes(outcomes)}</strong>
          </p>
          {grouped.failed.map((o, i) => (
            <p key={`f-${i}`} className="match-warning match-warning-overflow-loss">
              {o.name}: {o.detail}
            </p>
          ))}
          {grouped.ok.map((o, i) => (
            <p key={`o-${i}`} className="content-install-ok">
              {o.name}: {o.detail}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** One installable content group (rules or workbooks): list + install + upload. */
function ContentGroup({
  title,
  tip,
  installable,
  installedNames,
  selection,
  onToggle,
  onSelectAll,
  onClear,
  onInstall,
  installing,
  canInstall,
  uploadRef,
  uploadAccept,
  onUpload,
  uploadLabel,
}: {
  title: string;
  tip: string;
  installable: Array<{ name: string; detail: string; disabled?: boolean }>;
  installedNames: string[];
  selection: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onInstall: () => void;
  installing: boolean;
  canInstall: boolean;
  uploadRef: React.RefObject<HTMLInputElement | null>;
  uploadAccept: string;
  onUpload: (files: FileList | null) => void | Promise<void>;
  uploadLabel: string;
}) {
  const selectedCount = installable.filter(
    (i) => selection.has(i.name) && i.disabled !== true,
  ).length;
  return (
    <section className="content-install-group">
      <h3 className="content-install-title">
        {title} <InfoTip text={tip} />
      </h3>
      {installable.length === 0 && installedNames.length === 0 ? (
        <p className="panel-desc">None found for this solution.</p>
      ) : (
        <>
          {installable.length > 0 && (
            <div className="content-install-list">
              {installable.map((item) => (
                <label key={item.name} className="content-install-row">
                  <input
                    type="checkbox"
                    checked={selection.has(item.name)}
                    disabled={item.disabled === true}
                    onChange={() => onToggle(item.name)}
                  />
                  <span>{item.name}</span>
                  {item.detail !== "" && (
                    <span className="field-hint">{item.detail}</span>
                  )}
                </label>
              ))}
            </div>
          )}
          {installedNames.length > 0 && (
            <details className="gap-handles">
              <summary>{installedNames.length} already installed</summary>
              <div className="gap-handles-body">
                {installedNames.map((n) => (
                  <div key={n}>{n}</div>
                ))}
              </div>
            </details>
          )}
          <div className="panel-controls">
            <button
              className="run-button"
              onClick={onInstall}
              disabled={!canInstall || installing || selectedCount === 0}
            >
              {installing
                ? "Installing..."
                : `Install selected (${selectedCount})`}
            </button>
            {installable.length > 0 && (
              <>
                <button className="run-button" onClick={onSelectAll}>
                  Select all
                </button>
                <button className="run-button" onClick={onClear}>
                  Clear
                </button>
              </>
            )}
            <input
              ref={uploadRef}
              type="file"
              multiple
              accept={uploadAccept}
              onChange={(e) => void onUpload(e.target.files)}
              aria-label={uploadLabel}
            />
          </div>
        </>
      )}
    </section>
  );
}
