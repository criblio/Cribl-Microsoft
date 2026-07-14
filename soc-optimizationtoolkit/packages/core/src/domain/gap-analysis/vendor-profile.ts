/**
 * Vendor gap-analysis PROFILE - porting-plan Unit 18 task item 6.
 *
 * The legacy kql-parser HARD-CODED two CrowdStrike/FDR-specific behaviors:
 *   1. When a dataFlow routes by `event_simpleName in (...)`, it injected the
 *      FDR "common fields" (event_simpleName, timestamp, aid, aip, cid,
 *      event_platform) into the derived column set.
 *   2. analyzeDcrGap always emitted a `_time` enrichment whose expression
 *      referenced the CrowdStrike FDR fields `timestamp` and `ContextTimeStamp`.
 *
 * Neither generalizes: a Palo Alto or Cloudflare feed has no `event_simpleName`
 * and no `ContextTimeStamp`. This module makes both VENDOR-PARAMETERIZED. The
 * default profile injects nothing vendor-specific; the verbatim legacy behavior
 * survives as {@link CROWDSTRIKE_FDR_PROFILE}.
 *
 * Pure data: no IO, no fetch, no React, no Date/crypto.
 */

import type { FieldRef } from "./models";

/** How a vendor's quirks flavor DCR decoding + gap analysis. */
export interface VendorGapProfile {
  /** Stable id for provenance/UI (e.g. "default", "crowdstrike-fdr"). */
  id: string;
  /**
   * Fields injected into a dataFlow's derived column set ONLY when the flow is
   * event_simpleName-routed (the legacy FDR-common-field injection). Empty for
   * a generic vendor.
   */
  commonFields: readonly FieldRef[];
  /**
   * The Cribl-side `_time` enrichment expression to emit, or null to omit it
   * (letting the pipeline generator's own timestamp logic decide - Unit 17).
   * The value is a Cribl pipeline JS EXPRESSION STRING evaluated in Cribl at
   * runtime; core never evaluates it (no Date call happens here).
   */
  timeEnrichment: { field: string; value: string } | null;
}

/**
 * The generic default: no vendor-specific common-field injection and no
 * hard-coded `_time` expression. Used whenever a caller does not supply a
 * profile, so gap analysis never assumes a field that a feed may not have.
 */
export const DEFAULT_GAP_PROFILE: VendorGapProfile = Object.freeze({
  id: "default",
  commonFields: Object.freeze([]),
  timeEnrichment: null,
});

/**
 * The VERBATIM legacy CrowdStrike/FDR behavior, preserved as an explicit,
 * opt-in profile. `commonFields` and the `_time` expression are byte-identical
 * to the hard-coded values in legacy kql-parser.ts (lines 97-104 and 322).
 */
export const CROWDSTRIKE_FDR_PROFILE: VendorGapProfile = Object.freeze({
  id: "crowdstrike-fdr",
  commonFields: Object.freeze([
    { name: "event_simpleName", type: "string" },
    { name: "timestamp", type: "long" },
    { name: "aid", type: "string" },
    { name: "aip", type: "string" },
    { name: "cid", type: "string" },
    { name: "event_platform", type: "string" },
  ]),
  timeEnrichment: {
    field: "_time",
    value:
      "Number(timestamp) / 1000 || Number(ContextTimeStamp) || Date.now() / 1000",
  },
});
