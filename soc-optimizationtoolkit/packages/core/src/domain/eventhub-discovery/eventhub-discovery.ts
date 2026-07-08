/**
 * Event Hub discovery domain - roadmap Phase 4 (EVH-03 inventory + LOG-16
 * Cribl source generation; EVH-04/07/08 analysis layers follow later).
 *
 * The PURE half of in-app Event Hub discovery: the Resource Graph request
 * shape (the catalog's single-query path - the legacy per-resource loop is
 * deliberately NOT ported), the response parsers, and the Cribl Event Hub
 * source-config generator ported VERBATIM from the legacy
 * Generate-CriblEventHubSources.ps1 template (native Kafka format, SASL PLAIN
 * with $ConnectionString + a text-secret reference, TLS on). All fetching
 * lives in usecases/discover-event-hubs over the AzureManagement port.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";

// ---------------------------------------------------------------------------
// Resource Graph inventory (EVH-03 step 1)
// ---------------------------------------------------------------------------

/** The Resource Graph API version the discovery POSTs against. */
export const RESOURCE_GRAPH_API_VERSION = "2022-10-01";

/** The Event Hub ARM data-plane management API version (hubs, consumer groups). */
export const EVENTHUB_API_VERSION = "2021-11-01";

/**
 * The single-query namespace inventory (EVH-03): every Event Hub namespace in
 * the subscription with its SKU and location. Hub child resources are NOT
 * indexed by Resource Graph (the catalog's dev-variant finding), so hubs are
 * listed per namespace with a plain ARM GET afterwards.
 */
export const EVENTHUB_NAMESPACES_KQL =
  "Resources" +
  " | where type =~ 'microsoft.eventhub/namespaces'" +
  " | project name, resourceGroup, location, subscriptionId," +
  " skuName = tostring(sku.name), id" +
  " | order by name asc";

/** One discovered Event Hub namespace. */
export interface EventHubNamespaceInfo {
  name: string;
  resourceGroup: string;
  location: string;
  subscriptionId: string;
  skuName: string;
  resourceId: string;
}

/** One discovered Event Hub inside a namespace. */
export interface EventHubInfo {
  name: string;
  namespace: string;
  partitionCount: number | null;
  messageRetentionInDays: number | null;
  status: string;
  resourceId: string;
}

/**
 * Build the Resource Graph POST for the namespace inventory. `skipToken`
 * continues a paginated result set (>1000 rows).
 */
export function resourceGraphRequest(
  subscriptionId: string,
  query: string,
  skipToken?: string,
): AzureManagementRequest {
  return {
    method: "POST",
    path: "/providers/Microsoft.ResourceGraph/resources",
    apiVersion: RESOURCE_GRAPH_API_VERSION,
    body: {
      subscriptions: [subscriptionId],
      query,
      ...(skipToken !== undefined && skipToken !== ""
        ? { options: { $skipToken: skipToken } }
        : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse a Resource Graph namespaces response: the row array plus the
 * `$skipToken` continuation (empty when the result set is complete). Rows
 * missing a name are dropped, never crashed on.
 */
export function parseNamespacesResponse(body: unknown): {
  namespaces: EventHubNamespaceInfo[];
  skipToken: string;
} {
  const data = isRecord(body) ? body["data"] : undefined;
  const rows = Array.isArray(data) ? data : [];
  const namespaces: EventHubNamespaceInfo[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const name = str(row["name"]);
    if (name === "") continue;
    namespaces.push({
      name,
      resourceGroup: str(row["resourceGroup"]),
      location: str(row["location"]),
      subscriptionId: str(row["subscriptionId"]),
      skuName: str(row["skuName"]),
      resourceId: str(row["id"]),
    });
  }
  const skipToken = isRecord(body) ? str(body["$skipToken"]) : "";
  return { namespaces, skipToken };
}

/** Build the ARM GET that lists the Event Hubs inside one namespace. */
export function listEventHubsRequest(
  ns: EventHubNamespaceInfo,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      `/subscriptions/${ns.subscriptionId}` +
      `/resourceGroups/${ns.resourceGroup}` +
      `/providers/Microsoft.EventHub/namespaces/${ns.name}/eventhubs`,
    apiVersion: EVENTHUB_API_VERSION,
  };
}

/** Project one ARM eventhubs list item into an {@link EventHubInfo}. */
export function parseEventHubItem(
  item: unknown,
  namespace: string,
): EventHubInfo | null {
  if (!isRecord(item)) return null;
  const name = str(item["name"]);
  if (name === "") return null;
  const props = isRecord(item["properties"]) ? item["properties"] : {};
  const partitions = props["partitionCount"];
  const retention = props["messageRetentionInDays"];
  return {
    name,
    namespace,
    partitionCount: typeof partitions === "number" ? partitions : null,
    messageRetentionInDays: typeof retention === "number" ? retention : null,
    status: str(props["status"]),
    resourceId: str(item["id"]),
  };
}

// ---------------------------------------------------------------------------
// Configured-sender discovery (EVH-04) - the single-query crown jewel
// ---------------------------------------------------------------------------

/**
 * The single-query diagnostic-settings discovery (EVH-04): every
 * microsoft.insights/diagnosticsettings resource in the subscription that
 * targets an Event Hub, with the hub name, the namespace extracted from the
 * authorization-rule id, and the SOURCE resource id. Ported from the legacy
 * Get-AllDiagnosticSettingsOptimized KQL; the logs/metrics category columns
 * are deliberately not projected (the correlation does not consume them and
 * they dominate the payload).
 */
export const EVENTHUB_DIAG_SETTINGS_KQL =
  "resources" +
  " | where type == 'microsoft.insights/diagnosticsettings'" +
  " | where properties.eventHubName != '' or properties.eventHubAuthorizationRuleId != ''" +
  " | extend eventHubName = tostring(properties.eventHubName)" +
  " | extend eventHubAuthRuleId = tostring(properties.eventHubAuthorizationRuleId)" +
  " | extend eventHubNamespace = tostring(split(eventHubAuthRuleId, '/')[8])" +
  " | extend sourceResourceId = tostring(properties.resourceId)" +
  " | project name, eventHubName, eventHubNamespace, sourceResourceId";

/** One diagnostic setting sending an Azure resource's logs to an Event Hub. */
export interface DiagnosticSettingSender {
  /** The diagnostic setting name. */
  settingName: string;
  /** The explicit target hub, or "" (Azure then auto-creates per-category hubs). */
  eventHubName: string;
  /** The namespace, extracted from the authorization-rule resource id. */
  eventHubNamespace: string;
  /** The SOURCE resource whose logs are exported. */
  sourceResourceId: string;
}

/**
 * Parse a Resource Graph diagnostic-settings response (rows + `$skipToken`).
 * Rows without a setting name are dropped, never crashed on.
 */
export function parseDiagSettingsResponse(body: unknown): {
  senders: DiagnosticSettingSender[];
  skipToken: string;
} {
  const data = isRecord(body) ? body["data"] : undefined;
  const rows = Array.isArray(data) ? data : [];
  const senders: DiagnosticSettingSender[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const settingName = str(row["name"]);
    if (settingName === "") continue;
    senders.push({
      settingName,
      eventHubName: str(row["eventHubName"]),
      eventHubNamespace: str(row["eventHubNamespace"]),
      sourceResourceId: str(row["sourceResourceId"]),
    });
  }
  const skipToken = isRecord(body) ? str(body["$skipToken"]) : "";
  return { senders, skipToken };
}

/**
 * The senders configured for ONE hub. Matching rule (a deliberate fix over
 * the legacy `-or`, which credited a setting naming hub X to EVERY hub in the
 * namespace): a setting matches when it names this hub explicitly, or when it
 * names NO hub but targets this namespace (Azure then routes to auto-created
 * per-category hubs, so every hub in the namespace is a plausible target).
 */
export function sendersForHub(
  senders: readonly DiagnosticSettingSender[],
  namespaceName: string,
  hubName: string,
): DiagnosticSettingSender[] {
  return senders.filter(
    (s) =>
      (s.eventHubName === hubName && s.eventHubNamespace === namespaceName) ||
      (s.eventHubName === "" && s.eventHubNamespace === namespaceName),
  );
}

// ---------------------------------------------------------------------------
// Activity detection (EVH-07) - IncomingMessages over a lookback window
// ---------------------------------------------------------------------------

/** The Azure Monitor metrics API version. */
export const METRICS_API_VERSION = "2018-01-01";

/** The activity lookback the UI mints the timespan from (legacy: 7 days). */
export const EH_ACTIVITY_LOOKBACK_DAYS = 7;

/**
 * Build the per-hub IncomingMessages metrics GET (1-hour grain, Total
 * aggregation - the legacy Get-AzMetric shape). `timespan` is
 * "{startISO}/{endISO}", minted by the CALLER - core never reads a clock.
 */
export function metricsRequest(
  hubResourceId: string,
  timespan: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: `${hubResourceId}/providers/microsoft.insights/metrics`,
    apiVersion: METRICS_API_VERSION,
    query: {
      metricnames: "IncomingMessages",
      timespan,
      interval: "PT1H",
      aggregation: "Total",
    },
  };
}

/**
 * Sum the IncomingMessages totals out of a metrics response (the legacy
 * Measure-Object -Sum over Data.Total). Defensive: a malformed response sums
 * to 0, never throws.
 */
export function parseIncomingMessagesTotal(body: unknown): number {
  if (!isRecord(body)) return 0;
  const value = body["value"];
  if (!Array.isArray(value) || !isRecord(value[0])) return 0;
  const timeseries = value[0]["timeseries"];
  if (!Array.isArray(timeseries)) return 0;
  let total = 0;
  for (const series of timeseries) {
    if (!isRecord(series)) continue;
    const points = series["data"];
    if (!Array.isArray(points)) continue;
    for (const point of points) {
      if (isRecord(point) && typeof point["total"] === "number") {
        total += point["total"];
      }
    }
  }
  return total;
}

/** One hub's measured activity. */
export interface HubActivity {
  incomingMessages: number;
  isActive: boolean;
  /** Present when the metrics call failed (hub counted inactive, surfaced). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Consumer-group + authorization-rule enumeration (EVH-06)
// ---------------------------------------------------------------------------

/** One Event Hub authorization rule (name + joined rights). */
export interface EventHubAuthRule {
  name: string;
  rights: string[];
}

/** One hub's enumerated consumer groups and authorization rules. */
export interface HubEnumeration {
  consumerGroups: string[];
  authRules: EventHubAuthRule[];
}

/** Build the ARM GET listing one hub's consumer groups. */
export function listConsumerGroupsRequest(
  hubResourceId: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: `${hubResourceId}/consumergroups`,
    apiVersion: EVENTHUB_API_VERSION,
  };
}

/** Build the ARM GET listing one hub's authorization rules. */
export function listAuthRulesRequest(
  hubResourceId: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: `${hubResourceId}/authorizationRules`,
    apiVersion: EVENTHUB_API_VERSION,
  };
}

/** Parse consumer-group names out of the ARM list response. Defensive. */
export function parseConsumerGroupsResponse(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body["value"])) return [];
  const names: string[] = [];
  for (const item of body["value"]) {
    if (isRecord(item) && typeof item["name"] === "string" && item["name"] !== "") {
      names.push(item["name"]);
    }
  }
  return names;
}

/** Parse authorization rules (name + rights) out of the ARM list response. */
export function parseAuthRulesResponse(body: unknown): EventHubAuthRule[] {
  if (!isRecord(body) || !Array.isArray(body["value"])) return [];
  const rules: EventHubAuthRule[] = [];
  for (const item of body["value"]) {
    if (!isRecord(item)) continue;
    const name = item["name"];
    if (typeof name !== "string" || name === "") continue;
    const props = isRecord(item["properties"]) ? item["properties"] : {};
    const rightsRaw = props["rights"];
    const rights = Array.isArray(rightsRaw)
      ? rightsRaw.filter((r): r is string => typeof r === "string")
      : [];
    rules.push({ name, rights });
  }
  return rules;
}

/** One inferred sender/consumer hint (legacy Confidence: Hint vocabulary). */
export interface InferredSender {
  inferredFrom: "ConsumerGroup" | "AuthorizationRule";
  name: string;
  rights?: string[];
  confidence: "Hint";
  note: string;
}

/**
 * The legacy hint-inference heuristics (EVH-08 second half) over one hub's
 * enumeration: every non-$Default consumer group suggests a CONSUMER; every
 * non-RootManageSharedAccessKey rule carrying Send rights suggests a SENDER.
 */
export function inferSendersFromEnumeration(
  enumeration: HubEnumeration,
): InferredSender[] {
  const inferred: InferredSender[] = [];
  for (const group of enumeration.consumerGroups) {
    if (group !== "$Default") {
      inferred.push({
        inferredFrom: "ConsumerGroup",
        name: group,
        confidence: "Hint",
        note: "Consumer group name suggests this application/service consumes data",
      });
    }
  }
  for (const rule of enumeration.authRules) {
    if (
      rule.name !== "RootManageSharedAccessKey" &&
      rule.rights.some((r) => r.toLowerCase().includes("send"))
    ) {
      inferred.push({
        inferredFrom: "AuthorizationRule",
        name: rule.name,
        rights: rule.rights,
        confidence: "Hint",
        note: "Auth rule with Send rights suggests this is used by a sender",
      });
    }
  }
  return inferred;
}

// ---------------------------------------------------------------------------
// Unknown-sender correlation (EVH-08) - pure inference, verbatim thresholds
// ---------------------------------------------------------------------------

/** The legacy high-volume heuristic: >100k messages per configured source. */
export const EH_HIGH_VOLUME_PER_SOURCE = 100000;

/** One hub's correlation findings. */
export interface HubFindings {
  /** Active with ZERO configured sources: likely SDK/connection-string senders. */
  hasUnknownSenders: boolean;
  /** Human-readable analysis notes (legacy vocabulary). */
  notes: string[];
}

/**
 * Correlate one hub's configured senders against its measured activity - the
 * legacy Step 6 heuristics verbatim (consumer-group / auth-rule hint
 * inference joins when EVH-06 enumeration lands):
 *   - ACTIVE + 0 sources  -> unknown senders (the onboarding-visibility flag);
 *   - INACTIVE + sources  -> sources may be disabled;
 *   - ACTIVE + sources + volume > sources x 100k -> possible extra senders.
 */
export function analyzeHubFindings(
  senderCount: number,
  activity: HubActivity | undefined,
): HubFindings {
  const notes: string[] = [];
  let hasUnknownSenders = false;
  if (activity === undefined) {
    return { hasUnknownSenders, notes };
  }
  if (activity.isActive && senderCount === 0) {
    hasUnknownSenders = true;
    notes.push(
      "Event Hub is ACTIVE but has NO configured sources - likely using SDK/connection strings",
    );
  } else if (!activity.isActive && senderCount > 0) {
    notes.push(
      `Event Hub is INACTIVE but has ${senderCount} configured source(s) - sources may be disabled`,
    );
  } else if (activity.isActive && senderCount > 0) {
    if (activity.incomingMessages > senderCount * EH_HIGH_VOLUME_PER_SOURCE) {
      notes.push(
        "High message volume relative to configured sources - may have additional SDK-based senders",
      );
    }
  }
  return { hasUnknownSenders, notes };
}

/** The subscription-level statistics rollup (legacy Statistics block). */
export interface EhActivityStatistics {
  activeEventHubs: number;
  inactiveEventHubs: number;
  eventHubsWithUnknownSenders: number;
}

/** Roll activity + findings up into the legacy statistics counts. */
export function deriveEhStatistics(
  activityByHub: ReadonlyMap<string, HubActivity>,
  findingsByHub: ReadonlyMap<string, HubFindings>,
): EhActivityStatistics {
  let active = 0;
  let inactive = 0;
  for (const activity of activityByHub.values()) {
    if (activity.isActive) {
      active += 1;
    } else {
      inactive += 1;
    }
  }
  let unknown = 0;
  for (const findings of findingsByHub.values()) {
    if (findings.hasUnknownSenders) {
      unknown += 1;
    }
  }
  return {
    activeEventHubs: active,
    inactiveEventHubs: inactive,
    eventHubsWithUnknownSenders: unknown,
  };
}

// ---------------------------------------------------------------------------
// Cribl Event Hub source generation (LOG-16) - VERBATIM legacy template
// ---------------------------------------------------------------------------

/** Replace every non-alphanumeric with underscore (legacy id sanitization). */
export function sanitizeEhId(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

/** The Cribl text-secret name convention for a namespace's connection string. */
export function ehSecretName(namespaceName: string): string {
  return `eh_${sanitizeEhId(namespaceName)}_connectionString`;
}

/** The default Kafka consumer group. */
export const EH_DEFAULT_CONSUMER_GROUP = "$Default";

/** The placeholder the generated config carries until the secret is created. */
export const EH_SECRET_PLACEHOLDER = "<PASTE_CONNECTION_STRING_HERE>";

/**
 * Build one Cribl Stream Event Hub source config - the VERBATIM legacy
 * Generate-CriblEventHubSources.ps1 template (field set, defaults, and
 * ordering): native Kafka format against {namespace}.servicebus.windows.net:
 * 9093, SASL PLAIN with username $ConnectionString and the connection string
 * referenced as the text secret eh_{ns}_connectionString, TLS on.
 */
export function buildEventHubSourceConfig(
  namespaceName: string,
  eventHubName: string,
  groupId: string = EH_DEFAULT_CONSUMER_GROUP,
): Record<string, unknown> {
  const sourceId = `eh_${sanitizeEhId(namespaceName)}_${sanitizeEhId(eventHubName)}`;
  return {
    disabled: false,
    sendToRoutes: true,
    pqEnabled: false,
    streamtags: [],
    brokers: [`${namespaceName}.servicebus.windows.net:9093`],
    topics: [eventHubName],
    groupId,
    fromBeginning: true,
    connectionTimeout: 10000,
    requestTimeout: 60000,
    maxRetries: 5,
    maxBackOff: 30000,
    initialBackoff: 300,
    backoffRate: 2,
    authenticationTimeout: 10000,
    reauthenticationThreshold: 10000,
    sasl: {
      disabled: false,
      mechanism: "plain",
      authType: "secret",
      username: "$ConnectionString",
      password: EH_SECRET_PLACEHOLDER,
      textSecret: ehSecretName(namespaceName),
    },
    tls: {
      disabled: false,
      rejectUnauthorized: true,
    },
    sessionTimeout: 30000,
    rebalanceTimeout: 60000,
    heartbeatInterval: 3000,
    maxBytesPerPartition: 1048576,
    maxBytes: 10485760,
    maxSocketErrors: 0,
    minimizeDuplicates: false,
    id: sourceId,
    type: "eventhub",
    _metadata: {
      namespace: namespaceName,
      eventHub: eventHubName,
      description: `Event Hub: ${eventHubName} from ${namespaceName}`,
    },
  };
}

/**
 * Build the connection-strings reference document (the legacy
 * connection-strings.json): per-namespace secret names, broker endpoints, the
 * connection-string format, and the manual creation steps.
 */
export function buildConnectionStringsReference(
  namespaceNames: readonly string[],
): Record<string, unknown> {
  const unique = [...new Set(namespaceNames)].sort();
  return {
    _comment: "Cribl Worker Group secrets needed for Event Hub sources",
    instructions: [
      "1. In Cribl Stream, open the worker group and go to Group Settings > Security > Secrets",
      "2. Create a secret for each namespace using the 'secretName' shown below",
      "3. In Azure, open the Event Hub namespace > Shared access policies > RootManageSharedAccessKey",
      "4. Copy 'Connection string-primary key' as the secret value",
    ],
    secrets: unique.map((ns) => ({
      namespace: ns,
      secretName: ehSecretName(ns),
      broker: `${ns}.servicebus.windows.net:9093`,
      connectionStringFormat: `Endpoint=sb://${ns}.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=<KEY>`,
    })),
  };
}
