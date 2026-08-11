/**
 * Fallback routing - turning a permission verdict into "do it" / "download the
 * thing someone else runs" (capability-model-plan step 4).
 *
 * THE TENSION THIS MODULE RESOLVES. The plan says the ARM fallback should be
 * "forced from a permission verdict instead" of from the app mode. It ALSO says
 * (rule 3) that the audit informs and offers but never forbids, and that a
 * denied capability stays attemptable because Azure's own 403 is the real gate.
 * Taken literally, forcing artifact-only output off a `denied` verdict would
 * forbid the live attempt and contradict rule 3.
 *
 * The consistent reading, and the one implemented here:
 *
 *   UNREACHABLE FORCES. With no connection there is nowhere to send the
 *   request, so a live attempt is not a judgement call - it cannot happen. This
 *   is the case the old mode check actually covered (azure-only forced
 *   templateOnly because no live Cribl connection existed), so this preserves
 *   the existing behaviour rather than changing it.
 *
 *   DENIED OFFERS. The artifact is produced and named alongside the live
 *   action, which stays available. If the audit is stale or wrong the operator
 *   loses nothing; if it is right, Azure refuses and they already have the
 *   artifact in hand.
 *
 * That split is exactly {@link isAttemptable}, which is already false only for
 * `unreachable` - so this module composes the existing predicate rather than
 * introducing a second, subtly different rule.
 *
 * Pure: no IO, no clock.
 */

import { isAttemptable, verdictFor } from "./capabilities";
import type { Capability, CapabilityContext, CapabilitySet } from "./capabilities";
import { fallbackFor } from "./fallbacks";
import type { CapabilityFallback } from "./fallbacks";

/** How an action should be carried out. */
export type ActionRouting =
  | "live"      // do it: the capability is granted, or unmeasured and worth trying
  | "offer"     // do it if you like, and take the artifact too (measured denial)
  | "artifact"; // no connection - the artifact is the only possible output

/** What to do about one capability, and what to hand over. */
export interface CapabilityRouting {
  capability: Capability;
  routing: ActionRouting;
  /**
   * The artifact to produce, when there is one. Null for a granted capability,
   * and null for a blocked READ - reads have no offline substitute, and saying
   * so is the honest answer rather than a gap.
   */
  fallback: CapabilityFallback | null;
}

/**
 * Route one capability.
 *
 * `unknown` routes LIVE, deliberately. Not having measured is not a reason to
 * degrade someone's output - the plan's whole point is that an unmeasured or
 * stale audit costs an annotation, never the ability to work.
 */
export function routeCapability(
  capability: Capability,
  set: CapabilitySet,
  context: CapabilityContext,
): CapabilityRouting {
  const verdict = verdictFor(capability, set, context);
  const routing: ActionRouting = !isAttemptable(capability, set, context)
    ? "artifact"
    : verdict === "denied"
      ? "offer"
      : "live";
  return {
    capability,
    routing,
    fallback: routing === "live" ? null : fallbackFor(capability),
  };
}

/**
 * Whether a run must produce artifacts INSTEAD of writing anything live -
 * the capability-derived replacement for the mode-derived `forcedTemplateOnly`.
 *
 * True only when a required capability is UNREACHABLE. A denied capability does
 * not force this: the operator keeps the live attempt and is offered the
 * artifact beside it (see the module note).
 *
 * Preserves the behaviour the mode check produced - `!hasCribl(mode)` meant no
 * live Cribl connection existed, which is `destination.manage` unreachable.
 */
export function mustProduceArtifacts(
  required: readonly Capability[],
  set: CapabilitySet,
  context: CapabilityContext,
): boolean {
  return required.some(
    (capability) => !isAttemptable(capability, set, context),
  );
}

/**
 * Every artifact worth offering for a set of required capabilities, de-duplicated
 * by kind so one run does not offer the same pack three times over.
 *
 * Order follows `required`, so the caller controls which artifact leads.
 */
export function artifactsToOffer(
  required: readonly Capability[],
  set: CapabilitySet,
  context: CapabilityContext,
): CapabilityFallback[] {
  const seen = new Set<string>();
  const offers: CapabilityFallback[] = [];
  for (const capability of required) {
    const { fallback } = routeCapability(capability, set, context);
    if (fallback !== null && !seen.has(fallback.kind)) {
      seen.add(fallback.kind);
      offers.push(fallback);
    }
  }
  return offers;
}
