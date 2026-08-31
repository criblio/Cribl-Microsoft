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

/**
 * The verb on the action control for a surface that can only POINT at the run,
 * not start it - passed as `FallbackNotice`'s `produceLabel`.
 *
 * A control reading "Download the ARM request bodies" that answers with a
 * sentence about another screen is exactly the dishonesty this notice exists to
 * avoid, so a pointing surface says what its button does instead. One constant
 * rather than a per-kind table: what happens is identical for every kind, and
 * {@link fallbackRunPointer} already carries the part that differs.
 */
export const FALLBACK_POINTER_LABEL = "Show where this is produced";

/**
 * WHICH run produces a run-kind artifact, in the operator's words.
 *
 * This is the "point at it" half of what a producer may do (D-2, backlog
 * section 16): a screen wiring `onProduce` either STARTS the run that makes the
 * artifact or says where that run is - and never builds a run-kind body itself,
 * because the body a run collects is resolved against live Azure reads and a
 * hand-assembled imitation would be a different artifact wearing the same name.
 *
 * The sentences name a SURFACE rather than a route id because that is what the
 * operator can act on, and they live here so the surfaces that can only point
 * (the DCR inventory panel today, the Tables tab next) all name the same run
 * instead of each inventing a route.
 *
 * Null for the inline kinds: they are generated where the offer is shown, so
 * there is no run to send anyone to. That is the same line {@link
 * isInlineArtifact} draws, read from the other side.
 */
export function fallbackRunPointer(kind: CapabilityFallbackKind): string | null {
  switch (kind) {
    case "dcr-arm-bodies":
    case "table-arm-bodies":
      return (
        "DCR Automation's Batch tab produces these: list the table, set " +
        "Template only to on, and Run. It writes nothing and saves every " +
        "collected ARM request body as one JSON file."
      );
    case "arm-template":
      return (
        "Sentinel Integration's Deploy section produces this: Export instead " +
        "of deploy writes nothing and saves a .tgz whose ARM template holds " +
        "the whole deployment, with the az command in its README."
      );
    case "cribl-pack":
      return (
        "Sentinel Integration's Deploy section produces this: Export instead " +
        "of deploy assembles the pack without installing it, and includes it " +
        "in the .tgz once the Gap Analysis mappings are approved."
      );
    case "role-assignment-request":
    case "app-registration-request":
      return null;
  }
}
