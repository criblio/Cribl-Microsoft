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
 *     chip, and Home can never disagree).
 *   - {@link NO_ACTION_FALLBACK}: what the next-action card says when the
 *     core reports nothing actionable (cribl-only / air-gapped once their
 *     first-run arc is green) - honest capability messaging, no teaser.
 *
 * Pure: no IO, no fetch, no React.
 */

import { deriveJourney, nextAction } from "@soc/core";
import type { JourneyFacts, JourneyStageId } from "@soc/core";
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
  /** Element id to scroll to after navigating (same-route actions). */
  anchorId: string | null;
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
    anchorId: link?.anchorId ?? null,
  };
}

/** The next-action card's copy when the core reports nothing actionable. */
export const NO_ACTION_FALLBACK =
  "Nothing on the journey needs action right now.";


// ---------------------------------------------------------------------------
// Folding (DBT-248): the Setup page opens collapsed, like Sentinel Integration.
// ---------------------------------------------------------------------------

/** Every foldable section of the Setup page, in page order. The Next action panel is not one: it never folds. */
export const SETUP_SECTION_IDS: readonly string[] = [
  "journey",
  "azure-connectivity",
  "azure-connect",
  "azure-resources",
  "github-token",
  "sentinel-content",
  "schema-tables",
  "recent-runs",
];

/** Content-cache key prefix of the Setup page's pins. */
export const SETUP_PIN_PREFIX = "setup-pinned-sections";

/** The DOM id a Setup section scrolls to (distinct from the shell's legacy anchor divs). */
export function setupAnchorFor(id: string): string {
  return `setup-section-${id}`;
}

/**
 * The section a journey stage lands on, or undefined when the stage has no
 * section on this page (accept, ready, the integrate arc).
 */
export function sectionForStage(stageId: string): string | undefined {
  switch (stageId) {
    case "connect":
      return "azure-connect";
    case "target":
      return "azure-resources";
    case "github":
      return "github-token";
    default:
      return undefined;
  }
}

/** The section that needs the operator: the one the Next action points at. */
export function currentSetupSection(action: NextActionView | null): string | undefined {
  return action === null ? undefined : sectionForStage(action.stageId);
}

/** The sections the page actually renders, in order - the badge numbers count these. */
export function visibleSetupSections(facts: JourneyFacts): string[] {
  const connectivity = facts.connectivity ?? "full";
  return SETUP_SECTION_IDS.filter((id) => {
    if (id === "azure-connectivity") return connectivity === "partial";
    if (id === "azure-connect" || id === "azure-resources") return connectivity !== "disconnected";
    return true;
  });
}

/** "Step 2 of 4: Connect" for the current first-run stage, or "Setup complete". */
export function journeySummary(facts: JourneyFacts): string {
  const stages = deriveJourney(facts).firstRun.filter((s) => s.status !== "not-needed");
  const at = stages.findIndex((s) => s.status === "current");
  const current = stages[at];
  return current === undefined
    ? "Setup complete"
    : `Step ${at + 1} of ${stages.length}: ${current.label}`;
}

/** The Recent runs one-liner; undefined while the first load is pending. */
export function runsSummary(count: number | null, failed = false): string | undefined {
  if (failed) return "Could not load runs";
  if (count === null) return undefined;
  return count === 0 ? "No runs yet" : count === 1 ? "1 run" : `${count} runs`;
}
