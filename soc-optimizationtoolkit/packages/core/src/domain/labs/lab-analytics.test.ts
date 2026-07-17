import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAB_ADX_CLUSTER,
  DEFAULT_LAB_ADX_DATABASE,
  DEFAULT_LAB_EVENTHUB_NAMESPACE,
  LAB_ADX_COMMONSECURITYLOG_SCHEMA,
  adxCreateTableCommand,
  buildAdxClusterPutRequest,
  buildAdxDatabasePutRequest,
  buildAdxScriptPutRequest,
  buildConsumerGroupPutRequest,
  buildEventHubNamespacePutRequest,
  buildEventHubPutRequest,
  parseAdxClusterUri,
} from "./lab-analytics";

const SUB = "11111111-2222-3333-4444-555555555555";
const RG = "rg-lab-EventHubLab";

describe("Event Hub builders", () => {
  it("PUTs the namespace with the legacy Standard/1 settings", () => {
    const request = buildEventHubNamespacePutRequest(
      SUB,
      RG,
      "evhns-lab-eastus",
      "eastus",
      DEFAULT_LAB_EVENTHUB_NAMESPACE,
    );
    expect(request.path).toContain("/providers/Microsoft.EventHub/namespaces/evhns-lab-eastus");
    const body = request.body as Record<string, any>;
    expect(body.sku).toEqual({ name: "Standard", tier: "Standard", capacity: 1 });
  });

  it("PUTs hubs with partitionCount and messageRetentionInDays (legacy per-hub settings)", () => {
    const request = buildEventHubPutRequest(SUB, RG, "ns", "logs-hub", 4, 1);
    expect(request.path).toContain("/eventhubs/logs-hub");
    expect((request.body as any).properties).toEqual({
      partitionCount: 4,
      messageRetentionInDays: 1,
    });
  });

  it("PUTs consumer groups under the hub", () => {
    const request = buildConsumerGroupPutRequest(SUB, RG, "ns", "logs-hub", "cribl");
    expect(request.path).toContain("/eventhubs/logs-hub/consumergroups/cribl");
  });
});

describe("ADX builders", () => {
  it("PUTs the cluster with the legacy Dev SKU, streaming ingest, and auto-stop", () => {
    const request = buildAdxClusterPutRequest(
      SUB,
      RG,
      "adxlab1234eastus",
      "eastus",
      DEFAULT_LAB_ADX_CLUSTER,
    );
    const body = request.body as Record<string, any>;
    expect(body.sku).toEqual({
      name: "Dev(No SLA)_Standard_E2a_v4",
      tier: "Basic",
      capacity: 1,
    });
    expect(body.properties.enableStreamingIngest).toBe(true);
    expect(body.properties.enableAutoStop).toBe(true);
  });

  it("PUTs the CriblLogs database with ISO retention durations (legacy P7D/P30D)", () => {
    const request = buildAdxDatabasePutRequest(
      SUB,
      RG,
      "adx1",
      "eastus",
      DEFAULT_LAB_ADX_DATABASE,
    );
    expect(request.path).toContain("/databases/CriblLogs");
    const body = request.body as Record<string, any>;
    expect(body.kind).toBe("ReadWrite");
    expect(body.properties.softDeletePeriod).toBe("P30D");
    expect(body.properties.hotCachePeriod).toBe("P7D");
  });

  it("carries the 159-column CommonSecurityLog schema verbatim", () => {
    expect(LAB_ADX_COMMONSECURITYLOG_SCHEMA).toHaveLength(159);
    expect(LAB_ADX_COMMONSECURITYLOG_SCHEMA[0]).toBe("TimeGenerated:datetime");
    expect(LAB_ADX_COMMONSECURITYLOG_SCHEMA[158]).toBe("Type:string");
  });

  it("composes the .create-table script exactly like the legacy", () => {
    const command = adxCreateTableCommand("T", ["A:string", "B:int"]);
    expect(command).toBe(".create table T (A:string, B:int)");

    const request = buildAdxScriptPutRequest(SUB, RG, "adx1", "CriblLogs", "T", [
      "A:string",
    ]);
    expect(request.path).toContain("/databases/CriblLogs/scripts/create-table-T");
    const properties = (request.body as any).properties;
    expect(properties.scriptContent).toBe(".create table T (A:string)");
    expect(properties.continueOnError).toBe(false);
  });

  it("parses the cluster data URI tolerantly", () => {
    expect(parseAdxClusterUri({ properties: { uri: "https://adx1.eastus.kusto.windows.net" } })).toBe(
      "https://adx1.eastus.kusto.windows.net",
    );
    expect(parseAdxClusterUri({})).toBe("");
  });
});
