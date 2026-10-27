/**
 * The blob steps (B1 to B5) for the two flow-log sources. Azure writes flow
 * logs to a storage account; Event Grid posts a message per new blob to a
 * storage queue; the Cribl azure_blob source reads the queue to find new
 * files and then reads the blob. The app never writes any of this - the blob
 * sources are How-to only on the Azure side (D18); the Cribl source is still
 * created by the app.
 *
 * Paths and names come from the lab builders the Labs screen deploys with
 * (lab-storage: account, queue, system topic and BlobCreated subscription;
 * lab-flowlogs: Network Watcher and flow log, JSON format version 2).
 *
 * Pure: data and string building only.
 */

import {
  AZURE_NETWORK_WATCHER_RG,
  azureDefaultNetworkWatcherName,
  buildFlowLogGetRequest,
} from "../labs/lab-flowlogs";
import {
  DEFAULT_LAB_EVENT_GRID_SUBSCRIPTIONS,
  buildBlobContainerGetRequest,
  buildEventSubscriptionGetRequest,
  buildStorageAccountGetRequest,
  buildStorageQueueGetRequest,
  buildSystemTopicGetRequest,
  eventGridSubscriptionName,
  eventGridSystemTopicName,
} from "../labs/lab-storage";
import type { PlanValues } from "../onboarding-howto/plan-values";
import { onboardingSource } from "../onboarding-howto/sources";
import type { HowToStep } from "./steps";

const BLOB_IDS = ["vnetFlowLogs", "nsgFlowLogs"] as const;

/** The lab's BlobCreated subscription: its key and event types. */
const BLOB_CREATED = DEFAULT_LAB_EVENT_GRID_SUBSCRIPTIONS[0];

/** The subject filter that limits Event Grid to new blobs in the plan's container. */
export function blobSubjectFilter(container: string): string {
  return `/blobServices/default/containers/${container}/`;
}

function accountId(v: PlanValues): string {
  return buildStorageAccountGetRequest(v.subscriptionId, v.resourceGroup, v.storageAccount).path;
}

const ACCOUNT_TEMPLATE = buildStorageAccountGetRequest(
  "{{subscriptionId}}",
  "{{resourceGroup}}",
  "{{storageAccount}}",
).path;

function flowLogStep(
  id: string,
  sourceId: (typeof BLOB_IDS)[number],
  target: { readonly flag: string; readonly noun: string },
  extra: Partial<HowToStep>,
): HowToStep {
  return {
    id,
    sourceIds: [sourceId],
    title: `Create the ${target.noun} flow log {{flowLogName}}`,
    why: `The flow log writes ${target.noun} traffic records as JSON blobs into {{storageAccount}}. A target resource can carry only one flow log.`,
    portal: [
      "Open Network Watcher and select Flow logs, then + Create.",
      `Flow log type: ${target.noun}. Select the ${target.noun} to log, in region {{region}}.`,
      "Storage account: {{storageAccount}}. Flow log name: {{flowLogName}}. Network Watcher: {{networkWatcher}}.",
      "Log format: JSON, version 2. Create.",
    ],
    cli: `az network watcher flow-log create --subscription {{subscriptionId}} --location {{region}} --name {{flowLogName}} ${target.flag} <the ${target.noun} name or ID> --storage-account ${ACCOUNT_TEMPLATE} --resource-group {{resourceGroup}} --format JSON --log-version 2`,
    values: (v) => [
      {
        label: "Flow log resource ID",
        value: buildFlowLogGetRequest(v.subscriptionId, AZURE_NETWORK_WATCHER_RG, v.networkWatcher, v.flowLogName).path,
      },
      { label: "Azure's default Network Watcher here", value: azureDefaultNetworkWatcherName(v.region) },
      { label: "Container Azure writes to", value: onboardingSource(sourceId)?.defaultContainer ?? "" },
      { label: "Format", value: "JSON, version 2" },
    ],
    rbac: [
      "Microsoft.Network/networkWatchers/flowLogs/write on the Network Watcher (Network Contributor includes it).",
      "Microsoft.Storage/storageAccounts/read on {{storageAccount}}.",
    ],
    confirmHow: "Network Watcher, Flow logs lists {{flowLogName}} as enabled; within minutes the container below appears in {{storageAccount}}.",
    dependsOnValues: [
      "subscriptionId",
      "resourceGroup",
      "region",
      "storageAccount",
      "networkWatcher",
      "flowLogName",
    ],
    checkKinds: ["network-watcher", "flow-log", "storage-container"],
    provenance: "repo",
    ...extra,
  };
}

export const BLOB_STEPS: readonly HowToStep[] = [
  {
    id: "blob-storage-account",
    sourceIds: BLOB_IDS,
    title: "Create or pick the storage account {{storageAccount}}",
    why: "Flow logs can only be written to a storage account, in the same region as what they log.",
    portal: [
      "Open Storage accounts and select Create.",
      "Subscription {{subscriptionId}}, resource group {{resourceGroup}}, name {{storageAccount}}, region {{region}}, performance Standard, kind StorageV2.",
      "Review and create, or open the existing account and confirm its region.",
    ],
    cli: "az storage account create --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --name {{storageAccount}} --location {{region}} --sku Standard_LRS --kind StorageV2",
    values: (v) => [{ label: "Storage account resource ID", value: accountId(v) }],
    rbac: ["Microsoft.Storage/storageAccounts/write on the resource group (Contributor includes it)."],
    confirmHow: "The account {{storageAccount}} shows Provisioning state Succeeded and location {{region}}.",
    dependsOnValues: ["subscriptionId", "resourceGroup", "storageAccount", "region"],
    checkKinds: ["storage-account"],
    provenance: "repo",
  },
  flowLogStep("blob-flow-log-vnet", "vnetFlowLogs", { flag: "--vnet", noun: "virtual network" }, {}),
  flowLogStep(
    "blob-flow-log-nsg",
    "nsgFlowLogs",
    { flag: "--nsg", noun: "network security group" },
    {
      provenance: "inferred",
      warning:
        "Microsoft is retiring network security group flow logs in favour of virtual network flow logs, and may refuse new ones. Prefer virtual network flow logs where you can.",
    },
  ),
  {
    id: "blob-queue",
    sourceIds: BLOB_IDS,
    title: "Create the storage queue {{queueName}}",
    why: "Event Grid posts one message to this queue for every new blob. Cribl reads the queue to learn which files to collect, instead of listing the container.",
    portal: [
      "Open the storage account {{storageAccount}} and select Queues, then + Queue.",
      "Name: {{queueName}}. Create.",
    ],
    cli: "az storage queue create --account-name {{storageAccount}} --name {{queueName}} --auth-mode login\n# The account is in {{resourceGroup}}, subscription {{subscriptionId}}.",
    values: (v) => [
      {
        label: "Queue resource ID",
        value: buildStorageQueueGetRequest(v.subscriptionId, v.resourceGroup, v.storageAccount, v.queueName).path,
      },
    ],
    rbac: ["Microsoft.Storage/storageAccounts/queueServices/queues/write on {{storageAccount}}."],
    confirmHow: "The queue {{queueName}} is listed under Queues in {{storageAccount}}.",
    dependsOnValues: ["subscriptionId", "resourceGroup", "storageAccount", "queueName"],
    checkKinds: ["storage-queue"],
    provenance: "repo",
  },
  {
    id: "blob-event-grid",
    sourceIds: BLOB_IDS,
    title: "Send a message to {{queueName}} for every new blob in {{container}}",
    why: "An Event Grid system topic on the storage account publishes BlobCreated events; a subscription filtered to the flow-log container delivers them to the queue.",
    portal: [
      "Make sure the Microsoft.EventGrid resource provider is registered in {{subscriptionId}}.",
      "Open the storage account {{storageAccount}} and select Events, then + Event Subscription.",
      `Name: ${eventGridSubscriptionName(BLOB_CREATED.key)}. System topic name: {{systemTopic}}. Event types: ${BLOB_CREATED.eventTypes.join(", ")} only.`,
      "Endpoint type: Storage Queues; choose {{storageAccount}} and the queue {{queueName}}.",
      "On Filters, enable subject filtering and set Subject begins with to the value below for the container {{container}}. Create.",
    ],
    cli: [
      "az provider register --subscription {{subscriptionId}} --namespace Microsoft.EventGrid",
      `az eventgrid system-topic create --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --name {{systemTopic}} --location {{region}} --topic-type Microsoft.Storage.StorageAccounts --source ${ACCOUNT_TEMPLATE}`,
      `az eventgrid system-topic event-subscription create --subscription {{subscriptionId}} --resource-group {{resourceGroup}} --system-topic-name {{systemTopic}} --name ${eventGridSubscriptionName(BLOB_CREATED.key)} --endpoint-type storagequeue --endpoint ${ACCOUNT_TEMPLATE}/queueServices/default/queues/{{queueName}} --included-event-types ${BLOB_CREATED.eventTypes.join(" ")} --subject-begins-with ${blobSubjectFilter("{{container}}")}`,
    ].join("\n"),
    values: (v) => [
      { label: "System topic resource ID", value: buildSystemTopicGetRequest(v.subscriptionId, v.resourceGroup, v.systemTopic).path },
      { label: "Usual system topic name", value: eventGridSystemTopicName(v.storageAccount) },
      {
        label: "Event subscription resource ID",
        value: buildEventSubscriptionGetRequest(v.subscriptionId, v.resourceGroup, v.systemTopic, BLOB_CREATED.key).path,
      },
      { label: "Subject begins with", value: blobSubjectFilter(v.container) },
      {
        label: "Container",
        value: buildBlobContainerGetRequest(v.subscriptionId, v.resourceGroup, v.storageAccount, v.container).path,
      },
    ],
    rbac: [
      "Microsoft.EventGrid/systemTopics/write and Microsoft.EventGrid/eventSubscriptions/write on the resource group (EventGrid Contributor includes them).",
      "Microsoft.EventGrid/register/action on the subscription, only if it must be registered.",
    ],
    confirmHow: "The storage account's Events page lists the subscription with endpoint {{queueName}}; after the next flow-log blob, the queue's message count rises.",
    dependsOnValues: [
      "subscriptionId",
      "resourceGroup",
      "region",
      "storageAccount",
      "queueName",
      "systemTopic",
      "container",
    ],
    checkKinds: ["eventgrid-topic", "eventgrid-subscription"],
    provenance: "repo",
  },
  {
    id: "blob-rbac",
    sourceIds: BLOB_IDS,
    title: "Let the Cribl service principal read {{storageAccount}} and its queue",
    why: "The Cribl Azure Blob source signs in as a service principal. It must read the blobs and receive and delete the queue messages.",
    portal: [
      "Open the storage account {{storageAccount}} and select Access control (IAM), then Add role assignment.",
      "Assign Storage Blob Data Reader to the service principal with object ID {{criblPrincipalObjectId}}.",
      "Repeat with Storage Queue Data Message Processor, on the account or on the queue {{queueName}}.",
    ],
    cli: [
      `az role assignment create --assignee-object-id {{criblPrincipalObjectId}} --assignee-principal-type ServicePrincipal --role "Storage Blob Data Reader" --scope ${ACCOUNT_TEMPLATE}`,
      `az role assignment create --assignee-object-id {{criblPrincipalObjectId}} --assignee-principal-type ServicePrincipal --role "Storage Queue Data Message Processor" --scope ${ACCOUNT_TEMPLATE}/queueServices/default/queues/{{queueName}}`,
    ].join("\n"),
    values: (v) => [
      { label: "Blob role scope", value: accountId(v) },
      {
        label: "Queue role scope",
        value: buildStorageQueueGetRequest(v.subscriptionId, v.resourceGroup, v.storageAccount, v.queueName).path,
      },
      { label: "Principal object ID", value: v.criblPrincipalObjectId },
    ],
    rbac: ["Microsoft.Authorization/roleAssignments/write on the storage account (User Access Administrator or Owner)."],
    confirmHow: "Access control (IAM), Role assignments on {{storageAccount}} lists both roles for {{criblPrincipalObjectId}}.",
    dependsOnValues: [
      "subscriptionId",
      "resourceGroup",
      "storageAccount",
      "queueName",
      "criblPrincipalObjectId",
    ],
    checkKinds: ["storage-rbac"],
    provenance: "inferred",
  },
];
