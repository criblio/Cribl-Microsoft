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
 *   - {@link planSourceWiring} (applied by {@link wireSource}): the ROUTE ORDER
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
import type { CriblDeploymentType, DeployMode } from "@soc/core";

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
  /** The Cribl source id the routes filter on (`__inputId=='...'`). */
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
