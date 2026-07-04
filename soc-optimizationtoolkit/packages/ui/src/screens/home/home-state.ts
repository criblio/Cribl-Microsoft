/**
 * Home state - the PURE decisions behind the Home/Overview screen
 * (ux-flow-plan 4.3, Unit 6.5), kept out of the component so they are
 * unit-testable without a DOM.
 *
 * @soc/core's journey-state owns EVERY journey decision (deriveJourney,
 * nextAction, readinessChips); this module only binds the core output to
 * the shell's route/hint links and supplies the honest fallback copy:
 *
 *   - {@link deriveNextActionView}: the core nextAction joined with the
 *     shell's JourneyLinks - the ONE primary button Home headlines. When
 *     the action's stage has no route in this shell (e.g. the local
 *     shell's connect stage), the link's guidance text renders instead of
 *     a button - always-visible affordances, props not shell-sniffing
 *     prose.
 *   - {@link modeNoteFor}: the honest one-liner for the active mode,
 *     REUSING MODE_LABELS/MODE_OPTIONS (one source - the chooser, the
 *     chip, and Home can never disagree).
 *   - {@link NO_ACTION_FALLBACK}: what the next-action card says when the
 *     core reports nothing actionable (cribl-only / air-gapped once their
 *     first-run arc is green) - honest capability messaging, no teaser.
 *
 * Pure: no IO, no fetch, no React.
 */

import { nextAction } from "@soc/core";
import type { AppMode, JourneyFacts, JourneyStageId } from "@soc/core";
import { MODE_LABELS, MODE_OPTIONS } from "../../frame/frame-state";
import type { JourneyLinks } from "../../frame/stepper-state";

/** Everything the next-action card renders. */
export interface NextActionView {
  stageId: JourneyStageId;
  /** Short imperative (button text), from the core hint cascade. */
  label: string;
  /** One sentence of supporting copy, from the core hint cascade. */
  description: string;
  /** Route the button navigates to; null = no button in this shell. */
  routeId: string | null;
  /** Shell guidance for the stage (rendered with or without a button). */
  hint: string | null;
}

/**
 * Join the core nextAction with the shell's links. Null exactly when the
 * core says nothing is actionable; Home then falls back to
 * {@link NO_ACTION_FALLBACK} plus the mode note.
 */
export function deriveNextActionView(
  facts: JourneyFacts,
  links: JourneyLinks = {},
): NextActionView | null {
  const action = nextAction(facts);
  if (action === null) {
    return null;
  }
  const link = links[action.stageId];
  return {
    stageId: action.stageId,
    label: action.label,
    description: action.description,
    routeId: link?.routeId ?? null,
    hint: link?.hint ?? null,
  };
}

/** The next-action card's copy when the core reports nothing actionable. */
export const NO_ACTION_FALLBACK =
  "Nothing on the journey needs action right now. This mode's onboarding surfaces have not shipped yet - the mode note below states what this install can do today.";

/**
 * The honest one-liner for the active mode: label plus the SAME description
 * the mode chooser shows (MODE_OPTIONS is the one source). Total: a null
 * mode (never expected inside the frame) states itself honestly.
 */
export function modeNoteFor(mode: AppMode | null): string {
  const option = MODE_OPTIONS.find((o) => o.mode === mode);
  if (mode === null || option === undefined) {
    return "No operating mode is chosen yet.";
  }
  return `${MODE_LABELS[mode]}: ${option.description}`;
}
