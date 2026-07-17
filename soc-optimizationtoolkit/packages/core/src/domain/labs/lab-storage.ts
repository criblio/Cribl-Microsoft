/**
 * Lab storage request builders - roadmap Phase 5 (LAB-04 storage account /
 * containers / queues + LAB-05 Event Grid blob-notification wiring, the
 * catalog's FLAGGED PRODUCT-WORTHY piece).
 *
 * Ported from the legacy UnifiedLab Phase3-Storage scripts:
 * - Deploy-StorageAccount.ps1: StorageV2/Standard_LRS/Hot defaults, GET-first
 *   idempotency, and the global-name-collision retry (base truncated to 20 +
 *   a random 4-char suffix, capped at 24 - the suffix is SHELL-minted here,
 *   core never calls Math.random).
 * - Deploy-BlobContainers.ps1: the three containers keyed to the Cribl
 *   blob-ingestion patterns and the VERBATIM skip rules - flowlogs only when
 *   flow logs deploy (Azure auto-creates it otherwise), criblqueuesource only
 *   WITH Event Grid (BlobQueueLab), criblblobcollector only WITHOUT Event
 *   Grid (BlobCollectorLab).
 * - Deploy-StorageQueues.ps1: the blob-notifications queue.
 * - Deploy-EventGrid.ps1: Microsoft.EventGrid provider registration check,
 *   the {account}-events system topic on the storage account, and the
 *   storage-queue event subscriptions with includedEventTypes +
 *   subjectBeginsWith/EndsWith filters.
 *
 * Recorded deviations:
 * - Containers and queues are managed through the ARM MANAGEMENT plane
 *   (blobServices/default/containers, queueServices/default/queues) instead
 *   of the legacy data-plane cmdlets - no storage keys ever touch the app.
 * - The legacy queue config carried a messageTTL; neither the legacy
 *   New-AzStorageQueue call nor the management API applies it, so it is
 *   dropped rather than silently implied.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto (random suffixes are
 * injected by the shell).
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import type { LabComponentFlags } from "./lab-profiles";

/** ARM api-version for Microsoft.Storage (accounts, containers, queues). */
export const LAB_STORAGE_API_VERSION = "2023-01-01";

/** ARM api-version for Microsoft.EventGrid systemTopics + eventSubscriptions. */
export const LAB_EVENT_GRID_API_VERSION = "2022-06-15";

/** ARM api-version for resource-provider registration state/registration. */
export const LAB_PROVIDERS_API_VERSION = "2021-04-01";

/** Storage account settings (legacy storage.accounts.primary). */
export interface LabStorageAccountSettings {
  sku: string;
  kind: string;
  accessTier: string;
}

/** The legacy primary-account defaults, verbatim. */
export const DEFAULT_LAB_STORAGE_SETTINGS: LabStorageAccountSettings = {
  sku: "Standard_LRS",
  kind: "StorageV2",
  accessTier: "Hot",
};

/** One lab blob container definition (legacy storage.containers entries). */
export interface LabContainerDef {
  /** The config key the skip rules match on (legacy container keys). */
  key: string;
  name: string;
  description?: string;
}

/** The legacy default containers, verbatim (names and keys). */
export const DEFAULT_LAB_CONTAINERS: readonly LabContainerDef[] = [
  {
    key: "criblqueuesource",
    name: "criblqueuesource",
    description: "Cribl azure_blob source, queue-based discovery (BlobQueueLab)",
  },
  {
    key: "criblblobcollector",
    name: "criblblobcollector",
    description: "Cribl blob collector, scheduled polling (BlobCollectorLab)",
  },
  {
    key: "flowlogs",
    name: "insights-logs-flowlogflowevent",
    description: "vNet flow logs landing container (auto-created by Azure)",
  },
] as const;

/** One lab storage queue definition (legacy storage.queues.definitions). */
export interface LabQueueDef {
  key: string;
  name: string;
}

/** The legacy default queue, verbatim. */
export const DEFAULT_LAB_QUEUES: readonly LabQueueDef[] = [
  { key: "blobNotifications", name: "blob-notifications" },
] as const;

/** One Event Grid subscription definition (legacy storage.eventGrid.subscriptions). */
export interface LabEventGridSubscriptionDef {
  key: string;
  eventTypes: readonly string[];
  /** Destination storage queue name. */
  destinationQueue: string;
  subjectBeginsWith?: string;
  subjectEndsWith?: string;
}

/** The legacy blobCreated subscription, verbatim. */
export const DEFAULT_LAB_EVENT_GRID_SUBSCRIPTIONS: readonly LabEventGridSubscriptionDef[] =
  [
    {
      key: "blobCreated",
      eventTypes: ["Microsoft.Storage.BlobCreated"],
      destinationQueue: "blob-notifications",
      subjectBeginsWith: "/blobServices/default/containers/criblqueuesource/",
    },
  ] as const;

// ---------------------------------------------------------------------------
// Storage account
// ---------------------------------------------------------------------------

function storageAccountPath(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Storage/storageAccounts/${accountName}`
  );
}

/** GET one storage account (existence + provisioningState). */
export function buildStorageAccountGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: storageAccountPath(subscriptionId, resourceGroup, accountName),
    apiVersion: LAB_STORAGE_API_VERSION,
  };
}

/** PUT (create) one storage account with the legacy settings. */
export function buildStorageAccountPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  location: string,
  settings: LabStorageAccountSettings,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: storageAccountPath(subscriptionId, resourceGroup, accountName),
    apiVersion: LAB_STORAGE_API_VERSION,
    body: {
      location,
      sku: { name: settings.sku },
      kind: settings.kind,
      properties: {
        accessTier: settings.accessTier,
        allowBlobPublicAccess: false,
        minimumTlsVersion: "TLS1_2",
      },
    },
  };
}

/** The provisioningState of a storage account GET/PUT body ("" if absent). */
export function parseStorageProvisioningState(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const properties = (body as Record<string, unknown>)["properties"];
  if (typeof properties !== "object" || properties === null) {
    return "";
  }
  const state = (properties as Record<string, unknown>)["provisioningState"];
  return typeof state === "string" ? state : "";
}

/**
 * The collision-retry name (legacy Get-RandomSuffix path, verbatim shape):
 * base truncated to 20 chars + the SHELL-minted suffix, capped at 24.
 */
export function collisionStorageAccountName(
  baseName: string,
  suffix: string,
): string {
  let name = baseName.slice(0, Math.min(20, baseName.length)) + suffix;
  if (name.length > 24) {
    name = name.slice(0, 24);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Containers + queues (management plane)
// ---------------------------------------------------------------------------

/**
 * The containers a flag set actually deploys (legacy Deploy-BlobContainers
 * skip rules, verbatim):
 * - flowlogs only when flow logs deploy (Azure auto-creates it otherwise);
 * - criblqueuesource only WITH Event Grid (the BlobQueueLab pattern);
 * - criblblobcollector only WITHOUT Event Grid (the BlobCollectorLab pattern).
 * Unknown keys always deploy (custom containers pass through).
 */
export function containersToDeploy(
  containers: readonly LabContainerDef[],
  flags: LabComponentFlags,
): LabContainerDef[] {
  return containers.filter((container) => {
    if (container.key === "flowlogs" && !flags.monitoring.deployFlowLogs) {
      return false;
    }
    if (container.key === "criblqueuesource" && !flags.storage.deployEventGrid) {
      return false;
    }
    if (container.key === "criblblobcollector" && flags.storage.deployEventGrid) {
      return false;
    }
    return true;
  });
}

/** GET one blob container (management plane). */
export function buildBlobContainerGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      storageAccountPath(subscriptionId, resourceGroup, accountName) +
      `/blobServices/default/containers/${containerName}`,
    apiVersion: LAB_STORAGE_API_VERSION,
  };
}

/** PUT one PRIVATE blob container (legacy -Permission Off). */
export function buildBlobContainerPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path:
      storageAccountPath(subscriptionId, resourceGroup, accountName) +
      `/blobServices/default/containers/${containerName}`,
    apiVersion: LAB_STORAGE_API_VERSION,
    body: { properties: { publicAccess: "None" } },
  };
}

/** GET one storage queue (management plane). */
export function buildStorageQueueGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  queueName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      storageAccountPath(subscriptionId, resourceGroup, accountName) +
      `/queueServices/default/queues/${queueName}`,
    apiVersion: LAB_STORAGE_API_VERSION,
  };
}

/** PUT one storage queue (management plane). */
export function buildStorageQueuePutRequest(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  queueName: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path:
      storageAccountPath(subscriptionId, resourceGroup, accountName) +
      `/queueServices/default/queues/${queueName}`,
    apiVersion: LAB_STORAGE_API_VERSION,
    body: { properties: {} },
  };
}

// ---------------------------------------------------------------------------
// Event Grid (LAB-05 - the queue-based blob-discovery wiring)
// ---------------------------------------------------------------------------

/** The system topic's name on the storage account (legacy, verbatim). */
export function eventGridSystemTopicName(storageAccountName: string): string {
  return `${storageAccountName}-events`;
}

/** GET the Microsoft.EventGrid provider registration state. */
export function buildEventGridProviderGetRequest(
  subscriptionId: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: `/subscriptions/${subscriptionId}/providers/Microsoft.EventGrid`,
    apiVersion: LAB_PROVIDERS_API_VERSION,
  };
}

/** POST the Microsoft.EventGrid provider registration. */
export function buildEventGridProviderRegisterRequest(
  subscriptionId: string,
): AzureManagementRequest {
  return {
    method: "POST",
    path: `/subscriptions/${subscriptionId}/providers/Microsoft.EventGrid/register`,
    apiVersion: LAB_PROVIDERS_API_VERSION,
  };
}

/** The registrationState of a provider GET body ("" if absent). */
export function parseProviderRegistrationState(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const state = (body as Record<string, unknown>)["registrationState"];
  return typeof state === "string" ? state : "";
}

function systemTopicPath(
  subscriptionId: string,
  resourceGroup: string,
  topicName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.EventGrid/systemTopics/${topicName}`
  );
}

/** GET the storage account's Event Grid system topic. */
export function buildSystemTopicGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  topicName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: systemTopicPath(subscriptionId, resourceGroup, topicName),
    apiVersion: LAB_EVENT_GRID_API_VERSION,
  };
}

/** PUT the system topic sourced from the storage account (legacy, verbatim). */
export function buildSystemTopicPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  topicName: string,
  location: string,
  storageAccountResourceId: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: systemTopicPath(subscriptionId, resourceGroup, topicName),
    apiVersion: LAB_EVENT_GRID_API_VERSION,
    body: {
      location,
      properties: {
        source: storageAccountResourceId,
        topicType: "Microsoft.Storage.StorageAccounts",
      },
    },
  };
}

/** The subscription's deployed name (legacy "eg-sub-{key}", verbatim). */
export function eventGridSubscriptionName(key: string): string {
  return `eg-sub-${key}`;
}

/** GET one event subscription on the system topic. */
export function buildEventSubscriptionGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  topicName: string,
  subscriptionKey: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      systemTopicPath(subscriptionId, resourceGroup, topicName) +
      `/eventSubscriptions/${eventGridSubscriptionName(subscriptionKey)}`,
    apiVersion: LAB_EVENT_GRID_API_VERSION,
  };
}

/**
 * PUT one BlobCreated-to-storage-queue event subscription (legacy shape:
 * StorageQueue destination on the account, includedEventTypes plus optional
 * subjectBeginsWith/EndsWith filters).
 */
export function buildEventSubscriptionPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  topicName: string,
  storageAccountResourceId: string,
  subscription: LabEventGridSubscriptionDef,
): AzureManagementRequest {
  const filter: Record<string, unknown> = {
    includedEventTypes: [...subscription.eventTypes],
  };
  if (
    subscription.subjectBeginsWith !== undefined &&
    subscription.subjectBeginsWith !== ""
  ) {
    filter["subjectBeginsWith"] = subscription.subjectBeginsWith;
  }
  if (
    subscription.subjectEndsWith !== undefined &&
    subscription.subjectEndsWith !== ""
  ) {
    filter["subjectEndsWith"] = subscription.subjectEndsWith;
  }
  return {
    method: "PUT",
    path:
      systemTopicPath(subscriptionId, resourceGroup, topicName) +
      `/eventSubscriptions/${eventGridSubscriptionName(subscription.key)}`,
    apiVersion: LAB_EVENT_GRID_API_VERSION,
    body: {
      properties: {
        destination: {
          endpointType: "StorageQueue",
          properties: {
            resourceId: storageAccountResourceId,
            queueName: subscription.destinationQueue,
          },
        },
        filter,
      },
    },
  };
}
