/**
 * LabsScreen - roadmap Phase 5 (LAB-01/02/03/04/05/13/14): provision
 * disposable Azure lab environments from the app. Ships the full PLANNING
 * surface (the 8 UnifiedLab profiles, public/private mode, the two
 * resource-group permission modes, validation, planned resource names,
 * phases, permissions, plan download) and DEPLOYS phases 1-3 live: the lab
 * resource group with the MANDATORY TTL self-destruct watchdog, the storage
 * phase (account, pattern containers, notification queue, Event Grid blob
 * wiring), and the networking phase (NSGs + VNet). The remaining phases
 * (monitoring, analytics, flow logs, compute, DCRs, Cribl wiring, VPN
 * gateway) land as sibling steps in subsequent slices per the roadmap.
 *
 * All lab knowledge is @soc/core (domain/labs + the provisionLab usecase);
 * decisions live in the pure labs-state module; this component only renders
 * and drives IO through the ports (ZERO direct fetch here).
 */

import { useCallback, useMemo, useState } from "react";
import {
  LAB_PROFILES,
  provisionLab,
  type JobStep,
  type LabResourceGroupMode,
  type LabType,
  type ProvisionLabResult,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import {
  canDeployFoundation,
  defaultLabFormState,
  formatLabPhaseLine,
  initialLabSteps,
  labPlanArtifact,
  labPlanFromForm,
  labResourceNameRows,
  labRunResultLines,
  ttlExpiryPreview,
  type LabFormState,
} from "./labs-state";

export function LabsScreen() {
  const { ports, config } = usePorts();

  const [form, setForm] = useState<LabFormState>(defaultLabFormState);
  const [deploying, setDeploying] = useState(false);
  const [steps, setSteps] = useState<JobStep[]>([]);
  const [result, setResult] = useState<ProvisionLabResult | null>(null);
  const [deployError, setDeployError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");

  const set = useCallback(
    <K extends keyof LabFormState>(key: K, value: LabFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const plan = useMemo(
    () => labPlanFromForm(form, config.subscriptionId),
    [form, config.subscriptionId],
  );
  const profile = LAB_PROFILES.find((p) => p.id === form.labType);
  const nameRows = useMemo(
    () => labResourceNameRows(plan.names, plan.flags),
    [plan],
  );
  const hasMinter = ports.mintAssignmentName !== undefined;
  const gate = canDeployFoundation(plan, hasMinter);

  // The expiry preview needs a wall clock; minted HERE (the impure component
  // layer - core and labs-state stay clock-free).
  const expiryPreview = ttlExpiryPreview(form, new Date().toISOString());

  const downloadPlan = useCallback(async () => {
    setSaveNotice("");
    const artifact = labPlanArtifact(plan);
    try {
      await ports.artifacts.save(artifact.filename, "application/json", artifact.json);
      setSaveNotice(`Saved ${artifact.filename} through the artifact sink.`);
    } catch (err) {
      setSaveNotice(
        `Could not save: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [plan, ports.artifacts]);

  const deployLab = useCallback(async () => {
    if (deploying || !gate.ok || ports.mintAssignmentName === undefined) {
      return;
    }
    setDeploying(true);
    setDeployError("");
    setResult(null);
    setSteps(initialLabSteps(plan.flags));
    try {
      const outcome = await provisionLab(
        { azure: ports.azure, jobs: ports.jobs, logger: ports.logger },
        {
          subscriptionId: config.subscriptionId,
          resourceGroupName: plan.resourceGroupName,
          location: form.location.trim(),
          baseObjectName: form.baseObjectName.trim(),
          rgMode: form.rgMode,
          ttl: {
            hours: Number(form.ttlHours),
            warningHours: Number(form.ttlWarningHours),
            userEmail: form.ttlEmail.trim(),
          },
          flags: plan.flags,
          names: plan.names,
          nowIso: new Date().toISOString(),
          mintAssignmentName: ports.mintAssignmentName,
          // The legacy 4-char random collision suffix; randomness lives in
          // the impure component layer, never in core.
          mintStorageSuffix: () => Math.random().toString(36).slice(2, 6),
          retry: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
          onProgress: (step) => {
            setSteps((prev) =>
              prev.map((s) => (s.name === step.name ? step : s)),
            );
          },
        },
      );
      setResult(outcome);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeploying(false);
    }
  }, [deploying, gate.ok, ports, config.subscriptionId, plan, form]);

  return (
    <>
      <div className="panel">
        <h2 className="panel-title">1. Lab profile</h2>
        <p className="panel-desc">
          Eight profiles consolidated from the legacy UnifiedLab. Public mode
          uses internet-reachable endpoints; private mode adds Private Link,
          private endpoints, and the networking to reach them.
        </p>
        <label className="field">
          <span className="field-label">Profile</span>
          <select
            value={form.labType}
            onChange={(e) => set("labType", e.target.value as LabType)}
          >
            {LAB_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {profile !== undefined && (
            <span className="field-hint">{profile.description}</span>
          )}
        </label>
        <label className="integrate-check">
          <input
            type="radio"
            name="lab-mode"
            checked={form.labMode === "public"}
            onChange={() => set("labMode", "public")}
          />
          <span className="integrate-check-text">Public lab</span>
        </label>
        <label className="integrate-check">
          <input
            type="radio"
            name="lab-mode"
            checked={form.labMode === "private"}
            onChange={() => set("labMode", "private")}
          />
          <span className="integrate-check-text">
            Private lab (Private Link; requires DNS reachability from your
            network)
          </span>
        </label>
        <span className="field-label">Deployment phases this profile runs</span>
        {plan.phases.map((phase) => (
          <p className="field-hint" key={phase.number}>
            {formatLabPhaseLine(phase)}
          </p>
        ))}
      </div>

      <div className="panel">
        <h2 className="panel-title">2. Target, naming, and TTL</h2>
        <p className="panel-desc">
          Every app-provisioned lab carries a mandatory TTL self-destruct: an
          hourly watchdog Logic App deletes the whole resource group once the
          TTL expires, so a forgotten lab cannot run up cost.
        </p>
        <label className="integrate-check">
          <input
            type="radio"
            name="rg-mode"
            checked={form.rgMode === "create-new"}
            onChange={() => set("rgMode", "create-new" as LabResourceGroupMode)}
          />
          <span className="integrate-check-text">
            Create a new resource group (needs subscription Contributor plus a
            constrained RBAC Administrator grant)
          </span>
        </label>
        <label className="integrate-check">
          <input
            type="radio"
            name="rg-mode"
            checked={form.rgMode === "bring-your-own"}
            onChange={() => set("rgMode", "bring-your-own" as LabResourceGroupMode)}
          />
          <span className="integrate-check-text">
            Use an admin-pre-created resource group (least privilege: only
            Contributor on that group)
          </span>
        </label>
        {form.rgMode === "create-new" ? (
          <label className="field">
            <span className="field-label">Resource group prefix</span>
            <input
              type="text"
              value={form.resourceGroupPrefix}
              onChange={(e) => set("resourceGroupPrefix", e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="field-hint">
              The profile suffix is appended: {plan.resourceGroupName}
            </span>
          </label>
        ) : (
          <label className="field">
            <span className="field-label">Existing resource group</span>
            <input
              type="text"
              value={form.existingResourceGroupName}
              onChange={(e) => set("existingResourceGroupName", e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="field-hint">
              Must already exist; the deploy fails honestly instead of creating
              it.
            </span>
          </label>
        )}
        <label className="field">
          <span className="field-label">Location</span>
          <input
            type="text"
            value={form.location}
            onChange={(e) => set("location", e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">
            Azure region, e.g. eastus, westus2. Resource names carry it as a
            suffix.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Base object name</span>
          <input
            type="text"
            value={form.baseObjectName}
            onChange={(e) => set("baseObjectName", e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">
            Names every resource: vnet-{"{name}"}-{"{location}"}, sa{"{name}"}
            cribl, la-ttl-cleanup-{"{name}"}...
          </span>
        </label>
        <label className="field">
          <span className="field-label">TTL hours</span>
          <input
            type="text"
            value={form.ttlHours}
            onChange={(e) => set("ttlHours", e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {expiryPreview !== "" && (
            <span className="field-hint">{expiryPreview}</span>
          )}
        </label>
        <label className="field">
          <span className="field-label">TTL warning lead (hours)</span>
          <input
            type="text"
            value={form.ttlWarningHours}
            onChange={(e) => set("ttlWarningHours", e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">TTL warning email</span>
          <input
            type="text"
            value={form.ttlEmail}
            onChange={(e) => set("ttlEmail", e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">
            Recorded on the TTL_UserEmail tag so the expiry warning has a
            recipient.
          </span>
        </label>
        {plan.errors.map((error) => (
          <p className="field-hint eh-warning" key={error}>
            {error}
          </p>
        ))}
      </div>

      <div className="panel">
        <h2 className="panel-title">3. Plan review</h2>
        <p className="panel-desc">
          What this profile will create, and the Azure rights the selected
          resource-group mode needs. Download the plan as JSON for a change
          request or an air-gapped review.
        </p>
        <span className="field-label">Planned resources</span>
        {nameRows.length === 0 && (
          <p className="field-hint">
            This profile deploys no named resources beyond the resource group
            and its TTL watchdog.
          </p>
        )}
        {nameRows.map((row) => (
          <p className="field-hint" key={`${row.label}:${row.value}`}>
            {row.label}: {row.value}
          </p>
        ))}
        <span className="field-label">Required permissions</span>
        {plan.permissions.map((perm) => (
          <p className="field-hint" key={perm.role}>
            {perm.scope} - {perm.role}. {perm.reason}
          </p>
        ))}
        {plan.warnings.map((warning) => (
          <p className="field-hint eh-warning" key={warning}>
            {warning}
          </p>
        ))}
        <div className="panel-controls">
          <button className="run-button" onClick={() => void downloadPlan()}>
            Download plan (JSON)
          </button>
          {saveNotice !== "" && <span className="field-hint">{saveNotice}</span>}
        </div>
      </div>

      <div className="panel">
        <h2 className="panel-title">4. Deploy</h2>
        <p className="panel-desc">
          Deploys the profile's foundation, storage, networking, and
          monitoring phases live: the resource group (created, or TTL-extended
          if it exists) with the TTL self-destruct watchdog and its delete
          permission, the storage account with its pattern containers,
          notification queue, and Event Grid blob wiring, the NSGs and virtual
          network, then the Log Analytics workspace with Microsoft Sentinel.
          The remaining phases (Private Link, analytics, flow logs, compute,
          DCRs, Cribl wiring, VPN gateway) arrive in upcoming releases.
        </p>
        <div className="panel-controls">
          <button
            className="next-action-button"
            onClick={() => void deployLab()}
            disabled={deploying || !gate.ok}
          >
            {deploying ? "Deploying lab..." : "Deploy lab"}
          </button>
          {!gate.ok && <span className="field-hint">{gate.reason}</span>}
        </div>
        {steps.length > 0 && (
          <div className="discovery-result">
            {steps.map((step) => (
              <p className="field-hint" key={step.name}>
                [{step.status.toUpperCase()}] {step.name}
                {step.detail !== undefined ? ` - ${step.detail}` : ""}
              </p>
            ))}
          </div>
        )}
        {deployError !== "" && <pre className="result">{deployError}</pre>}
        {result !== null && (
          <pre className="result">{labRunResultLines(result).join("\n")}</pre>
        )}
      </div>
    </>
  );
}
