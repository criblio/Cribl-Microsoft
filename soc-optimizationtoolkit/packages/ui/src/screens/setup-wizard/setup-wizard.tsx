/**
 * SetupWizard - the local-app first-run onboarding, ASSEMBLED from the pieces
 * already shipped in Units 1, 9, and 14 (porting-plan Unit 22, GUI-03 delta).
 * It does NOT rebuild any of them; it composes them in order behind one wizard
 * chrome (the legacy-flow-analysis.md wizard bar): a 3-segment progress bar
 * (Target -> Connect -> Mode), the current step's screen, a persistent
 * Connections + Repositories status footer, and Back / Next / Get Started.
 *
 * Assembly order (target-specific where the two hosting targets differ):
 *   AuaGate (Unit 1; shown only when the wizard owns acceptance)
 *     -> Target chooser (Cribl-hosted vs local; core tradeoff DATA)
 *     -> Connect: the .tgz upload walkthrough (cribl-hosted) OR the
 *        leader-connect form (local, core base-URL + dual-profile rules)
 *     -> Connect Azure (service-principal identity guidance)
 *     -> Permission preflight (Unit 9 RbacPreflightPanel)
 *     -> Repositories / GitHub PAT (Unit 14 RepositoriesScreen)
 *     -> Mode (availability-gated cards with a Recommended badge; core matrix)
 *     -> Get Started (persists the chosen mode and enters the app).
 *
 * The step LIST, its target-specific + mode-gated visibility, and the 3-segment
 * progress all come from the pure setup-wizard-state module over @soc/core - no
 * step logic is duplicated here. Mode is the OUTPUT of the flow, so the step
 * list is always derived with mode undecided (the full connect path); the
 * chosen mode only drives the final card selection and Get Started.
 *
 * The composed preflight + repositories panels read their IO through
 * PortsContext, so the SHELL must mount this wizard inside a PortsProvider.
 */

import { useState } from "react";
import { modeCards } from "@soc/core";
import type {
  AppMode,
  ContentPlatform,
  CriblShellMode,
  LeaderProfileStore,
  SetupPath,
  WizardCapabilities,
  WizardPhase,
  WizardShape,
  WizardTarget,
} from "@soc/core";
import { AuaGate } from "../../frame/aua-gate";
import { RbacPreflightPanel } from "../preflight/rbac-preflight-panel";
import { RepositoriesScreen } from "../repositories/repositories-screen";
import { LeaderConnectStep } from "./leader-connect-step";
import type { AppliedReconnect } from "./leader-connect-step";
import { ModeCardGrid } from "./mode-card-grid";
import { TargetChooser } from "./target-chooser";
import { UploadWalkthroughStep } from "./upload-walkthrough-step";
import {
  deriveFooterStatus,
  deriveGetStarted,
  isFinalView,
  isFirstView,
  nextViewId,
  previousViewId,
  resolveCurrentViewId,
  wizardViewProgress,
  wizardViews,
} from "./setup-wizard-state";
import type { WizardFooterInput, WizardViewId } from "./setup-wizard-state";

export interface SetupWizardProps {
  /** The established connections; drives mode recommendation, card gating, and the footer. */
  capabilities: WizardCapabilities;
  /** Initial hosting target (defaults to local for the local host). */
  initialTarget?: WizardTarget;
  /** When true the target is fixed by the shell (the Cribl.Cloud app is always cribl-hosted). */
  lockTarget?: boolean;
  /** Cribl shell mode for the composed preflight panel. */
  criblShellMode: CriblShellMode;
  /** Content platform for the composed repositories step. */
  contentPlatform: ContentPlatform;
  /** The preflight panel's initial setup path. */
  defaultSetupPath?: SetupPath;
  /** Switch-account handler for the preflight panel. */
  onSwitchAccount?: () => void;
  /** Saved dual-profile store for the local leader-connect reconnect. */
  leaderProfiles?: LeaderProfileStore;
  /** Apply a validated reconnect plan (local). */
  onReconnect?: (plan: AppliedReconnect) => void | Promise<void>;
  /** Guidance for where the local shell reads leader credentials. */
  connectGuidance?: string;
  /** Guidance for where the Azure service-principal identity is configured. */
  azureConnectGuidance?: string;
  /** The packaged .tgz name for the cribl-hosted upload walkthrough. */
  uploadArtifactName?: string;
  /** Footer signal: GitHub content reachable + PAT valid (defaults false/pending). */
  repositoriesReachable?: boolean;
  /** Fully-explicit footer signals; overrides the capability-derived defaults. */
  footerOverride?: WizardFooterInput;
  /** Persist the chosen mode and enter the app. */
  onGetStarted: (mode: AppMode) => void | Promise<void>;
  /**
   * Acceptance handling when the wizard owns the AUA gate. When `accepted` is
   * false the wizard shows AuaGate first and calls `onAccept`; when omitted the
   * shell is assumed to have handled acceptance already.
   */
  accepted?: boolean;
  onAccept?: () => void | Promise<void>;
}

/** The three progress-segment labels. */
const PHASE_LABELS: Readonly<Record<WizardPhase, string>> = {
  target: "Target",
  connect: "Connect",
  mode: "Mode",
};

export function SetupWizard(props: SetupWizardProps) {
  const {
    capabilities,
    initialTarget = "local",
    lockTarget = false,
    criblShellMode,
    contentPlatform,
    defaultSetupPath,
    onSwitchAccount,
    leaderProfiles,
    onReconnect,
    connectGuidance,
    azureConnectGuidance,
    uploadArtifactName,
    repositoriesReachable = false,
    footerOverride,
    onGetStarted,
    accepted,
    onAccept,
  } = props;

  const [target, setTarget] = useState<WizardTarget>(initialTarget);
  const [chosenMode, setChosenMode] = useState<AppMode | null>(null);
  const [desiredViewId, setDesiredViewId] = useState<WizardViewId>("target");
  const [starting, setStarting] = useState(false);

  // The step list is derived with mode UNDECIDED: mode is the output of the
  // flow, not an input to step visibility, so first-run always walks the full
  // connect path regardless of what will be picked at the end.
  const shape: WizardShape = { target, mode: null };
  const views = wizardViews(shape);
  // Clamp the cursor so a target switch that drops the current view never
  // strands it (e.g. leaving leader-connect when the target becomes cribl-hosted).
  const currentViewId = resolveCurrentViewId(shape, desiredViewId);
  const currentView = views.find((v) => v.id === currentViewId) ?? views[0];

  const cards = modeCards(capabilities);
  const chosenCardAvailable =
    chosenMode !== null &&
    (cards.find((c) => c.mode === chosenMode)?.available ?? false);

  const final = isFinalView(shape, currentViewId);
  const first = isFirstView(shape, currentViewId);
  const getStarted = deriveGetStarted({
    isFinal: final,
    chosenMode,
    modeAvailable: chosenCardAvailable,
  });

  const footerInput: WizardFooterInput = footerOverride ?? {
    target,
    criblConnected: capabilities.hasCribl,
    criblChecked: capabilities.hasCribl,
    azureConnected: capabilities.hasAzure,
    azureChecked: capabilities.hasAzure,
    repositoriesReachable,
    repositoriesChecked: repositoriesReachable,
  };
  const footer = deriveFooterStatus(footerInput);

  const goNext = () => {
    const next = nextViewId(shape, currentViewId);
    if (next !== null) {
      setDesiredViewId(next);
    }
  };
  const goBack = () => {
    const prev = previousViewId(shape, currentViewId);
    if (prev !== null) {
      setDesiredViewId(prev);
    }
  };
  const changeTarget = (next: WizardTarget) => {
    setTarget(next);
    // The target step is first; stay on it after a switch.
    setDesiredViewId("target");
  };
  const start = async () => {
    if (!getStarted.ready || chosenMode === null) {
      return;
    }
    setStarting(true);
    try {
      await onGetStarted(chosenMode);
    } finally {
      setStarting(false);
    }
  };

  // AUA first when the wizard owns acceptance and it has not been given.
  if (accepted === false) {
    return <AuaGate onAccept={onAccept ?? (() => {})} />;
  }

  const progress = wizardViewProgress(currentViewId);

  return (
    <div className="wizard-screen">
      <div className="wizard-shell">
        <header className="wizard-header">
          <h1 className="wizard-title">Set up the SOC Optimization Toolkit</h1>
          <p className="wizard-subtitle">
            A short first-run flow: choose where the toolkit runs, connect Cribl
            and Azure, verify access, connect GitHub content, then pick an
            operating mode.
          </p>
        </header>

        <ol className="wizard-progress" aria-label="Setup progress">
          {progress.map((segment, index) => (
            <li
              key={segment.phase}
              className={`wizard-progress-seg wizard-progress-seg-${segment.status}`}
            >
              <span className="wizard-progress-index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="wizard-progress-label">
                {PHASE_LABELS[segment.phase]}
              </span>
            </li>
          ))}
        </ol>

        <div className="wizard-body">
          {currentViewId === "target" && (
            <TargetChooser value={target} onChange={changeTarget} locked={lockTarget} />
          )}
          {currentViewId === "upload-walkthrough" && (
            <UploadWalkthroughStep
              {...(uploadArtifactName !== undefined
                ? { artifactName: uploadArtifactName }
                : {})}
            />
          )}
          {currentViewId === "leader-connect" && (
            <LeaderConnectStep
              {...(leaderProfiles !== undefined ? { leaderProfiles } : {})}
              {...(onReconnect !== undefined ? { onReconnect } : {})}
              {...(connectGuidance !== undefined ? { connectGuidance } : {})}
            />
          )}
          {currentViewId === "connect-azure" && (
            <AzureConnectStep guidance={azureConnectGuidance} />
          )}
          {currentViewId === "preflight" && (
            <div className="wizard-step">
              <h2 className="wizard-step-title">Check permissions</h2>
              <p className="panel-desc">
                What the configured identity can and cannot do on both Azure and
                Cribl, before any deploy. This is informational - it reports
                access, it does not gate anything here.
              </p>
              <RbacPreflightPanel
                criblShellMode={criblShellMode}
                {...(defaultSetupPath !== undefined ? { defaultSetupPath } : {})}
                {...(onSwitchAccount !== undefined ? { onSwitchAccount } : {})}
              />
            </div>
          )}
          {currentViewId === "repositories" && (
            <div className="wizard-step">
              <h2 className="wizard-step-title">Connect GitHub content</h2>
              <p className="panel-desc">
                Connect to GitHub for Microsoft Sentinel content. Optional here -
                you can add or replace the token later from Repositories.
              </p>
              <RepositoriesScreen platform={contentPlatform} />
            </div>
          )}
          {currentViewId === "mode" && (
            <ModeCardGrid
              capabilities={capabilities}
              value={chosenMode}
              onChange={setChosenMode}
            />
          )}
        </div>

        <div className="wizard-footer">
          <div className="wizard-footer-status">
            <div className="wizard-status-group">
              <span className="wizard-status-group-label">Connections</span>
              {footer.connections.map((item) => (
                <span
                  key={item.id}
                  className={`wizard-status-item wizard-status-${item.tone}`}
                  title={item.detail}
                >
                  <span className="wizard-status-dot" aria-hidden="true" />
                  {item.label}
                </span>
              ))}
            </div>
            <div className="wizard-status-group">
              <span className="wizard-status-group-label">Repositories</span>
              <span
                className={`wizard-status-item wizard-status-${footer.repositories.tone}`}
                title={footer.repositories.detail}
              >
                <span className="wizard-status-dot" aria-hidden="true" />
                {footer.repositories.label}
              </span>
            </div>
          </div>

          <div className="wizard-footer-actions">
            {currentView !== undefined && currentView.skippable && !final && (
              <span className="field-hint">This step is optional.</span>
            )}
            <button
              type="button"
              className="run-button"
              onClick={goBack}
              disabled={first}
            >
              Back
            </button>
            {final ? (
              <button
                type="button"
                className="next-action-button"
                onClick={() => void start()}
                disabled={!getStarted.ready || starting}
                title={getStarted.ready ? undefined : getStarted.reason}
              >
                {starting ? "Starting..." : "Get Started"}
              </button>
            ) : (
              <button
                type="button"
                className="next-action-button"
                onClick={goNext}
              >
                Next
              </button>
            )}
          </div>
          {final && !getStarted.ready && (
            <p className="wizard-footer-hint">{getStarted.reason}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The Connect Azure step: guidance for the service-principal identity model.
 * The actual Azure connection is a service-principal (app registration) whose
 * secret the hosting shell stores; this step explains it and points forward to
 * the permission preflight, which VERIFIES access. Shell-specific specifics
 * (e.g. a config-file path) arrive as guidance text, never hard-coded here.
 */
function AzureConnectStep({ guidance }: { guidance?: string }) {
  return (
    <div className="wizard-step">
      <h2 className="wizard-step-title">Connect Azure</h2>
      <p className="panel-desc">
        Azure access uses a service principal (an app registration) with a
        client id and secret - not an interactive sign-in. The secret is stored
        write-only by the hosting shell and never returned to this page. The
        next step verifies exactly what the identity can do.
      </p>
      {guidance !== undefined && guidance !== "" ? (
        <p className="field-hint">{guidance}</p>
      ) : (
        <p className="field-hint">
          Configure the tenant, client id, and client secret in the hosting
          shell, then continue to the permission check.
        </p>
      )}
    </div>
  );
}
