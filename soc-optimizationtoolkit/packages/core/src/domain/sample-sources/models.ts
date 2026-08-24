/**
 * Sample-source models - where the operator gets their OWN samples from
 * (sample-acquisition plan Phase 3, ADR 0003).
 *
 * TWO WAYS, and the operator picks between them explicitly (user direction
 * 2026-08-19):
 *
 *   LAKE QUERY   - an existing Cribl Lake dataset, queried through Cribl Search.
 *                  Data that already exists, so it can report complete log types
 *                  and volumes rather than whatever a short window happened to
 *                  contain.
 *   LIVE CAPTURE - a configured Cribl source, captured with a filter. Bounded,
 *                  immediate, and limited to what flows during the capture.
 *
 * "Search dataset" is deliberately NOT a third choice. Lake datasets are already
 * exposed in Cribl Search's own dataset list (verified 2026-08-19: cribl_metrics,
 * Corelight and LogSources appear in both), so offering them separately listed
 * the same dataset twice and asked the operator to choose between a place and
 * the mechanism for reading it. Search is HOW a Lake dataset is queried, not a
 * different thing to query.
 *
 * Manual upload is not a mode here either: it needs no Cribl access at all,
 * which is exactly why it stays permanently available in the intake section
 * below rather than hiding behind a choice.
 *
 * Pure data: no IO, no fetch, no React, no Date/crypto.
 */

/** How the operator wants to get samples out of Cribl. */
export type AcquisitionMode = "lake-query" | "live-capture";

/** Which surface an entry belongs to. One per {@link AcquisitionMode}. */
export type SampleSourceKind = "lake-dataset" | "cribl-source";

/** The surface each mode draws from. */
export const MODE_KIND: Record<AcquisitionMode, SampleSourceKind> = {
  "lake-query": "lake-dataset",
  "live-capture": "cribl-source",
};

/** One thing the operator can pick, normalized across both surfaces. */
export interface SampleSourceRef {
  /** Which surface this came from. */
  kind: SampleSourceKind;
  /** The id the API knows it by - what a later query or capture addresses. */
  id: string;
  /** Operator-facing label; falls back to the id when nothing better exists. */
  label: string;
  /**
   * The worker group this must be addressed through, when it is group-scoped.
   * Cribl sources carry their Stream group. Lake datasets carry NONE - listing
   * them is a leader route, which is why picking Lake mode needs no group.
   */
  groupId?: string;
  /** One-line provenance for the operator (dataset description, source type). */
  detail?: string;
  /**
   * Retained size in bytes, when the surface reports it (Lake datasets do).
   * Advisory only - it says nothing about which LOG TYPES are inside.
   */
  sizeBytes?: number;
  /** Retention window in days, when reported. */
  retentionDays?: number;
  /** True when the entry is configured but switched off (disabled sources). */
  disabled?: boolean;
}

/**
 * The outcome of ONE surface's discovery, kept separate because the surfaces
 * fail independently and the operator's next move differs: no Lake dataset is a
 * different sentence from a Lake listing that returned 403.
 */
export interface SampleSourceSection {
  kind: SampleSourceKind;
  /**
   * What happened, in four states that must never be collapsed:
   *
   *   `pending`     - not looked at yet. Says nothing about the workspace.
   *   `ok`          - the API answered; the entries are complete.
   *   `unavailable` - the surface does not exist here.
   *   `failed`      - it should have worked and did not.
   *
   * `pending` exists because discovery is LAZY: only the worker group listing
   * runs on load, and a surface nobody has asked for yet must not render as
   * "you have none".
   */
  status: "pending" | "ok" | "unavailable" | "failed";
  entries: SampleSourceRef[];
  /**
   * Why, when the status is not `ok`. Written for an operator, naming what they
   * lose rather than only what broke.
   */
  note?: string;
}

/** Everything discovered, one section per surface, both always present. */
export interface SampleSourceInventory {
  sections: SampleSourceSection[];
}
