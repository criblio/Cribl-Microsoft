/**
 * Lab analytics request builders - roadmap Phase 5 (LAB-07: Event Hub
 * namespace/hubs/consumer groups + ADX cluster/database/table).
 *
 * Ported from the legacy UnifiedLab Phase5-Analytics scripts:
 * - Deploy-EventHub.ps1: Standard/1-capacity namespace, per-hub partition
 *   count and retention (legacy converted days to RetentionTimeInHour for the
 *   cmdlet; the ARM body takes messageRetentionInDays directly), and the
 *   per-hub consumer groups. The legacy shared-access-policy loop is carried
 *   as data-shape knowledge only - the shipped config defines NO policies, so
 *   nothing is built for it (verbatim no-op).
 * - Deploy-ADX.ps1: the cluster (Dev SKU default, streaming ingest +
 *   auto-stop from config), the CriblLogs ReadWrite database (soft-delete
 *   P30D, hot-cache P7D - ARM accepts the ISO durations directly, so the
 *   legacy TimeSpan conversion disappears), and the CommonSecurityLog table
 *   created through a Microsoft.Kusto database SCRIPT resource (the legacy
 *   New-AzKustoScript path - already ARM, no Kusto data-plane endpoint
 *   needed). The 160-column table schema is carried VERBATIM.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";

/** ARM api-version for Microsoft.EventHub (namespaces, hubs, consumer groups). */
export const LAB_EVENTHUB_ARM_API_VERSION = "2021-11-01";

/** ARM api-version for Microsoft.Kusto (clusters, databases, scripts). */
export const LAB_KUSTO_API_VERSION = "2023-08-15";

/** Event Hub namespace settings (legacy analytics.eventHub.namespace). */
export interface LabEventHubNamespaceSettings {
  sku: string;
  capacity: number;
}

/** The legacy namespace defaults, verbatim. */
export const DEFAULT_LAB_EVENTHUB_NAMESPACE: LabEventHubNamespaceSettings = {
  sku: "Standard",
  capacity: 1,
};

/** The legacy per-hub consumer group (every shipped hub declared ["cribl"]). */
export const DEFAULT_LAB_CONSUMER_GROUPS: readonly string[] = ["cribl"] as const;

function namespacePath(
  subscriptionId: string,
  resourceGroup: string,
  namespaceName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.EventHub/namespaces/${namespaceName}`
  );
}

/** GET the Event Hub namespace (existence + provisioningState). */
export function buildEventHubNamespaceGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  namespaceName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: namespacePath(subscriptionId, resourceGroup, namespaceName),
    apiVersion: LAB_EVENTHUB_ARM_API_VERSION,
  };
}

/** PUT the Event Hub namespace with the legacy Standard/1 settings. */
export function buildEventHubNamespacePutRequest(
  subscriptionId: string,
  resourceGroup: string,
  namespaceName: string,
  location: string,
  settings: LabEventHubNamespaceSettings,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: namespacePath(subscriptionId, resourceGroup, namespaceName),
    apiVersion: LAB_EVENTHUB_ARM_API_VERSION,
    body: {
      location,
      sku: { name: settings.sku, tier: settings.sku, capacity: settings.capacity },
      properties: {},
    },
  };
}

/** GET one Event Hub inside the namespace. */
export function buildEventHubGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  namespaceName: string,
  hubName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      namespacePath(subscriptionId, resourceGroup, namespaceName) +
      `/eventhubs/${hubName}`,
    apiVersion: LAB_EVENTHUB_ARM_API_VERSION,
  };
}

/** PUT one Event Hub with the legacy partition/retention settings. */
export function buildEventHubPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  namespaceName: string,
  hubName: string,
  partitionCount: number,
  messageRetentionInDays: number,
): AzureManagementRequest {
  return {
    method: "PUT",
    path:
      namespacePath(subscriptionId, resourceGroup, namespaceName) +
      `/eventhubs/${hubName}`,
    apiVersion: LAB_EVENTHUB_ARM_API_VERSION,
    body: {
      properties: { partitionCount, messageRetentionInDays },
    },
  };
}

/** GET one consumer group on a hub. */
export function buildConsumerGroupGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  namespaceName: string,
  hubName: string,
  groupName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      namespacePath(subscriptionId, resourceGroup, namespaceName) +
      `/eventhubs/${hubName}/consumergroups/${groupName}`,
    apiVersion: LAB_EVENTHUB_ARM_API_VERSION,
  };
}

/** PUT one consumer group on a hub. */
export function buildConsumerGroupPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  namespaceName: string,
  hubName: string,
  groupName: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path:
      namespacePath(subscriptionId, resourceGroup, namespaceName) +
      `/eventhubs/${hubName}/consumergroups/${groupName}`,
    apiVersion: LAB_EVENTHUB_ARM_API_VERSION,
    body: { properties: {} },
  };
}

// ---------------------------------------------------------------------------
// ADX (Kusto)
// ---------------------------------------------------------------------------

/** ADX cluster settings (legacy analytics.adx.cluster). */
export interface LabAdxClusterSettings {
  skuName: string;
  skuTier: string;
  skuCapacity: number;
  enableStreamingIngest: boolean;
  enableAutoStop: boolean;
}

/** The legacy cluster defaults, verbatim (Dev SKU, streaming + auto-stop on). */
export const DEFAULT_LAB_ADX_CLUSTER: LabAdxClusterSettings = {
  skuName: "Dev(No SLA)_Standard_E2a_v4",
  skuTier: "Basic",
  skuCapacity: 1,
  enableStreamingIngest: true,
  enableAutoStop: true,
};

/** ADX database settings (legacy analytics.adx.database). */
export interface LabAdxDatabaseSettings {
  name: string;
  /** ISO 8601 duration (ARM takes it directly; legacy converted to TimeSpan). */
  hotCachePeriod: string;
  softDeletePeriod: string;
}

/** The legacy database defaults, verbatim. */
export const DEFAULT_LAB_ADX_DATABASE: LabAdxDatabaseSettings = {
  name: "CriblLogs",
  hotCachePeriod: "P7D",
  softDeletePeriod: "P30D",
};

function clusterPath(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Kusto/clusters/${clusterName}`
  );
}

/** GET the ADX cluster (existence + provisioningState + uri). */
export function buildAdxClusterGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: clusterPath(subscriptionId, resourceGroup, clusterName),
    apiVersion: LAB_KUSTO_API_VERSION,
  };
}

/** PUT the ADX cluster (a 10-15 minute provisioning operation). */
export function buildAdxClusterPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  location: string,
  settings: LabAdxClusterSettings,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: clusterPath(subscriptionId, resourceGroup, clusterName),
    apiVersion: LAB_KUSTO_API_VERSION,
    body: {
      location,
      sku: {
        name: settings.skuName,
        tier: settings.skuTier,
        capacity: settings.skuCapacity,
      },
      properties: {
        enableStreamingIngest: settings.enableStreamingIngest,
        enableAutoStop: settings.enableAutoStop,
      },
    },
  };
}

/** The cluster's data-ingestion URI from a GET/PUT body ("" if absent). */
export function parseAdxClusterUri(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const properties = (body as Record<string, unknown>)["properties"];
  if (typeof properties !== "object" || properties === null) {
    return "";
  }
  const uri = (properties as Record<string, unknown>)["uri"];
  return typeof uri === "string" ? uri : "";
}

/** GET the ADX database. */
export function buildAdxDatabaseGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  databaseName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      clusterPath(subscriptionId, resourceGroup, clusterName) +
      `/databases/${databaseName}`,
    apiVersion: LAB_KUSTO_API_VERSION,
  };
}

/** PUT the ReadWrite ADX database with the legacy retention settings. */
export function buildAdxDatabasePutRequest(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  location: string,
  settings: LabAdxDatabaseSettings,
): AzureManagementRequest {
  return {
    method: "PUT",
    path:
      clusterPath(subscriptionId, resourceGroup, clusterName) +
      `/databases/${settings.name}`,
    apiVersion: LAB_KUSTO_API_VERSION,
    body: {
      location,
      kind: "ReadWrite",
      properties: {
        softDeletePeriod: settings.softDeletePeriod,
        hotCachePeriod: settings.hotCachePeriod,
      },
    },
  };
}

/**
 * The legacy CommonSecurityLog ADX table columns, VERBATIM (Deploy-ADX.ps1
 * lines 185-343, 159 columns): "name:type" pairs in the KQL .create-table
 * order.
 */
export const LAB_ADX_COMMONSECURITYLOG_SCHEMA: readonly string[] = [
  "TimeGenerated:datetime",
  "Activity:string",
  "AdditionalExtensions:string",
  "ApplicationProtocol:string",
  "CollectorHostName:string",
  "CommunicationDirection:string",
  "Computer:string",
  "DestinationDnsDomain:string",
  "DestinationHostName:string",
  "DestinationIP:string",
  "DestinationMACAddress:string",
  "DestinationNTDomain:string",
  "DestinationPort:int",
  "DestinationProcessId:int",
  "DestinationProcessName:string",
  "DestinationServiceName:string",
  "DestinationTranslatedAddress:string",
  "DestinationTranslatedPort:int",
  "DestinationUserID:string",
  "DestinationUserName:string",
  "DestinationUserPrivileges:string",
  "DeviceAction:string",
  "DeviceAddress:string",
  "DeviceCustomDate1:string",
  "DeviceCustomDate1Label:string",
  "DeviceCustomDate2:string",
  "DeviceCustomDate2Label:string",
  "DeviceCustomFloatingPoint1:real",
  "DeviceCustomFloatingPoint1Label:string",
  "DeviceCustomFloatingPoint2:real",
  "DeviceCustomFloatingPoint2Label:string",
  "DeviceCustomFloatingPoint3:real",
  "DeviceCustomFloatingPoint3Label:string",
  "DeviceCustomFloatingPoint4:real",
  "DeviceCustomFloatingPoint4Label:string",
  "DeviceCustomIPv6Address1:string",
  "DeviceCustomIPv6Address1Label:string",
  "DeviceCustomIPv6Address2:string",
  "DeviceCustomIPv6Address2Label:string",
  "DeviceCustomIPv6Address3:string",
  "DeviceCustomIPv6Address3Label:string",
  "DeviceCustomIPv6Address4:string",
  "DeviceCustomIPv6Address4Label:string",
  "DeviceCustomNumber1:int",
  "DeviceCustomNumber1Label:string",
  "DeviceCustomNumber2:int",
  "DeviceCustomNumber2Label:string",
  "DeviceCustomNumber3:int",
  "DeviceCustomNumber3Label:string",
  "DeviceCustomString1:string",
  "DeviceCustomString1Label:string",
  "DeviceCustomString2:string",
  "DeviceCustomString2Label:string",
  "DeviceCustomString3:string",
  "DeviceCustomString3Label:string",
  "DeviceCustomString4:string",
  "DeviceCustomString4Label:string",
  "DeviceCustomString5:string",
  "DeviceCustomString5Label:string",
  "DeviceCustomString6:string",
  "DeviceCustomString6Label:string",
  "DeviceDnsDomain:string",
  "DeviceEventCategory:string",
  "DeviceEventClassID:string",
  "DeviceExternalID:string",
  "DeviceFacility:string",
  "DeviceInboundInterface:string",
  "DeviceMacAddress:string",
  "DeviceName:string",
  "DeviceNtDomain:string",
  "DeviceOutboundInterface:string",
  "DevicePayloadId:string",
  "DeviceProduct:string",
  "DeviceTimeZone:string",
  "DeviceTranslatedAddress:string",
  "DeviceVendor:string",
  "DeviceVersion:string",
  "EndTime:datetime",
  "EventCount:int",
  "EventOutcome:string",
  "EventType:int",
  "ExternalID:int",
  "ExtID:string",
  "FieldDeviceCustomNumber1:long",
  "FieldDeviceCustomNumber2:long",
  "FieldDeviceCustomNumber3:long",
  "FileCreateTime:string",
  "FileHash:string",
  "FileID:string",
  "FileModificationTime:string",
  "FileName:string",
  "FilePath:string",
  "FilePermission:string",
  "FileSize:int",
  "FileType:string",
  "FlexDate1:string",
  "FlexDate1Label:string",
  "FlexNumber1:int",
  "FlexNumber1Label:string",
  "FlexNumber2:int",
  "FlexNumber2Label:string",
  "FlexString1:string",
  "FlexString1Label:string",
  "FlexString2:string",
  "FlexString2Label:string",
  "IndicatorThreatType:string",
  "LogSeverity:string",
  "MaliciousIP:string",
  "MaliciousIPCountry:string",
  "MaliciousIPLatitude:real",
  "MaliciousIPLongitude:real",
  "Message:string",
  "OldFileCreateTime:string",
  "OldFileHash:string",
  "OldFileID:string",
  "OldFileModificationTime:string",
  "OldFileName:string",
  "OldFilePath:string",
  "OldFilePermission:string",
  "OldFileSize:int",
  "OldFileType:string",
  "OriginalLogSeverity:string",
  "ProcessID:int",
  "ProcessName:string",
  "Protocol:string",
  "Reason:string",
  "ReceiptTime:string",
  "ReceivedBytes:long",
  "RemoteIP:string",
  "RemotePort:string",
  "ReportReferenceLink:string",
  "RequestClientApplication:string",
  "RequestContext:string",
  "RequestCookies:string",
  "RequestMethod:string",
  "RequestURL:string",
  "SentBytes:long",
  "SimplifiedDeviceAction:string",
  "SourceDnsDomain:string",
  "SourceHostName:string",
  "SourceIP:string",
  "SourceMACAddress:string",
  "SourceNTDomain:string",
  "SourcePort:int",
  "SourceProcessId:int",
  "SourceProcessName:string",
  "SourceServiceName:string",
  "SourceSystem:string",
  "SourceTranslatedAddress:string",
  "SourceTranslatedPort:int",
  "SourceUserID:string",
  "SourceUserName:string",
  "SourceUserPrivileges:string",
  "StartTime:datetime",
  "TenantId:string",
  "ThreatConfidence:string",
  "ThreatDescription:string",
  "ThreatSeverity:int",
  "Type:string",
] as const;

/** The KQL .create-table command (legacy composition, verbatim). */
export function adxCreateTableCommand(
  tableName: string,
  schema: readonly string[],
): string {
  return `.create table ${tableName} (${schema.join(", ")})`;
}

/** The database script resource name (legacy "create-table-{name}"). */
export function adxCreateTableScriptName(tableName: string): string {
  return `create-table-${tableName}`;
}

/** GET the table-creation script resource. */
export function buildAdxScriptGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  databaseName: string,
  tableName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      clusterPath(subscriptionId, resourceGroup, clusterName) +
      `/databases/${databaseName}/scripts/${adxCreateTableScriptName(tableName)}`,
    apiVersion: LAB_KUSTO_API_VERSION,
  };
}

/**
 * PUT the table-creation script (the legacy New-AzKustoScript path): the KQL
 * .create-table command runs inside the database via ARM - no Kusto
 * data-plane endpoint is ever contacted.
 */
export function buildAdxScriptPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  databaseName: string,
  tableName: string,
  schema: readonly string[],
): AzureManagementRequest {
  return {
    method: "PUT",
    path:
      clusterPath(subscriptionId, resourceGroup, clusterName) +
      `/databases/${databaseName}/scripts/${adxCreateTableScriptName(tableName)}`,
    apiVersion: LAB_KUSTO_API_VERSION,
    body: {
      properties: {
        scriptContent: adxCreateTableCommand(tableName, schema),
        continueOnError: false,
      },
    },
  };
}
