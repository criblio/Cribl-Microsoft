/**
 * OnboardTableScreen - the first shared @soc/ui screen: onboard one Log
 * Analytics table end to end by driving the @soc/core onboardTable use-case
 * through the ports in PortsContext. Native tables run the walking-skeleton
 * flow unchanged; a table name ending in _CL contextually reveals the
 * custom-table section (porting-plan Unit 5): schema source picker (bundled
 * vendor library, uploaded/pasted file, or the existing workspace table),
 * a column preview mapped through the characterized @soc/core contracts,
 * and a per-run retention choice seeded from the persisted Unit 4 default.
 * Pure React over the ports: ZERO direct fetch or storage access in this
 * module (the file input reads a user-picked File via the browser File API,
 * which is user input, not app IO).
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

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  destinationIdFromOptions,
  isCustomTableName,
  onboardTable,
  onboardTableStepsFor,
  DEFAULT_CUSTOM_TABLE_TOTAL_RETENTION_DAYS,
  DEFAULT_OPERATION_OPTIONS,
  SENTINEL_SECRET_PLACEHOLDER,
  VENDOR_SCHEMAS,
} from "@soc/core";
import type {
  CriblGroupSummary,
  CriblOptions,
  JobStep,
  OnboardTableOutcome,
  OperationOptions,
} from "@soc/core";
import { usePorts } from "../ports-context";
import { formatStepLine } from "./step-line";
import { RecentRuns } from "./recent-runs";
import { summaryText } from "./summary";
import {
  CUSTOM_SCHEMA_SOURCE_OPTIONS,
  defaultVendorIdForTable,
  deriveCustomSchemaPreview,
  formatSchemaPreview,
  resolveRetentionDays,
  RETENTION_CHOICES,
} from "./custom-schema-state";
import type { CustomSchemaSource } from "./custom-schema-state";

type RunStatus = "idle" | "running" | "ok" | "failed";

export interface OnboardTableScreenProps {
  /**
   * Persisted Cribl naming/targeting defaults (porting-plan Unit 4). When
   * provided, the destination id is composed from its prefix/suffix and the
   * worker-group dropdown preselects its workerGroup when that group exists
   * in the live list. Absent, legacy defaults apply unchanged.
   */
  criblDefaults?: CriblOptions;
  /**
   * Persisted deployment options (porting-plan Unit 4). Currently feeds the
   * custom (_CL) section's retention default (customTableRetentionDays,
   * overridable per run). Absent, the 30-day contract default applies.
   */
  operationDefaults?: OperationOptions;
  /**
   * Shell-provided pointer to where the operator grants the Monitoring
   * Metrics Publisher role (ux-flow-plan 4.4 cross-link fix): shared screens
   * never name shell-specific UI in prose, so each shell states its own
   * surface here - the cloud shell points at its Diagnostics view, the local
   * shell at its change-request path. Absent, a shell-neutral sentence
   * renders.
   */
  roleGuidance?: string;
}

/**
 * The onboarding screen: table name + worker group + ingestion identity in,
 * a live step list and an honest summary out. A _CL table name reveals the
 * custom-table schema section; native names keep the walking-skeleton flow.
 */
export function OnboardTableScreen({
  criblDefaults,
  operationDefaults,
  roleGuidance,
}: OnboardTableScreenProps = {}) {
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

  // Custom (_CL) section state (porting-plan Unit 5). All decisions live in
  // the pure custom-schema-state module; this component only holds the raw
  // control values. The section renders ONLY for _CL names - the native flow
  // is visually unchanged.
  const isCustom = isCustomTableName(table.trim());
  const [schemaSource, setSchemaSource] = useState<CustomSchemaSource>("vendor");
  // "" = no explicit pick: follow the typed table name (a matching bundled
  // schema preselects itself); an explicit pick sticks.
  const [vendorId, setVendorId] = useState("");
  const [schemaFileText, setSchemaFileText] = useState("");
  const [schemaFileName, setSchemaFileName] = useState("");
  // "" = no per-run override: the persisted Unit 4 default applies (and an
  // options blob that loads after mount still takes effect).
  const [retentionOverride, setRetentionOverride] = useState("");

  const persistedRetentionDefault =
    operationDefaults?.customTableRetentionDays ??
    DEFAULT_OPERATION_OPTIONS.customTableRetentionDays;
  const retentionDays = resolveRetentionDays(
    retentionOverride,
    persistedRetentionDefault,
  );
  const effectiveVendorId =
    vendorId !== "" ? vendorId : defaultVendorIdForTable(table);
  const schemaPreview = useMemo(
    () =>
      deriveCustomSchemaPreview({
        table,
        source: schemaSource,
        vendorId: effectiveVendorId,
        fileText: schemaFileText,
      }),
    [table, schemaSource, effectiveVendorId, schemaFileText],
  );

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
    // the first onProgress tick. The step list depends on the table: custom
    // (_CL) jobs carry the create-custom-table step, native jobs do not.
    const seeded: JobStep[] = onboardTableStepsFor(table.trim()).map((name) => ({
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
        // Custom (_CL) jobs carry the resolved schema (when a source
        // provides one - "use existing table" deliberately sends none) and
        // the per-run retention choice; native jobs carry neither, keeping
        // their input record byte-identical to the walking skeleton.
        ...(isCustom
          ? {
              ...(schemaPreview.providesSchema
                ? { customSchema: schemaPreview.columns }
                : {}),
              customTableRetentionDays: retentionDays,
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
    ingestionClientId.trim() !== "" &&
    (!isCustom || schemaPreview.ready);

  return (
    <section className="panel">
      <h2 className="panel-title">Onboard a table</h2>
      <p className="panel-desc">
        Deploys a Kind:Direct Data Collection Rule for one Log Analytics
        table in workspace {config.workspaceName} (resource group{" "}
        {config.resourceGroup}), then creates the matching Sentinel
        destination in the selected Cribl worker group and commits and
        deploys the group config. Custom (_CL) tables are created first when
        missing - one pipelined job. Every step below reports its real
        outcome.
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
            Native tables (e.g. SecurityEvent, Syslog) onboard directly. A
            name ending in _CL onboards a custom table - the custom table
            schema section appears below.
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
      {isCustom && (
        <div className="discovery-result">
          <span className="field-label">Custom table schema</span>
          <p className="panel-desc">
            The job checks whether {table.trim()} already exists in the
            workspace. An existing table keeps its live Azure schema; a
            missing table is created from the schema selected here
            (TimeGenerated is added automatically when absent, and
            Azure-managed columns are removed from the creation payload).
          </p>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Schema source</span>
              <select
                value={schemaSource}
                onChange={(e) =>
                  setSchemaSource(e.target.value as CustomSchemaSource)
                }
              >
                {CUSTOM_SCHEMA_SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Bundled vendor schemas ship with the app (no fetch). Choose
                &quot;Use the existing workspace table&quot; when the table
                was already created - the run then fails honestly if it does
                not exist.
              </span>
            </label>
            {schemaSource === "vendor" && (
              <label className="field">
                <span className="field-label">Vendor schema</span>
                <select
                  value={effectiveVendorId}
                  onChange={(e) => setVendorId(e.target.value)}
                >
                  <option value="">Select a vendor schema...</option>
                  {VENDOR_SCHEMAS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label} ({entry.table})
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  A schema matching the typed table name preselects itself.
                </span>
              </label>
            )}
            {schemaSource === "file" && (
              <label className="field">
                <span className="field-label">Schema JSON file</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file === undefined) {
                      return;
                    }
                    setSchemaFileName(file.name);
                    void file.text().then(setSchemaFileText);
                  }}
                />
                <textarea
                  value={schemaFileText}
                  onChange={(e) => {
                    setSchemaFileText(e.target.value);
                    setSchemaFileName("");
                  }}
                  rows={6}
                  placeholder='Or paste the schema JSON here, e.g. {"columns": [{"name": "EventName", "type": "string"}]}'
                  spellCheck={false}
                />
                <span className="field-hint">
                  Accepts a bare {"{"}columns{"}"} schema file, a Sentinel
                  table definition (properties.schema.columns), or a table
                  definition wrapper
                  (properties.schema.tableDefinition.columns).
                  {schemaFileName !== "" && ` Loaded from ${schemaFileName}.`}
                </span>
              </label>
            )}
            <label className="field">
              <span className="field-label">Interactive retention</span>
              <select
                value={String(retentionDays)}
                onChange={(e) => setRetentionOverride(e.target.value)}
              >
                {RETENTION_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Applies only when the table is created by this run. Default (
                {persistedRetentionDefault} days) comes from the Options
                screen; total retention is always{" "}
                {DEFAULT_CUSTOM_TABLE_TOTAL_RETENTION_DAYS} days.
              </span>
            </label>
          </div>
          {schemaPreview.notReadyHint !== null && (
            <p className="field-hint">{schemaPreview.notReadyHint}</p>
          )}
          {schemaPreview.errors.map((error) => (
            <p key={error} className="config-editor-error">
              {error}
            </p>
          ))}
          {schemaPreview.warnings.map((warning) => (
            <p key={warning} className="config-editor-warning">
              {warning}
            </p>
          ))}
          {schemaPreview.rows.length > 0 && (
            <>
              <span className="field-label">
                Column preview ({schemaPreview.rows.length} columns)
              </span>
              <pre className="result">
                {formatSchemaPreview(schemaPreview.rows)}
              </pre>
            </>
          )}
        </div>
      )}
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
        DCR. A later unit automates that assignment; until then,{" "}
        {roleGuidance ??
          "grant it out of band (az CLI, the portal, or a change request to the team holding RBAC rights)."}
      </p>
      <RecentRuns refreshToken={historyToken} />
    </section>
  );
}
