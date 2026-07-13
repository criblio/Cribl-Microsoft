import { describe, expect, it } from "vitest";

import { onboardTable } from "./onboard-table";
import type { OnboardTableInput } from "./onboard-table";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { FakeJobStore } from "../../testing/fake-job-store";
import { FakeLogger } from "../../testing/fake-logger";

const WORKSPACE_ID =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.OperationalInsights/workspaces/law-prod";

const IMMUTABLE_ID = "dcr-0123456789abcdef0123456789abcdef";
const INGESTION_ENDPOINT =
  "https://dcr-securityevent-eastus-a1b2.eastus-1.ingest.monitor.azure.com";

const WORKSPACE_RESPONSE = {
  status: 200,
  body: { id: WORKSPACE_ID, name: "law-prod", location: "eastus" },
};

const TABLE_SCHEMA_RESPONSE = {
  status: 200,
  body: {
    properties: {
      schema: {
        standardColumns: [
          { name: "TimeGenerated", type: "dateTime" },
          { name: "Account", type: "string" },
        ],
      },
    },
  },
};

const DCR_SUCCEEDED_BODY = {
  properties: {
    immutableId: IMMUTABLE_ID,
    provisioningState: "Succeeded",
    endpoints: { logsIngestion: INGESTION_ENDPOINT },
  },
};

function makePorts() {
  return {
    azure: new FakeAzureManagement({ dataCollectionRulesList: [] }),
    cribl: new FakeCriblClient({ outputsList: [] }),
    jobs: new FakeJobStore(),
    logger: new FakeLogger(() => "2026-07-03T10:00:00.000Z"),
  };
}

function baseInput(overrides: Partial<OnboardTableInput> = {}): OnboardTableInput {
  return {
    table: "SecurityEvent",
    subscriptionId: "sub-123",
    resourceGroup: "rg-sec",
    workspaceName: "law-prod",
    groupId: "default",
    tenantId: "11111111-2222-3333-4444-555555555555",
    ingestionClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    ...overrides,
  };
}

function scriptHappyPath(ports: {
  azure: FakeAzureManagement;
  cribl: FakeCriblClient;
}): void {
  ports.azure.respondWith(
    WORKSPACE_RESPONSE,
    TABLE_SCHEMA_RESPONSE,
    { status: 201, body: { properties: { provisioningState: "Creating" } } },
    { status: 200, body: DCR_SUCCEEDED_BODY },
    { status: 200, body: DCR_SUCCEEDED_BODY },
  );
  ports.cribl.respondWith(
    { status: 201, body: { items: [{ id: "MS-Sentinel-SecurityEvent-dest" }] } },
    { status: 200, body: { items: [{ commit: "abc123" }] } },
    { status: 200, body: { items: [{ id: "default" }] } },
    { status: 200, body: { items: [{ id: "MS-Sentinel-SecurityEvent-dest" }] } },
  );
}

describe("onboardTable logging", () => {
  it("logs the job start, every step transition, and the final success, tagged with the job id", async () => {
    const ports = makePorts();
    scriptHappyPath(ports);

    const job = await onboardTable(ports, {
      ...baseInput(),
      ingestionClientSecret: "live-secret",
    });
    expect(job.status).toBe("succeeded");

    const { entries } = ports.logger;
    expect(entries[0]).toMatchObject({
      level: "info",
      message: "onboard-table: job started",
      jobId: job.id,
    });
    // Every entry of the run is attributed to the job.
    expect(entries.every((entry) => entry.jobId === job.id)).toBe(true);

    // Step boundaries: a debug 'running' and an info 'succeeded' per step.
    expect(ports.logger.messagesAt("debug")).toEqual([
      "onboard-table: step fetch-workspace running",
      "onboard-table: step fetch-table-schema running",
      "onboard-table: step generate-dcr-name running",
      "onboard-table: step deploy-dcr running",
      "onboard-table: step create-cribl-destination running",
      "onboard-table: step commit-and-deploy running",
      "onboard-table: step verify running",
    ]);
    expect(ports.logger.messagesAt("info")).toContain(
      "onboard-table: step deploy-dcr succeeded",
    );
    expect(ports.logger.messagesAt("info").at(-1)).toBe(
      "onboard-table: job succeeded",
    );
    expect(ports.logger.messagesAt("error")).toEqual([]);
  });

  it("never logs the ingestion client secret value - only its redacted shape", async () => {
    const ports = makePorts();
    scriptHappyPath(ports);

    await onboardTable(ports, {
      ...baseInput(),
      ingestionClientSecret: "live-secret",
    });

    const startEntry = ports.logger.entries[0];
    expect(startEntry.context?.ingestionClientSecret).toBe("<redacted:11chars>");
    expect(JSON.stringify(ports.logger.entries)).not.toContain("live-secret");
  });

  it("records null for the secret reference when none was provided", async () => {
    const ports = makePorts();
    scriptHappyPath(ports);

    await onboardTable(ports, baseInput());

    expect(ports.logger.entries[0].context?.ingestionClientSecret).toBeNull();
  });

  it("logs the failing step and the job failure with the raw error text", async () => {
    const ports = makePorts();
    ports.azure.respondWith({
      status: 403,
      body: { error: { code: "AuthorizationFailed" } },
    });

    const job = await onboardTable(ports, baseInput());
    expect(job.status).toBe("failed");

    const errors = ports.logger.entries.filter((entry) => entry.level === "error");
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toBe("onboard-table: step fetch-workspace failed");
    expect(errors[0].context?.detail).toMatch(/HTTP 403 .*AuthorizationFailed/);
    expect(errors[1]).toMatchObject({
      message: "onboard-table: job failed",
      jobId: job.id,
    });
    expect(errors[1].context?.step).toBe("fetch-workspace");
    expect(errors[1].context?.error).toMatch(/HTTP 403 .*AuthorizationFailed/);
  });

  it("stays a no-op without a logger: the run behaves identically (zero behavior change)", async () => {
    const withLogger = makePorts();
    scriptHappyPath(withLogger);
    const without = {
      azure: new FakeAzureManagement({ dataCollectionRulesList: [] }),
      cribl: new FakeCriblClient({ outputsList: [] }),
      jobs: new FakeJobStore(),
    };
    scriptHappyPath(without);

    const loggedJob = await onboardTable(withLogger, baseInput());
    const silentJob = await onboardTable(without, baseInput());

    expect(silentJob.status).toBe(loggedJob.status);
    expect(silentJob.steps).toEqual(loggedJob.steps);
    expect(silentJob.result).toEqual(loggedJob.result);
  });
});
