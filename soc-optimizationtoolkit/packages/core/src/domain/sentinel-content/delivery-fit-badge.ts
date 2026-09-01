/**
 * Delivery-fit badge derivation (DBT-15, 2026-08-31): map what is KNOWN about a
 * solution's Logs-Ingestion fit - the shipped classification, the live
 * connector fetch, and the absence of either - onto the badge the solution
 * browser renders. Pure: no IO, no React, so every state including the absent
 * ones is pinnable without a DOM.
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
 * the map was generated. The map cannot tell them apart, which is exactly why a
 * missing entry ALONE has to say "not measured" rather than pick one.
 *
 * WHY EVIDENCE IS A PARAMETER (review finding 2, 2026-09-01). The first attempt
 * gave the selected-solution card the same badge as a list row, and the row's
 * tooltip promises "its connectors are classified live when the solution is
 * selected". On the card that promise is already spent: the solution IS
 * selected and the classification HAS run. With the fetch complete and zero
 * connector files found, the card said "Not measured" about something it had
 * just measured - the original defect with the sign flipped, and the same
 * absent-versus-zero confusion. So the caller passes what it actually knows:
 *
 *   not-fetched  - nobody has looked (every list row; the card before its
 *                  effect fires). "Not measured" is the honest answer.
 *   fetching     - a look is UNDERWAY. Neither measured nor un-lookable-at.
 *   fetched      - the look FINISHED. The adapter rejects on 401/403, so a
 *                  resolved [] is never a hidden permission failure, and unlike
 *                  ARM's RBAC-filtered 200s the GitHub contents API does not
 *                  silently strip entries.
 *
 *                  BUT NOT ALWAYS A FOLDER THAT WAS READ, which review caught
 *                  after this header first claimed it: the adapter also
 *                  resolves [] when the SOLUTION folder itself 404s
 *                  (adapters.ts:1182) and when a connector directory is found
 *                  by name but has no `sha` to open (adapters.ts:1197). The
 *                  port only promises [] "when the solution has no connector
 *                  directory" - it never promised the folder was read. So the
 *                  copy below says what is true of ALL of those - no connector
 *                  file was found - and does not claim we read the folder.
 *   fetch-failed - the look THREW. Not measured, and pointing the operator at
 *                  "select it and we will classify it" would be a loop.
 *
 * WHICH SOURCE WINS. A shipped tier beats a live tier: the generator reads
 * EVERY connector file in a solution, while the live decode caps at the first
 * few (CONNECTOR_DECODE_CAP), so the live answer can under-report a solution
 * whose best connector sits past the cap. The one live answer that DOES beat
 * the shipped tier is `no-connector`, because it does not merely disagree with
 * the shipped entry - it falsifies its premise. A shipped entry exists only
 * because the generator read at least one connector file for that name, so a
 * completed listing that finds none proves the entry is stale. Letting the
 * shipped tier win there would also contradict the card's own next line, which
 * reads "0 connector files" directly beneath the badge.
 *
 * WHAT IS DELIBERATELY NOT DONE. `classifySolutionIngestion([])` returns
 * `legacy` for an empty connector list, and the temptation is to reuse it for
 * the absent case so every row carries a tier. That would state a measured
 * verdict - "not a native Logs Ingestion target" - about a solution whose
 * connectors were never read, which is this card's defect with the sign
 * flipped. `no-connector` is NOT that fallback: it is reported only from a
 * COMPLETED listing, and it says what was seen (no connector file) rather than
 * ranking the solution against the three tiers.
 */

import type { IngestionTier } from "./ingestion-class";
import { ingestionTierLabel } from "./ingestion-class";
import { ingestionTierReason } from "./ingestion-classification";

/**
 * The badge states a solution can be in. The three tiers and `no-connector` are
 * MEASURED outcomes; `measuring` and `unmeasured` are statements about the
 * evidence rather than about the solution.
 */
export type DeliveryFitState =
  | IngestionTier
  | "no-connector"
  | "measuring"
  | "unmeasured";

/** Anything carrying a tier and the CCF kind that drove it. */
export interface TieredIngestion {
  tier: IngestionTier;
  kind: string;
}

/**
 * What the caller knows about the LIVE per-solution connector fetch. A list row
 * never fetches, so it passes `not-fetched` (the default); the selected card
 * passes its real phase.
 */
export type DeliveryFitEvidence =
  | { readonly phase: "not-fetched" }
  | { readonly phase: "fetching" }
  | {
      /**
       * The fetch COMPLETED. `connectorCount` is how many connector files the
       * listing returned - a measured zero when it is 0. `ingestion` is the
       * tier decoded from them, null/undefined when none could be parsed (or
       * when the value predates the field in a cache entry).
       */
      readonly phase: "fetched";
      readonly connectorCount: number;
      readonly ingestion?: TieredIngestion | null;
    }
  | { readonly phase: "fetch-failed" };

/** The evidence a caller that has not looked passes - named so it reads. */
export const DELIVERY_FIT_NOT_FETCHED: DeliveryFitEvidence = {
  phase: "not-fetched",
};

/** What a row renders: never blank, and never silent about which state it is. */
export interface DeliveryFitBadge {
  state: DeliveryFitState;
  /** The badge text. Guaranteed non-empty - that guarantee IS the fix. */
  label: string;
  /** One line of why, for the tooltip. */
  reason: string;
  /**
   * True when the badge reports something that was actually LOOKED AT - the
   * three tiers, and `no-connector`. False for `unmeasured` and `measuring`.
   * Carried explicitly so a caller can style or count "reports an absence of
   * evidence" without re-deriving it from `state` and getting the polarity
   * wrong.
   */
  measured: boolean;
}

/** The badge text for a solution nothing has classified. */
export const DELIVERY_FIT_UNMEASURED_LABEL = "Not measured";

/** The badge text while the live connector fetch is in flight. */
export const DELIVERY_FIT_MEASURING_LABEL = "Measuring...";

/** The badge text for a completed fetch that found no connector file at all. */
export const DELIVERY_FIT_NO_CONNECTOR_LABEL = "No connector";

/**
 * The tooltip for a solution NOBODY HAS LOOKED AT yet - the list-row case. It
 * says what is missing (the measurement) and what is NOT being claimed (a poor
 * fit), because those are the two readings a blank cell used to leave open, and
 * it points at the thing that WILL measure it. That last clause is why this
 * reason is scoped to `not-fetched`: on the selected card the selection has
 * already happened, so promising it there described the past as the future.
 */
export const DELIVERY_FIT_UNMEASURED_REASON =
  "Delivery fit not measured - this solution is not in the shipped " +
  "classification map, which covers only solutions whose Data Connector JSON " +
  "could be read when the map was generated. That is not the same as a poor " +
  "fit or no fit: its connectors are classified live when the solution is " +
  "selected.";

/** The tooltip while the live classification is running. */
export const DELIVERY_FIT_MEASURING_REASON =
  "Measuring delivery fit now - this solution is not in the shipped " +
  "classification map, so its data-connector files are being read and " +
  "classified. Not a claim about fit either way yet.";

/**
 * The tooltip for a COMPLETED listing that found nothing. This is a measured
 * statement, and it is scoped to what was actually read: the solution's folder
 * holds no connector file, so nothing in it declares a table or DCR stream. It
 * deliberately stops short of "you cannot deliver this" - a custom table and
 * DCR built by hand remain available, and the solution's rules and workbooks
 * work over whatever table is fed.
 */
export const DELIVERY_FIT_NO_CONNECTOR_REASON =
  "Checked: no data connector file was found for this solution, so nothing " +
  "in it declares a table or DCR stream to deliver into. Its rules, " +
  "workbooks and parsers still work over a table you feed another way.";

/** The tooltip when the live fetch threw - looked, learned nothing. */
export const DELIVERY_FIT_FETCH_FAILED_REASON =
  "Delivery fit not measured - this solution is not in the shipped " +
  "classification map, and fetching its data-connector files failed, so none " +
  "were read. That is not the same as a poor fit or no fit: retry the fetch " +
  "to measure it.";

/**
 * The tooltip when connector files EXIST but none of the ones read parsed. The
 * count is the listing's, and the wording says "the ones read" rather than
 * "all of them" because the decode is capped: claiming every file failed when
 * only the first few were opened would be its own small lie.
 */
export function deliveryFitUnreadableReason(connectorCount: number): string {
  return (
    "Delivery fit not measured - this solution is not in the shipped " +
    `classification map, and although ${connectorCount} data connector file` +
    `${connectorCount === 1 ? "" : "s"} were found, none of the ones read ` +
    "could be parsed as JSON. That is not the same as a poor fit or no fit."
  );
}

function tierBadge(
  ingestion: TieredIngestion,
  measuredLive: boolean,
): DeliveryFitBadge {
  return {
    state: ingestion.tier,
    label: ingestionTierLabel(ingestion.tier),
    reason:
      ingestionTierReason(ingestion.tier, ingestion.kind) +
      // Says where the verdict came from, so a tier that disagrees with the
      // shipped map on a later look is not mistaken for the shipped one.
      (measuredLive ? " Measured from this solution's own connector files." : ""),
    measured: true,
  };
}

function unmeasured(reason: string): DeliveryFitBadge {
  return {
    state: "unmeasured",
    label: DELIVERY_FIT_UNMEASURED_LABEL,
    reason,
    measured: false,
  };
}

/**
 * The badge for one solution. `shipped` is the precomputed lookup (null when
 * the map misses); `evidence` is what the live per-solution fetch has
 * established so far, defaulting to "nobody looked" for callers that never
 * fetch. Never returns a blank label, and never reports an unknown as a zero or
 * a zero as an unknown - see the module comment for which source wins.
 */
export function deliveryFitBadge(
  shipped: TieredIngestion | null | undefined,
  evidence: DeliveryFitEvidence = DELIVERY_FIT_NOT_FETCHED,
): DeliveryFitBadge {
  // A completed listing with nothing in it beats the shipped tier: it falsifies
  // the premise under which that entry was written (see the module comment).
  if (evidence.phase === "fetched" && evidence.connectorCount === 0) {
    return {
      state: "no-connector",
      label: DELIVERY_FIT_NO_CONNECTOR_LABEL,
      reason: DELIVERY_FIT_NO_CONNECTOR_REASON,
      measured: true,
    };
  }
  if (shipped !== null && shipped !== undefined) {
    return tierBadge(shipped, false);
  }
  switch (evidence.phase) {
    case "fetched":
      return evidence.ingestion !== null && evidence.ingestion !== undefined
        ? tierBadge(evidence.ingestion, true)
        : unmeasured(deliveryFitUnreadableReason(evidence.connectorCount));
    case "fetching":
      return {
        state: "measuring",
        label: DELIVERY_FIT_MEASURING_LABEL,
        reason: DELIVERY_FIT_MEASURING_REASON,
        measured: false,
      };
    case "fetch-failed":
      return unmeasured(DELIVERY_FIT_FETCH_FAILED_REASON);
    case "not-fetched":
      return unmeasured(DELIVERY_FIT_UNMEASURED_REASON);
  }
}
