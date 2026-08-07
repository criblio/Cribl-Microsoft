/**
 * Fallback notice state - the PURE copy decisions behind the "someone else runs
 * this" offer (capability-model-plan step 4).
 *
 * The catalog in @soc/core says WHAT the artifact is and how it is handed over.
 * This module says how the offer READS on screen, and it exists separately so
 * the wording is testable without a DOM and identical wherever the offer
 * appears.
 *
 * The tone is deliberate. This is an OFFER, not an error: the operator may still
 * attempt the live action (rule 3 - the audit informs and offers, it never
 * forbids), and the artifact is the thing they can hand to someone who can. A
 * notice that reads like a failure would push people to give up on an action
 * Azure has not actually refused yet.
 *
 * Pure: no IO, no React.
 */

import type { CapabilityFallbackKind } from "@soc/core";

/** The verb on the action control, per artifact kind. */
export function fallbackActionLabel(kind: CapabilityFallbackKind): string {
  switch (kind) {
    case "dcr-arm-bodies":
    case "table-arm-bodies":
    case "arm-template":
      return "Download the ARM request bodies";
    case "role-assignment-request":
      return "Generate the role-assignment request";
    case "app-registration-request":
      return "Generate the app-registration request";
    case "cribl-pack":
      return "Download the pack (.crbl)";
  }
}

/**
 * Whether producing this artifact is something the app does INLINE, or
 * something it hands off to another screen.
 *
 * The change-request kinds are generated on the spot from data the app already
 * has. The ARM and pack kinds are produced by a RUN (a template-only batch, a
 * pack build), so the honest offer points at that run rather than pretending a
 * button here produces it.
 */
export function isInlineArtifact(kind: CapabilityFallbackKind): boolean {
  return (
    kind === "role-assignment-request" || kind === "app-registration-request"
  );
}

/** One line of context under the offer, or null when the label says enough. */
export function fallbackHint(kind: CapabilityFallbackKind): string | null {
  return isInlineArtifact(kind)
    ? "Generated here - paste it into a ticket."
    : "Produced by a run that makes no live changes.";
}
