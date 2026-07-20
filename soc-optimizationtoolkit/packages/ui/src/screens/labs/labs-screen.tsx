/**
 * LabsScreen - roadmap Phase 5: provision disposable Azure lab environments
 * from the app. Ships the full PLANNING surface (the 8 UnifiedLab profiles,
 * public/private mode, the two resource-group permission modes, validation,
 * planned resource names, phases, permissions, plan download) and deploys
 * ALL TEN legacy phases live through the @soc/core provisionLab engine:
 * foundation with the MANDATORY TTL self-destruct, storage + Event Grid,
 * networking, Log Analytics + Sentinel (+ AMPLS in private mode), Event Hub
 * + ADX, flow logs, test VMs (transient password input), Direct DCRs for the
 * four Sentinel natives, the generated Cribl config bundle (downloadable via
 * the ArtifactSink), and the VPN gateway with the optional site-to-site
 * connection.
 *
 * All lab knowledge is @soc/core (domain/labs + the provisionLab usecase);
 * decisions live in the pure labs-state module; this component only renders
 * and drives IO through the ports (ZERO direct fetch here).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LAB_PROFILES,
  assembleFlowLogPack,
  checkLabPermissions,
  destroyLab,
  extendLabTtl,
  finalizeFlowLogPack,
  listLabs,
  listSubscriptions,
  provisionLab,
  type AzureSubscription,
  type CriblGroupSummary,
  type JobStep,
  type LabInventoryEntry,
  type LabResourceGroupMode,
  type LabType,
  type ProvisionLabResult,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import {
  canDeployFoundation,
  criblBundleArtifact,
  defaultLabFormState,
  flowLogPackResultLines,
  formatLabInventoryRow,
  formatLabPhaseLine,
  initialLabSteps,
  labPlanArtifact,
  labPlanFromForm,
  labResourceNameRows,
  labRunResultLines,
  onPremFromForm,
  permissionCheckLines,
  ttlExpiryPreview,
  vmPasswordMissing,
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
  const [checkingPerms, setCheckingPerms] = useState(false);
  const [permLines, setPermLines] = useState<string[]>([]);
  const [permError, setPermError] = useState("");
  // Subscription selection: defaults to the active connection's target and
  // feeds the plan, the permission check, the deploy, and the inventory.
  const [subscriptionId, setSubscriptionId] = useState(config.subscriptionId);
  const [subscriptions, setSubscriptions] = useState<AzureSubscription[] | null>(null);
  const [subError, setSubError] = useState("");
  // Inventory of running labs.
  const [labs, setLabs] = useState<LabInventoryEntry[] | null>(null);
  const [loadingLabs, setLoadingLabs] = useState(false);
  const [labsError, setLabsError] = useState("");
  const [extendHours, setExtendHours] = useState("72");
  const [confirmDestroy, setConfirmDestroy] = useState("");
  const [inventoryNotice, setInventoryNotice] = useState("");
  // Flow-log pack deployment.
  const [groups, setGroups] = useState<CriblGroupSummary[] | null>(null);
  const [groupId, setGroupId] = useState("");
  const [groupsError, setGroupsError] = useState("");
  const [packStorageAccount, setPackStorageAccount] = useState("");
  const [packSecret, setPackSecret] = useState("");
  const [packScheduleEnabled, setPackScheduleEnabled] = useState(true);
  const [deployingPack, setDeployingPack] = useState(false);
  const [packLines, setPackLines] = useState<string[]>([]);
  const [packError, setPackError] = useState("");

  const set = useCallback(
    <K extends keyof LabFormState>(key: K, value: LabFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const plan = useMemo(
    () => labPlanFromForm(form, subscriptionId),
    [form, subscriptionId],
  );

  // Load the subscription list once (one cheap ARM GET; the selector falls
  // back to the connection's target when the list is unavailable).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const subs = await listSubscriptions(ports.azure, ports.logger);
        if (!cancelled) {
          setSubscriptions(subs);
        }
      } catch (err) {
        if (!cancelled) {
          setSubError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ports.azure, ports.logger]);

  const refreshLabs = useCallback(async () => {
    if (loadingLabs || subscriptionId === "") {
      return;
    }
    setLoadingLabs(true);
    setLabsError("");
    setInventoryNotice("");
    setConfirmDestroy("");
    try {
      setLabs(
        await listLabs(
          ports.azure,
          { subscriptionId, nowIso: new Date().toISOString() },
          ports.logger,
        ),
      );
    } catch (err) {
      setLabs(null);
      setLabsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingLabs(false);
    }
  }, [loadingLabs, subscriptionId, ports.azure, ports.logger]);

  const extendLab = useCallback(
    async (name: string) => {
      setInventoryNotice("");
      const hours = Number(extendHours);
      if (!Number.isInteger(hours) || hours < 1) {
        setInventoryNotice("Extend hours must be a positive whole number.");
        return;
      }
      try {
        const outcome = await extendLabTtl(
          ports.azure,
          {
            subscriptionId,
            resourceGroupName: name,
            ttl: { hours, warningHours: 24, userEmail: "" },
            nowIso: new Date().toISOString(),
          },
          ports.logger,
        );
        setInventoryNotice(`${name}: TTL extended to ${outcome.expiresAt}.`);
        await refreshLabs();
      } catch (err) {
        setInventoryNotice(
          `${name}: extend failed - ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [extendHours, subscriptionId, ports.azure, ports.logger, refreshLabs],
  );

  const destroyLabNow = useCallback(
    async (name: string) => {
      setInventoryNotice("");
      try {
        await destroyLab(
          ports.azure,
          { subscriptionId, resourceGroupName: name },
          ports.logger,
        );
        setInventoryNotice(
          `${name}: deletion ACCEPTED - Azure deletes the group and everything ` +
            "in it asynchronously (it lingers in the list until done).",
        );
        setConfirmDestroy("");
        await refreshLabs();
      } catch (err) {
        setInventoryNotice(
          `${name}: destroy failed - ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [subscriptionId, ports.azure, ports.logger, refreshLabs],
  );

  const loadGroups = useCallback(async () => {
    setGroupsError("");
    try {
      const found = await ports.cribl.listGroups();
      setGroups(found);
      if (found.length > 0 && groupId === "") {
        setGroupId(found[0].id);
      }
    } catch (err) {
      setGroups(null);
      setGroupsError(
        `Worker groups unavailable (is a Cribl connection active?): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }, [ports.cribl, groupId]);

  const deployFlowLogPack = useCallback(async () => {
    if (deployingPack || groupId === "" || ports.packInstall === undefined) {
      return;
    }
    setDeployingPack(true);
    setPackError("");
    setPackLines([]);
    try {
      const storageAccountName =
        packStorageAccount.trim() !== ""
          ? packStorageAccount.trim()
          : (result?.storage?.accountName ?? plan.names.storageAccount);
      const pack = assembleFlowLogPack(
        {
          storageAccountName,
          tenantId: config.tenantId,
          clientId: config.clientId,
          scheduleEnabled: packScheduleEnabled,
        },
        Date.now(),
      );
      await ports.packInstall.install(groupId, pack.crblFileName, pack.crbl);
      const outcome = await finalizeFlowLogPack(
        ports.cribl,
        { groupId, clientSecret: packSecret },
        ports.logger,
      );
      setPackLines(flowLogPackResultLines(pack.crblFileName, groupId, outcome));
      setPackSecret("");
    } catch (err) {
      setPackError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeployingPack(false);
    }
  }, [
    deployingPack,
    groupId,
    ports.packInstall,
    ports.cribl,
    ports.logger,
    packStorageAccount,
    packSecret,
    packScheduleEnabled,
    result,
    plan.names.storageAccount,
    config.tenantId,
    config.clientId,
  ]);
  const profile = LAB_PROFILES.find((p) => p.id === form.labType);
  const nameRows = useMemo(
    () => labResourceNameRows(plan.names, plan.flags),
    [plan],
  );
  const hasMinter = ports.mintAssignmentName !== undefined;
  const gate = canDeployFoundation(plan, hasMinter, vmPasswordMissing(plan, form));

  // The expiry preview needs a wall clock; minted HERE (the impure component
  // layer - core and labs-state stay clock-free).
  const expiryPreview = ttlExpiryPreview(form, new Date().toISOString());

  const runPermissionCheck = useCallback(async () => {
    if (checkingPerms || subscriptionId === "") {
      return;
    }
    setCheckingPerms(true);
    setPermError("");
    setPermLines([]);
    try {
      const outcome = await checkLabPermissions(
        ports.azure,
        {
          subscriptionId,
          resourceGroupName: plan.resourceGroupName,
          rgMode: form.rgMode,
          flags: plan.flags,
        },
        ports.logger,
      );
      setPermLines(permissionCheckLines(outcome));
    } catch (err) {
      setPermError(
        `Permission check unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setCheckingPerms(false);
    }
  }, [checkingPerms, subscriptionId, ports.azure, ports.logger, plan, form.rgMode]);

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
          subscriptionId,
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
          tenantId: config.tenantId,
          clientId: config.clientId,
          vmAdminPassword: form.vmPassword,
          onPrem: onPremFromForm(form),
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
  }, [deploying, gate.ok, ports, config, plan, form, subscriptionId]);

  const downloadCriblConfigs = useCallback(async () => {
    if (result?.criblConfigs === undefined) {
      return;
    }
    setSaveNotice("");
    const artifact = criblBundleArtifact(result.criblConfigs, form.labType, form.labMode);
    try {
      await ports.artifacts.save(artifact.filename, "application/json", artifact.json);
      setSaveNotice(`Saved ${artifact.filename} through the artifact sink.`);
    } catch (err) {
      setSaveNotice(
        `Could not save: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [result, form.labType, form.labMode, ports.artifacts]);

  return (
    <>
      <div className="panel">
        <h2 className="panel-title">Subscription and running labs</h2>
        <p className="panel-desc">
          Everything below operates in the selected subscription. The
          inventory lists resource groups tagged as labs (this app or the
          legacy UnifiedLab), soonest self-destruct first.
        </p>
        <label className="field">
          <span className="field-label">Subscription</span>
          {subscriptions !== null && subscriptions.length > 0 ? (
            <select
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
            >
              {subscriptions.map((sub) => (
                <option key={sub.subscriptionId} value={sub.subscriptionId}>
                  {sub.displayName} ({sub.subscriptionId})
                </option>
              ))}
              {!subscriptions.some((s) => s.subscriptionId === subscriptionId) &&
                subscriptionId !== "" && (
                  <option value={subscriptionId}>{subscriptionId}</option>
                )}
            </select>
          ) : (
            <input
              type="text"
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          )}
          {subError !== "" && (
            <span className="field-hint eh-warning">
              Subscription list unavailable ({subError}) - enter an id directly.
            </span>
          )}
        </label>
        <div className="panel-controls">
          <button
            className="run-button"
            onClick={() => void refreshLabs()}
            disabled={loadingLabs || subscriptionId === ""}
          >
            {loadingLabs
              ? "Loading labs..."
              : labs === null
                ? "List running labs"
                : "Refresh labs"}
          </button>
          <label className="field">
            <span className="field-label">Extend by (hours)</span>
            <input
              type="text"
              value={extendHours}
              onChange={(e) => setExtendHours(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
        {labsError !== "" && <pre className="result">{labsError}</pre>}
        {labs !== null && labs.length === 0 && (
          <p className="field-hint">No running labs found in this subscription.</p>
        )}
        {labs !== null &&
          labs.map((lab) => (
            <div className="discovery-result" key={lab.name}>
              <span className={lab.expired ? "field-hint eh-warning" : "field-hint"}>
                {formatLabInventoryRow(lab)}
              </span>
              <div className="panel-controls">
                <button className="run-button" onClick={() => void extendLab(lab.name)}>
                  Extend TTL
                </button>
                {confirmDestroy === lab.name ? (
                  <>
                    <button
                      className="run-button"
                      onClick={() => void destroyLabNow(lab.name)}
                    >
                      CONFIRM destroy {lab.name}
                    </button>
                    <button
                      className="run-button"
                      onClick={() => setConfirmDestroy("")}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="run-button"
                    onClick={() => setConfirmDestroy(lab.name)}
                  >
                    Destroy...
                  </button>
                )}
              </div>
            </div>
          ))}
        {inventoryNotice !== "" && <p className="field-hint">{inventoryNotice}</p>}
      </div>

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
        {plan.flags.virtualMachines.deployVMs && (
          <label className="field">
            <span className="field-label">VM admin password (transient)</span>
            <input
              type="password"
              value={form.vmPassword}
              onChange={(e) => set("vmPassword", e.target.value)}
              autoComplete="new-password"
            />
            <span className="field-hint">
              Used once for the test VMs (localadmin) and never stored. A
              re-run that finds the VMs already deployed does not need it.
            </span>
          </label>
        )}
        {plan.flags.infrastructure.deployVPN && (
          <>
            <span className="field-label">
              On-premises VPN connection (optional)
            </span>
            <p className="field-hint">
              Leave blank to deploy the gateway only; fill all three to also
              create the lng-onprem local gateway and the IPsec site-to-site
              connection.
            </p>
            <label className="field">
              <span className="field-label">On-prem VPN device public IP</span>
              <input
                type="text"
                value={form.onPremGatewayIp}
                onChange={(e) => set("onPremGatewayIp", e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field-label">On-prem address spaces (CIDR, comma-separated)</span>
              <input
                type="text"
                value={form.onPremAddressSpace}
                onChange={(e) => set("onPremAddressSpace", e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field-label">IPsec shared key (transient)</span>
              <input
                type="password"
                value={form.onPremSharedKey}
                onChange={(e) => set("onPremSharedKey", e.target.value)}
                autoComplete="new-password"
              />
              <span className="field-hint">
                Sent only to the ARM connection resource; must match the key
                on your on-premises device.
              </span>
            </label>
          </>
        )}
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
          <button
            className="run-button"
            onClick={() => void runPermissionCheck()}
            disabled={checkingPerms || subscriptionId === ""}
          >
            {checkingPerms ? "Checking permissions..." : "Check permissions"}
          </button>
          <span className="field-hint">
            Evaluates the app registration's EFFECTIVE actions for this
            profile (never role names), including whether a conditional RBAC
            grant would block the TTL self-destruct role assignment.
          </span>
          <button className="run-button" onClick={() => void downloadPlan()}>
            Download plan (JSON)
          </button>
          {saveNotice !== "" && <span className="field-hint">{saveNotice}</span>}
        </div>
        {permError !== "" && <pre className="result">{permError}</pre>}
        {permLines.length > 0 && (
          <pre className="result">{permLines.join("\n")}</pre>
        )}
      </div>

      <div className="panel">
        <h2 className="panel-title">4. Deploy</h2>
        <p className="panel-desc">
          Deploys every phase the profile requires, in the legacy UnifiedLab
          order: the TTL-guarded resource group foundation, storage with the
          Cribl ingestion patterns, networking, Log Analytics with Sentinel
          (plus Private Link in private mode), Event Hub and ADX, vNet flow
          logs, traffic-generating test VMs, Direct DCRs for the four
          Sentinel-native tables, the generated Cribl configuration bundle,
          and the VPN gateway. Long-running resources (ADX 10-15 minutes, VPN
          gateway 30-45 minutes) are polled while this screen stays open; a
          re-run resumes from whatever already finished.
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
          <>
            <pre className="result">{labRunResultLines(result).join("\n")}</pre>
            {result.criblConfigs !== undefined && (
              <div className="panel-controls">
                <button className="run-button" onClick={() => void downloadCriblConfigs()}>
                  Download Cribl configs (JSON)
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="panel">
        <h2 className="panel-title">5. Deploy the vNet flow-log pack to Cribl</h2>
        <p className="panel-desc">
          Assembles the AzureFlowLogs pack in-app - the Azure_vNet_FlowLogs
          event breaker, the flow-tuple preprocessing pipeline, and the hourly
          blob collector job wired to your storage account - and installs it
          into the selected worker group, then commits and deploys. The
          collector authenticates with the Azure_vNet_Flowlogs_Secret text
          secret; provide the app registration's client secret below to create
          it, or leave blank if it already exists in the group.
        </p>
        <div className="panel-controls">
          <button className="run-button" onClick={() => void loadGroups()}>
            {groups === null ? "Load worker groups" : "Reload worker groups"}
          </button>
          {groupsError !== "" && (
            <span className="field-hint eh-warning">{groupsError}</span>
          )}
        </div>
        {groups !== null && groups.length > 0 && (
          <label className="field">
            <span className="field-label">Worker group (where to deploy)</span>
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.id}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span className="field-label">Storage account</span>
          <input
            type="text"
            value={packStorageAccount}
            onChange={(e) => setPackStorageAccount(e.target.value)}
            placeholder={result?.storage?.accountName ?? plan.names.storageAccount}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">
            Defaults to the lab's deployed storage account when left blank.
          </span>
        </label>
        <label className="field">
          <span className="field-label">
            Azure client secret for Azure_vNet_Flowlogs_Secret (transient, optional)
          </span>
          <input
            type="password"
            value={packSecret}
            onChange={(e) => setPackSecret(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="integrate-check">
          <input
            type="checkbox"
            checked={packScheduleEnabled}
            onChange={(e) => setPackScheduleEnabled(e.target.checked)}
          />
          <span className="integrate-check-text">
            Enable the hourly collector schedule immediately
          </span>
        </label>
        <div className="panel-controls">
          <button
            className="next-action-button"
            onClick={() => void deployFlowLogPack()}
            disabled={
              deployingPack || groupId === "" || ports.packInstall === undefined
            }
          >
            {deployingPack ? "Installing pack..." : "Install pack and deploy"}
          </button>
          {ports.packInstall === undefined && (
            <span className="field-hint">
              This shell did not provide a pack install client - a wiring gap,
              not a runtime state.
            </span>
          )}
        </div>
        {packError !== "" && <pre className="result">{packError}</pre>}
        {packLines.length > 0 && <pre className="result">{packLines.join("\n")}</pre>}
      </div>
    </>
  );
}
