/**
 * sample-acquisition shared MODELS - porting-plan Unit 16
 * (ENG-19, ENG-20 redesigned, ENG-41, ENG-42).
 *
 * The tiered sample-acquisition vocabulary: a resolved sample (raw vendor events
 * for one log type), a browse-list entry (metadata only, no content), a
 * per-log-type split, and the curated solution -> source mapping entry. These
 * are ported near-verbatim from legacy sample-resolver.ts (ResolvedSample,
 * AvailableSample, SampleSourceEntry) with the tier vocabulary preserved.
 *
 * Pure data + constants: no IO, no fetch, no React, no Date/crypto.
 */

import type { SampleFormat } from "../sample-parsing/models";

/**
 * The acquisition tiers, in PRECEDENCE order (highest first). Ported verbatim
 * from legacy sample-resolver.ts `ResolvedSample.tier`. The auto-resolution
 * precedence (see {@link TIER_PRECEDENCE}) is user > cribl > elastic >
 * synthesized; "sentinel-repo" is a browse-only tier that surfaces in the
 * browse list beside elastic but is not part of the silent auto-resolve chain
 * (legacy `resolveSamples` never consulted it).
 */
export type SampleTier =
  | "user"
  | "cribl"
  | "elastic"
  | "synthesized"
  | "sentinel-repo";

/**
 * Auto-resolution precedence for {@link file:./precedence.ts} - the pinned order
 * legacy `resolveSamples` applied: user-uploaded overrides everything, then
 * Cribl pack samples (already enveloped), then Elastic integrations test data,
 * then synthesis as the last resort. THE order is the contract (any reorder
 * silently changes which samples a user gets).
 */
export const TIER_PRECEDENCE: readonly SampleTier[] = Object.freeze([
  "user",
  "cribl",
  "elastic",
  "synthesized",
]);

/**
 * A resolved sample: the raw vendor event lines for one log type, tagged with
 * where it came from. Ported verbatim from legacy sample-resolver.ts.
 */
export interface ResolvedSample {
  /** The Sentinel destination table (or the log type for repo/user samples). */
  tableName: string;
  /** Detected vendor format: json, cef, kv, syslog, csv, ndjson, leef, unknown. */
  format: SampleFormat;
  /** Raw vendor event strings (already capped per tier). */
  rawEvents: string[];
  /** Provenance id, e.g. "elastic:cisco_asa/log/test.log:TRAFFIC". */
  source: string;
  /** Which tier produced this sample. */
  tier: SampleTier;
  /** Sub-type within the source (e.g. "traffic", "threat"), when known. */
  logType?: string;
}

/**
 * A browse-list entry: sample metadata for UI selection, WITHOUT the full
 * content. Ported verbatim from legacy sample-resolver.ts `AvailableSample`.
 */
export interface AvailableSample {
  /**
   * The STABLE selection id. For elastic splits it is `${source}:${logType}`
   * (the load-time footgun: browse and load must generate byte-identical ids or
   * selection silently breaks - see {@link file:./precedence.ts}).
   */
  id: string;
  /** The browse tier (no "user"; user samples are never browsed). */
  tier: Exclude<SampleTier, "user">;
  /** Human-readable source label, e.g. "Elastic: cisco_asa". */
  source: string;
  /** Data stream / log-type name. */
  logType: string;
  /** Detected format. */
  format: SampleFormat;
  /** Number of events in this sample. */
  eventCount: number;
  /** Original file name. */
  fileName: string;
  /** First few raw event lines for a UI preview. */
  preview?: string[];
}

/** One per-log-type split of a multi-type sample file. */
export interface SplitSample {
  /** The uppercased, sanitized log-type name (the split key). */
  logType: string;
  /** The raw event lines that fell into this log type. */
  rawEvents: string[];
  /** The format carried through from the parent sample. */
  format: SampleFormat;
  /** Convenience count === rawEvents.length. */
  eventCount: number;
}

/**
 * A curated solution -> sample-source mapping entry. Ported verbatim from
 * legacy sample-resolver.ts `SampleSourceEntry`.
 */
export interface SampleSourceEntry {
  /** Elastic integrations package name (e.g. "cisco_asa"). */
  elasticPackage?: string;
  /** Specific data streams to fetch (empty/absent = discover / default ["log"]). */
  elasticDataStreams?: string[];
  /** Cribl packs GitHub repo name (e.g. "cribl-cisco-asa-cleanup"). */
  criblPackRepo?: string;
  /** Known sample file names under the pack's data/samples/. */
  criblSampleFiles?: string[];
  /** Primary Sentinel destination table. */
  sentinelTable: string;
  /** Expected vendor format for synthesis. */
  sourceFormat?: SampleFormat;
}

// ---------------------------------------------------------------------------
// Event caps - the legacy per-tier slice limits, named (porting-plan Unit 16:
// "event caps (50/50/100)").
// ---------------------------------------------------------------------------

/** Elastic tier keeps at most this many events per file (legacy slice(0, 50)). */
export const ELASTIC_EVENT_CAP = 50;

/** Cribl tier keeps at most this many events per file (legacy slice(0, 50)). */
export const CRIBL_EVENT_CAP = 50;

/** User-uploaded tier keeps at most this many events (legacy slice(0, 100)). */
export const USER_EVENT_CAP = 100;

/** Synthesis generates exactly this many events per log type (legacy NUM_EVENTS). */
export const SYNTHESIS_EVENT_COUNT = 5;

/** How many raw lines a browse-list preview carries (legacy slice(0, 3)). */
export const PREVIEW_EVENT_COUNT = 3;
