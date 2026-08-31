/**
 * Delivery-fit badge derivation (DBT-15, 2026-08-31): map a solution's
 * Logs-Ingestion classification - INCLUDING its absence - onto the badge the
 * solution browser renders. Pure: no IO, no React, so every case including the
 * absent one is pinnable without a DOM.
 *
 * WHY THIS EXISTS. The browser rendered a badge only when the shipped map had
 * the solution (`lookupSolutionIngestion(name) !== null`) and rendered NOTHING
 * otherwise. Confirmed live 2026-08-28: "Palo Alto Cortex XDR", "AbuseIPDB" and
 * "Acronis Cyber Protect Cloud" showed an empty badge cell beside siblings
 * carrying Recommended, Supported and Legacy. A blank cell is ambiguous between
 * "nobody measured this" and "measured: nothing to deliver here" - the
 * absent-versus-zero distinction docs/inventory-standard.md is BINDING about,
 * where "not measured" is its own answer and must never collapse into either of
 * the other two.
 *
 * THE ABSENCE IS REAL, not a rendering failure. The shipped map comes from
 * scripts/generate-ingestion-classification.mjs, which walks the Azure-Sentinel
 * checkout and SKIPS a solution outright when its folder yields no Data
 * Connector JSON (`files.length === 0`) or none that parse
 * (`classes.length === 0`) - both `continue` without writing an entry. So 436
 * of the repo's solutions are in the map and the rest are simply not there, and
 * a missing name conflates three different facts: the solution ships no
 * connector, its connector JSON did not parse, or it was added upstream after
 * the map was generated. The map cannot tell them apart, which is exactly why
 * the badge has to say "not measured" rather than pick one.
 *
 * WHAT IS DELIBERATELY NOT DONE. `classifySolutionIngestion([])` returns
 * `legacy` for an empty connector list, and the temptation is to reuse it here
 * so every row carries a tier. That would state a measured verdict - "not a
 * native Logs Ingestion target" - about a solution whose connectors were never
 * read, which is the defect this card is about with the sign flipped. Nor is
 * "does not apply" inferred from a zero-length connector listing on the live
 * per-solution fetch: an empty listing is an unknown, not a zero.
 */

import type { IngestionTier } from "./ingestion-class";
import { ingestionTierLabel } from "./ingestion-class";
import { ingestionTierReason } from "./ingestion-classification";

/**
 * The badge states a solution row can be in. The three tiers are MEASURED
 * verdicts; `unmeasured` is the fourth, and it is a statement about the
 * evidence rather than about the solution.
 */
export type DeliveryFitState = IngestionTier | "unmeasured";

/** Anything carrying a tier and the CCF kind that drove it. */
export interface TieredIngestion {
  tier: IngestionTier;
  kind: string;
}

/** What a row renders: never blank, and never silent about which it is. */
export interface DeliveryFitBadge {
  state: DeliveryFitState;
  /** The badge text. Guaranteed non-empty - that guarantee IS the fix. */
  label: string;
  /** One line of why, for the tooltip. */
  reason: string;
  /**
   * False only for `unmeasured`. Carried explicitly so a caller can style or
   * count "reports an absence of evidence" without re-deriving it from `state`
   * and getting the polarity wrong.
   */
  measured: boolean;
}

/** The badge text for a solution the shipped map never classified. */
export const DELIVERY_FIT_UNMEASURED_LABEL = "Not measured";

/**
 * The tooltip for that state. It says what is missing (the measurement) and
 * what is NOT being claimed (a poor fit), because those are the two readings a
 * blank cell used to leave open. Worded as a statement of MECHANISM rather than
 * an instruction, because the same badge appears on the selected-solution card,
 * where "select it" would already be done.
 */
export const DELIVERY_FIT_UNMEASURED_REASON =
  "Delivery fit not measured - this solution is not in the shipped " +
  "classification map, which covers only solutions whose Data Connector JSON " +
  "could be read when the map was generated. That is not the same as a poor " +
  "fit or no fit: its connectors are classified live when the solution is " +
  "selected.";

/**
 * The badge for one solution's classification. `null`/`undefined` - the shipped
 * lookup missed and no live classification is available - is the fourth state,
 * NOT a missing badge and not a tier.
 */
export function deliveryFitBadge(
  ingestion: TieredIngestion | null | undefined,
): DeliveryFitBadge {
  if (ingestion === null || ingestion === undefined) {
    return {
      state: "unmeasured",
      label: DELIVERY_FIT_UNMEASURED_LABEL,
      reason: DELIVERY_FIT_UNMEASURED_REASON,
      measured: false,
    };
  }
  return {
    state: ingestion.tier,
    label: ingestionTierLabel(ingestion.tier),
    reason: ingestionTierReason(ingestion.tier, ingestion.kind),
    measured: true,
  };
}
