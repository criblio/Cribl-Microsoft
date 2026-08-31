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
  artifactsToOffer,
  emptyCapabilitySet,
  findVendorSchema,
  isStreamWorkerGroup,
  onboardBatch,
  onboardBatchStepsFor,
} from "@soc/core";
import type {
  BatchPacing,
  Capability,
  CapabilityContext,
  CapabilityFallback,
  CapabilitySet,
  CriblGroupSummary,
  CriblOptions,
  JobStep,
  OnboardBatchOutcome,
  OperationOptions,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { deriveCapabilityContext } from "../../capabilities/capability-audit-state";
import { FallbackNotice } from "../../capabilities/fallback-notice";
import {
  FALLBACK_POINTER_LABEL,
  fallbackRunPointer,
  isInlineArtifact,
} from "../../capabilities/fallback-notice-state";
import { SearchableSelect } from "../../components/searchable-select";
import { formatStepLine } from "../step-line";
import { RecentRuns } from "../recent-runs";
import {
  DEFAULT_BATCH_RUN_OVERRIDES,
  FORCED_TEMPLATE_ONLY_NOTICE,
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

/**
 * The WRITES a batch run performs, deciding which fallback artifacts it offers
 * (HON-7 / D-2, backlog section 16).
 *
 * `destination.manage` belongs here even though this screen never builds a
 * pack: the batch DOES create a Cribl destination per table, so the Cribl write
 * is genuinely one of this run's writes, and rule 2 says a blocked one gets an
 * artifact. The pack is that artifact, it is built elsewhere, and the producer
 * below points there rather than pretending otherwise.
 */
const BATCH_WRITE_CAPABILITIES: readonly Capability[] = Object.freeze([
  "dcr.write",
  "table.write",
  "destination.manage",
]);

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
  /**
   * Recorded Unit 6.5 decision: when the active mode has no live Cribl
   * connection (azure-only), the shell sets this and templateOnly is FORCED
   * on - a mode FACT the tri-state override deliberately cannot express or
   * undo. The screen keeps every affected control visible but disabled with
   * the reason (keep-list: always-visible-disabled affordances), skips the
   * worker-group discovery (there is no leader to ask), and does not accept
   * an ingestion secret (no destination is created, so none is used).
   */
  forcedTemplateOnly?: boolean;
  /**
   * What the connected identity was MEASURED to be able to do, used only to
   * decide which fallback artifacts this run offers (HON-7). Absent = an
   * unaudited set, in which every write resolves `unknown`, routes live, and
   * offers nothing - the honest answer when nothing has been measured.
   */
  capabilities?: CapabilitySet;
  /**
   * Connection facts for resolving unmeasured capabilities. Absent, they are
   * derived from the two facts this screen already holds: the active config
   * names an App registration, and `forcedTemplateOnly` IS "no reachable Cribl
   * connection" (the shell derives it from exactly that - `destination.manage`
   * unreachable). Deriving beats defaulting to reachable, which would claim a
   * Cribl connection the mode has already said does not exist.
   */
  capabilityContext?: CapabilityContext;
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
  forcedTemplateOnly = false,
  capabilities,
  capabilityContext,
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
    () => applyRunOverrides(persisted, overrides, forcedTemplateOnly),
    [persisted, overrides, forcedTemplateOnly],
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
      // Edge fleets cannot run these pipelines: Stream worker groups only.
      const list = (await ports.cribl.listGroups()).filter(isStreamWorkerGroup);
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
    // Forced templateOnly = no live Cribl connection in this mode: there is
    // no leader to list worker groups from, and the run makes no Cribl
    // calls, so discovery is skipped instead of failing noisily.
    if (!forcedTemplateOnly) {
      void loadGroups();
    }
  }, [loadGroups, forcedTemplateOnly]);

  // ---- Run state -----------------------------------------------------------
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<JobStep[]>([]);
  const [outcome, setOutcome] = useState<OnboardBatchOutcome | null>(null);
  const [outcomeTemplateOnly, setOutcomeTemplateOnly] = useState(false);
  const [recordState, setRecordState] = useState<RunState>("idle");
  const [runError, setRunError] = useState("");
  const [artifactFeedback, setArtifactFeedback] = useState("");
  // HON-7: what a taken offer said, when the answer was to POINT at another
  // screen's run rather than start this one. Its own slot, not artifactFeedback:
  // that line reports what THIS run saved, and merging the two would let a
  // pointer read as a file that exists.
  const [offerPointer, setOfferPointer] = useState("");
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

  /**
   * `forceTemplateOnly` is how the HON-7 fallback offer STARTS this run: the
   * offer is taken from a state where the operator's own overrides may leave
   * templateOnly off, and the artifact only exists if the run collects instead
   * of deploying. It forces the flag for THIS run without editing the override
   * select, so the operator's saved choice is not silently rewritten - the same
   * shape `forcedTemplateOnly` already uses for the mode fact.
   */
  const run = async (forceTemplateOnly = false) => {
    // NOT `effective`: that is memoised from the override state, so a run
    // started by the offer has to re-derive with the force applied.
    const options = forceTemplateOnly
      ? applyRunOverrides(persisted, overrides, true)
      : effective;
    setRunning(true);
    setRecordState("running");
    setOutcome(null);
    setRunError("");
    setArtifactFeedback("");
    setOfferPointer("");
    setLastArtifact(null);
    setOutcomeTemplateOnly(options.templateOnly);
    // Seed every parent step as pending so the list renders complete from
    // the first onProgress tick - shared prologue steps (fetch-workspace,
    // ensure-dce, associate-ampls) plus one table:{name} line per table.
    const seeded: JobStep[] = onboardBatchStepsFor(
      selection.specs,
      options,
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
        options,
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
        options.templateOnly &&
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

  // ---- The fallback offer (HON-7 / D-2) ----------------------------------
  // Rule 2: every blocked action falls back to a downloadable artifact. This
  // screen owns its own producer, and the two answers it can honestly give are
  // both here - it STARTS the template-only run for the ARM kinds it collects,
  // and POINTS at the run that builds the pack, which is not this one.
  //
  // ANNOTATES, NEVER REMOVES (rule 3): Run batch onboarding above is untouched.
  const context = useMemo(
    () =>
      capabilityContext ?? deriveCapabilityContext(config, !forcedTemplateOnly),
    [capabilityContext, config, forcedTemplateOnly],
  );
  const offers = useMemo(
    () =>
      artifactsToOffer(
        BATCH_WRITE_CAPABILITIES,
        capabilities ?? emptyCapabilitySet(),
        context,
      ),
    [capabilities, context],
  );

  // Whether the offered artifact is one THIS run collects. templateOnly mode
  // collects the custom-table PUT bodies and the DCR bodies (and the DCE /
  // AMPLS bodies in DCE mode) - it never assembles a Cribl pack, which is why
  // the pack kind is pointed at instead of run here.
  const producedByThisRun = (fallback: CapabilityFallback): boolean =>
    fallback.kind === "dcr-arm-bodies" || fallback.kind === "table-arm-bodies";

  // The template-only run's OWN prerequisites, which are fewer than canRun's:
  // it contacts no Cribl and creates no destination, so no worker group and no
  // ingestion client id are needed (onboardBatch's templateOnly branch reads
  // neither). Stating the reason is required - the notice never disables
  // silently.
  const offerRunDisabledReason = (): string | undefined => {
    if (running) {
      return "A batch run is already in flight.";
    }
    if (selection.errors.length > 0) {
      return "Fix the table list errors above first.";
    }
    if (selection.specs.length === 0) {
      return "List at least one table above - the artifact is per table.";
    }
    if (amplsIssue !== null) {
      return `AMPLS resource ID: ${amplsIssue}`;
    }
    return undefined;
  };

  // Take the offer: start this run for what it collects, point at the run that
  // makes the rest. Never assemble a run-kind artifact here (D-2) - only kinds
  // this screen can honestly answer for reach it, which the render below is
  // what guarantees.
  const produceFallback = (fallback: CapabilityFallback): void => {
    if (producedByThisRun(fallback)) {
      setOfferPointer("");
      void run(true);
      return;
    }
    setOfferPointer(fallbackRunPointer(fallback.kind) ?? "");
  };

  // Forced templateOnly runs make no Cribl calls, so no worker group is
  // required (there is no live leader to pick one from in this mode).
  const canRun =
    !running &&
    selection.specs.length > 0 &&
    selection.errors.length === 0 &&
    (forcedTemplateOnly || groupId !== "") &&
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
        {forcedTemplateOnly && (
          <p className="panel-desc">
            <strong>{FORCED_TEMPLATE_ONLY_NOTICE}</strong>
          </p>
        )}
        <pre className="result">
          {[
            `mode:                ${effective.createDCE ? "DCE-based DCRs (shared batch DCE, 64-char names)" : "Direct DCRs (30-char names, Cribl 4.14+)"}`,
            `skip existing DCRs:  ${effective.skipExistingDCRs ? "on" : "off"}`,
            `template only:       ${effective.templateOnly ? "on (nothing deploys; downloads one ARM deployment template)" : "off"}`,
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
          {forcedTemplateOnly ? (
            // Visible but disabled with the reason (keep-list: affordances
            // are never hidden): the force is a mode fact, not a choice.
            <label className="field">
              <span className="field-label">Template only (this run)</span>
              <select value="on" disabled>
                <option value="on">Forced on for this run</option>
              </select>
              <span className="field-hint">{FORCED_TEMPLATE_ONLY_NOTICE}</span>
            </label>
          ) : (
            <OverrideField
              label="Template only (this run)"
              hint="Collect every ARM request body as one JSON artifact instead of deploying."
              persisted={persisted.templateOnly}
              value={overrides.templateOnly}
              onChange={(v) => setOverride("templateOnly", v)}
            />
          )}
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
          {forcedTemplateOnly ? (
            <>
              <select disabled value="">
                <option value="">Not needed - template-only run</option>
              </select>
              <span className="field-hint">
                This mode has no live Cribl connection, so there is no leader
                to list worker groups from and the run creates no
                destinations.
              </span>
            </>
          ) : groups !== null ? (
            <SearchableSelect
              options={groups.map((g) => ({
                value: g.id,
                label: g.id,
                hint: g.product,
              }))}
              value={groupId}
              onChange={setGroupId}
              placeholder="Select a worker group..."
              ariaLabel="Filter worker groups"
            />
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
            disabled={forcedTemplateOnly}
          />
          <span className="field-hint">
            {forcedTemplateOnly
              ? "Not accepted in template-only runs: no destination is created, so no secret would ever be used (secrets are never collected without a purpose)."
              : `Transient, used for this run only. Left blank, destinations are created with the ${SENTINEL_SECRET_PLACEHOLDER} placeholder to fill in Cribl's UI.`}
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

      {/* HON-7 / D-2: the artifacts for the writes this connection was MEASURED
          to lack. Run batch onboarding above stays exactly as available - the
          audit informs and offers, Azure's own refusal is the gate. */}
      {offers.length > 0 && (
        <div className="discovery-result">
          <span className="field-label">Take these to someone who can</span>
          <p className="panel-desc">
            Running above stays available - this reports access, it does not
            gate the run. Each artifact below is what someone with the access
            would apply on your behalf.
          </p>
          {offers.map((offer) => (
            <FallbackNotice
              key={offer.kind}
              fallback={offer}
              // NO producer for an INLINE kind: those are generated on the spot
              // from data the app holds, this screen holds none of it, and a
              // button that did nothing would be worse than the notice naming
              // the artifact and stopping there (which is what absent means).
              // Unreachable today - nothing in BATCH_WRITE_CAPABILITIES maps to
              // an inline kind - and written as the rule so it survives one
              // being added.
              onProduce={
                isInlineArtifact(offer.kind)
                  ? undefined
                  : () => produceFallback(offer)
              }
              disabledReason={
                producedByThisRun(offer) ? offerRunDisabledReason() : undefined
              }
              // The label has to match what the click DOES: this run collects
              // the ARM bodies, so "Download..." is true for those; the pack is
              // built elsewhere, so that control says where instead (HON-7).
              produceLabel={
                producedByThisRun(offer) ? undefined : FALLBACK_POINTER_LABEL
              }
            />
          ))}
          {offerPointer !== "" && (
            <p className="panel-desc">{offerPointer}</p>
          )}
        </div>
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
