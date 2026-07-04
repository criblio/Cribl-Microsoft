/**
 * OnboardTableScreen - the first shared @soc/ui screen: onboard one NATIVE
 * Log Analytics table end to end by driving the @soc/core onboardTable
 * use-case through the ports in PortsContext. Pure React over the ports:
 * ZERO direct fetch or storage access in this module.
 *
 * Class names (panel, panel-title, field, run-button, result, ...) follow
 * the hosting shell's existing conventions; the shell's stylesheet is
 * assumed to define them.
 *
 * SECRET HANDLING: the optional ingestion client secret is TRANSIENT. The
 * platform's encrypted storage is write-only, so the app can never read a
 * stored secret back to reuse it here. The value is passed straight into
 * the use-case for this one run and cleared afterward; left blank, the
 * destination ships the "<replace me>" placeholder to fill in Cribl's UI.
 */

import { useCallback, useEffect, useState } from "react";
import {
  destinationIdFromOptions,
  onboardTable,
  ONBOARD_TABLE_STEPS,
  SENTINEL_SECRET_PLACEHOLDER,
} from "@soc/core";
import type {
  CriblGroupSummary,
  CriblOptions,
  JobStep,
  OnboardTableOutcome,
} from "@soc/core";
import { usePorts } from "../ports-context";
import { formatStepLine } from "./step-line";
import { RecentRuns } from "./recent-runs";
import { summaryText } from "./summary";

type RunStatus = "idle" | "running" | "ok" | "failed";

export interface OnboardTableScreenProps {
  /**
   * Persisted Cribl naming/targeting defaults (porting-plan Unit 4). When
   * provided, the destination id is composed from its prefix/suffix and the
   * worker-group dropdown preselects its workerGroup when that group exists
   * in the live list. Absent, legacy defaults apply unchanged.
   */
  criblDefaults?: CriblOptions;
}

/**
 * The walking-skeleton onboarding screen: table name + worker group +
 * ingestion identity in, a live step list and an honest summary out.
 */
export function OnboardTableScreen({ criblDefaults }: OnboardTableScreenProps = {}) {
  const { ports, config } = usePorts();

  const [table, setTable] = useState("SecurityEvent");
  const [groups, setGroups] = useState<CriblGroupSummary[] | null>(null);
  const [groupsError, setGroupsError] = useState("");
  const [groupId, setGroupId] = useState("");
  // Defaults to the ACTIVE connection's client id; the shell remounts this
  // screen when the active connection changes, re-reading the default.
  const [ingestionClientId, setIngestionClientId] = useState(
    () => config.clientId,
  );
  const [ingestionClientSecret, setIngestionClientSecret] = useState("");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<JobStep[]>([]);
  const [outcome, setOutcome] = useState<OnboardTableOutcome | null>(null);
  const [runError, setRunError] = useState("");
  // Bumped after every run (success or failure) so the persisted-run history
  // below reloads and shows the record that was just written.
  const [historyToken, setHistoryToken] = useState(0);

  // Populate the worker-group dropdown from the CriblClient port. On failure
  // the raw error is shown with a retry button - no silent empty dropdown.
  // The persisted worker-group default (Unit 4 options) wins the initial
  // selection when that group actually exists in the live list; otherwise
  // the first discovered group is preselected as before.
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

  const run = async () => {
    setRunning(true);
    setOutcome(null);
    setRunError("");
    // Seed every use-case step as pending so the list renders complete from
    // the first onProgress tick.
    const seeded: JobStep[] = ONBOARD_TABLE_STEPS.map((name) => ({
      name,
      status: "pending",
    }));
    setSteps(seeded);
    try {
      const record = await onboardTable(ports, {
        table: table.trim(),
        // The persisted destination prefix/suffix (Unit 4 options) compose
        // the destination id; without options the use-case's legacy default
        // ("MS-Sentinel-{table}-dest") applies.
        ...(criblDefaults !== undefined
          ? {
              destinationId: destinationIdFromOptions(
                table.trim(),
                criblDefaults,
              ),
            }
          : {}),
        subscriptionId: config.subscriptionId,
        resourceGroup: config.resourceGroup,
        workspaceName: config.workspaceName,
        groupId,
        tenantId: config.tenantId,
        ingestionClientId: ingestionClientId.trim(),
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
      } else {
        setRunError(
          record.error ?? "onboarding failed but recorded no error text",
        );
      }
    } catch (err) {
      // onboardTable absorbs step failures into the job record; reaching
      // here means the JobStore itself (or the ports wiring) failed.
      setRunError(String(err));
    } finally {
      // The secret is transient: never kept around after the run it was
      // typed for (write-only storage means it could never be re-read).
      setIngestionClientSecret("");
      setRunning(false);
      setHistoryToken((n) => n + 1);
    }
  };

  const status: RunStatus = running
    ? "running"
    : outcome !== null
      ? "ok"
      : runError !== ""
        ? "failed"
        : "idle";

  const canRun =
    !running &&
    table.trim() !== "" &&
    groupId !== "" &&
    ingestionClientId.trim() !== "";

  return (
    <section className="panel">
      <h2 className="panel-title">Onboard a native table (walking skeleton)</h2>
      <p className="panel-desc">
        Deploys a Kind:Direct Data Collection Rule for one native Log
        Analytics table in workspace {config.workspaceName} (resource group{" "}
        {config.resourceGroup}), then creates the matching Sentinel
        destination in the selected Cribl worker group and commits and
        deploys the group config. Every step below reports its real outcome.
      </p>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Table name</span>
          <input
            type="text"
            value={table}
            onChange={(e) => setTable(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">
            Native tables only (e.g. SecurityEvent, Syslog). Custom _CL tables
            are refused by this walking skeleton.
          </span>
        </label>
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
            The app registration the Cribl destination authenticates with when
            sending events. Defaults to the active connection&apos;s client id.
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
            Transient: this platform&apos;s encrypted storage is write-only, so
            the app cannot reuse a stored secret here. Provide it to bake it
            into the destination for this run only, or leave blank to create
            the destination with the {SENTINEL_SECRET_PLACEHOLDER} placeholder
            and paste the real secret in Cribl&apos;s UI.
          </span>
        </label>
      </div>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void run()}
          disabled={!canRun}
        >
          Run onboarding
        </button>
        <span className={`status status-${status}`}>{status}</span>
      </div>
      {steps.length > 0 && (
        <pre className="result">{steps.map(formatStepLine).join("\n")}</pre>
      )}
      {runError !== "" && <pre className="result">{runError}</pre>}
      {outcome !== null && (
        <div className="discovery-result">
          <span className="field-label">Onboarding summary</span>
          <pre className="result">{summaryText(outcome)}</pre>
        </div>
      )}
      <p className="panel-desc">
        What a green run proves: the DCR provisioned and the Cribl destination
        exists. It does NOT validate data flow - that requires a source
        actually sending events through the destination, which is a later
        phase.
      </p>
      <p className="panel-desc">
        Before events will ingest, the ingestion service principal (the client
        id above) needs the Monitoring Metrics Publisher role on the deployed
        DCR. Phase 2 automates that assignment; until then, grant it following
        the role guidance in panel 4 (Select resources and grant permissions)
        of the Spike Harness view.
      </p>
      <RecentRuns refreshToken={historyToken} />
    </section>
  );
}
