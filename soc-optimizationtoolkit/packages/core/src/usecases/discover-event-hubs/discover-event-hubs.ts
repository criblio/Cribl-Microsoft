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
  EVENTHUB_DIAG_SETTINGS_KQL,
  EVENTHUB_NAMESPACES_KQL,
  listAuthRulesRequest,
  listConsumerGroupsRequest,
  listEventHubsRequest,
  metricsRequest,
  parseAuthRulesResponse,
  parseConsumerGroupsResponse,
  parseDiagSettingsResponse,
  parseEventHubItem,
  parseIncomingMessagesTotal,
  parseNamespacesResponse,
  resourceGraphRequest,
} from "../../domain/eventhub-discovery/eventhub-discovery";
import type {
  DiagnosticSettingSender,
  EventHubInfo,
  EventHubNamespaceInfo,
  HubActivity,
  HubEnumeration,
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

/**
 * Discover the CONFIGURED senders (EVH-04): one skipToken-paginated Resource
 * Graph query returning every diagnostic setting in the subscription that
 * targets an Event Hub. Throws on a query failure (callers soft-fail it into
 * a warning - senders are an enrichment, not the inventory).
 */
export async function discoverEventHubSenders(
  azure: AzureManagement,
  input: { subscriptionId: string },
  logger?: Logger,
): Promise<DiagnosticSettingSender[]> {
  const senders: DiagnosticSettingSender[] = [];
  let skipToken = "";
  for (let page = 0; page < EH_DISCOVERY_MAX_PAGES; page += 1) {
    const res = await azure.request(
      resourceGraphRequest(
        input.subscriptionId,
        EVENTHUB_DIAG_SETTINGS_KQL,
        skipToken === "" ? undefined : skipToken,
      ),
    );
    if (!is2xx(res.status)) {
      throw new Error(`diagnostic-settings query failed: HTTP ${res.status}`);
    }
    const parsed = parseDiagSettingsResponse(res.body);
    senders.push(...parsed.senders);
    skipToken = parsed.skipToken;
    if (skipToken === "") {
      break;
    }
  }
  logger?.info("eventhub-discovery: senders", { count: senders.length });
  return senders;
}

/**
 * Cap on hubs checked per activity run: one metrics GET per hub against the
 * 100 req/min proxy budget; hubs beyond the cap are reported in the warning.
 */
export const EH_ACTIVITY_MAX_HUBS = 80;

/** The activity-check result: per-hub activity keyed "{namespace}/{hub}". */
export interface EventHubActivityResult {
  activityByHub: Map<string, HubActivity>;
  warnings: string[];
}

/**
 * Check per-hub activity (EVH-07): one IncomingMessages metrics GET per hub
 * over the caller-minted `timespan` ("{startISO}/{endISO}" - core never reads
 * a clock), sequential to pace the proxy budget, capped at
 * {@link EH_ACTIVITY_MAX_HUBS}. A failing hub is counted inactive with the
 * error surfaced on its activity record (the legacy SilentlyContinue,
 * made visible).
 */
export async function checkEventHubActivity(
  azure: AzureManagement,
  hubs: readonly EventHubInfo[],
  timespan: string,
  logger?: Logger,
): Promise<EventHubActivityResult> {
  const warnings: string[] = [];
  const capped = hubs.slice(0, EH_ACTIVITY_MAX_HUBS);
  if (hubs.length > capped.length) {
    warnings.push(
      `Activity checked for the first ${capped.length} of ${hubs.length} hubs ` +
        "(one metrics call per hub; re-run on a narrower selection for the rest).",
    );
  }
  const activityByHub = new Map<string, HubActivity>();
  for (const hub of capped) {
    const key = `${hub.namespace}/${hub.name}`;
    try {
      const res = await azure.request(metricsRequest(hub.resourceId, timespan));
      if (!is2xx(res.status)) {
        activityByHub.set(key, {
          incomingMessages: 0,
          isActive: false,
          error: `HTTP ${res.status}`,
        });
        continue;
      }
      const total = parseIncomingMessagesTotal(res.body);
      activityByHub.set(key, { incomingMessages: total, isActive: total > 0 });
    } catch (err) {
      activityByHub.set(key, {
        incomingMessages: 0,
        isActive: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger?.info("eventhub-discovery: activity", {
    checked: capped.length,
    active: [...activityByHub.values()].filter((a) => a.isActive).length,
  });
  return { activityByHub, warnings };
}

/**
 * Cap on hubs enumerated per run: TWO ARM GETs per hub (consumer groups +
 * authorization rules) against the 100 req/min proxy budget.
 */
export const EH_ENUMERATION_MAX_HUBS = 40;

/** The enumeration result: per-hub details keyed "{namespace}/{hub}". */
export interface EventHubEnumerationResult {
  enumerationByHub: Map<string, HubEnumeration>;
  warnings: string[];
}

/**
 * Enumerate consumer groups + authorization rules per hub (EVH-06): two ARM
 * GETs per hub, sequential, capped at {@link EH_ENUMERATION_MAX_HUBS}. A hub
 * whose enumeration fails becomes a warning and is skipped - the rest
 * continue. Feeds the EVH-08 hint inference (inferSendersFromEnumeration) and
 * the consumer-group names that seed Cribl source configs.
 */
export async function enumerateEventHubDetails(
  azure: AzureManagement,
  hubs: readonly EventHubInfo[],
  logger?: Logger,
): Promise<EventHubEnumerationResult> {
  const warnings: string[] = [];
  const capped = hubs.slice(0, EH_ENUMERATION_MAX_HUBS);
  if (hubs.length > capped.length) {
    warnings.push(
      `Enumerated the first ${capped.length} of ${hubs.length} hubs ` +
        "(two ARM calls per hub; re-run on a narrower selection for the rest).",
    );
  }
  const enumerationByHub = new Map<string, HubEnumeration>();
  for (const hub of capped) {
    const key = `${hub.namespace}/${hub.name}`;
    try {
      const groupsRes = await azure.request(
        listConsumerGroupsRequest(hub.resourceId),
      );
      const rulesRes = await azure.request(listAuthRulesRequest(hub.resourceId));
      if (!is2xx(groupsRes.status) || !is2xx(rulesRes.status)) {
        warnings.push(
          `Could not enumerate ${key}: HTTP ` +
            `${!is2xx(groupsRes.status) ? groupsRes.status : rulesRes.status}`,
        );
        continue;
      }
      enumerationByHub.set(key, {
        consumerGroups: parseConsumerGroupsResponse(groupsRes.body),
        authRules: parseAuthRulesResponse(rulesRes.body),
      });
    } catch (err) {
      warnings.push(
        `Could not enumerate ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  logger?.info("eventhub-discovery: enumeration", {
    enumerated: enumerationByHub.size,
    warnings: warnings.length,
  });
  return { enumerationByHub, warnings };
}
