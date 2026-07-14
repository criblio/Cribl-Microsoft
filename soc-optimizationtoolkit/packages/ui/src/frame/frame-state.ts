/**
 * Frame state - the PURE decisions behind the shared app frame.
 *
 * The @soc/core app-mode module owns the mode model (parse/serialize,
 * capability predicates, nav filter). This module owns the UI-side decisions
 * layered on top of it, kept out of the components so they are unit-testable
 * without a DOM:
 *
 *   - {@link resolveFramePhase}: which top-level surface the shell shows
 *     (loading / acceptance gate / mode chooser / the frame). Encodes the
 *     never-flash contract: while acceptance is still LOADING the answer is
 *     "loading", never "show the gate" - an already-accepted user must never
 *     see the agreement flash before their saved acceptance arrives.
 *   - {@link EMPTY_MODE_RECORD}: the Reconfigure contract. The legacy
 *     Settings page reset the app by writing an EMPTY object to
 *     integration-mode.json and reloading; writing this constant to the mode
 *     key parses back to null ("not yet chosen"), which routes the next load
 *     into mode selection.
 *   - {@link MODE_LABELS} / {@link MODE_OPTIONS}: the ONE display map and the
 *     ONE chooser list, both keyed by the core AppMode union (the legacy app
 *     had separate label maps in Settings and Sidebar that could drift).
 *   - {@link isScrolledToBottom}: the acceptance gate's scroll threshold.
 *   - {@link groupNavSections}: the sidebar's section grouping (ux-flow-plan
 *     4.4, Unit 6.5) - journey steps first, then tools, then diagnostics.
 *     Grouping is PRESENTATION only, applied AFTER the one core
 *     filterNavItems pass; mode filtering semantics are unchanged.
 *
 * Pure: no IO, no fetch, no React.
 */

import { APP_MODES } from "@soc/core";
import type { AcceptanceRecord, AppMode } from "@soc/core";

/**
 * What Reconfigure writes to the persisted mode key: an EMPTY JSON object.
 * parseAppMode reads it as null ("not yet chosen"), so the next load lands in
 * mode selection. This mirrors the legacy contract (Settings wrote `{}` to
 * integration-mode.json and reloaded) so blobs stay legible to both readers.
 */
export const EMPTY_MODE_RECORD = "{}";

/**
 * An acceptance value as the shell holds it: the parsed record, null for
 * "not accepted", or "loading" while the persisted blob is still in flight.
 */
export type LoadableAcceptance = AcceptanceRecord | null | "loading";

/** A mode value as the shell holds it; null means "not yet chosen". */
export type LoadableMode = AppMode | null | "loading";

/** The top-level surface the shell should render. */
export type FramePhase =
  | { phase: "loading" }
  | { phase: "aua" }
  | { phase: "mode-select" }
  | { phase: "ready"; mode: AppMode };

/**
 * Decide which top-level surface to show.
 *
 * Order is the contract:
 *   1. acceptance still loading -> "loading" (NEVER the gate: an accepted
 *      user must not see the agreement flash while their record loads)
 *   2. not accepted -> "aua" (the gate comes before everything else,
 *      including mode selection - even if the mode is still loading)
 *   3. mode still loading -> "loading"
 *   4. mode not yet chosen -> "mode-select"
 *   5. otherwise -> "ready" carrying the narrowed mode
 */
export function resolveFramePhase(
  acceptance: LoadableAcceptance,
  mode: LoadableMode,
): FramePhase {
  if (acceptance === "loading") {
    return { phase: "loading" };
  }
  if (acceptance === null) {
    return { phase: "aua" };
  }
  if (mode === "loading") {
    return { phase: "loading" };
  }
  if (mode === null) {
    return { phase: "mode-select" };
  }
  return { phase: "ready", mode };
}

/**
 * The one display label per mode, used by the frame's mode chip and the
 * settings screen alike so the two can never disagree.
 */
export const MODE_LABELS: Readonly<Record<AppMode, string>> = {
  full: "Full",
  "azure-only": "Azure Only",
  "cribl-only": "Cribl Only",
  "air-gapped": "Air-Gapped",
};

/** One selectable mode in the first-run chooser. */
export interface ModeOption {
  mode: AppMode;
  label: string;
  /** Honest one-liner: what this mode actually enables. */
  description: string;
}

/**
 * The chooser list, one entry per core APP_MODES value in the same order.
 * Descriptions state plainly what is live and what falls back to generated
 * artifacts - no mode is oversold.
 */
export const MODE_OPTIONS: readonly ModeOption[] = [
  {
    mode: "full",
    label: MODE_LABELS.full,
    description:
      "Live Azure and live Cribl connections - deployments go directly to both.",
  },
  {
    mode: "azure-only",
    label: MODE_LABELS["azure-only"],
    description:
      "Live Azure connection only - Cribl configuration is generated as downloadable artifacts.",
  },
  {
    mode: "cribl-only",
    label: MODE_LABELS["cribl-only"],
    description:
      "Live Cribl connection only - Azure templates are generated as downloadable artifacts.",
  },
  {
    mode: "air-gapped",
    label: MODE_LABELS["air-gapped"],
    description:
      "No live connections - every change is generated as a downloadable artifact for manual review.",
  },
];

/** All modes the chooser must cover (re-exported for the coverage test). */
export const CHOOSABLE_MODES: readonly AppMode[] = APP_MODES;

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

/** One rendered nav group: a section plus its visible routes, in order. */
export interface NavSectionGroup<T> {
  section: NavSection;
  items: T[];
}

/**
 * Group already-filtered nav items by section for rendering. Runs AFTER the
 * one core filterNavItems pass (grouping never re-filters): sections come
 * out in {@link NAV_SECTION_ORDER}, items keep their route-table order
 * within each section, empty sections are omitted, and items without a
 * section land in {@link DEFAULT_NAV_SECTION}.
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
