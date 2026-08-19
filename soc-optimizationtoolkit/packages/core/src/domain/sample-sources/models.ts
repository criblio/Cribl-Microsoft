/**
 * Sample-source inventory models - what the operator can actually REACH to get
 * samples from (sample-acquisition plan Phase 3, ADR 0003).
 *
 * The browser this replaces answered "which file should I use?" from a repo the
 * operator had no relationship with. This answers "where can I get my OWN data
 * from?", which has three possible answers in a Cribl.Cloud workspace:
 *
 *   - a Cribl SEARCH dataset (including federated ones) - searchable at scale,
 *     so it can report complete log types AND volumes;
 *   - a Cribl LAKE dataset - the workspace's own retained data;
 *   - a Cribl SOURCE - live, capturable with a filter, bounded.
 *
 * Manual upload is the fourth path and deliberately has no entry here: it needs
 * no discovery and no Cribl integration at all, which is exactly why it is the
 * fallback that always works.
 *
 * Pure data: no IO, no fetch, no React, no Date/crypto.
 */

/** Which acquisition surface an entry belongs to. */
export type SampleSourceKind = "search-dataset" | "lake-dataset" | "cribl-source";

/** One thing the operator can pick from, normalized across the three surfaces. */
export interface SampleSourceRef {
  /** Which surface this came from. */
  kind: SampleSourceKind;
  /** The id the API knows it by - what a later query or capture addresses. */
  id: string;
  /** Operator-facing label; falls back to the id when nothing better exists. */
  label: string;
  /**
   * The worker group this must be addressed through, when it is group-scoped.
   * Search datasets carry the Search group; Cribl sources carry their Stream
   * group; Lake datasets are a LEADER route and carry none.
   */
  groupId?: string;
  /** One-line provenance for the operator (dataset description, source type). */
  detail?: string;
  /**
   * Retained size in bytes, when the surface reports it (Lake datasets do).
   * Advisory only - it says nothing about which LOG TYPES are inside.
   */
  sizeBytes?: number;
  /** True when the entry is configured but switched off (disabled sources). */
  disabled?: boolean;
}

/**
 * The outcome of ONE surface's discovery. Kept per-surface rather than folded
 * into a single list+error because the surfaces fail independently and the
 * operator's next move differs: no Search entitlement is a different sentence
 * from a Search group that answered 403.
 */
export interface SampleSourceSection {
  kind: SampleSourceKind;
  /**
   * What happened, in four states that must never be collapsed:
   *
   *   `pending`     - not looked at yet. Nothing has been requested, so this
   *                   says nothing at all about the workspace.
   *   `ok`          - the API answered; the entries are complete.
   *   `unavailable` - the surface does not exist here (no Search group).
   *   `failed`      - it should have worked and did not.
   *
   * `pending` exists because discovery is LAZY (2026-08-19): only the worker
   * group listing runs on load, and a surface nobody has asked for yet must not
   * render as "you have none" - which is what `unavailable` or an empty `ok`
   * would say.
   */
  status: "pending" | "ok" | "unavailable" | "failed";
  entries: SampleSourceRef[];
  /**
   * Why, when the status is not `ok`. Written for an operator, naming what they
   * lose rather than only what broke.
   */
  note?: string;
}

/** Everything discovered, one section per surface, always all three present. */
export interface SampleSourceInventory {
  sections: SampleSourceSection[];
}
