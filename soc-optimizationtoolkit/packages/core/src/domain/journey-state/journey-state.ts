/**
 * Journey state - THE PURE MODULE BEHIND THE GUIDED JOURNEY.
 *
 * ux-flow-plan section 4.1 (Unit 6.5). The successor to the legacy
 * SentinelIntegration sectionDone/canDeploy chain: ONE derivation from
 * readiness facts to a per-stage status rail, ONE next-action headline, and
 * ONE set of readiness chips. Unit 20 EXTENDS this module with run facts
 * (JobStore summaries, review approval, wiring) - it never gets a second
 * implementation.
 *
 * Two arcs are modeled:
 *
 *   FIRST-RUN arc  (accept -> choose-mode -> connect -> target -> ready):
 *     runs once per install; resume is automatic because every input fact is
 *     re-derived from persisted state on each call - there is no stored
 *     wizard-progress blob to drift (ux-flow-plan 4.2).
 *
 *   INTEGRATE arc  (choose-content -> configure -> review -> deploy ->
 *     validate -> monitor): the repeatable job. The shipped surfaces are
 *     choose-content, configure, and deploy (the existing Onboard / Batch
 *     Onboard / Options screens) plus review (the Unit 7 deployment-preview
 *     screen - the ux-flow-plan 5.2 REVIEW stage); validate and monitor
 *     render as HONEST 'not-yet-available' placeholders until their units
 *     land (10/20/21, 27) - see UNSHIPPED_INTEGRATE_STAGES.
 *
 * Inputs are SPLIT readiness facts (replacing the conflated five-field
 * ONBOARD_REQUIRED_FIELDS gate): identity presence (tenantId + clientId),
 * secret liveness as a tri-state (liveness is session-only, so a stored
 * secret is honestly 'unknown', never silently 'live'), committed scope
 * (subscription + resource group + workspace), and optional Cribl
 * reachability. The shells derive the facts from signals they already own;
 * this module only maps facts to statuses and text.
 *
 * READ-AHEAD contract (user decision, binding): every stage of the active
 * arcs is visible and navigable; gating happens ONLY at the commit actions
 * that already exist inside the screens (accept, Use this target, Run). A
 * 'blocked' status therefore means "this stage's commit action is gated -
 * here is the single unlock condition", NOT "you cannot look at it". The
 * only stages a shell actually walls off are the two full-app gates it
 * already enforces (AuaGate, ModeSelect); this module adds no new gates.
 * In particular, Deploy's blocked reasons mirror the existing Run gate
 * (identity fields + committed scope). Secret liveness is deliberately NOT
 * part of Deploy's gate - the run itself proves a stored secret - it is
 * surfaced honestly through the connect stage, nextAction, and the chips.
 *
 * Mode honesty:
 *   - Artifact modes skip live-connection stages entirely rather than
 *     showing them locked: cribl-only has no 'target' stage, air-gapped has
 *     neither 'connect' nor 'target' (plan 4.1 contract).
 *   - Modes without a live Azure connection (cribl-only, air-gapped) have no
 *     shipped Integrate surface today (onboard requires both; batch-onboard
 *     relaxes to azure per the recorded Unit 6.5 decision), so their
 *     Integrate stages render 'not-yet-available' with an honest reason -
 *     never as a teaser.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto.
 */

import { hasAzure, hasCribl } from "../app-mode";
import type { AppMode } from "../app-mode";

/**
 * Client-secret liveness. Liveness is SESSION-ONLY knowledge:
 *
 *   live    - the secret was entered and connected in THIS session.
 *   unknown - a stored secret may exist (e.g. persisted from a previous
 *             session) but nothing this session has proven it works. The
 *             honest hedge: 'unknown' never renders as done or ok.
 *   missing - no secret is stored at all.
 */
export type SecretLiveness = "live" | "unknown" | "missing";

/**
 * The readiness facts the shells derive from signals they already own.
 * This is the SPLIT replacement for the conflated five-field gate: identity
 * (tenantId + clientId) and scope (subscriptionId + resourceGroup +
 * workspaceName) are separate layers, and the secret is a tri-state.
 */
export interface JourneyFacts {
  /** Acceptable-use agreement accepted (persisted AcceptanceRecord parsed). */
  accepted: boolean;
  /** Operating mode; null means not yet chosen (ModeSelect still walls). */
  mode: AppMode | null;
  /** Both identity fields (tenantId, clientId) are set on the active config. */
  identityPresent: boolean;
  /** Client-secret liveness for the active connection (session-only). */
  secretLive: SecretLiveness;
  /** A target scope (subscription + RG + workspace) has been committed. */
  scopeCommitted: boolean;
  /**
   * Cribl reachability, when the shell knows it; undefined means unknown.
   * Optional because not every shell probes it (the cloud shell runs inside
   * the leader). In full mode an unknown value never blocks (only a known
   * failure does); in cribl-only mode the Cribl link is the ONLY thing the
   * connect stage proves, so unknown honestly stays incomplete - the same
   * rule that keeps an unknown secret from rendering as done.
   */
  criblReachable?: boolean;
}

/** First-run arc stage ids, in dependency order. */
export type FirstRunStageId =
  | "accept"
  | "choose-mode"
  | "connect"
  | "target"
  | "ready";

/** Integrate arc stage ids, in dependency order. */
export type IntegrateStageId =
  | "choose-content"
  | "configure"
  | "review"
  | "deploy"
  | "validate"
  | "monitor";

/** Any journey stage id. */
export type JourneyStageId = FirstRunStageId | IntegrateStageId;

/** The full first-run arc, in dependency order (mode filtering may omit stages). */
export const FIRST_RUN_ARC: readonly FirstRunStageId[] = [
  "accept",
  "choose-mode",
  "connect",
  "target",
  "ready",
];

/** The full integrate arc, in dependency order (always emitted in full). */
export const INTEGRATE_ARC: readonly IntegrateStageId[] = [
  "choose-content",
  "configure",
  "review",
  "deploy",
  "validate",
  "monitor",
];

/**
 * Integrate stages whose product surface has NOT shipped yet. They render
 * 'not-yet-available' - an honest placeholder, never a teaser. Later units
 * shrink this list (Unit 7 shipped review; 10/20/21 ship validate; 27 ships
 * monitor) by editing it HERE, in the one journey module.
 */
export const UNSHIPPED_INTEGRATE_STAGES: readonly IntegrateStageId[] = [
  "validate",
  "monitor",
];

/**
 * Per-stage status:
 *
 *   complete          - the stage's outcome is satisfied by the facts.
 *   current           - the single stage to act on next (at most one across
 *                       BOTH arcs; exactly one whenever any stage is
 *                       actionable for the mode).
 *   available         - navigable and readable now (read-ahead); its own
 *                       commit gates still apply inside the screen.
 *   blocked           - navigable, but its commit action is gated;
 *                       blockedReason names the SINGLE unlock condition.
 *   not-yet-available - the stage's surface has not shipped (for this mode);
 *                       blockedReason says so honestly.
 */
export type StageStatus =
  | "complete"
  | "current"
  | "available"
  | "blocked"
  | "not-yet-available";

/** One rail entry. blockedReason is present exactly when the status is 'blocked' or 'not-yet-available'. */
export interface JourneyStage {
  id: JourneyStageId;
  label: string;
  status: StageStatus;
  /** The single unlock condition (blocked) or the honest not-shipped note. */
  blockedReason?: string;
}

/** Both arcs, derived together so 'current' is unique across the journey. */
export interface Journey {
  firstRun: JourneyStage[];
  integrate: JourneyStage[];
}

/** The ONE thing Home headlines: a stage plus imperative copy for it. */
export interface NextAction {
  stageId: JourneyStageId;
  /** Short imperative, e.g. "Commit an Azure target". */
  label: string;
  /** One sentence of supporting copy. */
  description: string;
}

/** Readiness-chip state. Only the secret chip can be 'unknown'. */
export type ChipState = "ok" | "missing" | "unknown";

/** One readiness chip for Home / the commit-point checklists. */
export interface ReadinessChip {
  id: "identity" | "secret" | "scope";
  label: string;
  state: ChipState;
  hint: string;
}

/** Display labels, exported so rails and gate panels share one source. */
export const JOURNEY_STAGE_LABELS: Readonly<Record<JourneyStageId, string>> = {
  accept: "Acceptable use",
  "choose-mode": "Mode",
  connect: "Connect",
  target: "Target",
  ready: "Readiness",
  "choose-content": "Choose content",
  configure: "Configure",
  review: "Review",
  deploy: "Deploy",
  validate: "Validate",
  monitor: "Monitor",
};

// The two full-app walls the shells already enforce (AuaGate, ModeSelect).
// Stages behind a wall are 'blocked' with the wall as their one unlock.
const ACCEPT_WALL_REASON = "Accept the acceptable-use agreement to continue.";
const MODE_WALL_REASON = "Choose an operating mode to continue.";

// Honest not-shipped notes for the placeholder integrate stages.
const UNSHIPPED_REASONS: Partial<Record<IntegrateStageId, string>> = {
  validate: "The post-deploy validation stage has not shipped yet.",
  monitor:
    "The monitoring dashboard has not shipped yet; observe completed runs in Recent runs and Logs.",
};

// Deploy's blocked-reason cascade mirrors the EXISTING Run gate (identity
// fields + committed scope) and names exactly one missing thing, identity
// first because scope selection depends on it.
const DEPLOY_NEEDS_IDENTITY_REASON =
  "Enter the tenant and client IDs in Connect first.";
const DEPLOY_NEEDS_SCOPE_REASON =
  "Commit an Azure target (subscription, resource group, and workspace) first.";

/** Honest reason the shipped integrate stages do not exist for a mode yet. */
function integrateModeReason(mode: AppMode): string {
  if (mode === "air-gapped") {
    return "Air-gapped artifact onboarding has not shipped yet.";
  }
  return "Onboarding needs a live Azure connection in this release.";
}

/**
 * The first-run stage ids for a mode. Artifact modes SKIP live-connection
 * stages entirely rather than showing them locked (plan 4.1 contract):
 * cribl-only has no 'target', air-gapped has neither 'connect' nor 'target'.
 * With mode null (not yet chosen) the generic full arc is returned; it
 * re-derives per mode the moment one is chosen.
 */
export function firstRunStageIds(mode: AppMode | null): FirstRunStageId[] {
  if (mode === null) {
    return [...FIRST_RUN_ARC];
  }
  const ids: FirstRunStageId[] = ["accept", "choose-mode"];
  if (hasAzure(mode) || hasCribl(mode)) {
    ids.push("connect");
  }
  if (hasAzure(mode)) {
    ids.push("target");
  }
  ids.push("ready");
  return ids;
}

/**
 * Whether the connect stage's outcome is satisfied.
 *
 * Azure side (modes with live Azure): identity present AND secret verified
 * live this session - 'unknown' honestly never counts as done.
 * Cribl side: in cribl-only mode reachability must be known-true (it is the
 * only thing the stage proves); in full mode the optional fact only vetoes
 * when known-false (unknown never blocks a mode whose primary signal is
 * the Azure identity).
 */
function connectSatisfied(facts: JourneyFacts): boolean {
  const mode = facts.mode;
  if (mode === null) {
    return false;
  }
  const azureOk =
    !hasAzure(mode) ||
    (facts.identityPresent && facts.secretLive === "live");
  const criblOk = !hasCribl(mode)
    ? true
    : mode === "cribl-only"
      ? facts.criblReachable === true
      : facts.criblReachable !== false;
  return azureOk && criblOk;
}

/** Stage-by-stage completion for the first-run arc, in arc order. */
function firstRunCompletion(
  facts: JourneyFacts,
  ids: readonly FirstRunStageId[],
): Map<FirstRunStageId, boolean> {
  const completion = new Map<FirstRunStageId, boolean>();
  let allPriorDone = true;
  for (const id of ids) {
    let done: boolean;
    switch (id) {
      case "accept":
        done = facts.accepted;
        break;
      case "choose-mode":
        done = facts.mode !== null;
        break;
      case "connect":
        done = connectSatisfied(facts);
        break;
      case "target":
        done = facts.scopeCommitted;
        break;
      case "ready":
        // Derived cap of the arc: complete exactly when everything before it
        // is. Never 'current' - its surface (Home's chips) only summarizes.
        done = allPriorDone;
        break;
    }
    completion.set(id, done);
    allPriorDone = allPriorDone && done;
  }
  return completion;
}

/**
 * Derive both arcs from the facts.
 *
 * Guarantees (pinned by tests):
 *   - the stage LISTS depend only on the mode - facts change statuses, never
 *     which stages exist, so a blocked later stage can never hide an earlier
 *     one;
 *   - at most one 'current' across both arcs, and it is exactly the stage
 *     {@link nextAction} points at;
 *   - every 'blocked' / 'not-yet-available' stage carries a blockedReason,
 *     and no other status does;
 *   - read-ahead: past the two full-app walls, incomplete first-run stages
 *     after the current one are 'available' (navigable), never 'blocked',
 *     and earlier integrate stages stay navigable while Deploy is blocked.
 */
export function deriveJourney(facts: JourneyFacts): Journey {
  const wall = !facts.accepted
    ? ACCEPT_WALL_REASON
    : facts.mode === null
      ? MODE_WALL_REASON
      : null;

  const ids = firstRunStageIds(facts.mode);
  const completion = firstRunCompletion(facts, ids);
  const firstRunDone = ids.every((id) => completion.get(id) === true);

  let currentAssigned = false;
  const firstRun: JourneyStage[] = ids.map((id) => {
    const label = JOURNEY_STAGE_LABELS[id];
    if (completion.get(id) === true) {
      return { id, label, status: "complete" as const };
    }
    // The FIRST incomplete stage is the current one - even when it is itself
    // a wall (accept / choose-mode): the wall stage is the thing to act on.
    if (!currentAssigned) {
      currentAssigned = true;
      return { id, label, status: "current" as const };
    }
    // Later incomplete stages: behind a wall they are blocked with the wall
    // as the single unlock; otherwise read-ahead keeps them navigable.
    if (wall !== null) {
      return { id, label, status: "blocked" as const, blockedReason: wall };
    }
    return { id, label, status: "available" as const };
  });

  const integrate: JourneyStage[] = INTEGRATE_ARC.map((id) => {
    const label = JOURNEY_STAGE_LABELS[id];
    const unshippedReason = UNSHIPPED_REASONS[id];
    if (unshippedReason !== undefined) {
      return {
        id,
        label,
        status: "not-yet-available" as const,
        blockedReason: unshippedReason,
      };
    }
    // Capability absence outranks fact walls: a mode with no shipped surface
    // for the stage is honestly 'not-yet-available' regardless of facts.
    if (facts.mode !== null && !hasAzure(facts.mode)) {
      return {
        id,
        label,
        status: "not-yet-available" as const,
        blockedReason: integrateModeReason(facts.mode),
      };
    }
    if (wall !== null) {
      return { id, label, status: "blocked" as const, blockedReason: wall };
    }
    if (id === "choose-content") {
      // The integrate arc's entry stage becomes current the moment the
      // first-run arc is green; before that it is still navigable
      // (read-ahead) - typing table names commits nothing.
      return {
        id,
        label,
        status: firstRunDone ? ("current" as const) : ("available" as const),
      };
    }
    if (id === "configure" || id === "review") {
      // Review (Unit 7's deployment preview) is READ-AHEAD like configure:
      // always navigable, never a hard gate on Deploy - its acknowledge
      // check arms only the handoff button on the Review screen itself,
      // and the acknowledgement is transient, never persisted as consent.
      return { id, label, status: "available" as const };
    }
    // deploy: mirror the EXISTING Run gate - identity fields + committed
    // scope - naming exactly one missing thing. Secret liveness is not part
    // of this gate (the run proves a stored secret; honesty lives in the
    // connect stage and the chips). No new gates.
    if (!facts.identityPresent) {
      return {
        id,
        label,
        status: "blocked" as const,
        blockedReason: DEPLOY_NEEDS_IDENTITY_REASON,
      };
    }
    if (!facts.scopeCommitted) {
      return {
        id,
        label,
        status: "blocked" as const,
        blockedReason: DEPLOY_NEEDS_SCOPE_REASON,
      };
    }
    return { id, label, status: "available" as const };
  });

  return { firstRun, integrate };
}

/**
 * The ONE thing Home headlines. Mirrors {@link deriveJourney}'s 'current'
 * stage exactly (pinned by test), with fact-aware imperative copy following
 * the legacy single-next-action hint cascade: each result names the single
 * missing thing in dependency order.
 *
 * Returns null when nothing in the journey is actionable - today that is
 * cribl-only / air-gapped once their first-run arc is green (their integrate
 * surfaces have not shipped); Home then falls back to the honest mode note.
 */
export function nextAction(facts: JourneyFacts): NextAction | null {
  if (!facts.accepted) {
    return {
      stageId: "accept",
      label: "Accept the acceptable-use agreement",
      description:
        "Review and accept the agreement; nothing else unlocks until acceptance is recorded.",
    };
  }
  const mode = facts.mode;
  if (mode === null) {
    return {
      stageId: "choose-mode",
      label: "Choose your operating mode",
      description:
        "Pick which live connections this install may use; navigation and the journey derive from the choice.",
    };
  }
  if (!connectSatisfied(facts)) {
    if (hasAzure(mode)) {
      if (!facts.identityPresent) {
        return {
          stageId: "connect",
          label: "Enter your Azure identity",
          description:
            "Provide the tenant and client IDs, then save and connect the client secret.",
        };
      }
      if (facts.secretLive === "missing") {
        return {
          stageId: "connect",
          label: "Connect the client secret",
          description:
            "Enter the client secret and connect; liveness is only tracked for this session.",
        };
      }
      if (facts.secretLive === "unknown") {
        return {
          stageId: "connect",
          label: "Verify the stored client secret",
          description:
            "A stored secret may exist, but liveness is only known per session - re-enter or verify it before relying on it.",
        };
      }
      // Azure side is green, so the miss is the Cribl link (full mode with
      // criblReachable === false).
      return {
        stageId: "connect",
        label: "Restore the Cribl connection",
        description:
          "The Cribl leader is not reachable; restore the connection before deploying destinations.",
      };
    }
    // cribl-only: the Cribl link is the only thing connect proves.
    if (facts.criblReachable === false) {
      return {
        stageId: "connect",
        label: "Restore the Cribl connection",
        description:
          "The Cribl leader is not reachable; restore the connection to continue.",
      };
    }
    return {
      stageId: "connect",
      label: "Verify the Cribl connection",
      description:
        "Cribl reachability is unknown; verify the leader connection to continue.",
    };
  }
  if (hasAzure(mode) && !facts.scopeCommitted) {
    return {
      stageId: "target",
      label: "Commit an Azure target",
      description:
        "Browse subscriptions and workspaces in Azure Targeting, then commit the scope with Use this target.",
    };
  }
  if (hasAzure(mode)) {
    return {
      stageId: "choose-content",
      label: "Choose content to onboard",
      description:
        "Pick a table or vendor schemas on Onboard or DCR Automation to start an integration run.",
    };
  }
  return null;
}

/**
 * The identity / secret / scope readiness chips for Home and the
 * commit-point checklists (legacy chip-checklist pattern, promoted).
 *
 * Only the secret chip can be 'unknown' - the honest hedge for a stored
 * secret whose liveness is session-only knowledge. Chips exist only for
 * modes with a live Azure connection; other modes (and mode-not-chosen)
 * return an empty list rather than rendering meaningless red chips.
 */
export function readinessChips(facts: JourneyFacts): ReadinessChip[] {
  if (!hasAzure(facts.mode)) {
    return [];
  }
  const identity: ReadinessChip = facts.identityPresent
    ? {
        id: "identity",
        label: "Identity",
        state: "ok",
        hint: "Tenant and client IDs are set.",
      }
    : {
        id: "identity",
        label: "Identity",
        state: "missing",
        hint: "Enter the tenant and client IDs in Connect.",
      };
  const secret: ReadinessChip =
    facts.secretLive === "live"
      ? {
          id: "secret",
          label: "Secret",
          state: "ok",
          hint: "Client secret connected this session.",
        }
      : facts.secretLive === "unknown"
        ? {
            id: "secret",
            label: "Secret",
            state: "unknown",
            hint: "A stored secret may exist, but liveness is only known per session - verify before relying on it.",
          }
        : {
            id: "secret",
            label: "Secret",
            state: "missing",
            hint: "Enter and connect the client secret.",
          };
  const scope: ReadinessChip = facts.scopeCommitted
    ? {
        id: "scope",
        label: "Scope",
        state: "ok",
        hint: "Target scope committed.",
      }
    : {
        id: "scope",
        label: "Scope",
        state: "missing",
        hint: "Commit a subscription, resource group, and workspace in Azure Targeting.",
      };
  return [identity, secret, scope];
}
