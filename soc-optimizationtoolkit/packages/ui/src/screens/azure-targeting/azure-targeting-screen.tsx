/**
 * AzureTargetingScreen - the Unit 2 product path for choosing where DCRs
 * deploy: the subscription -> workspace -> resource-group cascade over the
 * @soc/core azure-discovery usecases, plus create-resource-group,
 * create-workspace, and enable-Sentinel actions. Pure React over the ports in
 * PortsContext: ZERO direct fetch or storage access in this module.
 *
 * BROWSE NEVER COMMITS (legacy defect not reproduced): every selector here
 * only changes local browse state. The ONE way a browsed scope becomes the
 * active target is the explicit "Use this target" button, which hands the
 * scope to the SHELL via `onCommitScope` - the shell runs @soc/core's
 * commitTargetScope (cloud profile store) or its scope-override persistence
 * (local host), applies the invalidation, and returns the consequence notice
 * this screen surfaces (the same text the connection bar shows).
 *
 * ONE LOADER EFFECT (legacy had three overlapping): a single effect fetches
 * whatever buildLoaderPlan says is stale - subscriptions per refresh,
 * workspaces + resource-group choices per (refresh, subscription). Selectors
 * are ALWAYS VISIBLE, disabled with instructions until their data arrives
 * (the established design rule).
 *
 * OFFLINE BRANCH (the shell derives it from the frame's mode): free-text
 * entry of the three scope fields, nothing fetched, same explicit commit.
 *
 * Create/enable actions run as attempt-bounded jobs inside @soc/core (the
 * create-workspace provisioning poll is bounded by attempts, never
 * wall-clock) and report honest line-by-line output including the raw error
 * text on failure. Enable-Sentinel deploys into the workspace's ACTUAL
 * location - the legacy always-eastus bug is fixed and pinned in core.
 */

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_WORKSPACE_POLL_ATTEMPTS,
  createResourceGroup,
  createWorkspace,
  enableSentinel,
  listResourceGroupChoices,
  listSubscriptions,
  listWorkspaces,
} from "@soc/core";
import type {
  AzureResourceGroup,
  AzureSubscription,
  AzureWorkspace,
  ResourceGroupChoices,
  TargetScope,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import {
  buildLoaderPlan,
  formatScopeChip,
  sanitizeResourceGroupName,
  validateResourceGroupName,
} from "./targeting-state";

/** What the shell reports back from a commit request. */
export interface CommitScopeOutcome {
  /** False when nothing was committed (e.g. no active connection). */
  committed: boolean;
  /** The consequence notice to surface (connection-bar notice pattern). */
  notice: string;
}

export interface AzureTargetingScreenProps {
  /**
   * The air-gapped/offline branch: free-text scope entry, nothing fetched.
   * The SHELL derives this from the frame's resolved mode (no live Azure
   * connection = offline targeting).
   */
  offline: boolean;
  /**
   * Commit a browsed scope as the active target. The shell owns the profile
   * store / persistence and the invalidation side effects; the returned
   * notice is rendered here AND in the shell's connection bar.
   */
  onCommitScope: (scope: TargetScope) => Promise<CommitScopeOutcome>;
}

type SubsLoad =
  | { status: "idle" | "loading" }
  | { status: "loaded"; list: AzureSubscription[] }
  | { status: "error"; error: string };

type DepLoad =
  | { status: "idle" | "loading" }
  | { status: "loaded"; workspaces: AzureWorkspace[]; choices: ResourceGroupChoices }
  | { status: "error"; error: string };

export function AzureTargetingScreen(props: AzureTargetingScreenProps) {
  const { offline, onCommitScope } = props;
  const { ports, config } = usePorts();

  // Browse state - NEVER committed by itself. Seeded from the committed
  // scope so the pickers open on the current target.
  const [browseSub, setBrowseSub] = useState(config.subscriptionId);
  const [browseWs, setBrowseWs] = useState(config.workspaceName);
  const [browseRg, setBrowseRg] = useState(config.resourceGroup);
  const [location, setLocation] = useState("");

  // Create-action inputs.
  const [newRgName, setNewRgName] = useState("");
  const [newWsName, setNewWsName] = useState("");

  // The one loader's data. reloadNonce bumps on Refresh and after create
  // actions so fresh resources appear in the pickers.
  const [reloadNonce, setReloadNonce] = useState(0);
  const [subsLoad, setSubsLoad] = useState<SubsLoad>({ status: "idle" });
  const [depLoad, setDepLoad] = useState<DepLoad>({ status: "idle" });

  // Action runner state (create RG / create workspace / enable Sentinel).
  const [actionBusy, setActionBusy] = useState(false);
  const [actionOutput, setActionOutput] = useState("");

  // Commit state.
  const [committing, setCommitting] = useState(false);
  const [commitNotice, setCommitNotice] = useState("");

  // THE one loader effect. buildLoaderPlan decides what is stale; the keys
  // in loadedRef prevent refetching data whose inputs did not change (the
  // legacy page's three overlapping effects re-fetched on every render of
  // their trigger states and raced each other).
  const loadedRef = useRef({ subscriptionsKey: "", dependentsKey: "" });
  useEffect(() => {
    const plan = buildLoaderPlan({ offline, subscriptionId: browseSub, reloadNonce });
    let cancelled = false;
    void (async () => {
      if (
        plan.subscriptionsKey !== "" &&
        loadedRef.current.subscriptionsKey !== plan.subscriptionsKey
      ) {
        loadedRef.current.subscriptionsKey = plan.subscriptionsKey;
        setSubsLoad({ status: "loading" });
        try {
          const list = await listSubscriptions(ports.azure, ports.logger);
          if (!cancelled) {
            setSubsLoad({ status: "loaded", list });
          }
        } catch (err) {
          if (!cancelled) {
            setSubsLoad({ status: "error", error: String(err) });
          }
        }
      }
      if (plan.dependentsKey === "") {
        return;
      }
      if (loadedRef.current.dependentsKey !== plan.dependentsKey) {
        loadedRef.current.dependentsKey = plan.dependentsKey;
        setDepLoad({ status: "loading" });
        try {
          const workspaces = await listWorkspaces(
            ports.azure,
            browseSub,
            ports.logger,
          );
          const choices = await listResourceGroupChoices(
            ports.azure,
            browseSub,
            workspaces,
            ports.logger,
          );
          if (!cancelled) {
            setDepLoad({ status: "loaded", workspaces, choices });
          }
        } catch (err) {
          if (!cancelled) {
            setDepLoad({ status: "error", error: String(err) });
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ports.azure, ports.logger, offline, browseSub, reloadNonce]);

  const refresh = () => setReloadNonce((n) => n + 1);

  // Selecting a subscription clears the dependent browse choices; the loader
  // effect picks up the new dependents key on its own. The loaded-key ref is
  // reset WITH the data it tracks: without this, browsing A -> placeholder ->
  // A again would find the old key still marked loaded and never refetch,
  // leaving the pickers stuck on a false "No workspaces found" until Refresh.
  const onSubscriptionSelect = (subscriptionId: string) => {
    setBrowseSub(subscriptionId);
    setBrowseWs("");
    setBrowseRg("");
    setLocation("");
    loadedRef.current.dependentsKey = "";
    setDepLoad({ status: "idle" });
  };

  // Selecting a workspace also proposes its resource group and location
  // (matching the legacy cascade) - still browse-only state.
  const onWorkspaceSelect = (name: string) => {
    setBrowseWs(name);
    if (depLoad.status === "loaded") {
      const match = depLoad.workspaces.find((ws) => ws.name === name);
      if (match !== undefined) {
        if (match.resourceGroup !== "") {
          setBrowseRg(match.resourceGroup);
          setNewRgName("");
        }
        if (match.location !== "") {
          setLocation(match.location);
        }
      }
    }
  };

  const onResourceGroupSelect = (name: string) => {
    setBrowseRg(name);
    setNewRgName("");
    if (depLoad.status === "loaded") {
      const match = depLoad.choices.groups.find((rg) => rg.name === name);
      if (match !== undefined && match.location !== "") {
        setLocation(match.location);
      }
    }
  };

  // Shared honest-output runner for the create/enable actions: each step
  // line appears as it happens; a thrown error is appended verbatim.
  const runAction = async (task: (push: (line: string) => void) => Promise<void>) => {
    setActionBusy(true);
    const lines: string[] = [];
    const push = (line: string) => {
      lines.push(line);
      setActionOutput(lines.join("\n"));
    };
    setActionOutput("");
    try {
      await task(push);
    } catch (err) {
      push(String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const doCreateResourceGroup = () =>
    runAction(async (push) => {
      const problem = validateResourceGroupName(newRgName);
      if (problem !== null) {
        push(problem);
        return;
      }
      if (location.trim() === "") {
        push("Enter an Azure location (e.g. eastus) for the new resource group.");
        return;
      }
      push(`Creating resource group '${newRgName}' in ${location.trim()} (ARM PUT, idempotent)...`);
      const rg = await createResourceGroup(
        ports.azure,
        {
          subscriptionId: browseSub,
          name: newRgName,
          location: location.trim(),
        },
        ports.logger,
      );
      push(`Resource group '${rg.name}' is ready in ${rg.location}.`);
      setBrowseRg(rg.name);
      setNewRgName("");
      refresh();
    });

  const doCreateWorkspace = () =>
    runAction(async (push) => {
      const name = newWsName.trim();
      if (name === "") {
        push("Enter a workspace name.");
        return;
      }
      if (browseRg === "") {
        push("Select or create a resource group first - the workspace deploys into it.");
        return;
      }
      if (location.trim() === "") {
        push("Enter an Azure location (e.g. eastus) for the new workspace.");
        return;
      }
      push(
        `Creating workspace '${name}' in ${browseRg} / ${location.trim()} ` +
          "(sku PerGB2018, retention 90 days - the legacy defaults)...",
      );
      push(
        `Polling provisioning state (attempt-bounded, max ${DEFAULT_WORKSPACE_POLL_ATTEMPTS} polls)...`,
      );
      const ws = await createWorkspace(
        ports.azure,
        {
          subscriptionId: browseSub,
          resourceGroup: browseRg,
          name,
          location: location.trim(),
        },
        ports.logger,
      );
      push(
        `Workspace '${ws.name}' provisioned (resource group ${ws.resourceGroup}, ` +
          `location ${ws.location}, customerId ${ws.customerId === "" ? "(not yet reported)" : ws.customerId}).`,
      );
      setBrowseWs(ws.name);
      setNewWsName("");
      refresh();
    });

  const doEnableSentinel = () =>
    runAction(async (push) => {
      if (browseSub === "" || browseRg === "" || browseWs === "") {
        push("Select a subscription, resource group, and workspace first.");
        return;
      }
      push(
        `Reading workspace '${browseWs}' to resolve its ACTUAL location ` +
          "(the legacy always-eastus defect is fixed), then checking for an " +
          "existing SecurityInsights solution...",
      );
      const result = await enableSentinel(
        ports.azure,
        {
          subscriptionId: browseSub,
          resourceGroup: browseRg,
          workspaceName: browseWs,
        },
        ports.logger,
      );
      if (result.alreadyEnabled) {
        push(
          `Sentinel is already enabled: ${result.solutionName} exists in ` +
            `${result.location} - nothing was deployed.`,
        );
      } else {
        push(`Enabled: ${result.solutionName} deployed in ${result.location}.`);
      }
    });

  // The explicit commit - the ONLY path from browse state to the active
  // target scope.
  const browsedScope: TargetScope = {
    subscriptionId: browseSub.trim(),
    resourceGroup: browseRg.trim(),
    workspaceName: browseWs.trim(),
  };
  const scopeComplete =
    browsedScope.subscriptionId !== "" &&
    browsedScope.resourceGroup !== "" &&
    browsedScope.workspaceName !== "";

  const commit = async () => {
    setCommitting(true);
    setCommitNotice("");
    try {
      const outcome = await onCommitScope(browsedScope);
      setCommitNotice(
        outcome.notice !== ""
          ? outcome.notice
          : outcome.committed
            ? "Target scope committed."
            : "Nothing was committed.",
      );
    } catch (err) {
      setCommitNotice(`Commit failed: ${String(err)}`);
    } finally {
      setCommitting(false);
    }
  };

  const committedScope: TargetScope = {
    subscriptionId: config.subscriptionId,
    resourceGroup: config.resourceGroup,
    workspaceName: config.workspaceName,
  };

  // The resource-group options: the loaded choices plus the current browse
  // selection when it is not in the list yet (a just-created empty RG does
  // not appear in the workspace-derived fallback).
  const rgOptions: AzureResourceGroup[] =
    depLoad.status === "loaded" ? depLoad.choices.groups : [];
  const rgOptionsWithSelection =
    browseRg !== "" && !rgOptions.some((rg) => rg.name === browseRg)
      ? [...rgOptions, { name: browseRg, location: location }]
      : rgOptions;
  const wsOptions: AzureWorkspace[] =
    depLoad.status === "loaded" ? depLoad.workspaces : [];
  const wsOptionsHaveSelection =
    browseWs === "" || wsOptions.some((ws) => ws.name === browseWs);

  const commitBlock = (
    <>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void commit()}
          disabled={!scopeComplete || committing || actionBusy}
        >
          Use this target
        </button>
        <span className="field-hint">
          Committed scope: {formatScopeChip(committedScope)}
        </span>
      </div>
      {!scopeComplete && (
        <p className="panel-desc">
          Choose (or enter) a subscription, resource group, and workspace to
          enable the commit. Browsing alone never changes the committed
          target.
        </p>
      )}
      {commitNotice !== "" && <p className="connection-notice">{commitNotice}</p>}
    </>
  );

  if (offline) {
    return (
      <section className="panel">
        <h2 className="panel-title">Azure targeting (offline)</h2>
        <p className="panel-desc">
          No live Azure connection in this mode: enter the target scope
          manually. The values are embedded in generated artifacts (ARM
          templates, destination configs) for manual deployment, exactly like
          the connected path would target them.
        </p>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Subscription ID</span>
            <input
              type="text"
              value={browseSub}
              onChange={(e) => setBrowseSub(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">Resource group</span>
            <input
              type="text"
              value={browseRg}
              onChange={(e) => setBrowseRg(sanitizeResourceGroupName(e.target.value))}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">Log Analytics workspace</span>
            <input
              type="text"
              value={browseWs}
              onChange={(e) => setBrowseWs(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
        {commitBlock}
      </section>
    );
  }

  return (
    <section className="panel">
      <h2 className="panel-title">Azure targeting</h2>
      <p className="panel-desc">
        Browse the subscriptions, workspaces, and resource groups this
        connection can see, create what is missing, then commit the chosen
        scope with Use this target. Browsing never switches the committed
        scope by itself.
      </p>
      <div className="panel-controls">
        <button className="run-button" onClick={refresh} disabled={actionBusy}>
          Refresh from Azure
        </button>
        {subsLoad.status === "loading" && (
          <span className="field-hint">Loading subscriptions...</span>
        )}
      </div>
      {subsLoad.status === "error" && <pre className="result">{subsLoad.error}</pre>}
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Subscription</span>
          {subsLoad.status === "loaded" && subsLoad.list.length > 0 ? (
            <select
              value={browseSub}
              onChange={(e) => onSubscriptionSelect(e.target.value)}
            >
              <option value="">Select a subscription...</option>
              {subsLoad.list.map((sub) => (
                <option key={sub.subscriptionId} value={sub.subscriptionId}>
                  {sub.displayName === ""
                    ? sub.subscriptionId
                    : `${sub.displayName} (${sub.subscriptionId})`}
                </option>
              ))}
            </select>
          ) : (
            <select disabled value="">
              <option value="">
                {subsLoad.status === "loading"
                  ? "Loading subscriptions..."
                  : subsLoad.status === "error"
                    ? "Subscription discovery failed - fix the connection, then Refresh"
                    : subsLoad.status === "loaded"
                      ? "No enabled subscriptions visible - grant Reader, then Refresh"
                      : "Connect first, then Refresh from Azure"}
              </option>
            </select>
          )}
          <span className="field-hint">
            Only subscriptions in the Enabled state are listed.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Log Analytics workspace</span>
          {depLoad.status === "loaded" && wsOptions.length > 0 ? (
            <select
              value={browseWs}
              onChange={(e) => onWorkspaceSelect(e.target.value)}
            >
              <option value="">Select a workspace...</option>
              {!wsOptionsHaveSelection && (
                <option value={browseWs}>{browseWs} (just created)</option>
              )}
              {wsOptions.map((ws) => (
                <option key={`${ws.resourceGroup}/${ws.name}`} value={ws.name}>
                  {ws.name} ({ws.resourceGroup} / {ws.location})
                </option>
              ))}
            </select>
          ) : (
            <select disabled value="">
              <option value="">
                {browseSub === ""
                  ? "Select a subscription first..."
                  : depLoad.status === "loading"
                    ? "Loading workspaces..."
                    : depLoad.status === "error"
                      ? "Workspace discovery failed - see the error below"
                      : "No workspaces found - create one below"}
              </option>
            </select>
          )}
          <span className="field-hint">
            Selecting a workspace proposes its resource group and location.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Resource group (for DCRs)</span>
          {rgOptionsWithSelection.length > 0 ? (
            <select
              value={browseRg}
              onChange={(e) => onResourceGroupSelect(e.target.value)}
            >
              <option value="">Select a resource group...</option>
              {rgOptionsWithSelection.map((rg) => (
                <option key={rg.name} value={rg.name}>
                  {rg.location === "" ? rg.name : `${rg.name} (${rg.location})`}
                </option>
              ))}
            </select>
          ) : (
            <select disabled value="">
              <option value="">
                {browseSub === ""
                  ? "Select a subscription first..."
                  : depLoad.status === "loading"
                    ? "Loading resource groups..."
                    : "No resource groups visible - create one below"}
              </option>
            </select>
          )}
          {depLoad.status === "loaded" && depLoad.choices.source === "workspaces" && (
            <span className="field-hint">
              The resource-group list call was denied or empty; these choices
              are derived from workspace metadata instead.
              {depLoad.choices.listError !== null
                ? ` (${depLoad.choices.listError})`
                : ""}
            </span>
          )}
        </label>
        <label className="field">
          <span className="field-label">Location</span>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. eastus"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">
            Derived from the selected resource group or workspace; used by the
            create actions below.
          </span>
        </label>
      </div>
      {depLoad.status === "error" && <pre className="result">{depLoad.error}</pre>}

      <div className="discovery-result">
        <span className="field-label">Create what is missing</span>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">New resource group name</span>
            <input
              type="text"
              value={newRgName}
              onChange={(e) => setNewRgName(sanitizeResourceGroupName(e.target.value))}
              placeholder="e.g. rg-cribl-dcr-prod"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="field-hint">
              Letters, digits, underscore, hyphen, parentheses, and period
              only (other characters are stripped as you type).
            </span>
          </label>
          <label className="field">
            <span className="field-label">New workspace name</span>
            <input
              type="text"
              value={newWsName}
              onChange={(e) => setNewWsName(e.target.value)}
              placeholder="e.g. law-sentinel-prod"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="field-hint">
              Created in the selected resource group with the legacy defaults
              (PerGB2018, 90-day retention).
            </span>
          </label>
        </div>
        <div className="panel-controls">
          <button
            className="run-button"
            onClick={() => void doCreateResourceGroup()}
            disabled={actionBusy || browseSub === "" || newRgName === ""}
          >
            Create resource group
          </button>
          <button
            className="run-button"
            onClick={() => void doCreateWorkspace()}
            disabled={actionBusy || browseSub === "" || newWsName.trim() === ""}
          >
            Create workspace
          </button>
          <button
            className="run-button"
            onClick={() => void doEnableSentinel()}
            disabled={actionBusy || !scopeComplete}
          >
            Enable Sentinel on the workspace
          </button>
        </div>
        {actionOutput !== "" && <pre className="result">{actionOutput}</pre>}
      </div>

      {commitBlock}
    </section>
  );
}
