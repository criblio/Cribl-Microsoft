/**
 * IntegrateScreen - THE MVP CENTERPIECE: the single-page Integrate arc
 * (legacy-flow-analysis.md, structural decision ADOPTED 2026-07-04). The
 * legacy Sentinel Integration flagship was ONE scrolling page of numbered
 * sections that gate forward with an always-visible deploy readiness; this
 * screen is its successor, composing the ALREADY-SHIPPED screens as sections
 * rather than scattering them across sidebar routes.
 *
 * The seven sections render in page order from @soc/core INTEGRATE_SECTIONS.
 * Five are BUILT and operable today; two are honest coming-soon:
 *
 *   1. Sentinel Solution   - BUILT: the SolutionBrowser - lazy GitHub solution
 *      index (search, DEPRECATED badges + reason), per-solution on-demand fetch
 *      with commit-keyed caching, and the preserved `#/?solution=` deep link
 *      (Unit 14). Selecting a solution is additive and non-gating.
 *   2. Sample Data         - BUILT: the SampleIntakeSection - multi-file upload
 *      + paste-and-tag, per-sample chips (detected format + field table + raw
 *      preview), and a log-type rename that re-keys the tagged-sample store
 *      (Unit 11).
 *   3. Azure Resources     - BUILT: the AzureTargetingScreen cascade, the
 *      DCE / provision-DCR capability checkboxes, AND the operable
 *      RoleAssignmentSection (Unit 8, ENG-37 runtime half): grant Monitoring
 *      Metrics Publisher to the ingestion service principal on each DCR a
 *      deploy created, over the @soc/core assignDcrRoles usecase (GUID minting
 *      shell-injected). ADDITIVE + NON-GATING.
 *   4. Cribl Configuration - BUILT: worker-group select + pack name (prefilled
 *      from the saved Options destination prefix).
 *   5. DCR Gap Analysis    - BUILT: the MappingReviewSection - per-log-type
 *      gap analysis (six stat tiles, DCR/Cribl handles split), an editable
 *      dest/action mapping table, and the approval state machine (Auto-Approve
 *      All, per-table Approve, staleness). ADDITIVE + NON-GATING for the native
 *      deploy: it lights the Mappings pill and gates the content path only
 *      (Unit 18).
 *   6. Analytics Rule Cov. - BUILT: the RuleCoverageSection - the ONE shared
 *      content-reference analyzer over alert rules (SentinelContent port) and
 *      workbooks (AzureManagement ARM enumeration, net-new), rendered as two
 *      sections of one panel with three-way counts, per-item severity + coverage
 *      %, CUSTOM badges, missing-fields chips, and custom-YAML upload/clear.
 *      INFORMATIONAL: it lights the mapping table's RULE badges (the kept Unit
 *      18 ruleReferencedFields contract) but never gates a deploy (Unit 23).
 *   7. Deploy              - BUILT: the operable native-table onboard, driving
 *      the SAME @soc/core onboardTable use-case the validated Onboard screen
 *      runs (reusing onboardTableStepsFor, formatStepLine, summaryText,
 *      RecentRuns), with live step lines and the honest summary. The
 *      ReadinessFooter's Deploy triggers this run.
 *
 * The user validated the native-table onboard live end to end; it stays fully
 * operable THROUGH this page. The standalone Onboard / Azure Targeting /
 * Batch / Review routes remain registered (this page composes and supersedes
 * them during the transition; they stay reachable).
 *
 * Read-ahead contract: every section is visible; gating lives only at the
 * commit actions inside the composed screens (Use this target, Run deploy).
 * All decision logic is the pure @soc/core integrate-arc plus this package's
 * integrate-screen-state; this component only renders and orchestrates IO
 * through the ports in PortsContext (ZERO direct fetch/storage here).
 *
 * SECRET HANDLING mirrors OnboardTableScreen: the optional ingestion client
 * secret is TRANSIENT (write-only storage means it can never be read back);
 * left blank, the destination ships the placeholder to fill in Cribl.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_OPERATION_OPTIONS,
  SENTINEL_SECRET_PLACEHOLDER,
  canWireSource,
  deriveSectionStatuses,
  destinationIdFromOptions,
  onboardTable,
  onboardTableStepsFor,
  readinessPillsForMode,
} from "@soc/core";
import type {
  CriblGroupSummary,
  CriblOptions,
  DcrRoleTarget,
  DeployMode,
  GapFieldMapping,
  GapReport,
  IntegrateSectionId,
  JobStep,
  OnboardTableOutcome,
  OperationOptions,
  SolutionRef,
  TaggedSample,
  TargetScope,
} from "@soc/core";
import type { ReactNode } from "react";
import { usePorts } from "../../ports-context";
import { NumberedSection } from "../../components/numbered-section";
import { ReadinessFooter } from "../../components/readiness-footer";
import { AzureTargetingScreen } from "../azure-targeting/azure-targeting-screen";
import type { CommitScopeOutcome } from "../azure-targeting/azure-targeting-screen";
import { formatStepLine } from "../../onboarding/step-line";
import { summaryText } from "../../onboarding/summary";
import { RecentRuns } from "../../onboarding/recent-runs";
import { SampleIntakeSection } from "../samples/sample-intake-section";
import { MatchPreviewSection } from "../match-preview/match-preview-section";
import { MappingReviewSection } from "../mapping-review/mapping-review-section";
import type { MappingReviewRenameEvent } from "../mapping-review/mapping-review-section";
import { PipelinePreviewSection } from "../pipeline-preview/pipeline-preview-section";
import { SolutionBrowser } from "../solution-browser/solution-browser";
import { RuleCoverageSection } from "../rule-coverage/rule-coverage-section";
import { RoleAssignmentSection } from "../role-assignment/role-assignment-section";
import {
  dcrResourceIdFor,
  upsertRoleTarget,
} from "../role-assignment/role-assignment-state";
import {
  INTEGRATE_DEFAULT_TABLE,
  defaultPackName,
  deployDisabledReason,
  deriveSectionInputs,
} from "./integrate-screen-state";
import { WiringSection } from "./wiring-section";

export interface IntegrateScreenProps {
  /**
   * Whether the active connection has a committed target scope (subscription
   * + resource group + workspace). The SHELL owns this fact (it derives it
   * the same way it composes JourneyFacts.scopeCommitted); the Azure
   * Resources section's own commit flips it after "Use this target".
   */
  scopeCommitted: boolean;
  /**
   * The offline (artifact) targeting branch for the embedded
   * AzureTargetingScreen. The SHELL derives it from the mode; this route
   * requires 'both', so in practice Azure is live and this is false.
   */
  offline: boolean;
  /**
   * Commit a browsed scope as the active target (the same handler the
   * standalone Azure Targeting route uses). The shell owns the profile store
   * / persistence and returns the consequence notice.
   */
  onCommitScope: (scope: TargetScope) => Promise<CommitScopeOutcome>;
  /**
   * Persisted Cribl naming/targeting defaults (Unit 4 options): the
   * worker-group default preselects when it exists in the live list, the
   * destination id composes from the prefix/suffix, and the pack name
   * prefills from the prefix.
   */
  criblDefaults?: CriblOptions;
  /**
   * Persisted deployment options (Unit 4): feeds the Azure Resources DCE
   * capability checkbox (createDCE). Absent, the contract defaults apply.
   */
  operationDefaults?: OperationOptions;
  /** Navigate to the Options screen (the frame owns navigation). */
  onOpenOptions?: () => void;
  /**
   * Shell-provided pointer to where the operator grants the Monitoring
   * Metrics Publisher role (the same cross-link the shared Onboard footer
   * takes). Absent, a shell-neutral sentence renders.
   */
  roleGuidance?: string;
  /**
   * The active integration mode (Unit 20 mode gating). Drives the readiness
   * pills a mode shows (Workspace hidden when Azure is skipped, Worker Groups
   * when Cribl is skipped) and the post-deploy source-wiring unlock. Defaults
   * to "full" so the operable native path is unchanged (in "full" the pill set
   * equals the un-gated set); this route requires both connections, so in
   * practice the shell passes "full".
   */
  mode?: DeployMode;
}

type DeployStatus = "idle" | "running" | "ok" | "failed";

export function IntegrateScreen({
  scopeCommitted,
  offline,
  onCommitScope,
  criblDefaults,
  operationDefaults,
  onOpenOptions,
  roleGuidance,
  mode = "full",
}: IntegrateScreenProps) {
  const { ports, config } = usePorts();

  // ---- Cribl Configuration section (worker group + pack name) -----------
  const [groups, setGroups] = useState<CriblGroupSummary[] | null>(null);
  const [groupsError, setGroupsError] = useState("");
  const [groupId, setGroupId] = useState("");
  const [packName, setPackName] = useState(() => defaultPackName(criblDefaults));

  // ---- Deploy section (the operable native-table onboard) ---------------
  const [table, setTable] = useState(INTEGRATE_DEFAULT_TABLE);
  const [ingestionClientId, setIngestionClientId] = useState(
    () => config.clientId,
  );
  const [ingestionClientSecret, setIngestionClientSecret] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [steps, setSteps] = useState<JobStep[]>([]);
  const [outcome, setOutcome] = useState<OnboardTableOutcome | null>(null);
  const [runError, setRunError] = useState("");
  const [deployCompleted, setDeployCompleted] = useState(false);
  const [historyToken, setHistoryToken] = useState(0);
  // The DCRs this page's deploys created, accumulated for the Azure Resources
  // ingestion-role step (Unit 8, ENG-37 runtime half). The exact deployed name
  // + scope come straight from each outcome, so the role step never has to
  // predict a name (no location guesswork). Additive: never part of any gate.
  const [roleTargets, setRoleTargets] = useState<DcrRoleTarget[]>([]);

  // ---- Solution section (Unit 14) ---------------------------------------
  // The lazy GitHub solution browser is the Solution section's content. The
  // selection is ADDITIVE and NON-GATING (like samples): it completes the
  // now-built Solution section and lights the Solution readiness pill, but it
  // never gates the native-table deploy (the MVP-transition canDeploy rule).
  const [solution, setSolution] = useState<SolutionRef | null>(null);
  const solutionSelected = solution !== null;

  // ---- Sample Data section (Unit 11) ------------------------------------
  // The section owns its own store IO and reports the tagged-sample count so
  // the arc can complete Sample Data and light the Samples pill. Samples never
  // gate the native-table deploy below (the MVP-transition rule in @soc/core
  // canDeploy), so this count is intentionally NOT part of the run gate.
  const [sampleCount, setSampleCount] = useState(0);
  // The tagged samples themselves feed the Unit 13 match preview seeded into
  // this section (sample vs destination table -> matched/overflow/unmatched)
  // and the Unit 18 DCR Gap Analysis section below.
  const [samples, setSamples] = useState<TaggedSample[]>([]);

  // ---- DCR Gap Analysis section (Unit 18) -------------------------------
  // The mapping-review approval gate reports the CONTENT-path readiness. It is
  // ADDITIVE and NON-GATING for the native deploy (like samples/solution): it
  // completes the now-built Gap Analysis section and lights the Mappings pill,
  // but never participates in canDeploy (the MVP-transition rule). A log-type
  // rename is forwarded to the section so its approvals + mapping edits re-key
  // by the same Unit 11 primitive sample intake uses.
  const [mappingsApproved, setMappingsApproved] = useState(false);
  const [renameEvent, setRenameEvent] = useState<MappingReviewRenameEvent>();
  const renameNonce = useRef(0);
  // The Gap Analysis reports feed the Rule Coverage section (Unit 23): its
  // availability set and destination tables derive from them.
  const [gapReports, setGapReports] = useState<GapReport[]>([]);
  // The reviewer's effective (edited) mappings per logType feed the Unit 17
  // pipeline preview below, so it mirrors hand edits (not just the baseline).
  const [mappingOverrides, setMappingOverrides] = useState<
    Readonly<Record<string, GapFieldMapping[]>>
  >({});

  // ---- Analytics Rule Coverage section (Unit 23) ------------------------
  // The coverage analyzer reports the schema-resolvable referenced-field set
  // (the kept Unit 18 ruleReferencedFields contract) back UP so the Gap
  // Analysis mapping table lights its RULE badges. Informational only - it
  // never participates in the deploy gate.
  const [ruleFields, setRuleFields] = useState<ReadonlySet<string>>();

  // One place the Sample Data section reports its list: keep the count (arc
  // completion / Samples pill) and the samples (match preview) in sync.
  const handleSamplesChange = useCallback((list: TaggedSample[]) => {
    setSamples(list);
    setSampleCount(list.length);
  }, []);

  // The detected format per log type (drives the pipeline preview's serde /
  // timestamp selection). Derived from the tagged samples the section reports.
  const sampleFormats = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const sample of samples) {
      map[sample.logType] = sample.format;
    }
    return map;
  }, [samples]);

  // Rename contract (Unit 11 -> Unit 18): the Sample Data section re-keys the
  // tagged-sample STORE entry itself; this handler forwards the rename to the
  // DCR Gap Analysis section so its log-type-keyed approvals and mapping edits
  // re-key by the same Unit 11 primitive (never orphaning them - the legacy
  // bug). The nonce makes a repeated from/to still fire the section's effect.
  const handleRenameLogType = useCallback(
    (from: string, to: string) => {
      ports.logger?.info("sample log type renamed", { from, to });
      renameNonce.current += 1;
      setRenameEvent({ from, to, nonce: renameNonce.current });
    },
    [ports],
  );

  // Populate the worker-group dropdown from the CriblClient port (same
  // pattern as OnboardTableScreen: raw error + retry, no silent empty list).
  // The persisted worker-group default wins the initial selection when it
  // exists in the live list; otherwise the first discovered group is used.
  const preferredGroup = criblDefaults?.workerGroup ?? "";
  const loadGroups = useCallback(async () => {
    setGroups(null);
    setGroupsError("");
    try {
      const list = await ports.cribl.listGroups();
      setGroups(list);
      const preferred = list.some((g) => g.id === preferredGroup)
        ? preferredGroup
        : (list[0]?.id ?? "");
      setGroupId((current) => (current !== "" ? current : preferred));
    } catch (err) {
      setGroupsError(String(err));
    }
  }, [ports.cribl, preferredGroup]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  // ---- Derived section states, readiness pills, deploy gate -------------
  const sectionInputs = deriveSectionInputs({
    solutionSelected,
    scopeCommitted,
    workerGroup: groupId,
    packName,
    deployCompleted,
    sampleCount,
    mappingsApproved,
  });
  const resolved = deriveSectionStatuses(sectionInputs);
  // Mode-aware pills (Unit 20): the full pill set with the skipped side's
  // prerequisite hidden. In "full" this is identical to the un-gated set, so
  // the operable native path is unchanged.
  const pills = readinessPillsForMode(sectionInputs, mode);

  // The single unlock condition, in dependency order: the arc's built
  // prerequisites first (scope -> worker group -> pack name, from the pure
  // module), then the concrete native-run fields the arc model does not
  // track (a table name and an ingestion identity).
  const runDisabledReason =
    deployDisabledReason(sectionInputs) ??
    (table.trim() === ""
      ? "Enter a native table name in the Deploy section."
      : ingestionClientId.trim() === ""
        ? "Enter an ingestion client id in the Deploy section."
        : null);
  const canRunDeploy = runDisabledReason === null;

  const runDeploy = useCallback(async () => {
    const trimmedTable = table.trim();
    const trimmedClientId = ingestionClientId.trim();
    if (
      deploying ||
      trimmedTable === "" ||
      groupId === "" ||
      trimmedClientId === ""
    ) {
      return;
    }
    setDeploying(true);
    setOutcome(null);
    setRunError("");
    // Seed every use-case step as pending so the list renders complete from
    // the first onProgress tick (the shipped honest-step-list idiom).
    const seeded: JobStep[] = onboardTableStepsFor(trimmedTable).map((name) => ({
      name,
      status: "pending",
    }));
    setSteps(seeded);
    try {
      const record = await onboardTable(ports, {
        table: trimmedTable,
        ...(criblDefaults !== undefined
          ? {
              destinationId: destinationIdFromOptions(
                trimmedTable,
                criblDefaults,
              ),
            }
          : {}),
        subscriptionId: config.subscriptionId,
        resourceGroup: config.resourceGroup,
        workspaceName: config.workspaceName,
        groupId,
        tenantId: config.tenantId,
        ingestionClientId: trimmedClientId,
        ingestionClientSecret:
          ingestionClientSecret === "" ? undefined : ingestionClientSecret,
        onProgress: (step) => {
          setSteps((prev) =>
            prev.map((s) => (s.name === step.name ? { ...step } : s)),
          );
        },
      });
      if (record.status === "succeeded") {
        const result = record.result as OnboardTableOutcome;
        setOutcome(result);
        setDeployCompleted(true);
        // Register the just-deployed DCR as an ingestion-role target. The
        // outcome carries the exact deployed name and its scope, so the role
        // step addresses it precisely without predicting a name.
        setRoleTargets((prev) =>
          upsertRoleTarget(prev, {
            dcrResourceId: dcrResourceIdFor({
              subscriptionId: result.subscriptionId,
              resourceGroup: result.resourceGroup,
              dcrName: result.dcrName,
            }),
            table: trimmedTable,
          }),
        );
      } else {
        setRunError(
          record.error ?? "onboarding failed but recorded no error text",
        );
      }
    } catch (err) {
      setRunError(String(err));
    } finally {
      // The secret is transient: never kept after the run it was typed for.
      setIngestionClientSecret("");
      setDeploying(false);
      setHistoryToken((n) => n + 1);
    }
  }, [
    table,
    ingestionClientId,
    ingestionClientSecret,
    deploying,
    groupId,
    ports,
    criblDefaults,
    config,
  ]);

  const deployStatus: DeployStatus = deploying
    ? "running"
    : outcome !== null
      ? "ok"
      : runError !== ""
        ? "failed"
        : "idle";

  const createDCE = (operationDefaults ?? DEFAULT_OPERATION_OPTIONS).createDCE;

  // ---- Section bodies (built sections only) -----------------------------

  const solutionBody = (
    <>
      <p className="panel-desc">
        Search and select a Microsoft Sentinel solution. Selecting one lazily
        fetches that solution&apos;s content from GitHub (never a bulk mirror)
        and scopes the tables, samples, and analytics rules the rest of the page
        works with. Deprecated solutions are badged with the reason. Set or check
        your GitHub token in Repositories settings.
      </p>
      <SolutionBrowser onSelect={setSolution} />
    </>
  );

  const sampleDataBody = (
    <>
      <SampleIntakeSection
        store={ports.samples}
        onSamplesChange={handleSamplesChange}
        onRenameLogType={handleRenameLogType}
        solutionName={solution?.name ?? ""}
        {...(ports.content !== undefined ? { content: ports.content } : {})}
        {...(ports.sampleSource !== undefined
          ? { sampleSource: ports.sampleSource }
          : {})}
        {...(ports.logger !== undefined ? { logger: ports.logger } : {})}
      />
      <MatchPreviewSection samples={samples} />
    </>
  );

  const gapAnalysisBody = (
    <>
      <p className="panel-desc">
        Compare each tagged sample&apos;s fields against its Sentinel
        destination table: what passes through, what the Azure DCR already
        transforms, what the Cribl pipeline must handle, and what overflows.
        Approve each table&apos;s mappings before the content-driven pack is
        built - Auto-Approve All accepts them as-is. Approvals reset when you
        re-analyze; your edits survive. This is additive: the native-table
        deploy below never waits on an approval.
      </p>
      <MappingReviewSection
        solutionName={solution?.name ?? ""}
        samples={samples}
        content={ports.content}
        ruleFields={ruleFields}
        onGateChange={setMappingsApproved}
        onReportsChange={setGapReports}
        onEffectiveMappingsChange={setMappingOverrides}
        renameEvent={renameEvent}
      />
      <div className="integrate-subsection">
        <span className="field-label">Pipeline preview</span>
        <p className="panel-desc">
          The exact conf.yml and route.yml a content-driven build would generate
          from the approved mappings above - one pipeline per log type, with the
          volume-reduction rules and their reasons. Read-only: nothing here is
          deployed until the pack is built and installed.
        </p>
        <PipelinePreviewSection
          solutionName={solution?.name ?? ""}
          packName={packName}
          reports={gapReports}
          mappingOverrides={mappingOverrides}
          sampleFormats={sampleFormats}
          approved={mappingsApproved}
        />
      </div>
    </>
  );

  const ruleCoverageBody = (
    <RuleCoverageSection
      solutionName={solution?.name ?? ""}
      reports={gapReports}
      content={ports.content}
      onRuleFieldsChange={setRuleFields}
    />
  );

  const azureResourcesBody = (
    <>
      <AzureTargetingScreen offline={offline} onCommitScope={onCommitScope} />
      <div className="discovery-result">
        <span className="field-label">Deployment capabilities</span>
        <p className="panel-desc">
          What the deploy provisions and grants. DCE mode comes from your saved
          Options; the ingestion role is granted out of band today and
          automated in a later unit.
        </p>
        <label className="integrate-check">
          <input type="checkbox" checked={createDCE} readOnly disabled />
          <span className="integrate-check-text">
            Create a Data Collection Endpoint (DCE) -{" "}
            {createDCE ? "enabled" : "disabled"} in saved Options
            {onOpenOptions !== undefined ? " (change in Options)" : ""}.
          </span>
        </label>
        <label className="integrate-check">
          <input type="checkbox" checked readOnly disabled />
          <span className="integrate-check-text">
            Provision the Data Collection Rule the Cribl destination publishes
            metrics to - always part of the deploy below.
          </span>
        </label>
        <label className="integrate-check">
          <input type="checkbox" checked readOnly disabled />
          <span className="integrate-check-text">
            Assign Monitoring Metrics Publisher to the ingestion identity -
            granted per DCR in the step below (data cannot flow to a DCR without
            it).
          </span>
        </label>
        {onOpenOptions !== undefined && (
          <div className="panel-controls">
            <button className="run-button" onClick={onOpenOptions}>
              Open Options
            </button>
          </div>
        )}
      </div>
      <RoleAssignmentSection
        targets={roleTargets}
        clientId={config.clientId}
        roleGuidance={roleGuidance}
      />
    </>
  );

  const criblConfigBody = (
    <div className="form-grid">
      <label className="field">
        <span className="field-label">Cribl worker group</span>
        {groups !== null ? (
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">Select a worker group...</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.product !== undefined ? `${g.id} (${g.product})` : g.id}
              </option>
            ))}
          </select>
        ) : groupsError === "" ? (
          <span className="field-hint">Loading worker groups...</span>
        ) : (
          <span className="field-hint">
            Could not list worker groups: {groupsError}
          </span>
        )}
        {groupsError !== "" && (
          <button className="run-button" onClick={() => void loadGroups()}>
            Retry loading groups
          </button>
        )}
        <span className="field-hint">
          The worker group that will run the pipelines. Prefilled from your
          saved Options when that group exists in the live list.
        </span>
      </label>
      <label className="field">
        <span className="field-label">Pack name</span>
        <input
          type="text"
          value={packName}
          onChange={(e) => setPackName(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field-hint">
          The pack that will be built and installed. Prefilled from the
          destination prefix in Options; editable. Pack assembly ships in Unit
          19 - the native-table deploy below creates a Cribl destination
          directly.
        </span>
      </label>
    </div>
  );

  const deployBody = (
    <>
      <p className="panel-desc">
        Deploys a Kind:Direct Data Collection Rule for the native table below
        in workspace{" "}
        {config.workspaceName === "" ? "(not set)" : config.workspaceName} and
        creates the matching Sentinel destination in worker group{" "}
        {groupId === "" ? "(none selected)" : groupId}. This is the operable
        native-table onboard; solution- and sample-driven multi-log-type deploy
        arrives with the sections above. Each step below reports its real
        outcome.
      </p>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Native table name</span>
          <input
            type="text"
            value={table}
            onChange={(e) => setTable(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">
            A native Log Analytics table (e.g. SecurityEvent, Syslog). Custom
            (_CL) tables and vendor schemas use the Onboard and DCR Automation
            screens.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Ingestion client id</span>
          <input
            type="text"
            value={ingestionClientId}
            onChange={(e) => setIngestionClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">
            The app registration the Cribl destination authenticates with when
            sending events. Defaults to the active connection&apos;s client id.
          </span>
        </label>
        <label className="field">
          <span className="field-label">
            Ingestion client secret (optional)
          </span>
          <input
            type="password"
            value={ingestionClientSecret}
            onChange={(e) => setIngestionClientSecret(e.target.value)}
            autoComplete="new-password"
          />
          <span className="field-hint">
            Transient: this platform&apos;s encrypted storage is write-only, so
            the app cannot reuse a stored secret here. Provide it to bake it
            into the destination for this run only, or leave blank to create the
            destination with the {SENTINEL_SECRET_PLACEHOLDER} placeholder and
            paste the real secret in Cribl&apos;s UI.
          </span>
        </label>
      </div>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void runDeploy()}
          disabled={!canRunDeploy || deploying}
          title={runDisabledReason ?? undefined}
        >
          Run deploy
        </button>
        <span className={`status status-${deployStatus}`}>{deployStatus}</span>
        {!canRunDeploy && runDisabledReason !== null && (
          <span className="field-hint">{runDisabledReason}</span>
        )}
      </div>
      {steps.length > 0 && (
        <pre className="result">{steps.map(formatStepLine).join("\n")}</pre>
      )}
      {runError !== "" && <pre className="result">{runError}</pre>}
      {outcome !== null && (
        <div className="discovery-result">
          <span className="field-label">Deploy summary</span>
          <pre className="result">{summaryText(outcome)}</pre>
        </div>
      )}
      <p className="panel-desc">
        What a green run proves: the DCR provisioned and the Cribl destination
        exists. It does NOT validate data flow - that requires a source
        actually sending events through the destination. Before events ingest,
        the ingestion identity needs the Monitoring Metrics Publisher role on
        the deployed DCR (see the Azure Resources section above).
      </p>
      <RecentRuns refreshToken={historyToken} />
      {canWireSource(deployCompleted, mode) && (
        <div className="integrate-subsection">
          <span className="field-label">Source wiring</span>
          <p className="panel-desc">
            The destination is live - now connect a Cribl source to it. This
            creates the Sentinel route (and an optional non-final Cribl Lake
            route above it, cloud only), commits, and deploys to the worker
            group. Each action below is independently re-runnable.
          </p>
          <WiringSection
            deployCompleted={deployCompleted}
            mode={mode}
            deploymentType={ports.criblDeploymentType}
            workerGroup={groupId}
            packName={packName}
          />
        </div>
      )}
    </>
  );

  const sectionBody = (id: IntegrateSectionId): ReactNode => {
    switch (id) {
      case "solution":
        return solutionBody;
      case "sample-data":
        return sampleDataBody;
      case "azure-resources":
        return azureResourcesBody;
      case "cribl-config":
        return criblConfigBody;
      case "gap-analysis":
        return gapAnalysisBody;
      case "rule-coverage":
        return ruleCoverageBody;
      case "deploy":
        return deployBody;
      default:
        return null;
    }
  };

  return (
    <div className="integrate-page">
      <header className="integrate-header">
        <h1 className="integrate-title">Cribl Sentinel Integration</h1>
        <p className="integrate-subtitle">
          Configure and deploy a complete Cribl-to-Sentinel integration
          pipeline.
        </p>
      </header>
      {resolved.map(({ section, status, reason }) => (
        <NumberedSection
          key={section.id}
          number={section.number}
          title={section.title}
          status={status}
          infoTip={section.infoTip}
          reason={reason}
          shippedInUnit={section.shippedInUnit}
        >
          {sectionBody(section.id)}
        </NumberedSection>
      ))}
      <ReadinessFooter
        pills={pills}
        canDeploy={canRunDeploy}
        onDeploy={() => void runDeploy()}
        deploying={deploying}
        disabledReason={runDisabledReason}
      />
    </div>
  );
}
