/**
 * Onboarding sections - THE SCREEN'S LAYOUT, AND WHAT IS BUILT, AS DATA.
 *
 * The Azure Native Source Onboarding screen (AZR-18) renders the coverage
 * catalog as numbered sections, one per {@link CollectionMethod}, because
 * backlog.md#6 says the legacy `method` values ARE the section keys. This module
 * is that layout, fixed in core so the screen composes it rather than deciding
 * it, and so a pin can count it.
 *
 * ORDER. The tickable methods first, in {@link CollectionMethod}'s own order
 * (built-in-policy, custom-initiative, script, guided-portal), then one
 * reference section (`none`) holding every {@link UNSUPPORTED_SOURCES} row and
 * ONE EXPLICIT ROW for {@link XDR_TABLES_NOT_SUPPORTED}. That XDR row is its own
 * row on purpose (plan, layering critique 6): the tables live in a separate
 * object from the unsupported sources, so a layout that only walked
 * `UNSUPPORTED_SOURCES` would drop BehaviorEntities and BehaviorInfo and a
 * "catalog plus unsupported" count would not notice. The count pin is
 * catalog + unsupported + 1 for that reason.
 *
 * AVAILABILITY IS PER ITEM, NOT PER SECTION. The `script` method holds both
 * entraId and defenderExport (coverage-model.test.ts), and only the Defender
 * export is built in this slice. A per-section flag would either hide the
 * Defender export or offer an Entra deploy that does not exist. So
 * {@link ITEM_AVAILABILITY} is keyed by item id, and {@link sectionAvailability}
 * is derived from it: a section is available when any of its items is.
 *
 * THE EVENT HUB PREREQUISITE SITS OUTSIDE THE CATALOG. Every tickable item
 * streams to an Event Hub, so the hub is a precondition of the items rather
 * than an item an operator ticks; {@link ITEM_PREREQUISITES} names it per item.
 * It is not persisted (plan: the Event Hub choice lives in React state only).
 *
 * VISIBLE COPY. Every `title` and `reason` here reaches the screen, so none
 * carries a card id, a date or a phase number - those stay in these comments.
 * The copy-history gate runs in the ui package (findHistoryInCopy lives there
 * and core imports nothing from ui); its test imports these strings.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import {
  itemsByMethod,
  UNSUPPORTED_SOURCES,
  XDR_TABLES_NOT_SUPPORTED,
  type CollectionMethod,
  type CoverageItem,
  type UnsupportedItem,
} from "../coverage-model";
import type { OnboardingItemId } from "../onboarding-selection";

/** Id of the explicit XDR row. Not a catalog id, so it can never be ticked. */
export const XDR_TABLES_ROW_ID = "xdrTablesNotSupported";

/** One row of a section. The three kinds render differently and only `item` is tickable. */
export type OnboardingRow =
  | { readonly kind: "item"; readonly id: OnboardingItemId; readonly item: CoverageItem }
  | { readonly kind: "unsupported"; readonly id: string; readonly item: UnsupportedItem }
  | {
      readonly kind: "xdr-tables";
      readonly id: typeof XDR_TABLES_ROW_ID;
      readonly title: string;
      readonly tables: readonly string[];
      readonly reason: string;
    };

export interface OnboardingSection {
  /** The legacy `method` value; backlog.md#6 makes it the section key. */
  readonly key: CollectionMethod;
  /** Visible heading. */
  readonly title: string;
  readonly rows: readonly OnboardingRow[];
}

/**
 * The tickable methods, in display order. `none` is deliberately absent - it
 * has no catalog items and is rendered as the reference section instead.
 */
const METHOD_ORDER: readonly Exclude<CollectionMethod, "none">[] = [
  "built-in-policy",
  "custom-initiative",
  "script",
  "guided-portal",
];

/** Visible section headings, after backlog.md 6a-6c and 6e. */
const SECTION_TITLES: Readonly<Record<CollectionMethod, string>> = {
  "built-in-policy": "Azure Policy - built-in initiatives",
  "custom-initiative": "Azure Policy - community initiative",
  script: "Direct configuration - no policy",
  "guided-portal": "Defender XDR export - finished in the portal",
  none: "Sources that cannot stream to Event Hub",
};

/**
 * The screen's sections, in order. Built once from the catalog, so a catalog
 * item added later gets its ROW in its method's section without an edit here.
 * It still needs an entry in {@link ITEM_AVAILABILITY} and
 * {@link ITEM_PREREQUISITES}; the key-coverage pins fail until it has both.
 */
export const ONBOARDING_SECTIONS: readonly OnboardingSection[] = [
  ...METHOD_ORDER.map(
    (key): OnboardingSection => ({
      key,
      title: SECTION_TITLES[key],
      rows: itemsByMethod(key).map(
        (item): OnboardingRow => ({ kind: "item", id: item.id, item }),
      ),
    }),
  ),
  {
    key: "none",
    title: SECTION_TITLES.none,
    rows: [
      ...UNSUPPORTED_SOURCES.map(
        (item): OnboardingRow => ({ kind: "unsupported", id: item.id, item }),
      ),
      {
        kind: "xdr-tables",
        id: XDR_TABLES_ROW_ID,
        title: "Defender XDR tables the Streaming API does not carry",
        tables: XDR_TABLES_NOT_SUPPORTED.tables,
        reason: XDR_TABLES_NOT_SUPPORTED.reason,
      },
    ],
  },
];

/**
 * Whether one catalog item can be deployed from the screen today.
 *
 *   available  the deploy path exists
 *   not-built  shown, with its checkbox disabled and `reason` beside it
 */
export type ItemAvailability =
  | { readonly status: "available" }
  | { readonly status: "not-built"; readonly reason: string };

const NOT_BUILT_REASON = "Not available yet - this source cannot be deployed from here.";

/**
 * Availability per catalog item. Only the Defender for Cloud alert export is
 * built in this slice; Entra (AZR-2), the policy sections and the guided XDR
 * portal flow render as coming-soon with disabled rows (plan outOfScope).
 *
 * The type does NOT guard completeness: {@link OnboardingItemId} is `string`,
 * so a catalog item with no entry here compiles cleanly and indexing the map
 * is typed as never undefined. The guard is the test pin "has an entry for
 * every catalog id and no other" ({@link ITEM_PREREQUISITES} has its own
 * "covers no other id" pin). At runtime, an id missing from this map is
 * treated as not built by {@link itemAvailability}, never as available.
 */
export const ITEM_AVAILABILITY: Readonly<Record<OnboardingItemId, ItemAvailability>> = {
  diagnosticSettingsInitiative: { status: "not-built", reason: NOT_BUILT_REASON },
  communityPolicyInitiative: { status: "not-built", reason: NOT_BUILT_REASON },
  activityLog: { status: "not-built", reason: NOT_BUILT_REASON },
  entraId: { status: "not-built", reason: NOT_BUILT_REASON },
  defenderExport: { status: "available" },
  xdrStreaming: { status: "not-built", reason: NOT_BUILT_REASON },
};

/** Availability of one item. An id the map does not know is not built, never available. */
export function itemAvailability(id: OnboardingItemId): ItemAvailability {
  return ITEM_AVAILABILITY[id] ?? { status: "not-built", reason: NOT_BUILT_REASON };
}

/** A precondition that is not itself a catalog item. */
export type OnboardingPrerequisite = "eventHubTarget";

/**
 * What each item needs in place before it can be deployed. Every tickable item
 * delivers to an Event Hub, so each names the hub; the hub is chosen on the
 * screen, not ticked, which is why it is a prerequisite and not a catalog row.
 * Completeness is pinned by the "covers no other id" test, not by the type
 * (see {@link ITEM_AVAILABILITY}).
 */
export const ITEM_PREREQUISITES: Readonly<Record<OnboardingItemId, readonly OnboardingPrerequisite[]>> = {
  diagnosticSettingsInitiative: ["eventHubTarget"],
  communityPolicyInitiative: ["eventHubTarget"],
  activityLog: ["eventHubTarget"],
  entraId: ["eventHubTarget"],
  defenderExport: ["eventHubTarget"],
  xdrStreaming: ["eventHubTarget"],
};

/**
 * Whether a section has anything to deploy.
 *
 *   available  at least one of its items is available
 *   not-built  it has tickable items and none is available (coming-soon)
 *   reference  it has no tickable items at all (the cannot-stream section)
 */
export type SectionAvailability = "available" | "not-built" | "reference";

/** Derived from {@link ITEM_AVAILABILITY}; never set per section. */
export function sectionAvailability(section: OnboardingSection): SectionAvailability {
  const items = section.rows.filter((r) => r.kind === "item");
  if (items.length === 0) return "reference";
  return items.some((r) => itemAvailability(r.id).status === "available")
    ? "available"
    : "not-built";
}
