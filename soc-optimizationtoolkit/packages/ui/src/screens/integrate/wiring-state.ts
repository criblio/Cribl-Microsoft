/**
 * Wiring section state - the PURE decisions behind the Integrate arc's
 * post-deploy WIRING section (porting-plan Unit 20 UI: "sections 4-6 ... wiring
 * with a Lake toggle"), kept out of the component so they are unit-testable
 * without a DOM.
 *
 * @soc/core owns the load-bearing rules this module composes:
 *   - {@link canWireSource}: source wiring is offered only AFTER a successful
 *     deploy and only when Cribl is not skipped (the legacy showed Section 6
 *     only when deployComplete && criblConnected).
 *   - {@link deployModeGating}: which halves a mode skips (skipAzure/skipCribl).
 *   - {@link planSourceWiring} (planned by planWireSource, written by
 *     applyWireSource through the shared route-insert writer): the ROUTE ORDER
 *     SEMANTICS - Lake is a CLOUD-only capability, so the Lake toggle is only
 *     OFFERED for a cloud deployment and forced off otherwise.
 *
 * This module adds only the SHELL-level projection the section renders:
 *   - the unlock chain (why wiring is locked, in one sentence),
 *   - lake-toggle gating (available only for a cloud Cribl deployment),
 *   - the single unlock condition each action shows when disabled (wire the
 *     source; ensure the named Cribl secret).
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto.
 */

import { canWireSource, deployModeGating } from "@soc/core";
import type {
  ApplyRouteInsertOutcome,
  ApplyWireSourceResult,
  CriblDeploymentType,
  DeployMode,
  PlanWireSourceResult,
  ReadyWireSource,
} from "@soc/core";

/**
 * The Cribl deployment flavor the shell reports (undefined when a shell does
 * not declare one). Lake federation exists only on cloud, so an undefined or
 * "onprem" value hides the Lake toggle entirely.
 */
export type WiringDeploymentType = CriblDeploymentType | undefined;

/** The raw section values the component holds before reducing to a decision. */
export interface WiringInputs {
  /** A deploy run on this page has finished successfully (wiring's driver). */
  deployCompleted: boolean;
  /** The active integration mode (drives skipAzure/skipCribl). */
  mode: DeployMode;
  /** The Cribl deployment flavor the shell reports (cloud enables Lake). */
  deploymentType: WiringDeploymentType;
  /** A Cribl worker group is selected in the Cribl Configuration section. */
  workerGroupSelected: boolean;
  /** A non-empty pack name is set in the Cribl Configuration section. */
  packNameSet: boolean;
  /** The Cribl source as typed: its id, or `<type>:<id>`. */
  sourceId: string;
  /** Whether the operator asked for the full-fidelity Cribl Lake copy. */
  lakeRequested: boolean;
  /** The target Cribl Lake dataset id (only meaningful when Lake applies). */
  lakeDataset: string;
  /** Transient ingestion client secret for the ensure-secret action. */
  secretValue: string;
}

/** The resolved wiring-section decision the component renders. */
export interface WiringState {
  /** Whether the wiring section's actions are unlocked at all. */
  unlocked: boolean;
  /** The single reason wiring is locked, or null when unlocked. */
  lockReason: string | null;
  /** Whether the Lake toggle is OFFERED (cloud Cribl deployment only). */
  lakeAvailable: boolean;
  /** The EFFECTIVE Lake choice: requested AND available (forced off when not). */
  lakeEffective: boolean;
  /** The single unlock condition for "Wire source", or null when it can run. */
  wireDisabledReason: string | null;
  /** Whether "Wire source" can run. */
  canWire: boolean;
  /** The single unlock condition for "Ensure secret", or null when it can run. */
  secretDisabledReason: string | null;
  /** Whether "Ensure Cribl secret" can run. */
  canEnsureSecret: boolean;
}

// One home for every wiring reason string, so the section and its tests never
// drift. Each names exactly ONE next thing to do (the readiness-footer idiom).
export const WIRING_NEEDS_DEPLOY_REASON =
  "Run a successful deploy in the Deploy section first - there is nothing to " +
  "wire a source to until the pack's destination is live.";
export const WIRING_CRIBL_SKIPPED_REASON =
  "Source wiring needs a live Cribl connection; this mode skips Cribl.";
export const WIRING_NEEDS_WORKER_GROUP_REASON =
  "Select a Cribl worker group in Cribl Configuration first.";
export const WIRING_NEEDS_PACK_NAME_REASON =
  "Set a pack name in Cribl Configuration first.";
export const WIRING_NEEDS_SOURCE_REASON =
  "Enter the Cribl source id to route from (the input the pipeline reads).";
export const WIRING_NEEDS_DATASET_REASON =
  "Enter a Cribl Lake dataset id for the full-fidelity copy, or turn Lake off.";
export const WIRING_NEEDS_SECRET_REASON =
  "Enter the ingestion client secret to store as the named Cribl secret.";

/**
 * Why wiring is locked, or null when it is unlocked. Mirrors
 * {@link canWireSource}'s two false cases in order: a deploy has not completed,
 * or the mode skips Cribl (no source to wire).
 */
export function wiringLockReason(
  deployCompleted: boolean,
  mode: DeployMode,
): string | null {
  if (deployModeGating(mode).skipCribl) {
    return WIRING_CRIBL_SKIPPED_REASON;
  }
  if (!deployCompleted) {
    return WIRING_NEEDS_DEPLOY_REASON;
  }
  return null;
}

/**
 * Whether the Lake toggle is offered: only for a CLOUD Cribl deployment (Lake
 * federation is cloud-only, planSourceWiring never produces a Lake route
 * otherwise). An undefined deployment type (shell did not declare one) hides it.
 */
export function isLakeAvailable(deploymentType: WiringDeploymentType): boolean {
  return deploymentType === "cloud";
}

/**
 * Reduce the section's raw values to the wiring decision. The wire/secret
 * disabled reasons cascade in dependency order (unlock -> worker group -> pack
 * name -> the action's own field), so the section always names exactly one next
 * step. The Lake choice is EFFECTIVE only when cloud offers it, so an onprem
 * deployment can never accidentally request a Lake route.
 */
export function deriveWiringState(inputs: WiringInputs): WiringState {
  const unlocked = canWireSource(inputs.deployCompleted, inputs.mode);
  const lockReason = wiringLockReason(inputs.deployCompleted, inputs.mode);
  const lakeAvailable = isLakeAvailable(inputs.deploymentType);
  const lakeEffective = inputs.lakeRequested && lakeAvailable;

  const wireDisabledReason = ((): string | null => {
    if (!unlocked) {
      return lockReason;
    }
    if (!inputs.workerGroupSelected) {
      return WIRING_NEEDS_WORKER_GROUP_REASON;
    }
    if (!inputs.packNameSet) {
      return WIRING_NEEDS_PACK_NAME_REASON;
    }
    if (inputs.sourceId.trim() === "") {
      return WIRING_NEEDS_SOURCE_REASON;
    }
    if (lakeEffective && inputs.lakeDataset.trim() === "") {
      return WIRING_NEEDS_DATASET_REASON;
    }
    return null;
  })();

  const secretDisabledReason = ((): string | null => {
    if (!unlocked) {
      return lockReason;
    }
    if (!inputs.workerGroupSelected) {
      return WIRING_NEEDS_WORKER_GROUP_REASON;
    }
    if (inputs.secretValue.trim() === "") {
      return WIRING_NEEDS_SECRET_REASON;
    }
    return null;
  })();

  return {
    unlocked,
    lockReason,
    lakeAvailable,
    lakeEffective,
    wireDisabledReason,
    canWire: wireDisabledReason === null,
    secretDisabledReason,
    canEnsureSecret: secretDisabledReason === null,
  };
}

// ---------------------------------------------------------------------------
// The two-click confirm (DBT-301), the onboarding Cribl source panel's machine
// (azure-onboarding/cribl-source/cribl-source-state.ts confirmReducer): the
// FIRST click plans read-only and, when ready, arms; only a click while armed
// for the SAME key applies. Any change to what the confirm names - group,
// source, pack, Lake choice, dataset - is another key and disarms for good.
// ---------------------------------------------------------------------------

/** Everything the confirm names, as one key. */
export function wireArmKey(parts: {
  workerGroup: string;
  sourceId: string;
  packName: string;
  lakeEffective: boolean;
  lakeDataset: string;
}): string {
  return JSON.stringify([
    parts.workerGroup.trim(),
    parts.sourceId.trim(),
    parts.packName.trim(),
    parts.lakeEffective,
    parts.lakeEffective ? parts.lakeDataset.trim() : "",
  ]);
}

export type WireConfirmState =
  | { readonly phase: "idle" }
  | { readonly phase: "planning"; readonly key: string }
  | { readonly phase: "armed"; readonly key: string; readonly ready: ReadyWireSource }
  | { readonly phase: "planned"; readonly key: string; readonly result: Exclude<PlanWireSourceResult, { kind: "ready" }> }
  | { readonly phase: "applying"; readonly key: string }
  | { readonly phase: "done"; readonly result: ApplyWireSourceResult };

export type WireConfirmAction =
  | { readonly type: "inputs"; readonly key: string }
  | { readonly type: "plan-start"; readonly key: string }
  | { readonly type: "plan-result"; readonly key: string; readonly result: PlanWireSourceResult }
  | { readonly type: "apply-start"; readonly key: string }
  | { readonly type: "apply-result"; readonly result: ApplyWireSourceResult }
  | { readonly type: "reset" };

export const WIRE_CONFIRM_IDLE: WireConfirmState = { phase: "idle" };

export function wireConfirmReducer(state: WireConfirmState, action: WireConfirmAction): WireConfirmState {
  switch (action.type) {
    case "inputs":
      // An apply in flight runs to its outcome; anything keyed to an older key
      // is stale and goes back to idle (a revert never re-arms).
      if (state.phase === "idle" || state.phase === "done" || state.phase === "applying") return state;
      return state.key === action.key ? state : WIRE_CONFIRM_IDLE;
    case "plan-start":
      return { phase: "planning", key: action.key };
    case "plan-result":
      if (state.phase !== "planning" || state.key !== action.key) return state;
      return action.result.kind === "ready"
        ? { phase: "armed", key: action.key, ready: action.result.ready }
        : { phase: "planned", key: action.key, result: action.result };
    case "apply-start":
      if (state.phase !== "armed" || state.key !== action.key) return state;
      return { phase: "applying", key: action.key };
    case "apply-result":
      if (state.phase !== "applying") return state;
      return { phase: "done", result: action.result };
    case "reset":
      return WIRE_CONFIRM_IDLE;
  }
}

/**
 * What a Wire click does. A click after any outcome - a void included - PLANS
 * again: a void is re-planned and re-confirmed, never retried.
 */
export function wireClick(state: WireConfirmState, key: string): "plan" | "apply" | "none" {
  if (state.phase === "planning" || state.phase === "applying") return "none";
  if (state.phase === "armed" && state.key === key) return "apply";
  return "plan";
}

export function isWireArmed(state: WireConfirmState, key: string): state is Extract<WireConfirmState, { phase: "armed" }> {
  return state.phase === "armed" && state.key === key;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The confirm, line by line: the group, the table, where the routes go (the
 * top) and what happens to the others (nothing), each route, the source and
 * where its type came from, what could not be checked, the Lake dataset, the
 * commit files (an upper bound) with anyone else's pending work in them, and
 * the deploy's worker restart.
 */
export function wireConfirmLines(ready: ReadyWireSource): string[] {
  const ins = ready.insert;
  const lines: string[] = [
    `Worker group ${ins.groupId}: add ${plural(ins.newRoutes.length, "route", "routes")} at the top of routing table ${ins.tableId}, ` +
      `above its ${plural(ins.table.routeCount, "existing route", "existing routes")}. No other route is changed or moved.`,
  ];
  ins.newRoutes.forEach((r, i) => {
    lines.push(
      `${i + 1}. ${r.id}: filter ${r.filter}; pipeline ${r.pipeline}; output ${r.output ?? "(none)"}; ` +
        (r.final ? "final (matched events stop here)." : "not final (matched events continue to the next route)."),
    );
  });
  lines.push(`Source: ${ready.input.type}:${ready.input.id}. Its type was read from the worker group's sources.`);
  if (ins.uncheckable.length > 0) {
    lines.push(
      `Could not check ${plural(ins.uncheckable.length, "existing route", "existing routes")} for a route on this source, because this app cannot read ` +
        `${ins.uncheckable.length === 1 ? "its filter" : "their filters"}: ${ins.uncheckable.map((r) => r.id).join(", ")}.`,
    );
  }
  if (ready.createDataset !== null) {
    lines.push(`First creates Cribl Lake dataset ${ready.createDataset}, or uses it if it already exists.`);
  }
  lines.push(`Then commits at most ${ins.commitFiles.join(", ")}: only what is still pending there after the write.`);
  if (ins.scope.alreadyDirty.length > 0) {
    lines.push(
      `Already pending in that file, and carried by this commit too: uncommitted changes someone else made (${ins.scope.alreadyDirty.join(", ")}).`,
    );
  }
  lines.push(`Then deploys that commit to worker group ${ins.groupId}, which restarts its workers.`);
  return lines;
}

export type WireTone = "ok" | "warning" | "error";

export interface WireView {
  readonly tone: WireTone;
  readonly headline: string;
  /** Core's wording, verbatim. */
  readonly detail: string;
  /** Extra lines (the Lake dataset result, routes that could not be checked). */
  readonly notes: readonly string[];
}

/** A plan that did not arm, in words. */
export function wirePlanRefusalView(result: Exclude<PlanWireSourceResult, { kind: "ready" }>): WireView {
  if (result.kind === "refused") {
    return { tone: "warning", headline: "Not wired: nothing was changed.", detail: result.detail, notes: [] };
  }
  const r = result.result;
  const notes =
    r.uncheckable !== undefined && r.uncheckable.length > 0
      ? [`Not checked (filter unreadable): ${r.uncheckable.map((x) => x.id).join(", ")}.`]
      : [];
  const headline =
    r.reason === "conflicts"
      ? "Not wired: the routing table already routes this source. Nothing was changed."
      : "Not wired: nothing was changed.";
  const tone: WireTone = r.reason === "routes-unreadable" || r.reason === "unexpected-shape" ? "error" : "warning";
  return { tone, headline, detail: r.detail, notes };
}

/** Every apply outcome, by name, as a headline and a tone. */
export function insertOutcomeHeadline(outcome: ApplyRouteInsertOutcome): { tone: WireTone; headline: string } {
  switch (outcome.kind) {
    case "deployed":
      return { tone: "ok", headline: "Wired: routes written, committed and deployed." };
    case "already-applied":
      return { tone: "ok", headline: "Already wired: the routing table already holds these routes." };
    case "void":
      return outcome.cause === "scope-grew"
        ? { tone: "warning", headline: "Not written: more pending work appeared since you confirmed. Check again." }
        : { tone: "warning", headline: "Not written: the routing table changed since you confirmed. Check again." };
    case "scope-refused":
      return { tone: "warning", headline: "Not written: the commit could not be scoped." };
    case "unreadable":
      return { tone: "error", headline: "Not written: the routing table could not be re-read." };
    case "refused-before-write":
      return { tone: "warning", headline: "Not written: a route on this source appeared since you confirmed." };
    case "refused":
      return { tone: "error", headline: "Not written: Cribl refused the routes write." };
    case "transport-failed":
      return outcome.writeSent
        ? { tone: "error", headline: "Unknown: the routes write got no answer." }
        : { tone: "error", headline: "Not written: Cribl did not answer." };
    case "written-not-verified":
      return { tone: "error", headline: "Written, not verified: not committed or deployed." };
    case "nothing-to-commit":
    case "status-unknown":
    case "scope-unknown":
    case "committed-unknown-hash":
    case "commit-failed":
      return { tone: "warning", headline: "Written, not committed: nothing was deployed." };
    case "newer-commit":
    case "head-unknown":
    case "incomplete":
    case "unverified":
      return { tone: "warning", headline: "Written and committed, not deployed." };
    case "deploy-failed":
      return { tone: "error", headline: "Written and committed; the deploy was refused." };
    case "commit-sequence-failed":
      return { tone: "warning", headline: "Written; whether it was committed is unknown." };
  }
}

/** An apply's result, in words: the routes outcome plus the Lake dataset line. */
export function wireOutcomeView(result: ApplyWireSourceResult): WireView {
  const { tone, headline } = insertOutcomeHeadline(result.insert);
  const notes: string[] = [];
  if (result.dataset.kind === "created-or-exists") {
    notes.push(`Cribl Lake dataset ${result.dataset.dataset} is in place (HTTP ${result.dataset.status}).`);
  } else if (result.dataset.kind === "failed") {
    notes.push(`${result.dataset.detail} The Lake route points at it anyway; create the dataset in Cribl.`);
  }
  return { tone, headline, detail: result.insert.detail, notes };
}
