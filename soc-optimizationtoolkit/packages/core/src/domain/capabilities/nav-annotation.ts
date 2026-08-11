/**
 * Nav annotation - the replacement for filterNavItems
 * (capability-model-plan step 3).
 *
 * THIS IS WHERE THE PRODUCT'S BEHAVIOUR VISIBLY CHANGES, and the change is an
 * inversion rather than an adjustment. `filterNavItems(mode, routes)` REMOVED
 * what the mode could not use; `annotateNavItems` returns EVERY item and says
 * what is unavailable and why. An operator who declines every permission still
 * sees the whole product.
 *
 * Two invariants the plan calls binding, both pinned by tests:
 *
 *   1. NO ROUTE IS EVER HIDDEN. Output length equals input length, in input
 *      order, always. There is no filtering path in this module - not for
 *      `denied`, not for `unreachable`, not for an empty capability set. If a
 *      caller wants to hide something it must do so itself, visibly, and own
 *      that decision.
 *
 *   2. `unknown` NEVER RENDERS AS `denied`. "We have not measured" and "we
 *      measured and you cannot" are different facts. The availability type
 *      mirrors CapabilityVerdict one-for-one so the distinction cannot be
 *      flattened on the way through.
 *
 * A third rule follows from the plan's rule 3: annotation is not gating.
 * {@link AnnotatedNavItem.attemptable} is true for everything except
 * `unreachable`, so a denied route stays navigable and Azure's own 403 remains
 * the real gate.
 *
 * Pure: no IO, no clock.
 */

import { isAttemptable, isAzureCapability, verdictFor } from "./capabilities";
import type {
  Capability,
  CapabilityContext,
  CapabilitySet,
  CapabilityVerdict,
} from "./capabilities";
import { IDENTITY_FALLBACK, fallbackFor } from "./fallbacks";
import type { CapabilityFallback } from "./fallbacks";

/** The minimal shape {@link annotateNavItems} needs; items may carry more. */
export interface NavItemCapabilities {
  /** Stable identifier (route id, not display text). */
  id: string;
  /**
   * Every capability the item needs. EMPTY means always available - the
   * generation-only surfaces that work with no connection at all, which is what
   * `requires: 'none'` used to say.
   */
  requires: readonly Capability[];
}

/**
 * How an item stands. Mirrors CapabilityVerdict deliberately: collapsing these
 * four into a boolean is exactly the flattening the model exists to prevent.
 */
export type NavAvailability = "available" | "denied" | "unknown" | "unreachable";

/** One item plus what we know about it. The item itself is never modified. */
export interface AnnotatedNavItem<T> {
  /** The original item, untouched and always present. */
  item: T;
  /** The item's standing. */
  availability: NavAvailability;
  /** One line for the operator, or null when the item is simply available. */
  reason: string | null;
  /**
   * The required capabilities that are NOT granted, in the item's own order.
   * Empty when available. Callers explain with this rather than re-deriving it.
   */
  missing: Capability[];
  /**
   * Whether the operator may open it. True for everything except `unreachable`,
   * and not on permission grounds even then - with no connection there is
   * nowhere to send the request. A `denied` item stays attemptable.
   */
  attemptable: boolean;
  /**
   * What to offer instead, when something is blocked and an artifact exists.
   * Null when available, and ALSO null when the blocked capability is a read -
   * those have no honest substitute (see fallbacks).
   */
  fallback: CapabilityFallback | null;
}

/**
 * The worst verdict decides the item, in this precedence:
 *
 *   unreachable > denied > unknown > granted
 *
 * `unreachable` outranks `denied` because it is the more fundamental fact and
 * the more actionable message: telling someone their permissions are missing
 * when they have not connected at all sends them to the wrong place entirely.
 */
const VERDICT_RANK: Readonly<Record<CapabilityVerdict, number>> = {
  unreachable: 3,
  denied: 2,
  unknown: 1,
  granted: 0,
};

/** Map the governing verdict onto the item's availability. */
function availabilityFor(verdict: CapabilityVerdict): NavAvailability {
  switch (verdict) {
    case "granted":
      return "available";
    case "denied":
      return "denied";
    case "unknown":
      return "unknown";
    case "unreachable":
      return "unreachable";
  }
}

/**
 * The connection-side wording, kept distinct from the permission wording.
 *
 * Takes ONLY the capabilities that are actually `unreachable`, never every
 * missing one. An item can need a denied Azure capability and an unreachable
 * Cribl one at the same time; reading the whole missing list would tell the
 * operator to "Connect Azure" when Azure is connected and merely refusing them.
 */
function unreachableReason(unreachable: readonly Capability[]): string {
  const azure = unreachable.some(isAzureCapability);
  const cribl = unreachable.some((c) => !isAzureCapability(c));
  if (azure && cribl) {
    return "Connect Azure and Cribl to use this.";
  }
  return azure ? "Connect Azure to use this." : "Connect Cribl to use this.";
}

/** The reason line for a governing verdict. */
function reasonFor(
  availability: NavAvailability,
  unreachable: readonly Capability[],
  fallback: CapabilityFallback | null,
): string | null {
  switch (availability) {
    case "available":
      return null;
    case "unreachable":
      return unreachableReason(unreachable);
    case "unknown":
      return "Not checked yet - run the permission check to see if this will work.";
    case "denied":
      // Rule 3 in one sentence: still attemptable, and the offer comes with it.
      return fallback === null
        ? "The connected identity cannot do this, and there is no offline substitute - this needs live read access."
        : `The connected identity cannot do this. You can still try, or take the ${fallback.label.toLowerCase()} to someone who can.`;
  }
}

/**
 * Annotate every nav item with what the connected identity can do.
 *
 * Returns one entry per input item, in input order, ALWAYS. This function has
 * no filtering path; that is the point of it.
 */
export function annotateNavItems<T extends NavItemCapabilities>(
  items: readonly T[],
  set: CapabilitySet,
  context: CapabilityContext,
): AnnotatedNavItem<T>[] {
  return items.map((item) => {
    let governing: CapabilityVerdict = "granted";
    const missing: Capability[] = [];
    // Tracked separately from `missing`: only these may drive connection
    // wording, since an item can be denied on one side and unreachable on the
    // other at the same time.
    const unreachable: Capability[] = [];
    const denied: Capability[] = [];

    for (const capability of item.requires) {
      const verdict = verdictFor(capability, set, context);
      if (verdict !== "granted") {
        missing.push(capability);
      }
      if (verdict === "unreachable") {
        unreachable.push(capability);
      }
      if (verdict === "denied") {
        denied.push(capability);
      }
      if (VERDICT_RANK[verdict] > VERDICT_RANK[governing]) {
        governing = verdict;
      }
    }

    const availability = availabilityFor(governing);
    // Offer the fallback for the FIRST DENIED capability that has one: the
    // artifacts are per-action, and naming one concrete thing beats listing
    // several. Only a measured denial earns an offer - an unmeasured capability
    // has not been shown to need one.
    const fallback =
      availability === "denied"
        ? (denied
            .map((capability) => fallbackFor(capability))
            .find((entry) => entry !== null) ?? null)
        : availability === "unreachable" &&
            unreachable.some(isAzureCapability) &&
            !context.azureIdentityPresent
          ? IDENTITY_FALLBACK
          : null;

    return {
      item,
      availability,
      reason: reasonFor(availability, unreachable, fallback),
      missing,
      // COMPOSED, not restated. This used to derive from the governing
      // verdict (`availability !== "unreachable"`), which was the same rule as
      // isAttemptable written a second time - so revisiting rule 3 would have
      // changed the action layer while the nav silently kept the old behaviour,
      // leaving routes clickable that the action layer had begun refusing. An
      // item is attemptable when every capability it needs is.
      attemptable: item.requires.every((capability) =>
        isAttemptable(capability, set, context),
      ),
      fallback,
    };
  });
}

/**
 * The annotated items that are NOT simply available - what a summary line would
 * count. A convenience over the full list; it never removes anything from it.
 */
export function unavailableCount<T>(annotated: readonly AnnotatedNavItem<T>[]): number {
  return annotated.filter((entry) => entry.availability !== "available").length;
}
