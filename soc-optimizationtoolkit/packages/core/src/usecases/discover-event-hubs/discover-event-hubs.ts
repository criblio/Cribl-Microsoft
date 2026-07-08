/**
 * Event Hub discovery ACQUISITION usecase - roadmap Phase 4 (EVH-03 over the
 * AzureManagement port). One Resource Graph POST (skipToken-paginated)
 * inventories every namespace; one bounded ARM GET per namespace lists its
 * hubs (Resource Graph does not index hub child resources - the catalog's
 * dev-variant finding). The legacy N-resources x M-hubs scan (EVH-05) is
 * deliberately NOT ported.
 *
 * Failure semantics: a Resource Graph failure throws (nothing to show); a
 * single namespace's hub listing failing degrades to a WARNING and discovery
 * continues - one broken namespace never hides the rest.
 *
 * Pure orchestration over the port: no IO of its own.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { Logger } from "../../ports/logger";
import {
  EVENTHUB_NAMESPACES_KQL,
  listEventHubsRequest,
  parseEventHubItem,
  parseNamespacesResponse,
  resourceGraphRequest,
} from "../../domain/eventhub-discovery/eventhub-discovery";
import type {
  EventHubInfo,
  EventHubNamespaceInfo,
} from "../../domain/eventhub-discovery/eventhub-discovery";

/** Fail-safe bound on Resource Graph skipToken pages (1000 rows per page). */
export const EH_DISCOVERY_MAX_PAGES = 20;

/** The full discovery result. */
export interface EventHubDiscoveryResult {
  namespaces: EventHubNamespaceInfo[];
  hubs: EventHubInfo[];
  /** Per-namespace soft failures (hub listing denied/failed); never fatal. */
  warnings: string[];
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Discover every Event Hub namespace and its hubs in a subscription.
 */
export async function discoverEventHubs(
  azure: AzureManagement,
  input: { subscriptionId: string },
  logger?: Logger,
): Promise<EventHubDiscoveryResult> {
  // Namespace inventory: one Resource Graph query, skipToken-paginated.
  const namespaces: EventHubNamespaceInfo[] = [];
  let skipToken = "";
  for (let page = 0; page < EH_DISCOVERY_MAX_PAGES; page += 1) {
    const res = await azure.request(
      resourceGraphRequest(
        input.subscriptionId,
        EVENTHUB_NAMESPACES_KQL,
        skipToken === "" ? undefined : skipToken,
      ),
    );
    if (!is2xx(res.status)) {
      throw new Error(
        `Resource Graph query failed: HTTP ${res.status}` +
          (res.status === 403
            ? " - the identity needs Reader on the subscription"
            : ""),
      );
    }
    const parsed = parseNamespacesResponse(res.body);
    namespaces.push(...parsed.namespaces);
    skipToken = parsed.skipToken;
    if (skipToken === "") {
      break;
    }
  }

  // Per-namespace hub listing (plain ARM GET; soft-fails to a warning).
  const hubs: EventHubInfo[] = [];
  const warnings: string[] = [];
  for (const ns of namespaces) {
    try {
      const res = await azure.request(listEventHubsRequest(ns));
      if (!is2xx(res.status)) {
        warnings.push(
          `Could not list hubs in namespace ${ns.name}: HTTP ${res.status}`,
        );
        continue;
      }
      const value =
        typeof res.body === "object" &&
        res.body !== null &&
        Array.isArray((res.body as Record<string, unknown>)["value"])
          ? ((res.body as Record<string, unknown>)["value"] as unknown[])
          : [];
      for (const item of value) {
        const hub = parseEventHubItem(item, ns.name);
        if (hub !== null) {
          hubs.push(hub);
        }
      }
    } catch (err) {
      warnings.push(
        `Could not list hubs in namespace ${ns.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger?.info("eventhub-discovery: complete", {
    subscription: input.subscriptionId,
    namespaces: namespaces.length,
    hubs: hubs.length,
    warnings: warnings.length,
  });
  return { namespaces, hubs, warnings };
}
