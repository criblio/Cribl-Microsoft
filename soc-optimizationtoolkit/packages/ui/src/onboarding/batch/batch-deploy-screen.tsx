/**
 * BatchDeployScreen - porting-plan Unit 6: onboard MANY tables as ONE parent
 * job through the @soc/core onboardBatch usecase (batch deployment queue and
 * DCE/Private Link modes). Table multi-select (free-text list plus
 * add-from-vendor-schemas for bundled _CL entries), a summary of the
 * persisted Unit 4 OperationOptions with per-run overrides for
 * skipExistingDCRs/templateOnly/createDCE, live per-table step lines
 * ('skipped' renders with its distinct first-class tag), a combined summary
 * (deployed/skipped/failed counts + per-table outcomes), and templateOnly
 * runs deliver every collected ARM request body as ONE JSON artifact through
 * the ArtifactSink port.
 *
 * Pure React over the ports: ZERO direct fetch or storage access here. The
 * SHELL injects the pacing hooks (now/sleep) - the usecase's rolling-minute
 * ARM budget runs on shell-owned time, never on a clock of this package's
 * own. All non-trivial decisions live in the pure batch-state module.
 *
 * SECRET HANDLING matches OnboardTableScreen: the optional ingestion client
 * secret is TRANSIENT input for this one run and cleared afterward.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_OPERATION_OPTIONS,
  ONBOARD_BATCH_JOB_KIND,
  SENTINEL_SECRET_PLACEHOLDER,
  VENDOR_SCHEMAS,
  findVendorSchema,
  onboardBatch,
  onboardBatchStepsFor,
} from "@soc/core";
import type {
  BatchPacing,
  CriblGroupSummary,
  CriblOptions,
  JobStep,
  OnboardBatchOutcome,
  OperationOptions,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { formatStepLine } from "../step-line";
import { RecentRuns } from "../recent-runs";
import {
  DEFAULT_BATCH_RUN_OVERRIDES,
  amplsIssueFor,
  applyRunOverrides,
  batchRunDetail,
  batchRunLabel,
  batchTemplatesArtifactName,
  buildBatchSelection,
  buildTemplatesArtifact,
  formatBatchSummary,
} from "./batch-state";
import type { BatchRunOverride, BatchRunOverrides } from "./batch-state";

/** Terminal display state of the last run (batch jobs can end 'skipped'). */
type RunState = "idle" | "running" | "succeeded" | "failed" | "skipped";

const RUN_STATE_CLASS: Record<RunState, string> = {
  idle: "status-idle",
  running: "status-running",
  succeeded: "status-ok",
  failed: "status-failed",
  // No dedicated class in the shared stylesheet; neutral is honest - the
  // text says 'skipped' and the summary explains why.
  skipped: "status-idle",
};

export interface BatchDeployScreenProps {
  /**
   * Shell-injected pacing hooks for the usecase's rolling-minute ARM budget
   * (now/sleep; optionally maxRequestsPerMinute). Core never reads a clock -
   * the hosting shell owns time.
   */
  pacing: BatchPacing;
  /**
   * Persisted deployment options (porting-plan Unit 4) - the defaults this
   * screen summarizes and the per-run overrides modify. Absent, the @soc/core
   * defaults apply.
   */
  operationDefaults?: OperationOptions;
  /**
   * Persisted Cribl naming/targeting defaults (porting-plan Unit 4): the
   * worker-group dropdown preselects workerGroup when it exists in the live
   * list.
   */
  criblDefaults?: CriblOptions;
  /** Navigate to the Options screen (the frame owns navigation). */
  onOpenOptions?: () => void;
}

/** The tri-state override select, one per overridable flag. */
function OverrideField({
  label,
  hint,
  persisted,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  persisted: boolean;
  value: BatchRunOverride;
  onChange: (next: BatchRunOverride) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as BatchRunOverride)}
      >
        <option value="default">
          Use saved option ({persisted ? "on" : "off"})
        </option>
        <option value="on">On for this run</option>
        <option value="off">Off for this run</option>
      </select>
      <span className="field-hint">{hint}</span>
    </label>
  );
}

/**
 * The batch deployment screen: a table list and vendor-schema picks in, one
 * parent onboard-batch job with live step lines and an honest combined
 * summary out.
 */
export function BatchDeployScreen({
  pacing,
  operationDefaults,
  criblDefaults,
  onOpenOptions,
}: BatchDeployScreenProps) {
  const { ports, config } = usePorts();

  // ---- Table selection ---------------------------------------------------
  const [listText, setListText] = useState("");
  const [vendorPick, setVendorPick] = useState("");
  const [vendorIds, setVendorIds] = useState<string[]>([]);
  const selection = useMemo(
    () => buildBatchSelection(listText, vendorIds),
    [listText, vendorIds],
  );
  const availableVendors = VENDOR_SCHEMAS.filter(
    (entry) => !vendorIds.includes(entry.id),
  );

  // ---- Options: persisted defaults + per-run overrides --------------------
  const persisted = operationDefaults ?? DEFAULT_OPERATION_OPTIONS;
  const [overrides, setOverrides] = useState<BatchRunOverrides>(
    DEFAULT_BATCH_RUN_OVERRIDES,
  );
  const effective = useMemo(
    () => applyRunOverrides(persisted, overrides),
    [persisted, overrides],
  );
  // The Unit 6 AMPLS cross-field rule over the EFFECTIVE options: a per-run
  // createDCE override can create the private-only combination the Options
  // screen refuses to save without an AMPLS id. Blocks Run honestly instead
  // of letting the usecase fail its ensure-dce step.
  const amplsIssue = amplsIssueFor(effective);
  const setOverride = (key: keyof BatchRunOverrides, value: BatchRunOverride) =>
    setOverrides((prev) => ({ ...prev, [key]: value }));

  // ---- Cribl target and ingestion identity (OnboardTableScreen pattern) ---
  const [groups, setGroups] = useState<CriblGroupSummary[] | null>(null);
  const [groupsError, setGroupsError] = useState("");
  const [groupId, setGroupId] = useState("");
  const [ingestionClientId, setIngestionClientId] = useState(
    () => config.clientId,
  );
  const [ingestionClientSecret, setIngestionClientSecret] = useState("");

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

  // ---- Run state -----------------------------------------------------------
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<JobStep[]>([]);
  const [outcome, setOutcome] = useState<OnboardBatchOutcome | null>(null);
  const [outcomeTemplateOnly, setOutcomeTemplateOnly] = useState(false);
  const [recordState, setRecordState] = useState<RunState>("idle");
  const [runError, setRunError] = useState("");
  const [artifactFeedback, setArtifactFeedback] = useState("");
  const [lastArtifact, setLastArtifact] = useState<{
    name: string;
    json: string;
  } | null>(null);
  const [historyToken, setHistoryToken] = useState(0);

  const saveTemplatesArtifact = async (name: string, json: string) => {
    try {
      await ports.artifacts.save(name, "application/json", json);
      setArtifactFeedback(`Templates artifact saved: ${name}`);
    } catch (err) {
      setArtifactFeedback(
        `Could not save the templates artifact (${name}): ${String(err)}`,
      );
    }
  };

  const run = async () => {
    setRunning(true);
    setRecordState("running");
    setOutcome(null);
    setRunError("");
    setArtifactFeedback("");
    setLastArtifact(null);
    setOutcomeTemplateOnly(effective.templateOnly);
    // Seed every parent step as pending so the list renders complete from
    // the first onProgress tick - shared prologue steps (fetch-workspace,
    // ensure-dce, associate-ampls) plus one table:{name} line per table.
    const seeded: JobStep[] = onboardBatchStepsFor(
      selection.specs,
      effective,
    ).map((name) => ({ name, status: "pending" }));
    setSteps(seeded);
    try {
      const record = await onboardBatch(ports, {
        tables: selection.specs,
        subscriptionId: config.subscriptionId,
        resourceGroup: config.resourceGroup,
        workspaceName: config.workspaceName,
        groupId,
        tenantId: config.tenantId,
        ingestionClientId: ingestionClientId.trim(),
        ingestionClientSecret:
          ingestionClientSecret === "" ? undefined : ingestionClientSecret,
        options: effective,
        pacing,
        onProgress: (step) => {
          setSteps((prev) =>
            prev.map((s) => (s.name === step.name ? { ...step } : s)),
          );
        },
      });
      // onboardBatch never rejects for step/table failures - the parent
      // record carries the outcome (partial results included) either way.
      const result = (record.result ?? null) as OnboardBatchOutcome | null;
      setOutcome(result);
      const state: RunState =
        record.status === "succeeded"
          ? "succeeded"
          : record.status === "skipped"
            ? "skipped"
            : "failed";
      setRecordState(state);
      if (record.status === "failed") {
        setRunError(
          record.error ?? "the batch failed but recorded no error text",
        );
      }
      if (
        effective.templateOnly &&
        result !== null &&
        result.templates.length > 0
      ) {
        const name = batchTemplatesArtifactName(
          config.workspaceName,
          record.id,
        );
        const json = buildTemplatesArtifact(result.templates);
        setLastArtifact({ name, json });
        await saveTemplatesArtifact(name, json);
      }
    } catch (err) {
      // Reaching here means the JobStore itself (or the ports wiring / the
      // pacing budget input) failed - step failures never reject.
      setRecordState("failed");
      setRunError(String(err));
    } finally {
      // The secret is transient: never kept around after the run it was
      // typed for (write-only storage means it could never be re-read).
      setIngestionClientSecret("");
      setRunning(false);
      setHistoryToken((n) => n + 1);
    }
  };

  const canRun =
    !running &&
    selection.specs.length > 0 &&
    selection.errors.length === 0 &&
    groupId !== "" &&
    ingestionClientId.trim() !== "" &&
    amplsIssue === null;

  return (
    <section className="panel">
      <h2 className="panel-title">Batch onboarding</h2>
      <p className="panel-desc">
        Deploys DCRs for MANY Log Analytics tables as one job against
        workspace {config.workspaceName} (resource group {config.resourceGroup}
        ): one parent run with shared prologue steps - in DCE mode one Data
        Collection Endpoint is created or reused for the WHOLE batch (and
        associated with the AMPLS when public network access is disabled) -
        plus one step per table. One table failing never stops the others;
        tables already deployed, or downstream of a failed prerequisite, are
        skipped and say so. Re-running a completed batch is a no-op.
      </p>

      <div className="form-grid">
        <label className="field">
          <span className="field-label">Tables (one per line or comma-separated)</span>
          <textarea
            value={listText}
            onChange={(e) => setListText(e.target.value)}
            rows={5}
            placeholder={"SecurityEvent\nSyslog\nCommonSecurityLog"}
            spellCheck={false}
          />
          <span className="field-hint">
            Native names deploy directly. A _CL name listed here without a
            vendor schema requires the custom table to already exist in the
            workspace (its live schema wins).
          </span>
        </label>
        <label className="field">
          <span className="field-label">Add a bundled vendor schema table</span>
          <select
            value={vendorPick}
            onChange={(e) => setVendorPick(e.target.value)}
          >
            <option value="">Select a vendor schema...</option>
            {availableVendors.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label} ({entry.table})
              </option>
            ))}
          </select>
          <button
            className="run-button"
            disabled={vendorPick === ""}
            onClick={() => {
              if (vendorPick !== "") {
                setVendorIds((prev) => [...prev, vendorPick]);
                setVendorPick("");
              }
            }}
          >
            Add table with schema
          </button>
          <span className="field-hint">
            Adds the vendor&apos;s _CL table with its bundled schema, so a
            missing table is created as part of the batch (no fetch - the
            schemas ship with the app).
          </span>
        </label>
      </div>
      {vendorIds.length > 0 && (
        <div className="panel-controls">
          {vendorIds.map((id) => {
            const entry = findVendorSchema(id);
            return (
              <button
                key={id}
                className="run-button"
                title="Remove from the batch"
                onClick={() =>
                  setVendorIds((prev) => prev.filter((v) => v !== id))
                }
              >
                {entry !== undefined ? entry.table : id} (remove)
              </button>
            );
          })}
        </div>
      )}
      {selection.duplicates.length > 0 && (
        <p className="field-hint">
          Merged duplicate entries (typed and picked):{" "}
          {selection.duplicates.join(", ")} - the vendor schema applies.
        </p>
      )}
      {selection.errors.map((error) => (
        <p key={error} className="config-editor-error">
          {error}
        </p>
      ))}

      <div className="discovery-result">
        <span className="field-label">
          Deployment options ({selection.specs.length} table(s) selected)
        </span>
        <p className="panel-desc">
          Defaults come from the Options screen
          {onOpenOptions !== undefined ? (
            <>
              {" "}
              (
              <button className="run-button" onClick={onOpenOptions}>
                open Options
              </button>
              )
            </>
          ) : null}
          . The three flags below can be overridden for this run only; the
          saved options are not changed.
        </p>
        <pre className="result">
          {[
            `mode:                ${effective.createDCE ? "DCE-based DCRs (shared batch DCE, 64-char names)" : "Direct DCRs (30-char names, Cribl 4.14+)"}`,
            `skip existing DCRs:  ${effective.skipExistingDCRs ? "on" : "off"}`,
            `template only:       ${effective.templateOnly ? "on (nothing deploys; ARM bodies download as one artifact)" : "off"}`,
            `deployment timeout:  ${persisted.deploymentTimeoutSeconds}s`,
            `custom retention:    ${persisted.customTableRetentionDays} days`,
            `DCE public access:   ${persisted.dcePublicNetworkAccess ? "enabled" : "disabled (AMPLS required)"}`,
            `AMPLS resource id:   ${persisted.amplsResourceId === "" ? "(none)" : persisted.amplsResourceId}`,
          ].join("\n")}
        </pre>
        <div className="form-grid">
          <OverrideField
            label="Create DCE (this run)"
            hint="DCE-based DCRs routed through one shared batch DCE vs Direct DCRs."
            persisted={persisted.createDCE}
            value={overrides.createDCE}
            onChange={(v) => setOverride("createDCE", v)}
          />
          <OverrideField
            label="Skip existing DCRs (this run)"
            hint="A same-named DCR marks the table skipped with zero deploy calls."
            persisted={persisted.skipExistingDCRs}
            value={overrides.skipExistingDCRs}
            onChange={(v) => setOverride("skipExistingDCRs", v)}
          />
          <OverrideField
            label="Template only (this run)"
            hint="Collect every ARM request body as one JSON artifact instead of deploying."
            persisted={persisted.templateOnly}
            value={overrides.templateOnly}
            onChange={(v) => setOverride("templateOnly", v)}
          />
        </div>
        {amplsIssue !== null && (
          <p className="config-editor-error">
            AMPLS resource ID: {amplsIssue} Set it on the Options screen, or
            keep Create DCE off for this run.
          </p>
        )}
      </div>

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
            The app registration every created destination authenticates with.
            Defaults to the active connection&apos;s client id.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Ingestion client secret (optional)</span>
          <input
            type="password"
            value={ingestionClientSecret}
            onChange={(e) => setIngestionClientSecret(e.target.value)}
            autoComplete="new-password"
          />
          <span className="field-hint">
            Transient, used for this run only. Left blank, destinations are
            created with the {SENTINEL_SECRET_PLACEHOLDER} placeholder to fill
            in Cribl&apos;s UI.
          </span>
        </label>
      </div>

      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void run()}
          disabled={!canRun}
        >
          Run batch onboarding
        </button>
        <span className={`status ${RUN_STATE_CLASS[recordState]}`}>
          {recordState}
        </span>
      </div>

      {steps.length > 0 && (
        <pre className="result">{steps.map(formatStepLine).join("\n")}</pre>
      )}
      {runError !== "" && <pre className="result">{runError}</pre>}
      {outcome !== null && (
        <div className="discovery-result">
          <span className="field-label">Batch summary</span>
          <pre className="result">
            {formatBatchSummary(outcome, outcomeTemplateOnly)}
          </pre>
        </div>
      )}
      {lastArtifact !== null && (
        <div className="panel-controls">
          <button
            className="run-button"
            onClick={() =>
              void saveTemplatesArtifact(lastArtifact.name, lastArtifact.json)
            }
          >
            Download templates again ({lastArtifact.name})
          </button>
        </div>
      )}
      {artifactFeedback !== "" && (
        <p className="panel-desc">{artifactFeedback}</p>
      )}

      <p className="panel-desc">
        ARM traffic is paced to the shared request budget (the shell injects
        the clock); per-table progress persists after every table, so an
        interrupted run resumes by skipping what already completed. A green
        run proves DCRs provisioned and Cribl destinations exist - it does not
        validate data flow.
      </p>
      <RecentRuns
        refreshToken={historyToken}
        kind={ONBOARD_BATCH_JOB_KIND}
        title="Recent batch runs (persisted job records - the app's run log)"
        label={batchRunLabel}
        detail={batchRunDetail}
      />
    </section>
  );
}
