import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAB_CONTAINERS,
  DEFAULT_LAB_EVENT_GRID_SUBSCRIPTIONS,
  DEFAULT_LAB_STORAGE_SETTINGS,
  buildBlobContainerPutRequest,
  buildEventSubscriptionPutRequest,
  buildStorageAccountPutRequest,
  buildStorageQueuePutRequest,
  buildSystemTopicPutRequest,
  collisionStorageAccountName,
  containersToDeploy,
  eventGridSubscriptionName,
  eventGridSystemTopicName,
  parseProviderRegistrationState,
  parseStorageProvisioningState,
} from "./lab-storage";
import { labDeploymentConfig } from "./lab-profiles";

const SUB = "11111111-2222-3333-4444-555555555555";
const RG = "rg-lab-BlobQueueLab";

describe("buildStorageAccountPutRequest", () => {
  it("carries the legacy StorageV2/Standard_LRS/Hot settings", () => {
    const request = buildStorageAccountPutRequest(
      SUB,
      RG,
      "sacribllabcribl",
      "eastus",
      DEFAULT_LAB_STORAGE_SETTINGS,
    );
    expect(request.method).toBe("PUT");
    expect(request.path).toBe(
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/sacribllabcribl`,
    );
    const body = request.body as Record<string, any>;
    expect(body.sku).toEqual({ name: "Standard_LRS" });
    expect(body.kind).toBe("StorageV2");
    expect(body.properties.accessTier).toBe("Hot");
    expect(body.properties.allowBlobPublicAccess).toBe(false);
  });
});

describe("parseStorageProvisioningState", () => {
  it("reads properties.provisioningState tolerantly", () => {
    expect(
      parseStorageProvisioningState({ properties: { provisioningState: "Succeeded" } }),
    ).toBe("Succeeded");
    expect(parseStorageProvisioningState({})).toBe("");
    expect(parseStorageProvisioningState(null)).toBe("");
  });
});

describe("collisionStorageAccountName", () => {
  it("truncates the base to 20 and appends the shell-minted suffix (legacy)", () => {
    expect(collisionStorageAccountName("sacribllabcribl", "ab12")).toBe(
      "sacribllabcriblab12",
    );
    const long = collisionStorageAccountName("a".repeat(24), "zz99");
    expect(long).toBe("a".repeat(20) + "zz99");
    expect(long.length).toBe(24);
  });
});

describe("containersToDeploy (legacy skip rules, verbatim)", () => {
  it("BlobQueueLab (Event Grid on): criblqueuesource only", () => {
    const flags = labDeploymentConfig("BlobQueueLab", "public");
    const keys = containersToDeploy(DEFAULT_LAB_CONTAINERS, flags).map((c) => c.key);
    expect(keys).toEqual(["criblqueuesource"]);
  });

  it("BlobCollectorLab (Event Grid off): criblblobcollector only", () => {
    const flags = labDeploymentConfig("BlobCollectorLab", "public");
    const keys = containersToDeploy(DEFAULT_LAB_CONTAINERS, flags).map((c) => c.key);
    expect(keys).toEqual(["criblblobcollector"]);
  });

  it("CompleteLab deploys queue-source and flowlogs (flow logs on, Event Grid on)", () => {
    const flags = labDeploymentConfig("CompleteLab", "public");
    const keys = containersToDeploy(DEFAULT_LAB_CONTAINERS, flags).map((c) => c.key);
    expect(keys).toEqual(["criblqueuesource", "flowlogs"]);
  });

  it("passes unknown custom containers through", () => {
    const flags = labDeploymentConfig("BlobQueueLab", "public");
    const keys = containersToDeploy(
      [...DEFAULT_LAB_CONTAINERS, { key: "custom", name: "my-container" }],
      flags,
    ).map((c) => c.key);
    expect(keys).toContain("custom");
  });
});

describe("container and queue requests (management plane - no storage keys)", () => {
  it("PUTs a private container through blobServices/default", () => {
    const request = buildBlobContainerPutRequest(SUB, RG, "sax", "criblqueuesource");
    expect(request.path).toContain("/blobServices/default/containers/criblqueuesource");
    expect((request.body as any).properties.publicAccess).toBe("None");
  });

  it("PUTs a queue through queueServices/default", () => {
    const request = buildStorageQueuePutRequest(SUB, RG, "sax", "blob-notifications");
    expect(request.path).toContain("/queueServices/default/queues/blob-notifications");
  });
});

describe("Event Grid wiring (LAB-05)", () => {
  const accountId = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/sax`;

  it("names the system topic {account}-events (legacy, verbatim)", () => {
    expect(eventGridSystemTopicName("sax")).toBe("sax-events");
    expect(eventGridSubscriptionName("blobCreated")).toBe("eg-sub-blobCreated");
  });

  it("PUTs the system topic sourced from the storage account", () => {
    const request = buildSystemTopicPutRequest(SUB, RG, "sax-events", "eastus", accountId);
    const body = request.body as Record<string, any>;
    expect(body.properties.source).toBe(accountId);
    expect(body.properties.topicType).toBe("Microsoft.Storage.StorageAccounts");
  });

  it("PUTs the BlobCreated subscription with queue destination and filters", () => {
    const request = buildEventSubscriptionPutRequest(
      SUB,
      RG,
      "sax-events",
      accountId,
      DEFAULT_LAB_EVENT_GRID_SUBSCRIPTIONS[0],
    );
    expect(request.path).toContain("/eventSubscriptions/eg-sub-blobCreated");
    const properties = (request.body as any).properties;
    expect(properties.destination.endpointType).toBe("StorageQueue");
    expect(properties.destination.properties.queueName).toBe("blob-notifications");
    expect(properties.destination.properties.resourceId).toBe(accountId);
    expect(properties.filter.includedEventTypes).toEqual([
      "Microsoft.Storage.BlobCreated",
    ]);
    expect(properties.filter.subjectBeginsWith).toBe(
      "/blobServices/default/containers/criblqueuesource/",
    );
    // The legacy empty-string subjectEndsWith is dropped, not sent.
    expect("subjectEndsWith" in properties.filter).toBe(false);
  });

  it("parses the provider registration state tolerantly", () => {
    expect(parseProviderRegistrationState({ registrationState: "Registered" })).toBe(
      "Registered",
    );
    expect(parseProviderRegistrationState({})).toBe("");
  });
});
