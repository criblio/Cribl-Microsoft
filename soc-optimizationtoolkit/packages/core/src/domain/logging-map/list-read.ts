/**
 * The read verdict of ONE list request, for the Azure Logging Map (AZR-19).
 *
 * WHY NOT A PLAIN ARRAY. The legacy PowerShell this map ports from answered
 * every failed read with `catch { return @() }`, so "could not read" and "there
 * are none" came out identical. The inventory-honesty rule (`Listing` in
 * `../inventory-listing`) forbids that, and this module is how the map obeys
 * it: every per-scope list read is either `read` (with its rows - possibly
 * zero) or `refused` (with why). The refusal list is DERIVED from these values
 * by {@link refusalsOf}; it is never kept beside them, so the two cannot drift.
 *
 * Pure: no IO, no Date, no randomness. Domain - imports no usecase.
 */

import type { Listing } from "../inventory-listing";
import type { ScopeRead } from "./logging-map-types";

/** Why a read did not produce a verdict. */
export type RefusalReason =
  /** ARM answered with a non-2xx status. */
  | "http"
  /** The port rejected: network, token acquisition, proxy. */
  | "transport"
  /** A 2xx whose body (on any page) had no array `value`. Never zero rows. */
  | "unexpected-shape"
  /** The page cap, a read cap, or pagination unavailable. */
  | "too-many-pages";

/** A refused read, with enough to show the operator and to grep the logs. */
export interface Refusal {
  /** The request that was refused - its path, for the operator and the logs. */
  readonly request: string;
  /** The HTTP status, or null when no response arrived. */
  readonly status: number | null;
  /** The ARM error code (`AuthorizationFailed`...), '' when none. */
  readonly code: string;
  /** Raw greppable error text. */
  readonly text: string;
  readonly reason: RefusalReason;
}

/** The verdict of one list read: its rows, or why there are none to give. */
export type ListRead<T> =
  | { readonly state: "read"; readonly rows: readonly T[] }
  | { readonly state: "refused"; readonly refusal: Refusal };

/** A completed read. Zero rows is allowed and means a real zero. */
export function readRows<T>(rows: readonly T[]): ListRead<T> {
  return { state: "read", rows };
}

/** A refused read. */
export function readRefused<T>(refusal: Refusal): ListRead<T> {
  return { state: "refused", refusal };
}

/** Re-type a refusal while mapping a read's rows (a refusal carries no rows). */
export function mapListRead<S, T>(
  read: ListRead<S>,
  fn: (rows: readonly S[]) => readonly T[],
): ListRead<T> {
  return read.state === "read"
    ? { state: "read", rows: fn(read.rows) }
    : { state: "refused", refusal: read.refusal };
}

function isScopeRead(value: ScopeRead | ListRead<unknown>): value is ScopeRead {
  return "scopeId" in value;
}

/**
 * Every refusal in these reads, in order. THE ONLY SOURCE OF REFUSALS: a
 * {@link ScopeRead} contributes its assignments refusal then its exemptions
 * refusal, and a bare {@link ListRead} contributes its own. A `read` list
 * contributes nothing, whatever its row count.
 */
export function refusalsOf(
  reads: readonly (ScopeRead | ListRead<unknown>)[],
): readonly Refusal[] {
  const out: Refusal[] = [];
  for (const r of reads) {
    if (isScopeRead(r)) {
      if (r.assignments.state === "refused") out.push(r.assignments.refusal);
      if (r.exemptions.state === "refused") out.push(r.exemptions.refusal);
    } else if (r.state === "refused") {
      out.push(r.refusal);
    }
  }
  return out;
}

/**
 * Turn a PER-SCOPE ARM list read into a {@link Listing}.
 *
 * THE VERDICT ARGUMENT, extending the rule at `inventory-listing.ts` (`toListing`:
 * a raw empty is unverified and never `none`). That rule exists because a
 * PERMISSION-FILTERED listing - GET /subscriptions, GET managementGroups -
 * silently drops what the caller cannot see, so its empty answer means nothing.
 * A per-scope ARM read is a different request: policyAssignments
 * `atScope()`, policyExemptions and roleAssignments at a named scope answer
 * 403 when the caller lacks read permission there; they do not filter the
 * result down to empty. So a 2xx whose every page carried an array `value`,
 * with paging complete (which is exactly what `state: "read"` certifies), is a
 * capability verdict for that scope, and zero rows is a measured zero:
 *
 * - `read`, zero rows   -> `{ kind: "none" }`  (say "none" plainly)
 * - `read`, some rows   -> `{ kind: "rows" }`
 * - `refused`           -> `{ kind: "empty" }` (UNKNOWN, never a count)
 *
 * The 403-not-empty claim is a platform fact still to be confirmed live
 * (AZR-19 live item 3f). If it proves false for a request kind, that kind must
 * stop coming through here.
 *
 * DO NOT USE THIS for a permission-filtered listing. Those go through
 * `toListing`, which can never mint `none`.
 */
export function toListingFromRead<T>(read: ListRead<T>): Listing<T> {
  if (read.state === "refused") return { kind: "empty" };
  return read.rows.length === 0
    ? { kind: "none" }
    : { kind: "rows", rows: read.rows as readonly [T, ...T[]] };
}
