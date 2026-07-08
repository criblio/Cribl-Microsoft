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
