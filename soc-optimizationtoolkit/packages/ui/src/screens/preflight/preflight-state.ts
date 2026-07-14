/**
 * Preflight state - the PURE decisions behind the RBAC PREFLIGHT PANEL
 * (porting-plan Unit 9, ENG-38 delta / GUI-11), kept out of the component so
 * they are unit-testable without a DOM.
 *
 * The panel is the Setup Wizard's PERMISSION-CHECK step in the onboarding
 * consent flow: before a guided deploy attempts any write, it shows the operator
 * exactly what they can and cannot do on BOTH the Azure and the Cribl side. The
 * RUN itself is the @soc/core runAzurePreflight / runCriblPreflight side-runners
 * (each TOTAL: it catches its own failures and returns a populated preflight);
 * this module owns only the surrounding pure projection:
 *
 *   - {@link deriveAzureDots} / {@link deriveCriblDots}: project a side's
 *     effective-action checks + live probes into per-capability status DOTS
 *     (granted / missing / unknown / pending). PROBES ARE TRUTH; a role name is
 *     never consulted here (the legacy role-name heuristic is the negative
 *     example this whole unit exists to replace).
 *   - {@link derivePreflightView}: compose both sides into the panel view,
 *     rendering PARTIAL RESULTS HONESTLY - one side still pending or failed never
 *     blanks the other, because each side is projected independently.
 *   - {@link preflightActions}: RETRY / SWITCH ACCOUNT enablement, in a fixed
 *     priority so the button titles never contradict the panel state.
 *
 * DEPLOY-READINESS NAMING: the combined verdict here is
 * {@link PreflightView.hasRequiredAccess} - a PERMISSION verdict, and INFORMATIONAL.
 * It is deliberately NOT named `canDeploy`: integrate-arc's `canDeploy` is the UI
 * section-gate for the actual deploy partition, and this preflight must never be
 * conflated with it or regress it. The panel reports; it does not gate.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto, no Math.random.
 */

import {
  CRIBL_CAPABILITY_PROBES,
  REQUIRED_ACTIONS,
} from "@soc/core";
import type {
  AzurePreflight,
  CriblPreflight,
  SetupPath,
} from "@soc/core";

// ---------------------------------------------------------------------------
// Loadable per-side state (UI-level)
// ---------------------------------------------------------------------------

/**
 * The lifecycle of one side's check. `idle` before any run, `pending` while a
 * side-runner is in flight, `done` once it has resolved. The two sides advance
 * INDEPENDENTLY so a slow or failed side never blocks the other from rendering.
 */
export type SidePhase = "idle" | "pending" | "done";

/** UI-level state for the Azure side. */
export interface AzureSideState {
  phase: SidePhase;
  /** The resolved side-runner result, or null until `phase === "done"`. */
  result: AzurePreflight | null;
}

/** UI-level state for the Cribl side. */
export interface CriblSideState {
  phase: SidePhase;
  /** The resolved side-runner result, or null until `phase === "done"`. */
  result: CriblPreflight | null;
}

// ---------------------------------------------------------------------------
// Capability dots
// ---------------------------------------------------------------------------

/**
 * The status of one capability dot. `granted` = confirmed available; `missing` =
 * confirmed denied (a write the caller lacks, or a probe that 401/403'd);
 * `unknown` = could not be determined (permissions unreadable, or a probe that
 * returned neither 2xx nor an explicit 401/403); `pending` = the side check is
 * still running. `unknown` is NEVER conflated with `missing`: a resource that is
 * merely absent, or a transient error, must not read as a denial.
 */
export type DotStatus = "granted" | "missing" | "unknown" | "pending";

/** One capability row rendered with a status dot. */
export interface CapabilityDot {
  /** Stable key (the action string or capability key). */
  key: string;
  /** Human-readable label. */
  label: string;
  /** The dot status. */
  status: DotStatus;
  /** Short greppable detail (empty while pending). */
  detail: string;
  /**
   * Whether this capability is REQUIRED for a deploy. Required capabilities are
   * what {@link PreflightSideView.hasRequiredAccess} is gated on; the rest are
   * informative (live existence probes decorate, they never gate on their own).
   */
  required: boolean;
}

/** The CSS tone class for a dot status (single source for the stylesheet). */
export function dotToneClass(status: DotStatus): string {
  switch (status) {
    case "granted":
      return "preflight-dot-granted";
    case "missing":
      return "preflight-dot-missing";
    case "unknown":
      return "preflight-dot-unknown";
    case "pending":
      return "preflight-dot-pending";
  }
}

/** The short status word a dot renders beside its label. */
export function dotStatusLabel(status: DotStatus): string {
  switch (status) {
    case "granted":
      return "granted";
    case "missing":
      return "missing";
    case "unknown":
      return "unknown";
    case "pending":
      return "checking";
  }
}

// ---------------------------------------------------------------------------
// Azure side projection
// ---------------------------------------------------------------------------

/**
 * Project the Azure side into capability dots. While pending (or idle), the
 * REQUIRED_ACTIONS for the setup path render as `pending` dots so the panel
 * shows WHAT is being checked before the answer arrives. Once done, each
 * required action becomes `granted`/`missing` from its effective-action check
 * (or `unknown` when the permissions API could not be read - a read failure is
 * not a denial), followed by the live existence probes as informative dots.
 */
export function deriveAzureDots(
  state: AzureSideState,
  setupPath: SetupPath,
): CapabilityDot[] {
  if (state.phase !== "done" || state.result === null) {
    return REQUIRED_ACTIONS[setupPath].map((req) => ({
      key: req.action,
      label: req.label,
      status: "pending" as DotStatus,
      detail: "",
      required: true,
    }));
  }
  const result = state.result;
  const dots: CapabilityDot[] = result.checks.map((check) => ({
    key: check.action,
    label: check.label,
    // When the permissions API itself could not be read, we do not KNOW whether
    // the action is granted - surface `unknown`, never a false `missing`.
    status: !result.permissionsFetched
      ? ("unknown" as DotStatus)
      : check.granted
        ? ("granted" as DotStatus)
        : ("missing" as DotStatus),
    detail: !result.permissionsFetched
      ? result.error !== ""
        ? result.error
        : "permissions could not be read"
      : check.granted
        ? "effective action granted"
        : "effective action not granted",
    required: true,
  }));
  for (const probe of result.probes) {
    dots.push({
      key: `probe:${probe.name}`,
      label: probe.label,
      status:
        probe.status === "ok"
          ? "granted"
          : probe.status === "denied"
            ? "missing"
            : "unknown",
      detail: probe.detail,
      required: false,
    });
  }
  return dots;
}

// ---------------------------------------------------------------------------
// Cribl side projection
// ---------------------------------------------------------------------------

/**
 * Project the Cribl side into capability dots. While pending (or idle), the
 * fixed capability catalog renders as `pending` dots. Once done, each probe maps
 * `granted`/`denied`/`unknown` straight through (a probe that could not complete
 * degrades to `unknown`, never a false `missing`). On the CLOUD shell every
 * capability reads granted-by-platform; on LOCAL the probes are genuinely
 * informative - the projection is identical either way.
 */
export function deriveCriblDots(state: CriblSideState): CapabilityDot[] {
  if (state.phase !== "done" || state.result === null) {
    return CRIBL_CAPABILITY_PROBES.map((spec) => ({
      key: spec.capability,
      label: spec.label,
      status: "pending" as DotStatus,
      detail: "",
      required: spec.required,
    }));
  }
  return state.result.probes.map((probe) => ({
    key: probe.capability,
    label: probe.label,
    status:
      probe.status === "granted"
        ? "granted"
        : probe.status === "denied"
          ? "missing"
          : "unknown",
    detail: probe.detail,
    required: probe.required,
  }));
}

// ---------------------------------------------------------------------------
// Per-side view
// ---------------------------------------------------------------------------

/** The projected view of one preflight side. */
export interface PreflightSideView {
  /** Which side. */
  side: "azure" | "cribl";
  /** Section title. */
  title: string;
  /** The side lifecycle phase. */
  phase: SidePhase;
  /** True while the side check is running (renders the checking note + spinner). */
  checking: boolean;
  /** Per-capability dots (pending placeholders while checking). */
  dots: CapabilityDot[];
  /**
   * The GRANTED ROLES decoration for this side (role/policy names). Decoration
   * ONLY - probes are the truth; a role name never flips a dot. Empty when the
   * shell supplies none.
   */
  grantedRoles: string[];
  /**
   * Whether this side has its required access. Meaningful only when
   * `phase === "done"`; false while pending/idle (unknown is not readiness).
   */
  hasRequiredAccess: boolean;
  /** Raw greppable error text for this side ('' when none). */
  error: string;
  /** An honest one-line note about this side's current state. */
  note: string;
}

/** Section title per side. */
const SIDE_TITLE: Record<"azure" | "cribl", string> = {
  azure: "Azure access",
  cribl: "Cribl access",
};

/** The honest per-side note for the current phase/result. */
function azureNote(state: AzureSideState): string {
  if (state.phase !== "done" || state.result === null) {
    return "Checking Azure permissions...";
  }
  const result = state.result;
  if (!result.configured) {
    return result.error !== ""
      ? result.error
      : "Azure target not configured - select a subscription (and resource group) first.";
  }
  if (!result.permissionsFetched) {
    return result.error !== ""
      ? `Could not read effective permissions: ${result.error}`
      : "Could not read effective permissions at this scope.";
  }
  return result.hasRequiredAccess
    ? "All required Azure actions are granted."
    : "Some required Azure actions are missing.";
}

/** The honest per-side note for the Cribl side. */
function criblNote(state: CriblSideState): string {
  if (state.phase !== "done" || state.result === null) {
    return "Checking Cribl capabilities...";
  }
  const result = state.result;
  if (result.error !== "") {
    return result.error;
  }
  if (result.mode === "cloud") {
    return "Cribl capabilities are granted by the platform on this shell.";
  }
  return result.hasRequiredAccess
    ? "All required Cribl capabilities are granted."
    : "Some required Cribl capabilities are missing.";
}

// ---------------------------------------------------------------------------
// Actions (retry / switch account)
// ---------------------------------------------------------------------------

/** RETRY / SWITCH ACCOUNT enablement, with the disabled reason when applicable. */
export interface PreflightActionsView {
  /** Whether a re-run can start (no run is currently in flight). */
  canRetry: boolean;
  /** Why retry is disabled, or null when enabled. */
  retryReason: string | null;
  /** Whether the Switch Account action is available and can be invoked now. */
  canSwitchAccount: boolean;
  /** Why Switch Account is disabled, or null when enabled. */
  switchAccountReason: string | null;
}

/** Reason shown while a check is in flight. */
export const PREFLIGHT_RUNNING_REASON = "A permission check is already running.";

/** Reason shown when the shell wired no Switch Account handler. */
export const PREFLIGHT_NO_SWITCH_REASON =
  "This build has no account switcher - reconnect from the connection bar instead.";

/**
 * Derive RETRY / SWITCH ACCOUNT enablement. Fixed priority: a run in flight
 * disables BOTH (retry would double-run; switching identity mid-check would
 * discard in-flight results). Switch Account additionally requires the shell to
 * have wired a handler - absent one, the button stays visible-but-disabled with
 * the reason (affordances are never hidden).
 */
export function preflightActions(
  anyPending: boolean,
  switchAccountAvailable: boolean,
): PreflightActionsView {
  const running = anyPending;
  return {
    canRetry: !running,
    retryReason: running ? PREFLIGHT_RUNNING_REASON : null,
    canSwitchAccount: switchAccountAvailable && !running,
    switchAccountReason: running
      ? PREFLIGHT_RUNNING_REASON
      : switchAccountAvailable
        ? null
        : PREFLIGHT_NO_SWITCH_REASON,
  };
}

// ---------------------------------------------------------------------------
// Combined view
// ---------------------------------------------------------------------------

/** Input to {@link derivePreflightView}. */
export interface PreflightViewInput {
  /** The setup path being checked (selects the Azure required-action set). */
  setupPath: SetupPath;
  /** The Azure side's UI state. */
  azure: AzureSideState;
  /** The Cribl side's UI state. */
  cribl: CriblSideState;
  /** Whether the shell wired a Switch Account handler. */
  switchAccountAvailable: boolean;
  /**
   * OPTIONAL granted-roles decoration per side (role/policy names). Decoration
   * only - never consulted for readiness.
   */
  grantedRoles?: { azure?: readonly string[]; cribl?: readonly string[] };
}

/** The full panel view. */
export interface PreflightView {
  /** The Azure side. */
  azure: PreflightSideView;
  /** The Cribl side. */
  cribl: PreflightSideView;
  /** True while EITHER side is still running. */
  anyPending: boolean;
  /** True only once BOTH sides have resolved. */
  bothDone: boolean;
  /**
   * The combined PERMISSION verdict: both sides done AND both have their
   * required access. INFORMATIONAL - named distinctly from integrate-arc's
   * `canDeploy` on purpose; the panel never gates the actual deploy partition.
   */
  hasRequiredAccess: boolean;
  /** One-line summary, honest about pending/partial state. */
  summary: string;
  /** RETRY / SWITCH ACCOUNT enablement. */
  actions: PreflightActionsView;
}

/** The first Azure-side issue phrase, or null when the side is ready. */
function firstAzureIssue(result: AzurePreflight): string | null {
  if (result.hasRequiredAccess) {
    return null;
  }
  if (!result.configured) {
    return result.error !== "" ? result.error : "Azure not configured";
  }
  if (!result.permissionsFetched) {
    return "cannot read Azure permissions";
  }
  for (const check of result.checks) {
    if (!check.granted) {
      return `cannot ${check.label.toLowerCase()}`;
    }
  }
  return "Azure access missing";
}

/** The first Cribl-side issue phrase, or null when the side is ready. */
function firstCriblIssue(result: CriblPreflight): string | null {
  if (result.hasRequiredAccess) {
    return null;
  }
  if (result.error !== "") {
    return result.error;
  }
  for (const probe of result.probes) {
    if (probe.required && probe.status !== "granted") {
      return `cannot ${probe.label.toLowerCase()}`;
    }
  }
  return "Cribl access missing";
}

/** Compose the honest one-line summary. */
function summarize(input: PreflightViewInput): string {
  const azureDone = input.azure.phase === "done" && input.azure.result !== null;
  const criblDone = input.cribl.phase === "done" && input.cribl.result !== null;
  if (!azureDone || !criblDone) {
    return "Checking required access...";
  }
  // Both done here (the null-guards above narrow the results).
  const azureResult = input.azure.result as AzurePreflight;
  const criblResult = input.cribl.result as CriblPreflight;
  if (azureResult.hasRequiredAccess && criblResult.hasRequiredAccess) {
    return "All required access verified.";
  }
  const issues: string[] = [];
  const azureIssue = firstAzureIssue(azureResult);
  if (azureIssue !== null) {
    issues.push(`Azure: ${azureIssue}`);
  }
  const criblIssue = firstCriblIssue(criblResult);
  if (criblIssue !== null) {
    issues.push(`Cribl: ${criblIssue}`);
  }
  return `Missing required access - ${issues.join("; ")}`;
}

/**
 * Compose the full panel view from both sides' independent UI state. Each side
 * is projected on its own so PARTIAL RESULTS RENDER HONESTLY: a still-pending or
 * failed side shows its own note and dots without blanking the other side.
 */
export function derivePreflightView(input: PreflightViewInput): PreflightView {
  const azureDone = input.azure.phase === "done" && input.azure.result !== null;
  const criblDone = input.cribl.phase === "done" && input.cribl.result !== null;

  const azureView: PreflightSideView = {
    side: "azure",
    title: SIDE_TITLE.azure,
    phase: input.azure.phase,
    checking: input.azure.phase === "pending" || input.azure.phase === "idle",
    dots: deriveAzureDots(input.azure, input.setupPath),
    grantedRoles: [...(input.grantedRoles?.azure ?? [])],
    hasRequiredAccess: azureDone
      ? (input.azure.result as AzurePreflight).hasRequiredAccess
      : false,
    error: azureDone ? (input.azure.result as AzurePreflight).error : "",
    note: azureNote(input.azure),
  };

  const criblView: PreflightSideView = {
    side: "cribl",
    title: SIDE_TITLE.cribl,
    phase: input.cribl.phase,
    checking: input.cribl.phase === "pending" || input.cribl.phase === "idle",
    dots: deriveCriblDots(input.cribl),
    grantedRoles: [...(input.grantedRoles?.cribl ?? [])],
    hasRequiredAccess: criblDone
      ? (input.cribl.result as CriblPreflight).hasRequiredAccess
      : false,
    error: criblDone ? (input.cribl.result as CriblPreflight).error : "",
    note: criblNote(input.cribl),
  };

  const anyPending =
    input.azure.phase === "pending" || input.cribl.phase === "pending";
  const bothDone = azureDone && criblDone;

  return {
    azure: azureView,
    cribl: criblView,
    anyPending,
    bothDone,
    hasRequiredAccess:
      bothDone &&
      azureView.hasRequiredAccess &&
      criblView.hasRequiredAccess,
    summary: summarize(input),
    actions: preflightActions(anyPending, input.switchAccountAvailable),
  };
}
