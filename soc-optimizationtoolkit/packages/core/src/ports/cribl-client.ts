/**
 * CriblClient port: raw access to the Cribl REST API (shapes per the vendored
 * assets/cribl-openapi.json spec). Domain code composes paths and payloads;
 * adapters own the transport.
 *
 * Implementations:
 * - Cloud shell: adapter over the platform's locked fetch, talking to the
 *   hosting workspace's own API.
 * - Local shell: the Node host performs outbound HTTP to the configured
 *   on-prem leader, handling token auth itself.
 *
 * Adapters own authentication (bearer/OAuth token lifecycle) and the base
 * URL; neither surfaces through this interface.
 */

import type { HttpMethod, PortHttpResponse } from './http';
import { filterListing, listingRows } from '../domain/inventory-listing';
import type { Listing } from '../domain/inventory-listing';

/** A single Cribl API request. */
export interface CriblRequest {
  /** HTTP verb. */
  method: HttpMethod;
  /**
   * Path relative to the API base /api/v1, e.g. "/system/outputs". Callers
   * must NOT include a host, /api/v1, or any /m/{groupId} prefix.
   */
  path: string;
  /**
   * Target Worker Group / Edge Fleet. When set, the adapter prefixes the
   * path with /m/{groupId}; when omitted the request addresses the leader's
   * top-level API.
   */
  groupId?: string;
  /** JSON-serializable request body for PUT/POST/PATCH. */
  body?: unknown;
  /** Query parameters. */
  query?: Record<string, string>;
  /**
   * How long the caller is willing to wait, in milliseconds. Omitted means the
   * adapter's default, which is short on purpose.
   *
   * WHY THIS EXISTS (AZR-18). Nearly every product API call answers quickly, so
   * the cloud adapter guards them all with one short client-side timeout - not
   * because the platform imposes one, but because the locked fetch bridge
   * IGNORES AbortSignal and a DETACHED bridge never settles at all. Without the
   * guard a dead bridge hangs the UI silently, which is what platform/http.ts
   * says it is for.
   *
   * ONE CALL IS LEGITIMATELY SLOW: POST /system/capture holds the response open
   * for the whole capture window by design. Under a single 15s guard the ceiling
   * on a capture was 12 seconds, and an operator asking for anything longer was
   * told the platform bridge had given up on a capture that had in fact run.
   *
   * So the WAIT is now the caller's to state, because only the caller knows
   * whether slow means broken. Adapters must still apply their own default when
   * this is absent - a request with no opinion is not a request that may hang.
   */
  timeoutMs?: number;
}

/** Summary of one Worker Group / Edge Fleet as reported by the leader. */
export interface CriblGroupSummary {
  /** Group id, used as {@link CriblRequest.groupId}. */
  id: string;
  /** Product the group belongs to (e.g. "stream", "edge"), when reported. */
  product?: string;
}

/**
 * Whether a group can run Stream pipelines and host the destinations this app
 * deploys: product "stream" (case-insensitive) or UNREPORTED (older and
 * single-product leaders omit every product signal; hiding those would empty
 * the list on exactly the deployments that have no Edge fleets). Edge fleets
 * are excluded everywhere a worker group is selected.
 */
export function isStreamWorkerGroup(group: CriblGroupSummary): boolean {
  return (
    group.product === undefined || group.product.toLowerCase() === "stream"
  );
}

/** A groups listing split into the Stream worker groups and everything else. */
export interface StreamWorkerGroupListing {
  /**
   * The Stream worker groups. `rows` when there are some; `none` when the
   * leader DID return groups and none of them is a Stream group (a measured
   * zero - {@link excluded} names what was there); `empty` when the listing
   * itself returned nothing, which is unverified and must not be read as
   * "this deployment has no worker groups".
   */
  stream: Listing<CriblGroupSummary>;
  /**
   * Every listed group that is NOT a Stream worker group, in listing order:
   * Edge fleets, Outpost and Search groups. Always empty for an `empty`
   * listing - nothing was read to exclude.
   */
  excluded: readonly CriblGroupSummary[];
}

/**
 * Filter a groups listing to the Stream worker groups WITHOUT losing what the
 * filter removed (DBT-134).
 *
 * Every picker used to call `.filter(isStreamWorkerGroup)` on a bare array and
 * keep only the result, so "the leader returned nothing", "your role sees no
 * group" and "the leader returned three Edge fleets" all reached the screen as
 * the same `[]` and rendered as one enabled select reading "No matches". The
 * source listing has to travel with the filter for those to stay apart, which
 * is what `filterListing` demands and this keeps in one place.
 */
export function streamWorkerGroups(
  listing: Listing<CriblGroupSummary>,
): StreamWorkerGroupListing {
  // Rows to filter, not a count: the empty case is carried by `listing`
  // itself and reaches `filterListing` unchanged.
  const all = listingRows(listing);
  return {
    stream: filterListing(listing, all.filter(isStreamWorkerGroup)),
    excluded: all.filter((group) => !isStreamWorkerGroup(group)),
  };
}

/**
 * Whether a group is a Cribl Edge FLEET (2026-07-30 Edge fleet inventory).
 * Strict, unlike isStreamWorkerGroup's unreported-product tolerance: a
 * leader that reports no product signal has no fleets to list.
 */
export function isEdgeFleet(group: CriblGroupSummary): boolean {
  return group.product?.toLowerCase() === "edge";
}

/**
 * Whether a group is a Cribl SEARCH group - the one that serves `/search/*`.
 *
 * Strict, like {@link isEdgeFleet}: a leader reporting no product signal has no
 * Search group to find, and guessing one would send every Search call to a
 * Stream group that answers 404.
 *
 * WHY THIS EXISTS (verified live 2026-08-19): `/search/*` is GROUP-scoped -
 * `/m/{searchGroupId}/search/datasets`, not a leader route - even though the
 * OpenAPI spec declares those paths bare. Cribl's own Search UI addresses them
 * that way. The id is NOT a constant: this workspace's is `default_search`, so
 * it must be resolved from the groups listing rather than hard-coded.
 */
export function isSearchGroup(group: CriblGroupSummary): boolean {
  return group.product?.toLowerCase() === "search";
}

/**
 * Derive a group's product from the fields /master/groups items actually
 * carry, oldest-leader-compatible and in signal order:
 *
 *  1. the explicit `product` string, when present;
 *  2. the ConfigGroup `type` string - the spec's explicit discriminator
 *     ("Explicit type of the Worker Group, Outpost Group, or Edge Fleet";
 *     enum edge | lake_access | local_search | outpost | search | stream).
 *     This is what catches OUTPOST groups (live report 2026-07-09:
 *     default_outpost carried type "outpost" and NO isFleet flag, so it
 *     survived the fleet fix);
 *  3. the DEPRECATED isFleet / isSearch booleans - how leaders that predate
 *     both fields above mark Edge fleets and Search groups (live report
 *     2026-07-09: default_fleet listed with no `product` field).
 *
 * EITHER of the first two saying "stream" wins (DBT-134 hardening): with the
 * explicit string first and nothing else, an item carrying an unexpected
 * `product` value beside `type: "stream"` was classed by the product and
 * dropped from every worker-group picker, although the spec's own
 * discriminator said it was a Stream group.
 *
 * Returns undefined only when the item carries NO product signal at all;
 * isStreamWorkerGroup then keeps it visible (a leader reporting nothing is a
 * single-product deployment with nothing to mis-list).
 */
export function deriveGroupProduct(
  product: unknown,
  type: unknown,
  isFleet: unknown,
  isSearch: unknown,
): string | undefined {
  const saysStream = (v: unknown) =>
    typeof v === "string" && v.toLowerCase() === "stream";
  if (saysStream(product) || saysStream(type)) {
    return "stream";
  }
  if (typeof product === "string" && product !== "") {
    return product;
  }
  if (typeof type === "string" && type !== "") {
    return type;
  }
  if (isFleet === true) {
    return "edge";
  }
  if (isSearch === true) {
    return "search";
  }
  return undefined;
}

/**
 * Minimal Cribl API client.
 *
 * Error semantics: `request` resolves with `{status, body}` for every HTTP
 * response, including 4xx/5xx - callers branch on `status`. Both methods
 * reject only on transport failure (network error, token acquisition
 * failure).
 */
export interface CriblClient {
  /** Execute one Cribl API request. See {@link CriblRequest}. */
  request(opts: CriblRequest): Promise<PortHttpResponse>;

  /**
   * List the Worker Groups / Edge Fleets visible to the configured
   * credentials. Convenience over the groups endpoint so usecases can offer
   * a group picker without knowing the route.
   *
   * A `Listing`, not an array (DBT-134/DBT-135): the leader answers a caller
   * whose role - or whose app grant - covers no group with `200 []`, which is
   * byte-identical to a deployment that has none. `empty` keeps that unknown;
   * {@link streamWorkerGroups} is how a picker narrows it. Rejects on a
   * non-2xx or an unreadable body, exactly as before.
   */
  listGroups(): Promise<Listing<CriblGroupSummary>>;
}
