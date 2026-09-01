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
 *   FIRST-RUN arc  (accept -> connect -> target -> ready):
 *     runs once per install; resume is automatic because every input fact is
 *     re-derived from persisted state on each call - there is no stored
 *     wizard-progress blob to drift (ux-flow-plan 4.2).
 *
 *   INTEGRATE arc  (choose-content -> configure -> review -> deploy ->
 *     validate -> monitor): the repeatable job. The shipped surfaces are
 *     choose-content, configure, and deploy (the existing Onboard / Batch
 *     Onboard / Options screens). REVIEW IS NOT AMONG THEM: the Unit 7
 *     deployment-preview SCREEN was deleted on 2026-08-24 (commit 1c50cdb)
 *     and the standalone Review nav item was retired by user directive on
 *     2026-07-14, so the stage is bound without a route and says so
 *     (stepper-state.ts). Its usecase survives with no caller - see
 *     [[HON-8]] and [[DBT-37]]. validate and monitor
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
 * only stage a shell actually walls off is the full-app gate it already
 * enforces (AuaGate); this module adds no new gates.
 * In particular, Deploy's blocked reasons mirror the existing Run gate
 * (identity fields + committed scope). Secret liveness is deliberately NOT
 * part of Deploy's gate - the run itself proves a stored secret - it is
 * surfaced honestly through the connect stage, nextAction, and the chips.
 *
 * MODES ARE GONE (capability-model-plan step 5). They used to prune this arc -
 * cribl-only dropped 'target', air-gapped dropped 'connect' and 'target' - so an
 * operator saw a shorter journey than the product has. Both arcs now always
 * emit in full, and a stage that cannot be completed says so through its own
 * blockedReason. Same rule step 3 applied to the nav.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto.
 */


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
  /** Both identity fields (tenantId, clientId) are set on the active config. */
  identityPresent: boolean;
  /** Client-secret liveness for the active connection (session-only). */
  secretLive: SecretLiveness;
  /** A target scope (subscription + RG + workspace) has been committed. */
  scopeCommitted: boolean;
  /**
   * Cribl reachability, when the shell knows it; undefined means unknown.
   * Optional because not every shell probes it (the cloud shell runs inside
   * the leader). An unknown value never blocks - only a KNOWN failure does.
   * Modes used to make this stricter on the Cribl-only path; with modes gone
   * there is one rule, and it is the lenient one, because the local shell
   * legitimately never proves reachability.
   */
  criblReachable?: boolean;
}

/** First-run arc stage ids, in dependency order. */
export type FirstRunStageId =
  | "accept"
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

/**
 * The full first-run arc, in dependency order. ALWAYS emitted in full - mode
 * used to prune it, and capability-model-plan step 5 removed that hiding.
 */
export const FIRST_RUN_ARC: readonly FirstRunStageId[] = [
  "accept",
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
 * shrink this list (10/20/21 ship validate; 27 ships monitor) by editing it
 * HERE, in the one journey module.
 *
 * REVIEW IS ABSENT FROM THIS LIST AND THAT IS STILL CORRECT, but not for the
 * reason previously written here. This said "Unit 7 shipped review". Unit 7
 * shipped the ENGINE; the screen that called it was deleted on 2026-08-24 and
 * the nav item was retired before that. Review is not unshipped-and-pending,
 * it is retired - which is why it renders unlinked rather than as a
 * placeholder.
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

// The one full-app wall the shells still enforce (AuaGate). Stages behind it
// are 'blocked' with the wall as their single unlock. The mode wall went with
// mode selection itself (capability-model-plan step 5).
const ACCEPT_WALL_REASON = "Accept the acceptable-use agreement to continue.";

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

/**
 * The first-run stage ids. ALWAYS the full arc
 * (capability-model-plan step 5).
 *
 * Modes used to prune this list - cribl-only dropped 'target', air-gapped
 * dropped 'connect' and 'target' - so an operator was shown a shorter journey
 * than the product actually has. That is the same hiding step 3 removed from the
 * nav, and it goes for the same reason: the stages stay visible and a stage that
 * cannot be completed says so through its own blockedReason.
 *
 * Kept as a function rather than inlining FIRST_RUN_ARC at the call sites so the
 * arc has ONE accessor, and so a future per-connection variation has somewhere
 * to live.
 */
export function firstRunStageIds(): FirstRunStageId[] {
  return [...FIRST_RUN_ARC];
}

/**
 * Whether the connect stage's outcome is satisfied.
 *
 * Azure: identity present AND the secret verified live this session -
 * 'unknown' honestly never counts as done.
 *
 * Cribl: an optional fact that only vetoes when KNOWN-false. It used to be
 * stricter in cribl-only mode, where reachability was the only thing the stage
 * proved; with modes gone there is one rule, and requiring proof of a connection
 * the operator may not be using would wall the arc on a fact that is often
 * legitimately unknown (the local shell never proves it).
 */
function connectSatisfied(facts: JourneyFacts): boolean {
  const azureOk = facts.identityPresent && facts.secretLive === "live";
  const criblOk = facts.criblReachable !== false;
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
  const wall = !facts.accepted ? ACCEPT_WALL_REASON : null;

  const ids = firstRunStageIds();
  const completion = firstRunCompletion(facts, ids);
  const firstRunDone = ids.every((id) => completion.get(id) === true);

  let currentAssigned = false;
  const firstRun: JourneyStage[] = ids.map((id) => {
    const label = JOURNEY_STAGE_LABELS[id];
    if (completion.get(id) === true) {
      return { id, label, status: "complete" as const };
    }
    // The FIRST incomplete stage is the current one - even when it is itself
    // the wall (accept): the wall stage is the thing to act on.
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
 * Returns null only when the whole journey is satisfied - every first-run
 * stage complete and content selection reached. Home falls back to its own
 * copy in that case.
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
  if (!connectSatisfied(facts)) {
    {
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
      // The Azure side is green, so the only remaining way connect can be
      // unsatisfied is a KNOWN-unreachable Cribl leader - unknown never blocks
      // (see connectSatisfied). The two cribl-only branches that used to follow
      // were unreachable once modes went, and lint caught them.
      return {
        stageId: "connect",
        label: "Restore the Cribl connection",
        description:
          "The Cribl leader is not reachable; restore the connection before deploying destinations.",
      };
    }
  }
  if (!facts.scopeCommitted) {
    return {
      stageId: "target",
      label: "Commit an Azure target",
      description:
        "Browse subscriptions and workspaces in Azure Targeting, then commit the scope with Use this target.",
    };
  }
  return {
    stageId: "choose-content",
    label: "Choose content to onboard",
    description:
      "Pick a table or vendor schemas on the Sentinel Integration page to start an integration run.",
  };
}

/**
 * The identity / secret / scope readiness chips for Home and the
 * commit-point checklists (legacy chip-checklist pattern, promoted).
 *
 * Only the secret chip can be 'unknown' - the honest hedge for a stored
 * secret whose liveness is session-only knowledge.
 *
 * Chips used to be suppressed entirely for modes without a live Azure
 * connection. With modes gone they ALWAYS render: an operator without Azure
 * access sees the same three chips reporting honestly that identity and scope
 * are missing, which is the annotate-don't-hide rule from step 3 applied to the
 * chips (capability-model-plan step 5).
 */
export function readinessChips(facts: JourneyFacts): ReadinessChip[] {
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
