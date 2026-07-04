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
