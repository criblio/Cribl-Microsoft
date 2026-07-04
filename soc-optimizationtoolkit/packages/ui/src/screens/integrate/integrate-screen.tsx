/**
 * IntegrateScreen - THE MVP CENTERPIECE: the single-page Integrate arc
 * (legacy-flow-analysis.md, structural decision ADOPTED 2026-07-04). The
 * legacy Sentinel Integration flagship was ONE scrolling page of numbered
 * sections that gate forward with an always-visible deploy readiness; this
 * screen is its successor, composing the ALREADY-SHIPPED screens as sections
 * rather than scattering them across sidebar routes.
 *
 * The seven sections render in page order from @soc/core INTEGRATE_SECTIONS.
 * Three are BUILT and operable today; four are honest coming-soon:
 *
 *   1. Sentinel Solution   - coming-soon (Unit 14)
 *   2. Sample Data         - coming-soon (Unit 11)
 *   3. Azure Resources     - BUILT: the AzureTargetingScreen cascade + the
 *      DCE / metrics / role-assignment capability checkboxes (the role
 *      checkbox is Unit 8's target - rendered honestly with an
 *      "assigns after deploy" note).
 *   4. Cribl Configuration - BUILT: worker-group select + pack name (prefilled
 *      from the saved Options destination prefix).
 *   5. DCR Gap Analysis    - coming-soon (Unit 18)
 *   6. Analytics Rule Cov. - coming-soon (Unit 23)
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

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_OPERATION_OPTIONS,
  SENTINEL_SECRET_PLACEHOLDER,
  deriveReadinessPills,
  deriveSectionStatuses,
  destinationIdFromOptions,
  onboardTable,
  onboardTableStepsFor,
} from "@soc/core";
import type {
  CriblGroupSummary,
  CriblOptions,
  IntegrateSectionId,
  JobStep,
  OnboardTableOutcome,
  OperationOptions,
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
import {
  INTEGRATE_DEFAULT_TABLE,
  defaultPackName,
  deployDisabledReason,
  deriveSectionInputs,
} from "./integrate-screen-state";

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
    scopeCommitted,
    workerGroup: groupId,
    packName,
    deployCompleted,
  });
  const resolved = deriveSectionStatuses(sectionInputs);
  const pills = deriveReadinessPills(sectionInputs);

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
        setOutcome(record.result as OnboardTableOutcome);
        setDeployCompleted(true);
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
          <input type="checkbox" checked={false} readOnly disabled />
          <span className="integrate-check-text">
            Assign Monitoring Metrics Publisher to the ingestion identity -
            assigns after deploy (automated in Unit 8). Until then,{" "}
            {roleGuidance ??
              "grant it out of band (az CLI, the portal, or a change request)."}
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
            (_CL) tables and vendor schemas use the Onboard and Batch Onboard
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
    </>
  );

  const sectionBody = (id: IntegrateSectionId): ReactNode => {
    switch (id) {
      case "azure-resources":
        return azureResourcesBody;
      case "cribl-config":
        return criblConfigBody;
      case "deploy":
        return deployBody;
      default:
        return null;
    }
  };

  return (
    <div className="integrate-page">
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
