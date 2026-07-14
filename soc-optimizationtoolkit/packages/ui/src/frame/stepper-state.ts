/**
 * Stepper state - the PURE decisions behind the JourneyStepper rail
 * (ux-flow-plan 4.2, Unit 6.5). @soc/core's journey-state owns EVERY status
 * decision (deriveJourney); this module only binds its stages to the app's
 * route table and derives per-item render facts, kept out of the component
 * so they are unit-testable without a DOM.
 *
 * READ-AHEAD contract (user decision, binding): every stage is visible and
 * NAVIGABLE - gating lives only at the commit actions inside the screens.
 * So a 'blocked' stage with a route target IS clickable (its blockedReason
 * renders as the hint naming the single unlock condition); the ONLY stages
 * that never navigate are 'not-yet-available' ones, because no surface
 * exists to navigate to - honest placeholder, never a teaser.
 *
 * Cross-links are DATA, not shell-sniffing prose (parity keep-list): each
 * shell passes a {@link JourneyLinks} map binding stage ids to its own
 * routes and guidance - e.g. the cloud shell points the connect stage at
 * the Setup page's App registration and connect section, while the local
 * shell has no connect route and supplies config-file guidance text.
 * {@link SHARED_JOURNEY_LINKS} carries the bindings that are identical in
 * both shells so they cannot drift.
 *
 * Pure: no IO, no fetch, no React.
 */

import type { JourneyStage, JourneyStageId, StageStatus } from "@soc/core";

/** One stage's shell binding: where it navigates and/or extra guidance. */
export interface JourneyLink {
  /** Route id to navigate to (AppFrameNav.navigate). Omit = not navigable. */
  routeId?: string;
  /** Guidance microcopy (e.g. the cross-link or config-file hint). */
  hint?: string;
}

/** Stage id -> shell binding. Stages without an entry render unlinked. */
export type JourneyLinks = Partial<Record<JourneyStageId, JourneyLink>>;

/**
 * The stage->route bindings that are IDENTICAL in both shells (both route
 * tables use these ids), exported so the two cannot drift. Shells merge
 * their shell-specific entries over it via {@link mergeJourneyLinks} -
 * notably 'connect', which differs per shell by design.
 */
export const SHARED_JOURNEY_LINKS: JourneyLinks = {
  target: {
    routeId: "home",
    hint:
      "Choose the target in the Select resources and grant permissions section " +
      "on Setup; the Integrate page's Azure Resources section commits the deploy scope.",
  },
  ready: {
    routeId: "preflight",
    hint:
      "Summarized by the readiness chips on Setup; Permission Verification has " +
      "the full effective-permissions report.",
  },
  "choose-content": {
    routeId: "dcr-automation",
    hint: "Single or batch DCR deployment on the DCR Automation screen.",
  },
  configure: {
    routeId: "dcr-automation",
    hint: "Per-run overrides live on the run screen.",
  },
  review: {
    hint:
      "The standalone Review screen is retired from the menu; the Integrate " +
      "page's Deploy section reports exactly what a run creates.",
  },
  deploy: {
    routeId: "dcr-automation",
    hint: "Run single or batch on DCR Automation.",
  },
};

/**
 * Merge shell-specific links over {@link SHARED_JOURNEY_LINKS}. Per-stage
 * SHALLOW merge: an override can add a hint while keeping the shared route
 * (or vice versa). Inputs are never mutated.
 */
export function mergeJourneyLinks(overrides: JourneyLinks = {}): JourneyLinks {
  const merged: JourneyLinks = {};
  const ids = new Set<JourneyStageId>([
    ...(Object.keys(SHARED_JOURNEY_LINKS) as JourneyStageId[]),
    ...(Object.keys(overrides) as JourneyStageId[]),
  ]);
  for (const id of ids) {
    merged[id] = { ...SHARED_JOURNEY_LINKS[id], ...overrides[id] };
  }
  return merged;
}

/** Everything the stepper renders for one stage. */
export interface StepperItem {
  id: JourneyStageId;
  label: string;
  status: StageStatus;
  /** 1-based circle number within this rail. */
  index: number;
  /** Route to navigate to on click; null renders a non-clickable stage. */
  routeId: string | null;
  /**
   * Hint microcopy under the label: the blockedReason when present (the
   * single unlock condition / honest not-shipped note always wins), else
   * the link's guidance, else nothing.
   */
  hint: string | null;
}

/**
 * Bind derived stages to their shell links. Zero status logic - statuses
 * pass through from deriveJourney untouched. Rules (pinned by tests):
 *   - 'not-yet-available' stages NEVER get a route, even if a link binds
 *     one (no navigation into unshipped surfaces);
 *   - every other status keeps its link's route (read-ahead: blocked
 *     stages stay navigable);
 *   - blockedReason outranks the link hint.
 */
export function buildStepperItems(
  stages: readonly JourneyStage[],
  links: JourneyLinks = {},
): StepperItem[] {
  return stages.map((stage, i) => {
    const link = links[stage.id];
    const routeId =
      stage.status === "not-yet-available" ? null : (link?.routeId ?? null);
    return {
      id: stage.id,
      label: stage.label,
      status: stage.status,
      index: i + 1,
      routeId,
      hint: stage.blockedReason ?? link?.hint ?? null,
    };
  });
}
