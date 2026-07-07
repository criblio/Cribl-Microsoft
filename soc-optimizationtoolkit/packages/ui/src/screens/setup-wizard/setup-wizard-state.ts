/**
 * Setup wizard state - the PURE UI-side decisions that ASSEMBLE the already-built
 * first-run pieces into one coherent Setup Wizard (porting-plan Unit 22, GUI-03
 * delta), kept out of the component so they are unit-testable without a DOM.
 *
 * @soc/core's first-run-wizard module owns the abstract RULES (the mode
 * auto-selection matrix, the target tradeoff table, the leader base-URL
 * derivation, the dual-profile reconnect, the abstract step list + 3-segment
 * progress). This module only layers the CONCRETE-SCREEN decisions the assembled
 * wizard adds on top of those rules:
 *
 *   - {@link wizardViews}: the concrete ordered screen list, GROWN from the core
 *     step list (target -> cribl-side connect -> azure connect -> mode) by
 *     injecting the two connect-phase panels the wizard reuses - the RBAC
 *     preflight (Unit 9) and the Repositories/PAT step (Unit 14) - as the tail
 *     of the Connect phase, right before Mode. Target-specific visibility (the
 *     cribl-side step is the .tgz upload walkthrough for cribl-hosted, the
 *     leader-connect form for local) and mode-gated visibility both come from
 *     the core rules verbatim, so the assembled list can never disagree with
 *     them.
 *   - {@link nextViewId} / {@link previousViewId} / {@link resolveCurrentViewId}:
 *     Back / forward navigation over that derived list, RE-DERIVED from the
 *     current view id on every call (no stored index to drift when the target
 *     switch changes the step set out from under the cursor).
 *   - {@link wizardViewProgress}: the 3-segment progress bar, delegating to the
 *     core phase->segment derivation (the injected panels map to the Connect
 *     segment).
 *   - {@link deriveFooterStatus}: the persistent Connections + Repositories
 *     status footer (legacy-flow-analysis.md wizard bar), with the cribl-hosted
 *     target's implicit-by-platform Cribl link reflected honestly.
 *   - {@link deriveGetStarted}: the Get Started enablement gate - reachable only
 *     on the final Mode view, only once an AVAILABLE mode is chosen, with the
 *     single always-visible-disabled reason otherwise.
 *   - {@link deriveLeaderBaseUrl}: the target-specific base-URL dispatcher for
 *     the leader-connect step (cloud org id vs self-managed protocol/address/
 *     port), surfacing the core /api/v1 fix message either way.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto, no Math.random.
 */

import {
  deriveCloudBaseUrl,
  deriveSelfManagedBaseUrl,
  hasAzure,
  hasCribl,
  wizardProgress,
  wizardSteps,
} from "@soc/core";
import type {
  AppMode,
  BaseUrlResult,
  LeaderDeploymentType,
  WizardPhase,
  WizardSegment,
  WizardShape,
  WizardStepId,
  WizardTarget,
} from "@soc/core";

// ---------------------------------------------------------------------------
// Concrete screen (view) list
// ---------------------------------------------------------------------------

/**
 * The two connect-phase panels the wizard REUSES that the core step model does
 * not enumerate (it models the abstract connect steps; these are concrete
 * shipped screens folded into the Connect phase):
 *
 *   preflight    - the Unit 9 RBAC preflight panel (reports Azure + Cribl access).
 *   repositories - the Unit 14 Repositories / GitHub-PAT step.
 */
export type WizardExtraViewId = "preflight" | "repositories";

/** A concrete wizard screen id: a core abstract step or one of the reused panels. */
export type WizardViewId = WizardStepId | WizardExtraViewId;

/** One concrete wizard screen: its id, label, progress phase, and skippability. */
export interface WizardView {
  id: WizardViewId;
  /** Human-facing step label. */
  label: string;
  /** Which of the three progress segments the screen belongs to. */
  phase: WizardPhase;
  /** Skippable screens mirror the legacy "Skip" affordance (never target/mode). */
  skippable: boolean;
}

/** Labels for the two reused panels (core owns the abstract-step labels). */
const EXTRA_VIEW_LABELS: Readonly<Record<WizardExtraViewId, string>> = {
  preflight: "Check permissions",
  repositories: "Connect GitHub",
};

/**
 * The concrete ordered screen list for a target + mode.
 *
 * Grown from the core {@link wizardSteps} list: every core step is kept in
 * order (so target-specific and mode-gated visibility come straight from the
 * core rules), and the two reused connect-phase panels are injected right
 * before the final Mode step - preflight then repositories - so the assembled
 * order is target -> cribl-side connect -> azure connect -> preflight ->
 * repositories -> mode.
 *
 * The two panels are shown whenever the shape is NOT a decided air-gapped
 * re-run (mode null, or a mode with a live Azure or Cribl link): reusing the
 * app-mode capability predicates exactly as the core step rules do, so a
 * reconfigure straight to air-gapped drops the connect panels rather than
 * offering a permission check for links it will never use.
 */
export function wizardViews(shape: WizardShape): WizardView[] {
  const showConnectPanels =
    shape.mode === null || hasAzure(shape.mode) || hasCribl(shape.mode);
  const views: WizardView[] = [];
  for (const step of wizardSteps(shape)) {
    if (step.id === "mode" && showConnectPanels) {
      views.push(makeExtraView("preflight"));
      views.push(makeExtraView("repositories"));
    }
    views.push({
      id: step.id,
      label: step.label,
      phase: step.phase,
      skippable: step.skippable,
    });
  }
  return views;
}

function makeExtraView(id: WizardExtraViewId): WizardView {
  // The reused panels are connect-phase and skippable (they inform, never gate).
  return { id, label: EXTRA_VIEW_LABELS[id], phase: "connect", skippable: true };
}

/** The concrete view ids for a shape, in order. */
export function wizardViewIds(shape: WizardShape): WizardViewId[] {
  return wizardViews(shape).map((view) => view.id);
}

/**
 * The next view id after `currentId`, or null when `currentId` is the last view
 * (or is not in the current list). RE-DERIVED so a target switch that changes
 * the list is always navigated against the current shape.
 */
export function nextViewId(
  shape: WizardShape,
  currentId: WizardViewId,
): WizardViewId | null {
  const ids = wizardViewIds(shape);
  const index = ids.indexOf(currentId);
  if (index < 0 || index >= ids.length - 1) {
    return null;
  }
  return ids[index + 1] ?? null;
}

/**
 * The previous view id before `currentId`, or null when `currentId` is the
 * first view (or is not in the current list).
 */
export function previousViewId(
  shape: WizardShape,
  currentId: WizardViewId,
): WizardViewId | null {
  const ids = wizardViewIds(shape);
  const index = ids.indexOf(currentId);
  if (index <= 0) {
    return null;
  }
  return ids[index - 1] ?? null;
}

/**
 * Clamp a desired view id to one that exists for the current shape: the desired
 * id when it is still present, otherwise the first view (target). Callers use
 * this after a target switch so the cursor never lands on a view the new target
 * dropped (e.g. moving off leader-connect when the target becomes cribl-hosted).
 */
export function resolveCurrentViewId(
  shape: WizardShape,
  desired: WizardViewId,
): WizardViewId {
  const ids = wizardViewIds(shape);
  return ids.includes(desired) ? desired : (ids[0] ?? "target");
}

/** Whether a view is the final (Mode) view for the shape. */
export function isFinalView(shape: WizardShape, viewId: WizardViewId): boolean {
  const ids = wizardViewIds(shape);
  return ids.length > 0 && ids[ids.length - 1] === viewId;
}

/** Whether a view is the first (Target) view for the shape. */
export function isFirstView(shape: WizardShape, viewId: WizardViewId): boolean {
  const ids = wizardViewIds(shape);
  return ids.length > 0 && ids[0] === viewId;
}

/**
 * The 3-segment progress bar for a concrete view. Delegates to the core
 * phase->segment derivation; the two injected connect-phase panels map to a
 * connect step so they light the Connect segment exactly like the core connect
 * steps do.
 */
export function wizardViewProgress(viewId: WizardViewId): WizardSegment[] {
  const stepId: WizardStepId =
    viewId === "preflight" || viewId === "repositories"
      ? "connect-azure"
      : viewId;
  return wizardProgress(stepId);
}

// ---------------------------------------------------------------------------
// Connections + Repositories status footer
// ---------------------------------------------------------------------------

/** Status palette for a footer item (matches the CSS status tokens). */
export type WizardStatusTone = "ready" | "pending" | "attention";

/** One status item in the wizard footer. */
export interface WizardStatusItem {
  id: string;
  label: string;
  /** One-line detail under the label. */
  detail: string;
  tone: WizardStatusTone;
}

/** The persistent footer: the two connection dots plus the repositories dot. */
export interface WizardFooterStatus {
  connections: WizardStatusItem[];
  repositories: WizardStatusItem;
}

/** The live signals the footer reflects (all shell-supplied booleans). */
export interface WizardFooterInput {
  /** The hosting target (cribl-hosted implies the Cribl link is by-platform). */
  target: WizardTarget;
  /** A live Cribl connection has been established (ignored for cribl-hosted). */
  criblConnected: boolean;
  /** A Cribl connect / preflight attempt has run (distinguishes pending vs attention). */
  criblChecked: boolean;
  /** A live Azure connection has been established. */
  azureConnected: boolean;
  /** An Azure connect / preflight attempt has run. */
  azureChecked: boolean;
  /** GitHub content is reachable and the PAT (if any) is valid. */
  repositoriesReachable: boolean;
  /** A repositories reachability check has run. */
  repositoriesChecked: boolean;
}

/** Derive a status tone from connected / checked booleans. */
function toneFor(connected: boolean, checked: boolean): WizardStatusTone {
  if (connected) {
    return "ready";
  }
  return checked ? "attention" : "pending";
}

/**
 * Derive the Connections + Repositories status footer. The cribl-hosted target
 * reports its Cribl link as ready-by-platform (the app runs inside the leader,
 * so there is nothing to connect); every other dot follows the connected /
 * checked signals honestly - pending before any attempt, attention after a
 * failed one, ready once established.
 */
export function deriveFooterStatus(
  input: WizardFooterInput,
): WizardFooterStatus {
  const criblByPlatform = input.target === "cribl-hosted";
  const criblConnected = criblByPlatform || input.criblConnected;
  const criblTone: WizardStatusTone = criblByPlatform
    ? "ready"
    : toneFor(input.criblConnected, input.criblChecked);
  const azureTone = toneFor(input.azureConnected, input.azureChecked);
  const repoTone = toneFor(input.repositoriesReachable, input.repositoriesChecked);
  return {
    connections: [
      {
        id: "cribl",
        label: "Cribl",
        detail: criblByPlatform
          ? "Connected by platform (running inside the Cribl leader)."
          : criblConnected
            ? "Connected to the leader."
            : input.criblChecked
              ? "Not connected - complete the Connect leader step."
              : "Not connected yet.",
        tone: criblTone,
      },
      {
        id: "azure",
        label: "Azure",
        detail: input.azureConnected
          ? "Connected with a valid service principal."
          : input.azureChecked
            ? "Not connected - check the Connect Azure step."
            : "Not connected yet.",
        tone: azureTone,
      },
    ],
    repositories: {
      id: "repositories",
      label: "Repositories",
      detail: input.repositoriesReachable
        ? "GitHub reachable - Sentinel content available."
        : input.repositoriesChecked
          ? "GitHub not reachable - check the token in the Connect GitHub step."
          : "Not checked yet (optional).",
      tone: repoTone,
    },
  };
}

// ---------------------------------------------------------------------------
// Get Started enablement
// ---------------------------------------------------------------------------

/** Get Started is reachable only on the final Mode view. */
export const GET_STARTED_NOT_FINAL_REASON =
  "Reach the Mode step to finish - use Next to continue.";
/** No mode picked on the Mode view yet. */
export const GET_STARTED_NO_MODE_REASON =
  "Choose an operating mode to continue.";
/** The picked mode is gated (its required connection is not established). */
export const GET_STARTED_MODE_UNAVAILABLE_REASON =
  "The chosen mode needs a connection that is not established - pick an available mode or go back and connect.";

/** The inputs the Get Started gate reads. */
export interface GetStartedInput {
  /** Whether the current view is the final Mode view. */
  isFinal: boolean;
  /** The mode chosen on the Mode step, null until one is picked. */
  chosenMode: AppMode | null;
  /**
   * Whether the chosen mode is AVAILABLE for the current capabilities (from the
   * core modeCards availability flag). Ignored when no mode is chosen.
   */
  modeAvailable: boolean;
}

/** The Get Started gate: ready, or a single always-visible-disabled reason. */
export type GetStartedGate =
  | { ready: true }
  | { ready: false; reason: string };

/**
 * The Get Started enablement gate. Enabled only on the final Mode view, only
 * once a mode is chosen, and only when that mode is available for the
 * established connections - otherwise a single, specific reason so the button
 * stays visible-but-disabled with an explanation (never a silent dead control).
 */
export function deriveGetStarted(input: GetStartedInput): GetStartedGate {
  if (!input.isFinal) {
    return { ready: false, reason: GET_STARTED_NOT_FINAL_REASON };
  }
  if (input.chosenMode === null) {
    return { ready: false, reason: GET_STARTED_NO_MODE_REASON };
  }
  if (!input.modeAvailable) {
    return { ready: false, reason: GET_STARTED_MODE_UNAVAILABLE_REASON };
  }
  return { ready: true };
}

// ---------------------------------------------------------------------------
// Leader-connect base-URL dispatch (local target)
// ---------------------------------------------------------------------------

/** The leader-connect form values, one shape covering both deployment types. */
export interface LeaderConnectFormInput {
  deploymentType: LeaderDeploymentType;
  /** Cribl.Cloud organization id (cloud deployment type). */
  organizationId: string;
  /** Self-managed protocol. */
  protocol: "https" | "http";
  /** Self-managed leader IP or FQDN (a full URL wins). */
  address: string;
  /** Self-managed optional port. */
  port: string;
}

/**
 * Derive the leader base URL for the current form, dispatching to the right
 * core derivation by deployment type: the Cribl.Cloud org id for cloud, or the
 * protocol/address/port composition for self-managed. Both funnel through the
 * core normalizer, so a pasted `.../api/v1` still surfaces the verbatim host
 * fix message either way.
 */
export function deriveLeaderBaseUrl(
  input: LeaderConnectFormInput,
): BaseUrlResult {
  if (input.deploymentType === "cloud") {
    return deriveCloudBaseUrl(input.organizationId);
  }
  return deriveSelfManagedBaseUrl({
    protocol: input.protocol,
    address: input.address,
    port: input.port,
  });
}
