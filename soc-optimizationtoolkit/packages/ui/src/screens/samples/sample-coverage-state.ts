/**
 * Sample-coverage state - the PURE decisions behind the Sample Data section's
 * completeness confirmation (user request 2026-08-04).
 *
 * THE THING THE APP WAS NOT SAYING: every unique log type the operator tags
 * becomes its own route pair, pipeline pair, and sample file in the generated
 * pack (@soc/core scaffoldPack + generateRouteYml). A log type with no sample
 * therefore gets no route at all - its events arrive unshaped and unreduced -
 * and log types that cannot be told apart collapse into overlapping match-all
 * routes where only the first receives events. None of that was visible before
 * the pack was built.
 *
 * So the section states the consequence, compares what the solution's
 * detections reference against what has been provided, and asks the operator
 * to confirm before the pack build is armed.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { LogTypeCoverage } from "@soc/core";

/** What the pack gains per unique log type - stated once, here. */
export const ROUTES_PER_LOG_TYPE = 2;
export const PIPELINES_PER_LOG_TYPE = 2;

/**
 * The consequence line for a given sample count. Concrete counts, because
 * "each sample adds routes and pipelines" is abstract until it is numbers.
 */
export function packShapeSummary(sampleCount: number): string {
  if (sampleCount === 0) {
    return (
      "No samples tagged yet. Each unique log type you add becomes its own pair of " +
      "routes and pipelines in the pack - with none, the pack has nothing to route."
    );
  }
  const routes = sampleCount * ROUTES_PER_LOG_TYPE;
  const pipelines = sampleCount * PIPELINES_PER_LOG_TYPE;
  const types = sampleCount === 1 ? "log type" : "log types";
  return (
    `${sampleCount} ${types} tagged, so the pack will carry ${routes} routes and ` +
    `${pipelines} pipelines (a reduction and a transform pair per log type), plus ` +
    `one sample file each. A log type with no sample gets no route, so its events ` +
    `arrive unshaped.`
  );
}

/** How the derived comparison should read, given what is known. */
export type CoverageVerdict =
  /** No content parsed yet - nothing to compare against, and we say so. */
  | "unknown"
  /** Content parsed but it discriminates on nothing - an honest empty result. */
  | "no-signal"
  /** Every referenced log type has a sample. */
  | "covered"
  /** At least one referenced log type has no sample. */
  | "gaps";

export interface SampleCoverageView {
  verdict: CoverageVerdict;
  /** One-sentence headline for the section. */
  headline: string;
  /** Log-type names with no sample, in the order the core ranked them. */
  missing: string[];
  /** Provided log types no detection references - reported, never an error. */
  unreferenced: string[];
  /** Whether the acknowledgement checkbox must be ticked to arm the build. */
  requiresAck: boolean;
}

/**
 * Project the core coverage result into what the section renders.
 *
 * `contentLoaded` distinguishes "we have not looked" from "we looked and the
 * detections discriminate on nothing" - collapsing those would let an
 * unanalyzed solution read as fully covered, which is exactly the false-ok this
 * codebase refuses elsewhere.
 *
 * The acknowledgement is required in EVERY state except 'unknown': even with no
 * gaps found the operator is the only one who knows whether more unique log
 * types exist, because the derivation is a lower bound (table-wide and
 * ASIM-normalized rules contribute nothing).
 */
export function deriveSampleCoverageView(
  coverage: LogTypeCoverage,
  contentLoaded: boolean,
  sampleCount: number,
): SampleCoverageView {
  const missing = coverage.missing.map((m) => m.value);
  const unreferenced = [...coverage.unreferenced];

  if (!contentLoaded) {
    return {
      verdict: "unknown",
      headline:
        "Run the DCR Gap Analysis to compare your samples against the log types " +
        "this solution's detections reference.",
      missing: [],
      unreferenced,
      requiresAck: false,
    };
  }

  if (coverage.expected.length === 0) {
    return {
      verdict: "no-signal",
      headline:
        "This solution's detections do not filter on a log-type field, so there is " +
        "nothing to compare against - only you can confirm the set is complete.",
      missing: [],
      unreferenced,
      requiresAck: sampleCount > 0,
    };
  }

  if (missing.length === 0) {
    return {
      verdict: "covered",
      headline: `Every log type this solution's detections reference (${coverage.expected.length}) has a sample.`,
      missing: [],
      unreferenced,
      requiresAck: true,
    };
  }

  const label = missing.length === 1 ? "log type" : "log types";
  return {
    verdict: "gaps",
    headline:
      `${missing.length} ${label} referenced by this solution's detections have no sample: ` +
      `${missing.join(", ")}. Each one you add becomes another route and pipeline pair; ` +
      "continuing without them means those events are never shaped.",
    missing,
    unreferenced,
    requiresAck: true,
  };
}

/** The build-gate reason, or null once the operator has confirmed. */
export function sampleCoverageGateReason(
  view: SampleCoverageView,
  acknowledged: boolean,
): string | null {
  if (!view.requiresAck || acknowledged) {
    return null;
  }
  return view.verdict === "gaps"
    ? "Confirm the sample set in Add Sample Data - some referenced log types have no sample."
    : "Confirm in Add Sample Data that you have no more unique log types to provide.";
}
