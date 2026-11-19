/**
 * Focus here (AZR-147, ADR 0009 decision 6 amendment 2026-11-19) - the ACTIVE
 * tenant's gaps, from its latest gap read, for the summary at the top of Azure
 * Native Source Onboarding and the gap badges in the source chooser.
 *
 * THREE BUCKETS, NEVER FOLDED (claude-kit standards/inventory-honesty.md):
 *
 *   gap       at least one indicator is RED - a measured gap. Listed with the
 *             red indicators' own reason sentences.
 *   unknown   no indicator is red, and at least one is unknown (a read was
 *             refused, not run, not proven to be this tenant's, or the source
 *             has no cell at all). Counted, never shown as a gap or as OK.
 *   ok        both indicators green.
 *
 * Every source of the catalog lands in exactly one bucket, so the three counts
 * always add up to the catalog's size.
 *
 * Pure: no IO, no Date, no randomness.
 */

import { GAP_SOURCES, type GapIndicator, type TenantGapRow } from "./tenant-gap";
import type { OnboardingSourceId } from "../onboarding-howto/sources";

/** One red indicator of a gap source. */
export interface FocusIndicator {
  readonly side: "azure" | "cribl";
  readonly indicator: GapIndicator;
}

/** One source with a measured gap. */
export interface FocusGap {
  readonly sourceId: OnboardingSourceId;
  readonly title: string;
  /** The red indicators, Azure first. Never empty. */
  readonly red: readonly FocusIndicator[];
  /** The other indicator when it could not be told; null when it is green or also red. */
  readonly unknownSide: FocusIndicator | null;
}

/** The active tenant's focus, from one row. */
export interface FocusSummary {
  readonly gaps: readonly FocusGap[];
  /** Sources with no red indicator and at least one unknown (or no cell at all). */
  readonly unknownSources: readonly OnboardingSourceId[];
  /** Sources with both indicators green. */
  readonly okSources: readonly OnboardingSourceId[];
}

/** Bucket every catalog source of `row`. */
export function focusSummary(row: TenantGapRow): FocusSummary {
  const gaps: FocusGap[] = [];
  const unknownSources: OnboardingSourceId[] = [];
  const okSources: OnboardingSourceId[] = [];
  for (const source of GAP_SOURCES) {
    const cell = row.cells.find((c) => c.sourceId === source.id);
    if (cell === undefined) {
      unknownSources.push(source.id);
      continue;
    }
    const sides: FocusIndicator[] = [
      { side: "azure", indicator: cell.azure },
      { side: "cribl", indicator: cell.cribl },
    ];
    const red = sides.filter((s) => s.indicator.state === "red");
    if (red.length > 0) {
      const unknownSide = sides.find((s) => s.indicator.state === "unknown") ?? null;
      gaps.push({ sourceId: source.id, title: source.title, red, unknownSide });
    } else if (sides.some((s) => s.indicator.state === "unknown")) {
      unknownSources.push(source.id);
    } else {
      okSources.push(source.id);
    }
  }
  return { gaps, unknownSources, okSources };
}

/** The sources with a measured gap, for the chooser's badges. */
export function gapSourceIds(row: TenantGapRow | null): ReadonlySet<OnboardingSourceId> {
  if (row === null) return new Set();
  return new Set(focusSummary(row).gaps.map((g) => g.sourceId));
}
