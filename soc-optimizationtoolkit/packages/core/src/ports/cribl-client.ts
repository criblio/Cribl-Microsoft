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
   */
  listGroups(): Promise<CriblGroupSummary[]>;
}
