/**
 * Guided workflow state - porting-plan Unit 20 task item 10. The
 * sectionDone/canDeploy/deployComplete UNLOCK CHAIN plus MODE GATING
 * (skipAzure/skipCribl), extracted as a pure, tested module. It IS the product's
 * guided UX.
 *
 * This layers ADDITIVELY on integrate-arc: the single-page section model and the
 * native-deploy readiness rule live there (canDeploy / canDeployContentPath /
 * deriveReadinessPills). This module adds the two things the guided DEPLOY needs
 * on top of that model:
 *
 *   1. MODE GATING. The integration mode selects which halves run
 *      (SentinelIntegration.tsx 920-921): air-gapped and cribl-only SKIP Azure;
 *      air-gapped and azure-only SKIP Cribl. {@link deployModeGating} is the one
 *      source of that mapping.
 *
 *   2. A MODE-AWARE deploy gate that never weakens the native MVP rule. For the
 *      FULL mode it is IDENTICAL to integrate-arc's canDeploy (asserted by test);
 *      the gated modes only RELAX the requirement that the SKIPPED side is ready
 *      (an air-gapped deploy needs no committed workspace and no worker group;
 *      it still needs a pack name). It is a strict widening per skipped side, so
 *      the native-onboard MVP-transition rule survives unchanged.
 *
 * Plus the post-deploy WIRING unlock: source wiring is offered only after a
 * successful deploy and only when Cribl is not skipped (the legacy showed
 * Section 6 only when deployComplete && criblConnected).
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto.
 */

import {
  canDeploy as integrateCanDeploy,
  canDeployContentPath as integrateCanDeployContentPath,
  deriveReadinessPills,
  type ReadinessPill,
  type SectionInputs,
} from "../../domain/integrate-arc";

/** The four integration modes (app-mode's model, named for the deploy flow). */
export type DeployMode = "full" | "azure-only" | "cribl-only" | "air-gapped";

/** Which halves of the deploy a mode skips. */
export interface ModeGating {
  /** Skip all Azure operations (DCR/DCE/table/role). */
  skipAzure: boolean;
  /** Skip all Cribl operations (destination/pack upload/wiring). */
  skipCribl: boolean;
}

/**
 * The mode -> skip mapping (SentinelIntegration.tsx 920-921, verbatim):
 * air-gapped and cribl-only skip Azure; air-gapped and azure-only skip Cribl;
 * full skips neither.
 */
export function deployModeGating(mode: DeployMode): ModeGating {
  return {
    skipAzure: mode === "air-gapped" || mode === "cribl-only",
    skipCribl: mode === "air-gapped" || mode === "azure-only",
  };
}

/**
 * Whether the deploy can run in the given mode. Widens integrate-arc's canDeploy
 * per skipped side WITHOUT weakening it:
 *   - scope is required UNLESS Azure is skipped,
 *   - a worker group is required UNLESS Cribl is skipped,
 *   - a pack name is ALWAYS required (every mode builds or exports a pack).
 *
 * INVARIANT (pinned): for mode "full" this equals integrate-arc's canDeploy
 * exactly - the native MVP-transition rule is preserved untouched.
 */
export function canDeployInMode(
  inputs: SectionInputs,
  mode: DeployMode,
): boolean {
  const gating = deployModeGating(mode);
  if (!gating.skipAzure && !gating.skipCribl) {
    // Full mode defers entirely to the canonical native rule (no drift).
    return integrateCanDeploy(inputs);
  }
  const scopeOk = gating.skipAzure || inputs.scopeCommitted;
  const workerGroupOk = gating.skipCribl || inputs.workerGroupSelected;
  return scopeOk && workerGroupOk && inputs.packNameSet;
}

/**
 * Whether the CONTENT / mapping-driven path can deploy in the given mode: the
 * mode-aware deploy gate AND mapping approval (integrate-arc's content-path
 * rule). A strict superset of {@link canDeployInMode}.
 */
export function canDeployContentPathInMode(
  inputs: SectionInputs,
  mode: DeployMode,
): boolean {
  if (!deployModeGating(mode).skipAzure && !deployModeGating(mode).skipCribl) {
    return integrateCanDeployContentPath(inputs);
  }
  return canDeployInMode(inputs, mode) && inputs.mappingsApproved === true;
}

/**
 * Whether source wiring is unlocked: a deploy has completed AND Cribl is not
 * skipped (there is no source to wire in an Azure-only or air-gapped run). Wiring
 * completion never re-locks it (each step is re-runnable).
 */
export function canWireSource(
  deployCompleted: boolean,
  mode: DeployMode,
): boolean {
  return deployCompleted && !deployModeGating(mode).skipCribl;
}

/**
 * The readiness pills applicable to a mode: integrate-arc's full pill set with
 * the skipped-side prerequisites removed (Workspace hidden when Azure is
 * skipped; Worker Groups hidden when Cribl is skipped) - the legacy show flags
 * (SentinelIntegration.tsx 3260-3261). Pack Name, Solution, Samples, and
 * Mappings always show.
 */
export function readinessPillsForMode(
  inputs: SectionInputs,
  mode: DeployMode,
): ReadinessPill[] {
  const gating = deployModeGating(mode);
  return deriveReadinessPills(inputs).filter((pill) => {
    if (pill.id === "workspace") return !gating.skipAzure;
    if (pill.id === "worker-groups") return !gating.skipCribl;
    return true;
  });
}

/** The full derived guided-workflow state a shell renders. */
export interface GuidedWorkflowState {
  mode: DeployMode;
  gating: ModeGating;
  /** Mode-aware native deploy gate (equals integrate-arc canDeploy in full). */
  canDeploy: boolean;
  /** Mode-aware content-path deploy gate (adds mapping approval). */
  canDeployContentPath: boolean;
  /** Post-deploy source-wiring unlock. */
  canWireSource: boolean;
  /** The readiness pills applicable to the mode. */
  readinessPills: ReadinessPill[];
}

/**
 * Derive the whole guided-workflow state from the section inputs, the mode, and
 * whether a deploy has completed (the deploy-complete flag is the wiring
 * unlock's driver; SectionInputs.deployCompleted stays the section model's).
 */
export function deriveGuidedWorkflow(
  inputs: SectionInputs,
  mode: DeployMode,
): GuidedWorkflowState {
  return {
    mode,
    gating: deployModeGating(mode),
    canDeploy: canDeployInMode(inputs, mode),
    canDeployContentPath: canDeployContentPathInMode(inputs, mode),
    canWireSource: canWireSource(inputs.deployCompleted, mode),
    readinessPills: readinessPillsForMode(inputs, mode),
  };
}
