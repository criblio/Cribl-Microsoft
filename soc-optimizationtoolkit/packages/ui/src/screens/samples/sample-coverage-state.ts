/**
 * Sample-coverage state - the PURE decisions behind the Sample Data section's
 * two coverage questions, both fed by the SAME core join (deriveExpectedLogTypes
 * over the solution's content, compareLogTypeCoverage against the tagged
 * samples):
 *
 *   1. the RECOMMENDATION, at the top of the section - "this solution's
 *      detections need TRAFFIC, THREAT and CONFIG; you have provided TRAFFIC".
 *      Forward-looking, advisory, gates nothing (ADR 0003).
 *   2. the completeness CONFIRMATION, at the bottom - the 2026-08-04 request
 *      below, which does gate the pack build on an acknowledgement.
 *
 * They are the same fact asked at different moments: before the operator goes
 * and gets samples, and before the pack is built from them. Only the second
 * blocks, and it blocks on the OPERATOR's answer rather than on the derivation.
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

import type {
  LogTypeCoverage,
  LogTypeEvidence,
  MergedLogType,
  UnreferencedLogType,
} from "@soc/core";

export type { UnreferencedLogType };

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
        "This solution's detections have not been read yet, so there is nothing " +
        "to compare your samples against.",
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

  // The missing names are NOT repeated here: the recommendation panel at the top
  // of the section lists every expected log type with its provided state, and
  // printing the same list twice on one screen reads as two different findings.
  const label = missing.length === 1 ? "log type" : "log types";
  return {
    verdict: "gaps",
    headline:
      `${missing.length} ${label} referenced by this solution's detections still have ` +
      "no sample. Each one you add becomes another route and pipeline pair; " +
      "continuing without them means those events are never shaped.",
    missing,
    unreferenced,
    requiresAck: true,
  };
}

// ---------------------------------------------------------------------------
// The log-type RECOMMENDATION (ADR 0003, plan Phase 2)
// ---------------------------------------------------------------------------
//
// Same core join as the confirmation above - deriveExpectedLogTypes, the tagged
// samples, compareLogTypeCoverage - asked at the other end of the task.
//
// The confirmation is BACKWARD-looking and gates the build: you have provided
// these, some are missing, tick to proceed. The recommendation is FORWARD-
// looking and gates nothing: here is what this solution's detections
// discriminate on, so here is what to go and fetch. It sits where the Browse
// Samples button used to, because that is the moment the operator is deciding
// what to provide - which is precisely what the browser was pretending to
// answer for them by scoring filenames.
//
// ADVISORY, NEVER BLOCKING, and that is not a style preference: expected-log-
// types is explicitly a LOWER BOUND (table-wide rules contribute nothing,
// ASIM-normalized rules hide the discriminator behind a parser, a solution with
// no shipped detections yields nothing at all). Blocking on a lower bound blocks
// on a guess. The one gate in this section stays the 2026-08-04 acknowledgement,
// which asks the OPERATOR to confirm rather than asserting the app knows.

/** How the recommendation panel should read, given what is known. */
export type RecommendationStatus =
  /** The solution's detections have not been read yet. */
  | "unknown"
  /** Read, but they discriminate on nothing - we cannot recommend. */
  | "no-signal"
  /** We know what is needed and none of it has been provided. */
  | "none-provided"
  /** Some provided, some not. */
  | "partial"
  /** Every expected log type has a sample. */
  | "covered";

/**
 * One recommended log type, with whether the operator has provided it and WHICH
 * EVIDENCE named it.
 *
 * The evidence tier is not decoration. "A shipped detection filters on this"
 * and "your vendor documents this feed" are different claims, and an operator
 * deciding what to spend effort collecting needs to know which one they are
 * looking at - especially for a solution whose recommendation is entirely
 * vendor-derived because it ships no detections at all.
 */
export interface RecommendedLogType {
  /** The literal as its strongest source writes it (e.g. "TRAFFIC"). */
  value: string;
  /** Which tier named it. */
  evidence: LogTypeEvidence;
  /** True when a tagged sample covers it. */
  provided: boolean;
  /** Content tiers: the discriminator field the content compares against. */
  field?: string;
  /** Content tiers: how many items reference it - the core's ranking. */
  referenceCount?: number;
  /** Vendor tier: who documents it, and where. */
  vendor?: string;
  docUrl?: string;
  doc?: string;
  /**
   * Events MEASURED for this log type over {@link LogTypeRecommendation.volumeWindow},
   * when a Lake query has run. Undefined means unmeasured - which is the state
   * before any query, and must never render as zero.
   */
  eventCount?: number;
  /**
   * ESTIMATED bytes over that same window - the mean size of this log type's
   * sampled events times {@link eventCount}, computed in core.
   *
   * Undefined far more often than the count is: it needs a sample of THIS log
   * type's events, and a skewed dataset can count a log type at dataset scale
   * without any of its events appearing in the sample. Renders only with the
   * word "estimated" beside it.
   */
  estimatedBytes?: number;
}

/** Operator-facing name for an evidence tier. */
export function evidenceLabel(evidence: LogTypeEvidence): string {
  switch (evidence) {
    case "detection":
      return "a shipped detection filters on it";
    case "workbook":
      return "a shipped workbook queries it";
    case "vendor":
      return "the vendor documents this feed";
  }
}

export interface LogTypeRecommendation {
  status: RecommendationStatus;
  /** The lead sentence: what is needed, and what has been provided. */
  headline: string;
  /** Every expected log type, strongest evidence then measured volume first. */
  entries: RecommendedLogType[];
  /**
   * Provided log types no detection references - neutral, never an error, now
   * ranked by measured volume where one exists (plan Phase 5).
   */
  unreferenced: UnreferencedLogType[];
  /**
   * The window every `eventCount` on this recommendation was measured over.
   * Undefined when nothing has been measured.
   *
   * CARRIED BECAUSE A COUNT WITHOUT ITS WINDOW IS NOT A FACT: "890K events" is
   * a different claim over an hour than over a month, and the Lake result keeps
   * these together for exactly that reason. If the number renders, so does this.
   */
  volumeWindow?: { earliest: string; latest: string };
}

/** Join names as prose: "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Derive the forward-looking recommendation from the same coverage result the
 * confirmation uses.
 *
 * `contentLoaded` separates "not read yet" from "read, and it discriminates on
 * nothing" for the same reason {@link deriveSampleCoverageView} does: collapsing
 * them would let an unread solution read as "nothing needed", which is the
 * false-ok this codebase refuses everywhere else.
 */
export function deriveLogTypeRecommendation(
  merged: readonly MergedLogType[],
  unreferencedProvided: readonly UnreferencedLogType[],
  contentLoaded: boolean,
  volumeWindow?: { earliest: string; latest: string },
): LogTypeRecommendation {
  const unreferenced = [...unreferencedProvided];
  // Attached at every exit rather than at one: each status below returns its
  // own shape, and a window that appeared in only some of them would make the
  // counts render bare in the others.
  const withWindow = (
    recommendation: LogTypeRecommendation,
  ): LogTypeRecommendation => {
    if (volumeWindow !== undefined) {
      recommendation.volumeWindow = volumeWindow;
    }
    return recommendation;
  };

  // NOT LOADED means NOT LOADED, whatever the vendor catalog happens to know
  // (2026-08-20 audit). The vendor tier resolves from the solution NAME, which
  // is available the instant a solution is picked - while the content fetch is
  // still in flight. The guard briefly read `!contentLoaded && merged.length
  // === 0`, so during that window a Palo Alto solution announced "This solution
  // ships no detections that name a log type" before a single rule had been
  // read. That is the false-ok this module exists to refuse, and the same race
  // class as the 1.11.14 "await the live schema before re-analysing" fix.
  //
  // The vendor list is still worth showing while waiting - it is real, and it
  // is what the operator would act on - but it is shown under a headline that
  // says the content read is unfinished, never one that reports its verdict.
  if (!contentLoaded) {
    const vendorOnly = merged.filter((m) => m.evidence === "vendor");
    return withWindow({
      status: "unknown",
      headline:
        vendorOnly.length === 0
          ? "The log types this solution needs are read from its own content - " +
            "that read has not completed yet."
          : "Still reading this solution's content. Meanwhile, its vendor " +
            `documents ${joinNames(vendorOnly.map((m) => m.value))} - whether ` +
            "this solution needs them is not known yet.",
      entries: vendorOnly.map((m) => {
        const entry: RecommendedLogType = {
          value: m.value,
          evidence: m.evidence,
          provided: m.provided,
        };
        if (m.vendor !== undefined) entry.vendor = m.vendor;
        if (m.docUrl !== undefined) entry.docUrl = m.docUrl;
        if (m.doc !== undefined) entry.doc = m.doc;
        if (m.eventCount !== undefined) entry.eventCount = m.eventCount;
        if (m.estimatedBytes !== undefined) {
          entry.estimatedBytes = m.estimatedBytes;
        }
        return entry;
      }),
      unreferenced,
    });
  }

  const entries: RecommendedLogType[] = merged.map((m) => {
    const entry: RecommendedLogType = {
      value: m.value,
      evidence: m.evidence,
      provided: m.provided,
    };
    if (m.field !== undefined) entry.field = m.field;
    if (m.referencedBy !== undefined) entry.referenceCount = m.referencedBy.length;
    if (m.vendor !== undefined) entry.vendor = m.vendor;
    if (m.docUrl !== undefined) entry.docUrl = m.docUrl;
    if (m.doc !== undefined) entry.doc = m.doc;
    if (m.eventCount !== undefined) entry.eventCount = m.eventCount;
    if (m.estimatedBytes !== undefined) entry.estimatedBytes = m.estimatedBytes;
    return entry;
  });

  if (entries.length === 0) {
    return withWindow({
      status: "no-signal",
      headline:
        "This solution's detections do not filter on a log-type field, and no " +
        "vendor log-type documentation is bundled for it - so the app cannot say " +
        "which log types it needs. Provide the ones your environment sends.",
      entries: [],
      unreferenced,
    });
  }

  // WHOSE claim this is, said in the lead sentence. A list built entirely from
  // vendor documentation must not read as "your solution needs these" - it is
  // the fallback for a solution that told us nothing, and saying otherwise
  // would dress a catalog up as a requirement.
  const fromContent = entries.filter((e) => e.evidence !== "vendor");
  const lead =
    fromContent.length === 0
      ? `This solution ships no detections that name a log type. ${entries[0].vendor ?? "The vendor"} documents ${joinNames(entries.map((e) => e.value))}.`
      : `This solution's content needs ${joinNames(fromContent.map((e) => e.value))}.`;

  const have = entries.filter((e) => e.provided).map((e) => e.value);

  if (have.length === 0) {
    return withWindow({
      status: "none-provided",
      headline: `${lead} You have provided none of them yet.`,
      entries,
      unreferenced,
    });
  }
  if (have.length < entries.length) {
    return withWindow({
      status: "partial",
      headline: `${lead} You have provided ${joinNames(have)}.`,
      entries,
      unreferenced,
    });
  }
  return withWindow({
    status: "covered",
    headline: `${lead} You have provided all of them.`,
    entries,
    unreferenced,
  });
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
