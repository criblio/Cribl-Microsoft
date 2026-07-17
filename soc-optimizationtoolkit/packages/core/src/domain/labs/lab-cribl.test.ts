import { describe, expect, it } from "vitest";
import {
  buildLabAdxDestination,
  buildLabBlobCollectorSource,
  buildLabBlobQueueSource,
  buildLabCriblBundle,
  buildLabFlowLogCollector,
  type LabCriblBundleInput,
} from "./lab-cribl";
import { DEFAULT_LAB_EVENT_HUBS } from "./lab-naming";
import { labDeploymentConfig } from "./lab-profiles";

const TENANT = "tenant-1";
const CLIENT = "client-1";

function bundleInput(overrides?: Partial<LabCriblBundleInput>): LabCriblBundleInput {
  return {
    flags: labDeploymentConfig("BlobQueueLab", "public"),
    tenantId: TENANT,
    clientId: CLIENT,
    storageAccountName: "sacribllabcribl",
    eventHubNamespace: "evhns-cribllab-eastus",
    eventHubs: DEFAULT_LAB_EVENT_HUBS,
    adxClusterName: "adxcribllab1234eastus",
    adxClusterUri: "https://adx.eastus.kusto.windows.net",
    adxDatabase: "CriblLogs",
    ...overrides,
  };
}

describe("generator shapes (legacy Generate-CriblConfigs, verbatim)", () => {
  it("ADX destination: azure_data_explorer with clientCredentials + CriblMapping", () => {
    const dest = buildLabAdxDestination("adx1", "https://adx", "CriblLogs", TENANT, CLIENT);
    expect(dest["id"]).toBe("adx:adx1-CommonSecurityLog");
    expect(dest["type"]).toBe("azure_data_explorer");
    const conf = dest["conf"] as Record<string, unknown>;
    expect(conf["authType"]).toBe("clientCredentials");
    expect(conf["clientTextSecret"]).toBe("Azure_Client_Secret");
    expect(conf["ingestionMapping"]).toBe("CriblMapping");
    expect(conf["batchSize"]).toBe(1000);
    expect(conf["maxPayloadSizeKB"]).toBe(4096);
  });

  it("blob queue source: the Event Grid discovery pattern", () => {
    const source = buildLabBlobQueueSource(
      "criblqueuesource",
      "blob-notifications",
      "sax",
      TENANT,
      CLIENT,
    );
    expect(source["id"]).toBe("azure_blob_queue_criblqueuesource");
    expect(source["type"]).toBe("azure_blob");
    expect(source["queueName"]).toBe("blob-notifications");
    expect(source["visibilityTimeout"]).toBe(600);
    expect(source["clientTextSecret"]).toBe("Azure_Blob_Queue_Secret");
  });

  it("flow-log collector: hourly cron with the -75m..-15m window and breaker/pipeline", () => {
    const collector = buildLabFlowLogCollector("sax", TENANT, CLIENT);
    expect(collector["id"]).toBe("Azure_vNet_FlowLogs_sax");
    const schedule = collector["schedule"] as Record<string, any>;
    expect(schedule.cronSchedule).toBe("15 * * * *");
    expect(schedule.run.earliest).toBe("-75m");
    expect(schedule.run.latest).toBe("-15m");
    expect(schedule.enabled).toBe(true);
    const conf = (collector["collector"] as any).conf;
    expect(conf.containerName).toBe("insights-logs-flowlogflowevent");
    expect(conf.path).toBe(
      "flowLogResourceID=/${*}/${*}/${_time:y=%Y}/${_time:m=%m}/${_time:d=%d}/${_time:h=%H}",
    );
    expect(conf.clientTextSecret).toBe("Azure_vNet_Flowlogs_Secret");
    const input = collector["input"] as Record<string, any>;
    expect(input.breakerRulesets).toEqual(["Azure_vNet_FlowLogs"]);
    expect(input.pipeline).toBe("Azure_vNet_FlowLogs_PreProcessing");
  });

  it("polling blob collector: collectForever with 60s service period", () => {
    const source = buildLabBlobCollectorSource("criblblobcollector", "sax", TENANT, CLIENT);
    expect(source["id"]).toBe("azure_blob_collector_criblblobcollector");
    expect(source["collectForever"]).toBe(true);
    expect(source["servicePeriodSecs"]).toBe(60);
    expect(source["clientTextSecret"]).toBe("Azure_Blob_Collector_Secret");
  });
});

describe("buildLabCriblBundle gating (legacy, verbatim)", () => {
  it("BlobQueueLab: queue source only, with its secret", () => {
    const bundle = buildLabCriblBundle(bundleInput());
    expect(bundle.adxDestinations).toHaveLength(0);
    expect(bundle.eventHubSources).toHaveLength(0);
    expect(bundle.blobSources).toHaveLength(1);
    expect((bundle.blobSources[0] as any).id).toBe("azure_blob_queue_criblqueuesource");
    expect(bundle.requiredSecrets.map((s) => s.name)).toEqual(["Azure_Blob_Queue_Secret"]);
  });

  it("EventHubLab: one source per hub reusing the discovery template", () => {
    const bundle = buildLabCriblBundle(
      bundleInput({ flags: labDeploymentConfig("EventHubLab", "public") }),
    );
    expect(bundle.eventHubSources).toHaveLength(3);
    expect((bundle.eventHubSources[0] as any).topics).toEqual(["logs-hub"]);
    expect((bundle.eventHubSources[0] as any).groupId).toBe("cribl");
    expect(bundle.requiredSecrets.map((s) => s.name)).toEqual([
      "EventHub_evhns-cribllab-eastus_ConnectionString",
    ]);
  });

  it("ADXLab: the ADX destination with the cluster URI", () => {
    const bundle = buildLabCriblBundle(
      bundleInput({ flags: labDeploymentConfig("ADXLab", "public") }),
    );
    expect(bundle.adxDestinations).toHaveLength(1);
    expect((bundle.adxDestinations[0] as any).conf.cluster).toBe(
      "https://adx.eastus.kusto.windows.net",
    );
  });

  it("BlobCollectorLab: the polling collector (no Event Grid, no flow logs)", () => {
    const bundle = buildLabCriblBundle(
      bundleInput({ flags: labDeploymentConfig("BlobCollectorLab", "public") }),
    );
    expect(bundle.blobSources).toHaveLength(1);
    expect((bundle.blobSources[0] as any).id).toBe(
      "azure_blob_collector_criblblobcollector",
    );
  });

  it("FlowLogLab: the scheduled flow-log collector", () => {
    const bundle = buildLabCriblBundle(
      bundleInput({ flags: labDeploymentConfig("FlowLogLab", "public") }),
    );
    expect(bundle.blobSources).toHaveLength(1);
    expect((bundle.blobSources[0] as any).id).toBe("Azure_vNet_FlowLogs_sacribllabcribl");
  });

  it("CompleteLab: ADX + hubs + queue source + flow collector, secrets deduped", () => {
    const bundle = buildLabCriblBundle(
      bundleInput({ flags: labDeploymentConfig("CompleteLab", "public") }),
    );
    expect(bundle.adxDestinations).toHaveLength(1);
    expect(bundle.eventHubSources).toHaveLength(3);
    expect(bundle.blobSources).toHaveLength(2); // queue source + flow collector
    const names = bundle.requiredSecrets.map((s) => s.name);
    expect(names).toContain("Azure_Client_Secret");
    expect(names).toContain("Azure_Blob_Queue_Secret");
    expect(names).toContain("Azure_vNet_Flowlogs_Secret");
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries deployed DCR references through to the bundle", () => {
    const bundle = buildLabCriblBundle(
      bundleInput({
        dcrs: [
          {
            table: "SecurityEvent",
            dcrName: "dcr-SecurityEvent-eastus",
            immutableId: "dcr-imm-1",
            logsIngestionEndpoint: "https://x.ingest.monitor.azure.com",
            stream: "Microsoft-SecurityEvent",
          },
        ],
      }),
    );
    expect(bundle.sentinelDcrs).toHaveLength(1);
    expect(bundle.sentinelDcrs[0].immutableId).toBe("dcr-imm-1");
  });
});
