/**
 * Frame state - the PURE decisions behind the shared app frame.
 *
 * The @soc/core app-setup module owns the persisted facts (acceptance and setup
 * codecs). This module owns the UI-side decisions layered on top of them, kept
 * out of the components so they are unit-testable without a DOM:
 *
 *   - {@link resolveFramePhase}: which top-level surface the shell shows
 *     (loading / acceptance gate / first-run wizard / the frame). Encodes the
 *     never-flash contract: while acceptance is still LOADING the answer is
 *     "loading", never "show the gate" - an already-accepted user must never
 *     see the agreement flash before their saved acceptance arrives.
 *
 * The mode record, chooser list and label map that lived here went with app
 * modes (capability-model-plan step 5). The Reconfigure contract survives as
 * EMPTY_SETUP_RECORD in core: writing an empty object parses back to "not set
 * up", which routes the next load into the wizard - the same legacy behaviour,
 * now keyed on setup rather than mode.
 *
 *   - {@link isScrolledToBottom}: the acceptance gate's scroll threshold.
 *   - {@link groupNavSections}: the sidebar's section grouping (ux-flow-plan
 *     4.4, Unit 6.5) - journey steps first, then tools, then diagnostics.
 *     Grouping is PRESENTATION only and never removes anything; since
 *     capability-model-plan step 3 the nav annotates rather than filters, so
 *     every route reaches this function.
 *
 * Pure: no IO, no fetch, no React.
 */

import type { AcceptanceRecord } from "@soc/core";

/**
 * An acceptance value as the shell holds it: the parsed record, null for
 * "not accepted", or "loading" while the persisted blob is still in flight.
 */
export type LoadableAcceptance = AcceptanceRecord | null | "loading";

/**
 * Whether setup is complete, as the shell holds it. null means "not yet set
 * up". This replaced the persisted AppMode, which carried that meaning only
 * incidentally (capability-model-plan step 5).
 */
export type LoadableSetup = boolean | null | "loading";

/** The top-level surface the shell should render. */
export type FramePhase =
  | { phase: "loading" }
  | { phase: "aua" }
  | { phase: "setup" }
  | { phase: "ready" };

/**
 * Decide which top-level surface to show.
 *
 * Order is the contract:
 *   1. acceptance still loading -> "loading" (NEVER the gate: an accepted
 *      user must not see the agreement flash while their record loads)
 *   2. not accepted -> "aua" (the gate comes before everything else,
 *      including setup - even if setup state is still loading)
 *   3. setup still loading -> "loading"
 *   4. setup not complete -> "setup" (the first-run wizard)
 *   5. otherwise -> "ready"
 *
 * Step 4 used to be "mode-select", and "ready" used to carry the chosen mode.
 * The wizard replaced the chooser and the frame no longer has a mode to carry
 * (capability-model-plan step 5); the ORDER is unchanged.
 */
export function resolveFramePhase(
  acceptance: LoadableAcceptance,
  setup: LoadableSetup,
): FramePhase {
  if (acceptance === "loading") {
    return { phase: "loading" };
  }
  if (acceptance === null) {
    return { phase: "aua" };
  }
  if (setup === "loading") {
    return { phase: "loading" };
  }
  if (setup === null || setup === false) {
    return { phase: "setup" };
  }
  return { phase: "ready" };
}


/**
 * The sidebar's nav sections (ux-flow-plan 4.4): journey steps in dependency
 * order, standalone tools that feed or observe the journey, features still
 * under development, diagnostics last. Routes without a declared section
 * default to 'tools'.
 *
 * DEVELOPMENT (user directive 2026-07-09): the holding area for features not
 * yet validated live. Only Setup and Sentinel Integration are active in the
 * journey; everything unvalidated parks here (still reachable - parked, not
 * hidden) and MOVES OUT one item at a time as it passes live testing.
 */
export type NavSection = "journey" | "tools" | "development" | "diagnostics";

/** Where an undeclared route lands. */
export const DEFAULT_NAV_SECTION: NavSection = "tools";

/** Fixed presentation order of the sections. */
export const NAV_SECTION_ORDER: readonly NavSection[] = [
  "journey",
  "tools",
  "development",
  "diagnostics",
];

/** The one display label per section (rendered uppercase by the frame). */
export const NAV_SECTION_LABELS: Readonly<Record<NavSection, string>> = {
  journey: "Journey",
  tools: "Tools",
  development: "Development",
  diagnostics: "Diagnostics",
};

/**
 * The short flag rendered beside a nav item that is not simply available
 * (capability-model-plan step 3).
 *
 * Three distinct words for three distinct facts, and keeping them distinct is
 * the point: "unchecked" must never read as "no access", because not having
 * measured is not the same as having been refused. There is no label for
 * `available` - an available item carries no flag at all.
 */
export const NAV_FLAG_LABELS: Readonly<
  Record<"denied" | "unknown" | "unreachable", string>
> = {
  denied: "no access",
  unknown: "unchecked",
  unreachable: "not connected",
};

/** One rendered nav group: a section plus its routes, in order. */
export interface NavSectionGroup<T> {
  section: NavSection;
  items: T[];
}

/**
 * Group nav items by section for rendering. Presentation only - it never
 * removes an item, and since step 3 nothing upstream does either: sections come
 * out in {@link NAV_SECTION_ORDER}, items keep their route-table order within
 * each section, empty sections are omitted, and items without a section land in
 * {@link DEFAULT_NAV_SECTION}.
 */
export function groupNavSections<T extends { section?: NavSection }>(
  items: readonly T[],
): NavSectionGroup<T>[] {
  return NAV_SECTION_ORDER.map((section) => ({
    section,
    items: items.filter(
      (item) => (item.section ?? DEFAULT_NAV_SECTION) === section,
    ),
  })).filter((group) => group.items.length > 0);
}

/**
 * Slack below which the acceptance gate counts the body as read: within this
 * many pixels of the true bottom (sub-pixel scroll positions and zoomed
 * layouts rarely land exactly on it).
 */
export const AUA_SCROLL_SLACK_PX = 30;

/**
 * Whether a scroll container is (close enough to) fully scrolled.
 *
 * Also true for content that does not scroll at all (scrollHeight <=
 * clientHeight): the legacy gate only ever set its flag from scroll events,
 * so a window tall enough to show the whole agreement could never enable
 * Accept. Callers check this once on mount to close that soft-lock.
 */
export function isScrolledToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < AUA_SCROLL_SLACK_PX;
}
