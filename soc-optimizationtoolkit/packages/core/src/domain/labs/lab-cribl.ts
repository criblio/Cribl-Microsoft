/**
 * Lab Cribl configuration generators - roadmap Phase 5 (LAB-11, the
 * catalog's highest-value flagged asset: ready-to-import Cribl Stream
 * configs derived from the deployed lab resources).
 *
 * Ported VERBATIM from the legacy UnifiedLab
 * Phase9-Integration/Generate-CriblConfigs.ps1 emission shapes:
 * - ADX destination (azure_data_explorer, clientCredentials auth,
 *   CriblMapping ingestion mapping, json/gzip batching) - lines 111-130.
 * - Azure Blob source with QUEUE-based discovery (the Event Grid pattern) -
 *   lines 228-250.
 * - Flow-log scheduled blob collector (cron 15 * * * *, relative
 *   -75m..-15m window, the flowLogResourceID time-partitioned path, the
 *   Azure_vNet_FlowLogs breaker ruleset + preprocessing pipeline) - lines
 *   278-338.
 * - Plain polling blob collector (BlobCollectorLab) - lines 368-390.
 * - The per-pattern GATING, verbatim: ADX when deployADX; Event Hub sources
 *   when deployEventHub; queue source when deployQueues AND deployEventGrid;
 *   flow collector when deployFlowLogs; polling collector when
 *   deployContainers and NOT deployEventGrid and NOT deployFlowLogs.
 * - The required-secrets manifest the legacy README carried.
 *
 * Event Hub sources REUSE the discovery feature's buildEventHubSourceConfig
 * (the LAB-05/11/19 merge decision - one source template, not two).
 *
 * The bundle is DATA: the screen downloads it through the ArtifactSink (the
 * legacy wrote files); pushing configs to the Cribl API is a later slice.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import { buildEventHubSourceConfig } from "../eventhub-discovery";
import type { LabComponentFlags } from "./lab-profiles";
import type { LabEventHub } from "./lab-naming";

/** Inputs for {@link buildLabCriblBundle}. */
export interface LabCriblBundleInput {
  flags: LabComponentFlags;
  /** Entra tenant id embedded in clientCredentials configs. */
  tenantId: string;
  /** Entra application (client) id embedded in clientCredentials configs. */
  clientId: string;
  /** The DEPLOYED storage account name (post-collision-suffix). */
  storageAccountName: string;
  /** The Event Hub namespace name (sources are emitted per hub). */
  eventHubNamespace: string;
  /** The hubs, with their first consumer group used as the Kafka groupId. */
  eventHubs: readonly LabEventHub[];
  /** The ADX cluster name (id composition). */
  adxClusterName: string;
  /** The ADX cluster's data URI (from the deployed cluster; "" if unknown). */
  adxClusterUri: string;
  /** The ADX database (legacy CriblLogs). */
  adxDatabase: string;
  /** Deployed Sentinel DCRs (phase 8 outcome) for the reference section. */
  dcrs?: readonly LabDcrReference[];
}

/** One deployed DCR carried into the bundle's reference section. */
export interface LabDcrReference {
  table: string;
  dcrName: string;
  immutableId: string;
  logsIngestionEndpoint: string;
  stream: string;
}

/** One required Cribl text secret (the legacy README manifest rows). */
export interface LabCriblSecret {
  name: string;
  purpose: string;
}

/** The assembled, downloadable bundle. */
export interface LabCriblBundle {
  adxDestinations: Record<string, unknown>[];
  eventHubSources: Record<string, unknown>[];
  blobSources: Record<string, unknown>[];
  /** Sentinel DCR wiring (ids + ingestion endpoints) for destination setup. */
  sentinelDcrs: LabDcrReference[];
  requiredSecrets: LabCriblSecret[];
}

/** The legacy ADX destination shape (Generate-CriblConfigs 111-130, verbatim). */
export function buildLabAdxDestination(
  adxClusterName: string,
  clusterUri: string,
  database: string,
  tenantId: string,
  clientId: string,
  table = "CommonSecurityLog",
): Record<string, unknown> {
  return {
    id: `adx:${adxClusterName}-${table}`,
    type: "azure_data_explorer",
    systemFields: [],
    conf: {
      cluster: clusterUri,
      database,
      table,
      authType: "clientCredentials",
      tenantId,
      clientId,
      clientTextSecret: "Azure_Client_Secret",
      ingestionMapping: "CriblMapping",
      format: "json",
      compression: "gzip",
      batchSize: 1000,
      flushPeriodSec: 30,
      maxPayloadSizeKB: 4096,
    },
  };
}

/** The legacy queue-discovery blob source (Generate-CriblConfigs 228-250, verbatim). */
export function buildLabBlobQueueSource(
  containerName: string,
  queueName: string,
  storageAccountName: string,
  tenantId: string,
  clientId: string,
): Record<string, unknown> {
  return {
    id: `azure_blob_queue_${containerName}`,
    disabled: false,
    sendToRoutes: true,
    pqEnabled: false,
    streamtags: [],
    fileFilter: "/.*/gm",
    visibilityTimeout: 600,
    numReceivers: 1,
    maxMessages: 1,
    servicePeriodSecs: 5,
    skipOnError: false,
    staleChannelFlushMs: 10000,
    parquetChunkSizeMB: 5,
    parquetChunkDownloadTimeout: 600,
    authType: "clientSecret",
    type: "azure_blob",
    queueName,
    tenantId,
    clientId,
    clientTextSecret: "Azure_Blob_Queue_Secret",
    storageAccountName,
  };
}

/** The legacy flow-log scheduled collector (Generate-CriblConfigs 278-338, verbatim). */
export function buildLabFlowLogCollector(
  storageAccountName: string,
  tenantId: string,
  clientId: string,
  containerName = "insights-logs-flowlogflowevent",
): Record<string, unknown> {
  return {
    id: `Azure_vNet_FlowLogs_${storageAccountName}`,
    type: "collection",
    ttl: "4h",
    ignoreGroupJobsLimit: false,
    removeFields: [],
    resumeOnBoot: false,
    schedule: {
      cronSchedule: "15 * * * *",
      maxConcurrentRuns: 10,
      skippable: false,
      resumeMissed: true,
      run: {
        rescheduleDroppedTasks: true,
        maxTaskReschedule: 1,
        logLevel: "info",
        jobTimeout: "0",
        mode: "run",
        timeRangeType: "relative",
        earliest: "-75m",
        latest: "-15m",
      },
      enabled: true,
    },
    streamtags: [],
    workerAffinity: false,
    collector: {
      conf: {
        authType: "clientSecret",
        recurse: true,
        includeMetadata: true,
        includeTags: false,
        maxBatchSize: 10,
        parquetChunkSizeMB: 5,
        parquetChunkDownloadTimeout: 600,
        azureCloud: "azure",
        containerName,
        path: "flowLogResourceID=/${*}/${*}/${_time:y=%Y}/${_time:m=%m}/${_time:d=%d}/${_time:h=%H}",
        extractors: [],
        clientId,
        tenantId,
        storageAccountName,
        clientTextSecret: "Azure_vNet_Flowlogs_Secret",
      },
      destructive: false,
      type: "azure_blob",
      encoding: "utf8",
    },
    input: {
      type: "collection",
      staleChannelFlushMs: 10000,
      sendToRoutes: true,
      preprocess: { disabled: true },
      throttleRatePerSec: "0",
      breakerRulesets: ["Azure_vNet_FlowLogs"],
      pipeline: "Azure_vNet_FlowLogs_PreProcessing",
    },
    savedState: {},
  };
}

/** The legacy polling blob collector (Generate-CriblConfigs 368-390, verbatim). */
export function buildLabBlobCollectorSource(
  containerName: string,
  storageAccountName: string,
  tenantId: string,
  clientId: string,
): Record<string, unknown> {
  return {
    id: `azure_blob_collector_${containerName}`,
    disabled: false,
    sendToRoutes: true,
    pqEnabled: false,
    streamtags: [],
    fileFilter: "/.*/gm",
    recurse: true,
    maxBatchSize: 10,
    collectForever: true,
    servicePeriodSecs: 60,
    skipOnError: false,
    staleChannelFlushMs: 10000,
    parquetChunkSizeMB: 5,
    parquetChunkDownloadTimeout: 600,
    authType: "clientSecret",
    type: "azure_blob",
    containerName,
    tenantId,
    clientId,
    clientTextSecret: "Azure_Blob_Collector_Secret",
    storageAccountName,
  };
}

/**
 * Assemble the full bundle with the legacy per-pattern gating, verbatim.
 * Empty tenant/client ids are carried as-is - the configs remain valid
 * templates with blanks the operator fills in Cribl.
 */
export function buildLabCriblBundle(input: LabCriblBundleInput): LabCriblBundle {
  const { flags } = input;
  const bundle: LabCriblBundle = {
    adxDestinations: [],
    eventHubSources: [],
    blobSources: [],
    sentinelDcrs: [...(input.dcrs ?? [])],
    requiredSecrets: [],
  };
  const secrets = new Map<string, string>();

  if (flags.analytics.deployADX) {
    bundle.adxDestinations.push(
      buildLabAdxDestination(
        input.adxClusterName,
        input.adxClusterUri,
        input.adxDatabase,
        input.tenantId,
        input.clientId,
      ),
    );
    secrets.set("Azure_Client_Secret", "ADX clientCredentials application secret");
  }

  if (flags.analytics.deployEventHub) {
    for (const hub of input.eventHubs) {
      bundle.eventHubSources.push(
        buildEventHubSourceConfig(input.eventHubNamespace, hub.name, "cribl"),
      );
    }
    secrets.set(
      `EventHub_${input.eventHubNamespace}_ConnectionString`,
      "Event Hub namespace connection string (RootManageSharedAccessKey or a Listen policy)",
    );
  }

  if (flags.storage.deployQueues && flags.storage.deployEventGrid) {
    bundle.blobSources.push(
      buildLabBlobQueueSource(
        "criblqueuesource",
        "blob-notifications",
        input.storageAccountName,
        input.tenantId,
        input.clientId,
      ),
    );
    secrets.set("Azure_Blob_Queue_Secret", "Blob queue source application secret");
  }

  if (flags.monitoring.deployFlowLogs) {
    bundle.blobSources.push(
      buildLabFlowLogCollector(
        input.storageAccountName,
        input.tenantId,
        input.clientId,
      ),
    );
    secrets.set(
      "Azure_vNet_Flowlogs_Secret",
      "Flow-log blob collector application secret",
    );
  }

  if (
    flags.storage.deployContainers &&
    !flags.storage.deployEventGrid &&
    !flags.monitoring.deployFlowLogs
  ) {
    bundle.blobSources.push(
      buildLabBlobCollectorSource(
        "criblblobcollector",
        input.storageAccountName,
        input.tenantId,
        input.clientId,
      ),
    );
    secrets.set(
      "Azure_Blob_Collector_Secret",
      "Polling blob collector application secret",
    );
  }

  bundle.requiredSecrets = [...secrets.entries()].map(([name, purpose]) => ({
    name,
    purpose,
  }));
  return bundle;
}
