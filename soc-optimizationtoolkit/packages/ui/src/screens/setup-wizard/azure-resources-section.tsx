/**
 * AzureResourcesSection - the Setup page's "Select resources and grant
 * permissions" section, promoted from the cloud shell's Diagnostics panel 4.
 * Discover the subscriptions the app registration can see, SELECT the
 * subscription (and, per setup path, the workspace or resource group), then
 * generate the az role-assignment script and validate the caller's EFFECTIVE
 * permissions (the RBAC permissions API evaluates allowed actions, never role
 * names, so custom/lookalike roles are handled correctly).
 *
 * All IO rides the ports: ARM reads through ports.azure (the adapter owns
 * token acquisition and refresh end to end - the panel's explicit
 * acquire-and-store steps are gone by design), the stored-credentials report
 * through ports.secrets.list, downloads through ports.artifacts. Pure
 * decisions (response parsing, error messages, setup-path -> scope mapping)
 * live in azure-setup-state.
 *
 * Discovery auto-runs ONCE after each successful connect (connectNonce
 * increments; the ref guard never fires on mount). When discovery returns
 * ZERO subscriptions a fresh service principal cannot list any, so a one-time
 * bootstrap subscription text input appears - the only place a subscription
 * is typed - to scope the role script until Reader is granted. Hosts should
 * KEY this section by the active connection id so switching connections
 * remounts it and discards all cached discovery and validation state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RBAC_PERMISSIONS_API_VERSION,
  deriveResourceGroup,
  renderRoleAssignmentCli,
  resourceCreationRequest,
  roleAssignmentRequest,
} from "@soc/core";
import type { AzureSetupPath, ChangeRequestContext } from "@soc/core";
import { SearchableSelect } from "../../components/searchable-select";
import { usePorts } from "../../ports-context";
import { ChangeRequestBlock } from "./change-request-block";
import {
  RESOURCE_GROUPS_API_VERSION,
  dependentListingStatus,
  ROLE_SCRIPT_FILENAME,
  SUBSCRIPTIONS_API_VERSION,
  VALIDATION_SKIPPED_LINES,
  WORKSPACES_API_VERSION,
  armFailureMessage,
  evaluateScopeLines,
  parseResourceGroupOptions,
  parseSubscriptionOptions,
  parseWorkspaceOptions,
  permissionScopeChecks,
  resourceGroupSelectOptions,
  scriptCopyFeedback,
  scriptDownloadFeedback,
  storedCredentialReport,
  subscriptionSelectOptions,
  wrapRoleScript,
  workspaceSelectOptions,
} from "./azure-setup-state";
import type {
  ResourceGroupOption,
  SubscriptionOption,
  WorkspaceOption,
} from "./azure-setup-state";
import { useRunner } from "./use-runner";

export interface AzureResourcesSectionProps {
  clientId: string;
  tenantId: string;
  setupPath: AzureSetupPath;
  subscriptionId: string;
  onSubscriptionIdChange: (value: string) => void;
  rgName: string;
  onRgNameChange: (value: string) => void;
  workspaceName: string;
  onWorkspaceNameChange: (value: string) => void;
  /** Bumped by the shell after each successful connect (auto-runs discovery). */
  connectNonce: number;
  /**
   * The active connection's change-request context (app name + non-secret
   * config), used to generate the role-assignment and resource-creation tickets.
   */
  ctx: ChangeRequestContext;
  /**
   * Heading line of the stored-credentials report, shell-supplied so it can
   * name the shell's secret store (e.g. the cloud app's KV app-ID scope).
   */
  storageContextLabel?: string;
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

export function AzureResourcesSection({
  clientId,
  tenantId,
  setupPath,
  subscriptionId,
  onSubscriptionIdChange,
  rgName,
  onRgNameChange,
  workspaceName,
  onWorkspaceNameChange,
  connectNonce,
  ctx,
  storageContextLabel = "Stored credentials:",
}: AzureResourcesSectionProps) {
  const { ports } = usePorts();
  const [stored, setStored] = useState("checking stored credentials...");
  const [validating, setValidating] = useState(false);
  const [scriptFeedback, setScriptFeedback] = useState("");
  const [discoverStatus, discoverOutput, runDiscover] = useRunner();

  // Resource discovery state. Each list is null until its query has run; an
  // empty array means the query succeeded but returned nothing. For
  // subscriptions an empty array is the bootstrap signal (dropdown hidden,
  // text input shown). Lists live in React state only - never persisted, and
  // a connection switch remounts this section (host key), which discards them.
  const [subscriptions, setSubscriptions] = useState<SubscriptionOption[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | null>(null);
  const [resourceGroups, setResourceGroups] = useState<ResourceGroupOption[] | null>(null);
  const [dependentStatus, setDependentStatus] = useState("");

  // Run the setup-path-dependent query for a chosen subscription:
  //   existing   -> Log Analytics workspaces (selecting one also sets rgName)
  //   lab-byo-rg -> resource groups
  //   lab-new-rg -> nothing (the lab creates its own resource group)
  // Clears the previous dependent lists first so stale options never linger.
  const loadDependent = useCallback(
    async (sub: string, path: AzureSetupPath) => {
      setWorkspaces(null);
      setResourceGroups(null);
      if (sub === "") {
        setDependentStatus("");
        return;
      }
      // BOTH LISTS, ALWAYS, WHATEVER THE PATH. This used to branch: lab-new-rg
      // returned without listing anything, `existing` listed only workspaces,
      // lab-byo-rg only resource groups. That made the DEPLOYMENT TARGET a
      // property of the setup path, so an operator could only repoint a
      // workspace from `existing` and only a resource group from lab-byo-rg,
      // and from lab-new-rg neither - reported live 2026-09-04 as "there are 4
      // options in the drop down and none of them allow you to select a
      // specific Log Analytics workspace or resource group".
      //
      // The target is not a setup-path question. First-run setup CHOOSES a
      // shape; repointing an install that already works is a different act and
      // has to stay available. So the lists load together and the path now only
      // decides what the CREATE fields below offer.
      //
      // EACH LIST DEGRADES INDEPENDENTLY, and that is AZR-14's lesson applied
      // rather than restated: on the targeting screen these two calls shared one
      // try, so a denied workspace list took the resource-group call down with
      // it and the operator could not tell a denied list from one never
      // attempted. Promise.allSettled here means a permission that covers one
      // and not the other still fills the picker it covers.
      setDependentStatus("Listing workspaces and resource groups...");
      const [wsOutcome, rgOutcome] = await Promise.allSettled([
        ports.azure.request({
          method: "GET",
          path: `/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.OperationalInsights/workspaces`,
          apiVersion: WORKSPACES_API_VERSION,
        }),
        ports.azure.request({
          method: "GET",
          path: `/subscriptions/${encodeURIComponent(sub)}/resourcegroups`,
          apiVersion: RESOURCE_GROUPS_API_VERSION,
        }),
      ]);

      const notes: string[] = [];

      if (wsOutcome.status === "rejected") {
        notes.push(`Workspace discovery error: ${String(wsOutcome.reason)}`);
      } else if (!is2xx(wsOutcome.value.status)) {
        notes.push(
          armFailureMessage("Workspaces", wsOutcome.value.status, wsOutcome.value.body),
        );
      } else {
        const list = parseWorkspaceOptions(wsOutcome.value.body);
        setWorkspaces(list);
        // HON-2: the wording is a pure decision and lives in
        // azure-setup-state, where it is pinned. It used to be inline here
        // and said "No workspaces found... Create one", which is the exact
        // confident wrong answer docs/inventory-standard.md forbids.
        notes.push(dependentListingStatus("workspaces", list.length));
      }

      if (rgOutcome.status === "rejected") {
        notes.push(`Resource group discovery error: ${String(rgOutcome.reason)}`);
      } else if (!is2xx(rgOutcome.value.status)) {
        notes.push(
          armFailureMessage("Resource groups", rgOutcome.value.status, rgOutcome.value.body),
        );
      } else {
        const list = parseResourceGroupOptions(rgOutcome.value.body);
        setResourceGroups(list);
        notes.push(dependentListingStatus("resource-groups", list.length));
      }

      if (path === "lab-new-rg") {
        notes.push(
          "This setup path CREATES a resource group in the lab - the target above still selects where the app deploys.",
        );
      }

      setDependentStatus(notes.join(" "));
    },
    [ports],
  );

  // Discover / refresh: list subscriptions through ports.azure (the adapter
  // acquires or refreshes the ARM token itself). A 401/403 returns an
  // actionable message and leaves the dropdown hidden. An EMPTY list is NOT
  // an error: it means the service principal has no role assignments yet, so
  // the bootstrap subscription input is revealed (subscriptions === []).
  const discover = useCallback(
    () =>
      runDiscover(async () => {
        setSubscriptions(null);
        setWorkspaces(null);
        setResourceGroups(null);
        setDependentStatus("");
        const res = await ports.azure.request({
          method: "GET",
          path: "/subscriptions",
          apiVersion: SUBSCRIPTIONS_API_VERSION,
        });
        if (!is2xx(res.status)) {
          // 401/403: a token/authorization problem, not an empty tenant. Leave
          // subscriptions null so the bootstrap input does NOT appear.
          return armFailureMessage("Subscriptions", res.status, res.body);
        }
        const list = parseSubscriptionOptions(res.body);
        setSubscriptions(list);
        if (list.length === 0) {
          return (
            "No subscriptions returned. This app registration has no role assignments yet, so it " +
            "cannot list any subscription. Enter your subscription ID below to scope the role " +
            "assignment script, run it (it grants Reader), wait a couple of minutes for propagation, " +
            "then Discover / refresh from Azure again."
          );
        }
        // If the already-selected subscription is among the discovered set, load
        // its dependent list so a returning user sees the dependent dropdown now.
        const current = subscriptionId.trim();
        if (current !== "" && list.some((s) => s.subscriptionId === current)) {
          await loadDependent(current, setupPath);
        }
        return `Discovered ${list.length} subscription(s). Choose one below.`;
      }),
    [ports, subscriptionId, setupPath, loadDependent, runDiscover],
  );

  // Selecting a subscription sets the shared subscriptionId and re-runs the
  // dependent query for the current setup path.
  const onSubscriptionSelect = (value: string) => {
    onSubscriptionIdChange(value);
    void loadDependent(value, setupPath);
  };

  // Selecting a workspace sets the shared workspaceName and derives the resource
  // group from the workspace's ARM id (via @soc/core) so the user never types it.
  const onWorkspaceSelect = (name: string) => {
    onWorkspaceNameChange(name);
    const match = (workspaces ?? []).find((w) => w.name === name);
    if (match) {
      onRgNameChange(deriveResourceGroup(match.id));
    }
  };

  // When the setup path changes, the dependent query type changes (workspaces
  // vs resource groups vs none), so clear the now-irrelevant dependent lists;
  // if a subscription has already been discovered and selected, re-run the
  // query for the new path. The ref guard makes this fire ONLY on an actual
  // setupPath change, never when discovery repopulates subscriptions.
  const prevSetupPathRef = useRef(setupPath);
  useEffect(() => {
    if (prevSetupPathRef.current === setupPath) {
      return;
    }
    prevSetupPathRef.current = setupPath;
    setWorkspaces(null);
    setResourceGroups(null);
    setDependentStatus("");
    const current = subscriptionId.trim();
    if (subscriptions !== null && current !== "") {
      void loadDependent(current, setupPath);
    }
  }, [setupPath, subscriptions, subscriptionId, loadDependent]);

  // The stored-credentials report: what already exists in this shell's secret
  // store (key names only - values are write-only). The tenant ID reflects
  // the ACTIVE connection's config, not a global key.
  const buildKvReport = useCallback(
    async () => storedCredentialReport(await ports.secrets.list("azure"), tenantId, storageContextLabel),
    [ports, tenantId, storageContextLabel],
  );

  // Auto-run on mount and after a save: report stored state only (no ARM calls).
  const checkStored = useCallback(async () => {
    try {
      const { lines } = await buildKvReport();
      setStored(lines.join("\n"));
    } catch (err) {
      setStored(`stored-credentials check failed: ${String(err)}`);
    }
  }, [buildKvReport]);

  useEffect(() => {
    void checkStored();
  }, [checkStored]);

  // Auto-run discovery ONCE after a successful connect, and refresh the
  // stored-credentials report at the same time so it reflects the just-saved
  // secret/token instead of staying stale until a manual Re-check.
  // connectNonce increments on each connect; the ref guard fires only on an
  // actual increment, never on mount (prev === current) or on unrelated
  // re-renders (e.g. when checkStored's identity changes as tenantId changes).
  const prevConnectNonceRef = useRef(connectNonce);
  useEffect(() => {
    if (prevConnectNonceRef.current === connectNonce) {
      return;
    }
    prevConnectNonceRef.current = connectNonce;
    void discover();
    void checkStored();
  }, [connectNonce, discover, checkStored]);

  // Combined preflight: the stored-credentials report, then (if the connection
  // is made) validate the caller's EFFECTIVE permissions at the scope(s) the
  // selected setup path uses. Token freshness is the adapter's job.
  const recheckAndValidate = useCallback(async () => {
    setValidating(true);
    try {
      const report = await buildKvReport();
      const baseLines = report.lines;
      if (!report.azureBasicPresent || report.tenant === "") {
        setStored([...baseLines, ...VALIDATION_SKIPPED_LINES].join("\n"));
        return;
      }
      setStored([...baseLines, "", "Permission validation: querying scopes..."].join("\n"));
      const validationLines: string[] = [];
      try {
        for (const check of permissionScopeChecks(setupPath, subscriptionId, rgName)) {
          if (check.kind === "needs-input") {
            validationLines.push(check.message);
            continue;
          }
          const res = await ports.azure.request({
            method: "GET",
            path: check.permissionsPath,
            apiVersion: RBAC_PERMISSIONS_API_VERSION,
          });
          validationLines.push(
            ...evaluateScopeLines(check.label, res.status, res.body, check.required),
          );
        }
      } catch (err) {
        validationLines.push(`Permission validation error: ${String(err)}`);
      }
      setStored([...baseLines, "", "Permission validation:", ...validationLines].join("\n"));
    } catch (err) {
      setStored(`stored-credentials check failed: ${String(err)}`);
    } finally {
      setValidating(false);
    }
  }, [ports, buildKvReport, setupPath, subscriptionId, rgName]);

  // The az role-assignment script for the selected setup path, built from the
  // SELECTED (or bootstrap-typed) subscription and the derived/selected resource
  // group. Blank fields stay as <placeholders> so a partial copy is visibly
  // incomplete. Copy/download report via a small feedback line (no runner).
  const script = renderRoleAssignmentCli(setupPath, {
    clientId,
    subscriptionId,
    resourceGroup: rgName,
  });
  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(script);
      setScriptFeedback(scriptCopyFeedback(script));
    } catch (err) {
      setScriptFeedback(`Copy failed: ${String(err)}`);
    }
  };
  // Download avoids the terminal multi-line paste prompt and lets the script be
  // reviewed and re-run: bash assign-roles.sh, or run the az lines in PowerShell.
  const downloadScript = async () => {
    try {
      await ports.artifacts.save(ROLE_SCRIPT_FILENAME, "application/x-sh", wrapRoleScript(script));
      setScriptFeedback(scriptDownloadFeedback(script));
    } catch (err) {
      setScriptFeedback(`Download failed: ${String(err)}`);
    }
  };

  return (
    <section className="panel">
      <h2 className="panel-title">Select resources and grant permissions</h2>
      <p className="panel-desc">
        Discover the subscriptions this app registration can see, select the subscription and (for the
        existing and bring-your-own-RG paths) the target resource, then generate and run the role
        assignment script and validate the effective permissions. Discovery runs automatically once
        after you Save and connect above; use Discover / refresh from Azure to re-run it after
        granting roles.
      </p>
      <ChangeRequestBlock
        title="Cannot assign roles yourself? Generate a change request"
        description={
          'The human-readable companion to the az CLI script below: a paste-ready ticket asking a team ' +
          'with RBAC rights to assign exactly the roles this setup path requires, at the named scopes, ' +
          'with a justification per role. Blank fields appear as clear placeholders.'
        }
        filename="role-assignment-request.txt"
        generate={() => roleAssignmentRequest(ctx)}
      />
      <ChangeRequestBlock
        title="Need a resource group or Event Hub created? Generate a change request"
        description={
          'A paste-ready ticket asking for the Azure resources this app needs but you may lack rights ' +
          'to create: for the new-lab-RG path a resource group with a mandatory TTL auto-delete, plus ' +
          'an Event Hub namespace for the diagnostic-settings export path.'
        }
        filename="resource-creation-request.txt"
        generate={() => resourceCreationRequest(ctx)}
      />
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void discover()}
          disabled={discoverStatus === "running"}
        >
          Discover / refresh from Azure
        </button>
        <span className={`status status-${discoverStatus}`}>{discoverStatus}</span>
      </div>
      {discoverOutput !== "" && <pre className="result">{discoverOutput}</pre>}
      <div className="form-grid">
        {subscriptions === null && (
          <label className="field">
            <span className="field-label">Subscription</span>
            <SearchableSelect
              options={[]}
              value=""
              onChange={() => undefined}
              disabled
              placeholder="Click Discover / refresh from Azure above to load..."
            />
            <span className="field-hint">
              The selectors fill from live discovery. Save and connect above first, then Discover.
            </span>
          </label>
        )}
        {subscriptions !== null && subscriptions.length > 0 && (
          <label className="field">
            <span className="field-label">Subscription</span>
            <SearchableSelect
              options={subscriptionSelectOptions(subscriptions)}
              value={subscriptionId}
              onChange={onSubscriptionSelect}
              placeholder="Select a subscription..."
              ariaLabel="Filter subscriptions"
            />
          </label>
        )}
        {subscriptions !== null && subscriptions.length === 0 && (
          <label className="field">
            <span className="field-label">Subscription ID (one-time bootstrap)</span>
            <input
              type="text"
              value={subscriptionId}
              onChange={(e) => onSubscriptionIdChange(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="find it via 'az account list' or the Azure portal"
            />
            <span className="field-hint">
              Discovery found no subscriptions, so this app registration has no role assignments yet.
              Type the subscription ID here to scope the role script below - this is the only place a
              subscription is typed. After you grant Reader and Discover / refresh from Azure again,
              the dropdown replaces it.
            </span>
          </label>
        )}
        {/* THE DEPLOYMENT TARGET, AND IT IS NOT GATED ON THE SETUP PATH.
            Both pickers used to be: the workspace only on `existing`, the
            resource group only on `lab-byo-rg`, and neither on `lab-new-rg`.
            Since the paths are mutually exclusive no path ever showed both, so
            repointing an install that already worked meant knowing which path
            happened to expose the field you needed.
            Setup CHOOSES a shape once; the target is changed for the life of
            the install, so it lives here beside the credentials it is scoped
            by, always. Both write straight to the shared config
            (workspaceName / resourceGroup), which is what every screen already
            reads - so changing one here repoints the app and re-runs the audit
            (App.tsx: a connection switch or scope commit falls out of the audit
            key changing). */}
        <label className="field">
          <span className="field-label">Log Analytics workspace (deployment target)</span>
          <SearchableSelect
            options={workspaceSelectOptions(workspaces ?? [])}
            value={workspaceName}
            onChange={onWorkspaceSelect}
            disabled={workspaces === null || workspaces.length === 0}
            placeholder={
              workspaces !== null && workspaces.length > 0
                ? "Select a workspace..."
                : subscriptionId === ""
                  ? "Select a subscription first..."
                  : workspaces !== null
                    ? "No workspaces were readable - see the discovery note above"
                    : "Click Discover / refresh from Azure above"
            }
            ariaLabel="Filter workspaces"
          />
          <span className="field-hint">
            Every screen that names a workspace uses this one. Change it at any
            time to deploy to a different workspace; selecting one also fills
            the resource group below from its ARM id.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Resource group (deployment target)</span>
          <SearchableSelect
            options={resourceGroupSelectOptions(resourceGroups ?? [])}
            value={rgName}
            onChange={onRgNameChange}
            disabled={resourceGroups === null || resourceGroups.length === 0}
            placeholder={
              resourceGroups !== null && resourceGroups.length > 0
                ? "Select a resource group..."
                : subscriptionId === ""
                  ? "Select a subscription first..."
                  : resourceGroups !== null
                    ? "No resource groups were readable - see the discovery note above"
                    : "Click Discover / refresh from Azure above"
            }
            ariaLabel="Filter resource groups"
          />
          <span className="field-hint">
            Where DCRs are created. Selecting a workspace above sets this for
            you; override it here if the DCRs belong somewhere else.
          </span>
        </label>
      </div>
      {dependentStatus !== "" && (
        <div className="discovery-result">
          <span className="field-label">
            {setupPath === "existing"
              ? "Workspace discovery"
              : setupPath === "lab-byo-rg"
                ? "Resource group discovery"
                : "Setup path"}
          </span>
          <pre className="result">{dependentStatus}</pre>
        </div>
      )}
      <div className="discovery-result">
        <span className="field-label">Role assignment script</span>
        <pre className="result">{script}</pre>
      </div>
      <div className="panel-controls">
        <button className="run-button" onClick={() => void copyScript()}>
          Copy az CLI script
        </button>
        <button className="run-button" onClick={() => void downloadScript()}>
          Download {ROLE_SCRIPT_FILENAME}
        </button>
      </div>
      {scriptFeedback !== "" && <p className="panel-desc">{scriptFeedback}</p>}
      <p className="panel-desc">
        The script is generated from the selected (or bootstrap) subscription and the derived resource
        group. Copy or download it - download avoids the terminal multi-line paste prompt and lets you
        review it first. If you paste, choose Paste (not Paste as one line, which would join the
        commands). Role assignments can take a couple of minutes to propagate; Discover / refresh from
        Azure again afterward.
      </p>
      <pre className="result">{stored}</pre>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void recheckAndValidate()}
          disabled={validating}
        >
          Re-check and validate permissions
        </button>
      </div>
      <p className="panel-desc">
        Re-check and validate permissions reports the stored credential state and then, if the
        connection is made, checks the caller&apos;s EFFECTIVE Azure permissions for the selected
        setup path and resources - it evaluates the actions actually allowed (via the RBAC
        permissions API), not role names, so custom or lookalike roles are handled correctly.
      </p>
    </section>
  );
}
