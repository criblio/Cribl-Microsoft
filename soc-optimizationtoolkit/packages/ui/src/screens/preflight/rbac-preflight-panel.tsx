/**
 * RbacPreflightPanel - the RBAC PREFLIGHT PANEL (porting-plan Unit 9, ENG-38
 * delta / GUI-11), the Setup Wizard's PERMISSION-CHECK step in the onboarding
 * consent flow. Before a guided deploy attempts any write, it shows the operator
 * exactly what they can and cannot do on BOTH the Azure and the Cribl side:
 * per-capability status DOTS, the granted-roles decoration, and RETRY / SWITCH
 * ACCOUNT actions.
 *
 * The RUN is the @soc/core side-runners runAzurePreflight / runCriblPreflight,
 * each TOTAL (it catches its own failures and returns a populated preflight).
 * This component fires them INDEPENDENTLY so PARTIAL RESULTS RENDER HONESTLY -
 * one side still pending or failed never blanks the other. Every non-trivial
 * decision (dot derivation, retry/switch enablement, partial-render note,
 * summary text) is the pure preflight-state module.
 *
 * INFORMATIONAL / NON-GATING: the combined verdict is surfaced as
 * hasRequiredAccess (a PERMISSION verdict). It is deliberately NOT integrate-arc's
 * canDeploy - the panel reports; it never gates or regresses the actual deploy
 * partition.
 *
 * PROBES ARE TRUTH: readiness comes from effective-action checks + live probes,
 * never from a role name (the legacy role-name heuristic is the negative example
 * this unit replaces). The granted-roles list is decoration only.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CRIBL_CAPABILITY_PROBES,
  REQUIRED_ACTIONS,
  runAzurePreflight,
  runCriblPreflight,
} from "@soc/core";
import type {
  AzurePreflight,
  AzurePreflightTarget,
  CriblPreflight,
  CriblShellMode,
  SetupPath,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import {
  type AzureSideState,
  type CapabilityDot,
  type CriblSideState,
  type PreflightSideView,
  derivePreflightView,
  dotStatusLabel,
  dotToneClass,
} from "./preflight-state";

/** The setup paths offered in the panel's selector, with human labels. */
const SETUP_PATH_OPTIONS: readonly { value: SetupPath; label: string }[] = [
  { value: "existing-rg", label: "Existing workspace (deploy into its resource group)" },
  { value: "existing-subscription", label: "Existing subscription (discovery / read only)" },
  { value: "lab-new-rg-subscription", label: "Lab: create a new resource group (subscription scope)" },
  { value: "lab-byo-rg", label: "Lab: bring your own resource group" },
];

export interface RbacPreflightPanelProps {
  /**
   * Which app shell is hosting - "cloud" (the app runs inside the Cribl leader,
   * so the Cribl probe is granted-by-platform) or "local" (the probes are
   * genuinely informative against the configured leader). Shell-declared.
   */
  criblShellMode: CriblShellMode;
  /** The setup path selected initially (the user can change it). */
  defaultSetupPath?: SetupPath;
  /** The worker group / edge fleet the Cribl probes target (local shell). */
  workerGroup?: string;
  /**
   * OPTIONAL granted-roles decoration per side (role/policy names from the
   * shell). Decoration ONLY - probes are the truth; a role name never flips a
   * dot or readiness.
   */
  grantedRoles?: { azure?: readonly string[]; cribl?: readonly string[] };
  /**
   * OPTIONAL Switch Account handler. When wired, the Switch Account button
   * invokes it (e.g. clear the live secret and return to the connect step);
   * absent, the button stays visible-but-disabled with a reason.
   */
  onSwitchAccount?: () => void;
}

/** Build the denied-everything Azure fallback for an unexpected side throw. */
function azureThrowFallback(setupPath: SetupPath, err: unknown): AzurePreflight {
  const message = err instanceof Error ? err.message : String(err);
  return {
    configured: false,
    setupPath,
    scopeKind:
      setupPath === "existing-rg" || setupPath === "lab-byo-rg"
        ? "resource-group"
        : "subscription",
    scope: "",
    permissionsFetched: false,
    checks: REQUIRED_ACTIONS[setupPath].map((req) => ({
      action: req.action,
      label: req.label,
      granted: false,
    })),
    probes: [],
    hasRequiredAccess: false,
    error: `azure preflight error: ${message}`,
  };
}

/** Build the unknown-everything Cribl fallback for an unexpected side throw. */
function criblThrowFallback(
  mode: CriblShellMode,
  workerGroup: string,
  err: unknown,
): CriblPreflight {
  const message = err instanceof Error ? err.message : String(err);
  return {
    mode,
    workerGroup,
    probes: CRIBL_CAPABILITY_PROBES.map((spec) => ({
      capability: spec.capability,
      label: spec.label,
      required: spec.required,
      status: "unknown",
      detail: message,
    })),
    hasRequiredAccess: false,
    error: `cribl preflight error: ${message}`,
  };
}

/** One capability dot row. */
function DotRow({ dot }: { dot: CapabilityDot }) {
  return (
    <li className={`preflight-dot-row ${dotToneClass(dot.status)}`}>
      <span className="preflight-dot" aria-hidden="true" />
      <span className="preflight-dot-label">{dot.label}</span>
      <span className="preflight-dot-status">{dotStatusLabel(dot.status)}</span>
      {dot.detail !== "" && dot.status !== "granted" && (
        <span className="preflight-dot-detail">{dot.detail}</span>
      )}
    </li>
  );
}

/** One side (Azure or Cribl) section. */
function SideSection({ view }: { view: PreflightSideView }) {
  const required = view.dots.filter((d) => d.required);
  const informative = view.dots.filter((d) => !d.required);
  return (
    <section className="preflight-side">
      <div className="preflight-side-head">
        <span className="field-label">{view.title}</span>
        <span
          className={`status status-${
            view.checking ? "running" : view.hasRequiredAccess ? "ok" : "failed"
          }`}
        >
          {view.checking ? "checking" : view.hasRequiredAccess ? "ready" : "attention"}
        </span>
      </div>
      <p className="panel-desc">{view.note}</p>
      <ul className="preflight-dot-list">
        {required.map((dot) => (
          <DotRow key={dot.key} dot={dot} />
        ))}
      </ul>
      {informative.length > 0 && (
        <>
          <span className="field-hint">Reachability probes (informative)</span>
          <ul className="preflight-dot-list">
            {informative.map((dot) => (
              <DotRow key={dot.key} dot={dot} />
            ))}
          </ul>
        </>
      )}
      {view.grantedRoles.length > 0 && (
        <p className="field-hint">
          Granted roles (decoration - probes above are the truth):{" "}
          {view.grantedRoles.join(", ")}
        </p>
      )}
    </section>
  );
}

export function RbacPreflightPanel({
  criblShellMode,
  defaultSetupPath = "existing-rg",
  workerGroup = "",
  grantedRoles,
  onSwitchAccount,
}: RbacPreflightPanelProps) {
  const { ports, config } = usePorts();

  const [setupPath, setSetupPath] = useState<SetupPath>(defaultSetupPath);
  const [azure, setAzure] = useState<AzureSideState>({ phase: "idle", result: null });
  const [cribl, setCribl] = useState<CriblSideState>({ phase: "idle", result: null });

  const target: AzurePreflightTarget = useMemo(
    () => ({
      subscriptionId: config.subscriptionId,
      resourceGroup: config.resourceGroup,
      workspaceName: config.workspaceName,
    }),
    [config.subscriptionId, config.resourceGroup, config.workspaceName],
  );

  const run = useCallback(() => {
    const logger = ports.logger;
    setAzure({ phase: "pending", result: null });
    setCribl({ phase: "pending", result: null });
    // Both sides fire INDEPENDENTLY: each resolves into its own state slot so a
    // slow or failed side never blocks the other from rendering. The core
    // side-runners are total; the extra .catch is belt-and-braces so an
    // unexpected throw still resolves the side to a populated (errored) result
    // rather than leaving it stuck on pending.
    void runAzurePreflight(ports.azure, setupPath, target, logger)
      .then((result) => setAzure({ phase: "done", result }))
      .catch((err: unknown) =>
        setAzure({ phase: "done", result: azureThrowFallback(setupPath, err) }),
      );
    void runCriblPreflight(ports.cribl, criblShellMode, workerGroup, logger)
      .then((result) => setCribl({ phase: "done", result }))
      .catch((err: unknown) =>
        setCribl({
          phase: "done",
          result: criblThrowFallback(criblShellMode, workerGroup, err),
        }),
      );
  }, [ports, setupPath, target, criblShellMode, workerGroup]);

  // Auto-run on mount and whenever the setup path or target scope changes.
  useEffect(() => {
    run();
  }, [run]);

  const view = derivePreflightView({
    setupPath,
    azure,
    cribl,
    switchAccountAvailable: onSwitchAccount !== undefined,
    ...(grantedRoles !== undefined ? { grantedRoles } : {}),
  });

  return (
    <div className="preflight-panel">
      <div className="preflight-controls">
        <label className="field">
          <span className="field-label">Setup path (what will be checked)</span>
          <select
            value={setupPath}
            onChange={(e) => setSetupPath(e.target.value as SetupPath)}
          >
            {SETUP_PATH_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        className={`preflight-summary status-${
          view.anyPending ? "running" : view.hasRequiredAccess ? "ok" : "failed"
        }`}
      >
        {view.summary}
      </div>
      <p className="field-hint">
        This is an informational preflight - it reports access, it does not gate
        the deploy. Effective-action checks and live probes are the truth; the
        role names below are decoration only.
      </p>

      <div className="preflight-sides">
        <SideSection view={view.azure} />
        <SideSection view={view.cribl} />
      </div>

      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => run()}
          disabled={!view.actions.canRetry}
          title={view.actions.retryReason ?? undefined}
        >
          Retry
        </button>
        <button
          className="run-button"
          onClick={() => onSwitchAccount?.()}
          disabled={!view.actions.canSwitchAccount}
          title={view.actions.switchAccountReason ?? undefined}
        >
          Switch account
        </button>
      </div>
    </div>
  );
}
