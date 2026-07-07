/**
 * First-run wizard - THE PURE RULES BEHIND THE LOCAL-APP SETUP WIZARD.
 *
 * Unit 22 (GUI-03 delta). The consent flow, permission matrix, and RBAC
 * preflight shipped in Phases 1-2; the Cribl auth manager already exists.
 * This module is the remaining pure logic that ASSEMBLES those pieces into a
 * coherent first-run wizard, ported from the legacy SetupWizard.tsx
 * (IS-R/pages/SetupWizard.tsx) step/skip semantics but with its bug classes
 * fixed. Four concerns, all pure data + total functions:
 *
 *   1. MODE AUTO-SELECTION MATRIX - {hasCribl, hasAzure} capability booleans
 *      -> the recommended AppMode plus which mode cards are available vs
 *      gated. Reuses the shared AppMode type (no parallel mode enum).
 *
 *   2. TARGET CHOOSER - Cribl-hosted vs local as a typed choice, with the
 *      tradeoff (what each target can / cannot do) carried as DATA the UI
 *      renders, never as prose baked into a component.
 *
 *   3. LEADER-CONNECT rules (local target) - base-URL DERIVATION (cloud org
 *      -> workspace host; self-managed protocol+address+port -> leader URL),
 *      the /api/v1-suffix rejection carried verbatim from the local host's
 *      config validator, and DUAL-PROFILE SWAP semantics that fix the legacy
 *      reconnect-with-divergent-overrides bug class: a reconnect validates
 *      the override SET and the stored secret AS ONE UNIT and never
 *      half-applies (the legacy handler mutated a possibly-wrong-profile auth
 *      object field by field, so a cloud override could ride a self-managed
 *      secret).
 *
 *   4. WIZARD STEP / SKIP progression - which steps show per target+mode,
 *      which are skippable, and a stable 3-segment progress derivation. Like
 *      journey-state, everything is RE-DERIVED from inputs on each call - there
 *      is no stored wizard-progress blob to drift - and step visibility reuses
 *      the app-mode capability predicates (hasAzure/hasCribl) exactly as
 *      firstRunStageIds does.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto, no Math.random.
 */

import { hasAzure, hasCribl } from "../app-mode";
import type { AppMode } from "../app-mode";

// ---------------------------------------------------------------------------
// 1. Mode auto-selection matrix
// ---------------------------------------------------------------------------

/**
 * The live-connection capabilities the wizard has established so far. Both
 * default to false (nothing connected) so a partially-filled wizard maps to a
 * safe recommendation.
 */
export interface WizardCapabilities {
  /** A live Cribl connection has been established (or will be). */
  hasCribl: boolean;
  /** A live Azure connection has been established (or will be). */
  hasAzure: boolean;
}

/**
 * The capability each mode REQUIRES to be selectable. Expressed once, here, so
 * {@link modeCards} availability can never disagree with {@link recommendMode}.
 * air-gapped requires neither - it is always available.
 */
const MODE_REQUIREMENTS: Readonly<
  Record<AppMode, { azure: boolean; cribl: boolean }>
> = {
  full: { azure: true, cribl: true },
  "azure-only": { azure: true, cribl: false },
  "cribl-only": { azure: false, cribl: true },
  "air-gapped": { azure: false, cribl: false },
};

/** Whether `caps` satisfy a mode's requirement (both required links present). */
function modeAvailable(mode: AppMode, caps: WizardCapabilities): boolean {
  const req = MODE_REQUIREMENTS[mode];
  return (!req.azure || caps.hasAzure) && (!req.cribl || caps.hasCribl);
}

/**
 * The recommended mode for a capability pair - the RICHEST mode both links
 * support. Both links -> full; Azure only -> azure-only; Cribl only ->
 * cribl-only; neither -> air-gapped. The result is ALWAYS an available mode
 * (pinned by test), so the recommended card is never a gated one.
 */
export function recommendMode(caps: WizardCapabilities): AppMode {
  if (caps.hasAzure && caps.hasCribl) {
    return "full";
  }
  if (caps.hasAzure) {
    return "azure-only";
  }
  if (caps.hasCribl) {
    return "cribl-only";
  }
  return "air-gapped";
}

/** One selectable mode card for the wizard's mode step. */
export interface ModeCard {
  mode: AppMode;
  /** Human-facing card title. */
  label: string;
  /** One-line description of what the mode does. */
  description: string;
  /** False when the mode's required link is not connected (card is gated). */
  available: boolean;
  /** True for exactly one card: the {@link recommendMode} result. */
  recommended: boolean;
}

/** Display copy per mode, kept out of the UI so both shells share one source. */
const MODE_COPY: Readonly<Record<AppMode, { label: string; description: string }>> =
  {
    full: {
      label: "Full integration",
      description:
        "Deploy DCRs to Azure, build and upload packs to Cribl, wire sources, and validate data flow end to end.",
    },
    "azure-only": {
      label: "Azure only",
      description:
        "Deploy DCRs and custom tables to Azure; build Cribl packs as downloadable artifacts for manual import.",
    },
    "cribl-only": {
      label: "Cribl only",
      description:
        "Upload packs to Cribl and wire sources; generate ARM templates as downloadable artifacts for manual Azure deployment.",
    },
    "air-gapped": {
      label: "Air-gapped (offline)",
      description:
        "No live connections; export packs, ARM templates, and deployment instructions as artifacts to apply manually.",
    },
  };

/** The canonical mode order for the wizard's card list. */
export const WIZARD_MODE_ORDER: readonly AppMode[] = [
  "full",
  "azure-only",
  "cribl-only",
  "air-gapped",
];

/**
 * The full mode-card matrix for a capability pair: one card per mode in a
 * stable order, each carrying availability and the single recommended flag.
 * The recommended card is always available.
 */
export function modeCards(caps: WizardCapabilities): ModeCard[] {
  const recommended = recommendMode(caps);
  return WIZARD_MODE_ORDER.map((mode) => ({
    mode,
    label: MODE_COPY[mode].label,
    description: MODE_COPY[mode].description,
    available: modeAvailable(mode, caps),
    recommended: mode === recommended,
  }));
}

// ---------------------------------------------------------------------------
// 2. Target chooser
// ---------------------------------------------------------------------------

/**
 * Where the toolkit itself runs:
 *
 *   cribl-hosted - inside a Cribl.Cloud workspace leader (the sandboxed
 *                  browser app; the Cribl connection is implicit).
 *   local        - the local Node host on the operator's machine, which
 *                  connects out to any leader (Cribl.Cloud or self-managed).
 */
export type WizardTarget = "cribl-hosted" | "local";

/** All target values, for runtime listing / validation. */
export const WIZARD_TARGETS: readonly WizardTarget[] = ["cribl-hosted", "local"];

/** The tradeoff data for one target - rendered by the UI, never prose in it. */
export interface TargetTradeoff {
  target: WizardTarget;
  label: string;
  /** One-line summary of the target. */
  summary: string;
  /** What this target CAN do (capabilities). */
  can: readonly string[];
  /** What this target CANNOT do (limitations). */
  cannot: readonly string[];
}

/**
 * The tradeoff table both targets are chosen against. Frozen data: the UI maps
 * over `can`/`cannot`, so the comparison lives here, testable, not scattered
 * across JSX.
 */
export const TARGET_TRADEOFFS: Readonly<Record<WizardTarget, TargetTradeoff>> = {
  "cribl-hosted": {
    target: "cribl-hosted",
    label: "Cribl-hosted",
    summary:
      "Runs inside the Cribl.Cloud workspace leader - no local install to manage.",
    can: [
      "Runs inside the Cribl.Cloud leader with no software to install",
      "Uploads packs straight to the workspace over the control-plane API",
      "Ships and updates alongside the workspace",
    ],
    cannot: [
      "Cannot reach on-prem or self-managed leaders outside Cribl.Cloud",
      "Cannot write to the operator's disk - artifacts download through the browser",
      "Bound by the proxy request budget, so content is fetched lazily, never bulk-mirrored",
    ],
  },
  local: {
    target: "local",
    label: "Local host",
    summary:
      "Runs the local Node host on your machine and connects out to any leader.",
    can: [
      "Connects to any leader - Cribl.Cloud or on-prem / self-managed",
      "Installs packs directly onto the leader from the host",
      "Writes air-gap artifacts to local disk",
    ],
    cannot: [
      "Requires installing and running the local host on the operator's machine",
      "Reads leader credentials from the host config - no browser OAuth handoff",
    ],
  },
};

/** The tradeoff table as an ordered list (cribl-hosted first). */
export function targetTradeoffs(): TargetTradeoff[] {
  return WIZARD_TARGETS.map((t) => TARGET_TRADEOFFS[t]);
}

// ---------------------------------------------------------------------------
// 3. Leader-connect rules (local target)
// ---------------------------------------------------------------------------

/**
 * The two leader deployment shapes the wizard distinguishes (legacy naming):
 *
 *   cloud        - a Cribl.Cloud workspace (base URL derived from the org id).
 *   self-managed - an on-prem / self-managed leader (base URL from
 *                  protocol + address + port).
 */
export type LeaderDeploymentType = "cloud" | "self-managed";

/** A derivation result: a normalized base URL, or an actionable error. */
export type BaseUrlResult =
  | { ok: true; baseUrl: string }
  | { ok: false; error: string };

// The exact /api/v1-suffix message the local host's config validator uses, kept
// verbatim so the wizard and the host speak with one voice.
const API_V1_SUFFIX_ERROR =
  'The leader base URL must not end with /api/v1 - the toolkit appends /api/v1 to every leader call itself; use the bare leader base URL.';
const SCHEME_ERROR =
  "The leader base URL must start with http:// or https://.";
const EMPTY_URL_ERROR = "Enter a leader base URL.";
const EMPTY_ORG_ERROR = "Enter your Cribl.Cloud organization id.";
const ORG_CHARS_ERROR =
  "The organization id may only contain letters, numbers, and hyphens.";
const EMPTY_ADDRESS_ERROR = "Enter the leader address (IP or FQDN).";

/**
 * Normalize a leader base URL the operator typed or pasted. TOTAL - never
 * throws. Applies, in order: reject empty; require an http/https scheme;
 * reject a trailing /api/v1 (the host appends it) with the verbatim host
 * message; strip trailing slashes. This is the ONE base-URL gate every
 * derivation funnels through, so the /api/v1 rule is unavoidable.
 */
export function normalizeLeaderBaseUrl(raw: string): BaseUrlResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: EMPTY_URL_ERROR };
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, error: SCHEME_ERROR };
  }
  if (/\/api\/v1\/*$/i.test(trimmed)) {
    return { ok: false, error: API_V1_SUFFIX_ERROR };
  }
  return { ok: true, baseUrl: trimmed.replace(/\/+$/, "") };
}

/**
 * Derive the Cribl.Cloud workspace base URL from an organization id:
 * `https://main-{org}.cribl.cloud`. Rejects an empty or malformed org id
 * rather than emitting a broken host.
 */
export function deriveCloudBaseUrl(organizationId: string): BaseUrlResult {
  const org = organizationId.trim();
  if (org === "") {
    return { ok: false, error: EMPTY_ORG_ERROR };
  }
  if (/[^A-Za-z0-9-]/.test(org)) {
    return { ok: false, error: ORG_CHARS_ERROR };
  }
  return { ok: true, baseUrl: `https://main-${org}.cribl.cloud` };
}

/** Inputs for a self-managed leader base URL. */
export interface SelfManagedLeaderInput {
  protocol: "https" | "http";
  /** Leader IP or FQDN. May be a bare host or a full URL (which wins). */
  address: string;
  /** Optional port; omitted from the URL when empty. */
  port?: string;
}

/**
 * Derive a self-managed leader base URL from protocol + address + optional
 * port, then run it through {@link normalizeLeaderBaseUrl} so a pasted
 * `.../api/v1` is still rejected. If `address` already carries an http/https
 * scheme it is treated as a full URL and normalized directly (protocol/port
 * are ignored), so a paste is never double-schemed.
 */
export function deriveSelfManagedBaseUrl(
  input: SelfManagedLeaderInput,
): BaseUrlResult {
  const address = input.address.trim();
  if (address === "") {
    return { ok: false, error: EMPTY_ADDRESS_ERROR };
  }
  if (/^https?:\/\//i.test(address)) {
    return normalizeLeaderBaseUrl(address);
  }
  const port = (input.port ?? "").trim();
  const composed = `${input.protocol}://${address}${port === "" ? "" : `:${port}`}`;
  return normalizeLeaderBaseUrl(composed);
}

/**
 * A saved leader profile for one deployment type. The secret NEVER lives here
 * (it is in the encrypted secrets store); `hasSecret` only records whether one
 * is stored for THIS profile.
 */
export interface StoredLeaderProfile {
  deploymentType: LeaderDeploymentType;
  clientId: string;
  baseUrl: string;
  /** Whether an encrypted secret is stored FOR THIS profile. */
  hasSecret: boolean;
  /** The org id (cloud profiles only). */
  organizationId?: string;
}

/**
 * Both saved profiles, keyed by deployment type. The legacy app kept these in
 * two encrypted files and swapped between them; the divergent-override bug came
 * from falling back to whichever profile existed when the requested one did
 * not.
 */
export interface LeaderProfileStore {
  cloud: StoredLeaderProfile | null;
  selfManaged: StoredLeaderProfile | null;
}

/**
 * The overrides a reconnect carries from the form: the deployment type the
 * user is reconnecting AS, plus any edited base URL / org id / client id. The
 * secret is NOT here - reconnect reuses the stored secret for the SAME profile.
 */
export interface ReconnectOverrides {
  deploymentType: LeaderDeploymentType;
  baseUrl?: string;
  organizationId?: string;
  clientId?: string;
}

/**
 * A fully-resolved, validated reconnect. Emitted only when the override set and
 * the stored secret agree AS ONE UNIT; the shell applies these values wholesale
 * or, on `{ ok: false }`, applies NOTHING.
 */
export type ReconnectPlan =
  | {
      ok: true;
      deploymentType: LeaderDeploymentType;
      clientId: string;
      baseUrl: string;
      /** Present for cloud reconnects only. */
      organizationId?: string;
    }
  | { ok: false; error: string };

// Reconnect error copy. NO_SAVED / NO_SECRET are the two clean failures that
// replace the legacy silent fallback + half-apply.
const noSavedProfileError = (type: LeaderDeploymentType): string =>
  `No saved ${type} credentials to reconnect. Connect and save a ${type} profile first.`;
const noStoredSecretError = (type: LeaderDeploymentType): string =>
  `The saved ${type} profile has no stored secret. Enter the secret and connect instead of reconnecting.`;
const DIVERGENT_CLOUD_ERROR =
  "The base URL and organization id disagree. Clear one so the reconnect uses a single consistent target.";

/** Pick an override string only when non-empty (legacy truthiness), else the fallback. */
function pickOverride(override: string | undefined, fallback: string): string {
  return override !== undefined && override.trim() !== ""
    ? override.trim()
    : fallback;
}

/**
 * Plan a dual-profile reconnect, VALIDATING THE OVERRIDE SET AND THE STORED
 * SECRET AS ONE UNIT.
 *
 * The critical fix over the legacy `auth:cribl-reconnect` handler, which:
 *   - fell back to `loadCriblAuth()` (whichever profile existed) when the
 *     requested deployment type had no saved profile, then
 *   - mutated that possibly-wrong-profile auth object field by field
 *     (`if (overrides.baseUrl) auth.baseUrl = ...`),
 * so a cloud override could ride a self-managed secret - a DIVERGENT,
 * half-applied connection.
 *
 * Here the profile is selected STRICTLY by the override deployment type with NO
 * cross-profile fallback: if that profile is absent, or has no stored secret,
 * the reconnect fails cleanly and changes nothing. The base URL is then
 * resolved and validated in full (for cloud, an edited base URL that disagrees
 * with the org id is rejected rather than one silently winning), and a plan is
 * returned only when every field plus the stored secret are consistent.
 */
export function planReconnect(
  store: LeaderProfileStore,
  overrides: ReconnectOverrides,
): ReconnectPlan {
  const type = overrides.deploymentType;
  const profile = type === "cloud" ? store.cloud : store.selfManaged;

  // No cross-profile fallback: a divergent-type reconnect fails cleanly.
  if (profile === null) {
    return { ok: false, error: noSavedProfileError(type) };
  }
  if (!profile.hasSecret) {
    return { ok: false, error: noStoredSecretError(type) };
  }

  const clientId = pickOverride(overrides.clientId, profile.clientId);

  if (type === "cloud") {
    const org = pickOverride(overrides.organizationId, profile.organizationId ?? "");
    const derived = deriveCloudBaseUrl(org);
    if (!derived.ok) {
      return { ok: false, error: derived.error };
    }
    // If the operator also edited the base URL, it must agree with the org id -
    // never let one half-apply over the other.
    if (overrides.baseUrl !== undefined && overrides.baseUrl.trim() !== "") {
      const edited = normalizeLeaderBaseUrl(overrides.baseUrl);
      if (!edited.ok) {
        return { ok: false, error: edited.error };
      }
      if (edited.baseUrl !== derived.baseUrl) {
        return { ok: false, error: DIVERGENT_CLOUD_ERROR };
      }
    }
    return {
      ok: true,
      deploymentType: "cloud",
      clientId,
      baseUrl: derived.baseUrl,
      organizationId: org,
    };
  }

  // self-managed: resolve from the edited base URL or the stored one, validated.
  const source = pickOverride(overrides.baseUrl, profile.baseUrl);
  const normalized = normalizeLeaderBaseUrl(source);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  return {
    ok: true,
    deploymentType: "self-managed",
    clientId,
    baseUrl: normalized.baseUrl,
  };
}

// ---------------------------------------------------------------------------
// 4. Wizard step / skip progression
// ---------------------------------------------------------------------------

/**
 * The wizard's concrete steps. The cribl-side step differs by target:
 * cribl-hosted shows an upload walkthrough (package the .tgz, upload the app),
 * local shows leader-connect (base-URL + dual-profile). Azure is the same step
 * for both targets.
 */
export type WizardStepId =
  | "target"
  | "upload-walkthrough"
  | "leader-connect"
  | "connect-azure"
  | "mode";

/**
 * The three STABLE progress segments (the legacy 3-dot bar). Step count varies
 * with target and mode, but the bar is always Target -> Connect -> Mode; every
 * connection/bootstrap step folds into the single Connect segment.
 */
export type WizardPhase = "target" | "connect" | "mode";

/** The three progress phases in order. */
export const WIZARD_PHASES: readonly WizardPhase[] = [
  "target",
  "connect",
  "mode",
];

/** Which of the three phases a step belongs to. */
const STEP_PHASE: Readonly<Record<WizardStepId, WizardPhase>> = {
  target: "target",
  "upload-walkthrough": "connect",
  "leader-connect": "connect",
  "connect-azure": "connect",
  mode: "mode",
};

/** One wizard step: its id, label, phase, and whether it can be skipped. */
export interface WizardStep {
  id: WizardStepId;
  label: string;
  phase: WizardPhase;
  /** Skippable steps mirror the legacy "Skip Cribl" / "Skip Azure" actions. */
  skippable: boolean;
}

/** The current target + mode the step list is derived for. */
export interface WizardShape {
  /** The hosting target chosen in step 1. */
  target: WizardTarget;
  /** The operating mode; null means not yet decided (show all connect steps). */
  mode: AppMode | null;
}

const STEP_LABELS: Readonly<Record<WizardStepId, string>> = {
  target: "Choose target",
  "upload-walkthrough": "Upload the app",
  "leader-connect": "Connect leader",
  "connect-azure": "Connect Azure",
  mode: "Mode",
};

/**
 * The steps that show for a target + mode.
 *
 * Rules (reusing the app-mode capability predicates, exactly as
 * firstRunStageIds does):
 *   - `target` always shows first and is NOT skippable (a target must be
 *     chosen).
 *   - the cribl-side step shows when the mode has a live Cribl link, or when
 *     the mode is undecided (null) so the user can connect and let the mode
 *     auto-select. Its identity is target-driven: upload-walkthrough for
 *     cribl-hosted, leader-connect for local. It is skippable.
 *   - `connect-azure` shows when the mode has a live Azure link, or when the
 *     mode is undecided. It is skippable.
 *   - `mode` always shows last and is NOT skippable (a mode must be chosen).
 *
 * air-gapped therefore yields [target, mode]; cribl-only drops the Azure step;
 * azure-only drops the cribl step; full and null show both connect steps.
 */
export function wizardSteps(shape: WizardShape): WizardStep[] {
  const { target, mode } = shape;
  const steps: WizardStep[] = [makeStep("target", false)];

  const showCribl = mode === null || hasCribl(mode);
  const showAzure = mode === null || hasAzure(mode);

  if (showCribl) {
    const criblStepId: WizardStepId =
      target === "cribl-hosted" ? "upload-walkthrough" : "leader-connect";
    steps.push(makeStep(criblStepId, true));
  }
  if (showAzure) {
    steps.push(makeStep("connect-azure", true));
  }
  steps.push(makeStep("mode", false));
  return steps;
}

function makeStep(id: WizardStepId, skippable: boolean): WizardStep {
  return { id, label: STEP_LABELS[id], phase: STEP_PHASE[id], skippable };
}

/** Whether a given step is skippable for a target + mode. */
export function isStepSkippable(
  shape: WizardShape,
  stepId: WizardStepId,
): boolean {
  const step = wizardSteps(shape).find((s) => s.id === stepId);
  return step !== undefined && step.skippable;
}

/** A progress segment's status relative to the current step. */
export type SegmentStatus = "complete" | "current" | "upcoming";

/** One of the three progress segments with its status. */
export interface WizardSegment {
  phase: WizardPhase;
  status: SegmentStatus;
}

/**
 * Derive the 3-segment progress bar from the current step. RE-DERIVED from the
 * current step (never a stored counter), so a skip - which just advances the
 * current step - moves the bar without any separate bookkeeping. Phases before
 * the current step's phase are complete, its own phase is current, later phases
 * are upcoming.
 */
export function wizardProgress(currentStepId: WizardStepId): WizardSegment[] {
  const currentPhase = STEP_PHASE[currentStepId];
  const currentIndex = WIZARD_PHASES.indexOf(currentPhase);
  return WIZARD_PHASES.map((phase, index) => {
    let status: SegmentStatus;
    if (index < currentIndex) {
      status = "complete";
    } else if (index === currentIndex) {
      status = "current";
    } else {
      status = "upcoming";
    }
    return { phase, status };
  });
}
