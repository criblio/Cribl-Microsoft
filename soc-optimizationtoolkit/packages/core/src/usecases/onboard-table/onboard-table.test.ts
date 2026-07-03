import { describe, expect, it } from "vitest";
import {
  onboardTable,
  ONBOARD_TABLE_JOB_KIND,
  ONBOARD_TABLE_STEPS,
} from "./onboard-table";
import type { OnboardTableInput, OnboardTableOutcome } from "./onboard-table";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { FakeJobStore } from "../../testing/fake-job-store";
import type { JobStep } from "../../ports/job-store";

const WORKSPACE_ID =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.OperationalInsights/workspaces/law-prod";

const WORKSPACE_PATH = WORKSPACE_ID; // GET path equals the resource id here

const DCR_PATH =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.Insights/dataCollectionRules/dcr-SecurityEvent-eastus";

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
          { name: "TenantId", type: "string" },
          { name: "TimeGenerated", type: "dateTime" },
          { name: "Account", type: "string" },
          { name: "EventID", type: "int" },
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
    azure: new FakeAzureManagement(),
    cribl: new FakeCriblClient(),
    jobs: new FakeJobStore(),
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

function stepByName(steps: JobStep[], name: string): JobStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`step '${name}' missing from job record`);
  }
  return step;
}

describe("onboardTable happy path", () => {
  it("runs every step, records the exact port call sequence, and succeeds", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      TABLE_SCHEMA_RESPONSE,
      // PUT returns Creating -> one poll GET reaches Succeeded
      { status: 201, body: { properties: { provisioningState: "Creating" } } },
      { status: 200, body: DCR_SUCCEEDED_BODY },
      // verify GET
      { status: 200, body: DCR_SUCCEEDED_BODY },
    );
    ports.cribl.respondWith(
      { status: 201, body: { items: [{ id: "MS-Sentinel-SecurityEvent-dest" }] } },
      { status: 200, body: { items: [{ commit: "abc123" }] } },
      { status: 200, body: { items: [{ id: "default" }] } },
      { status: 200, body: { items: [{ id: "MS-Sentinel-SecurityEvent-dest" }] } },
    );

    const progress: string[] = [];
    const job = await onboardTable(ports, {
      ...baseInput(),
      ingestionClientSecret: "live-secret",
      onProgress: (step) => progress.push(`${step.name}:${step.status}`),
    });

    expect(job.kind).toBe(ONBOARD_TABLE_JOB_KIND);
    expect(job.status).toBe("succeeded");
    expect(job.error).toBeUndefined();
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual(
      ONBOARD_TABLE_STEPS.map((name) => `${name}:succeeded`),
    );

    const outcome = job.result as OnboardTableOutcome;
    expect(outcome).toEqual({
      dcrName: "dcr-SecurityEvent-eastus",
      dcrImmutableId: IMMUTABLE_ID,
      logsIngestionEndpoint: INGESTION_ENDPOINT,
      streamName: "Custom-SecurityEvent",
      destinationId: "MS-Sentinel-SecurityEvent-dest",
      groupId: "default",
      commitVersion: "abc123",
    });

    // Exact Azure call sequence.
    expect(
      ports.azure.calls.map((call) => `${call.method} ${call.path}`),
    ).toEqual([
      `GET ${WORKSPACE_PATH}`,
      `GET ${WORKSPACE_PATH}/tables/SecurityEvent`,
      `PUT ${DCR_PATH}`,
      `GET ${DCR_PATH}`,
      `GET ${DCR_PATH}`,
    ]);
    expect(ports.azure.calls[0]!.apiVersion).toBe("2022-10-01");
    expect(ports.azure.calls[2]!.apiVersion).toBe("2023-03-11");
    const putBody = ports.azure.calls[2]!.body as {
      kind: string;
      properties: { streamDeclarations: Record<string, unknown> };
    };
    expect(putBody.kind).toBe("Direct");
    expect(Object.keys(putBody.properties.streamDeclarations)).toEqual([
      "Custom-SecurityEvent",
    ]);

    // Exact Cribl call sequence; the deploy PATCH targets the leader (no groupId).
    expect(
      ports.cribl.calls.map(
        (call) => `${call.method} ${call.path} [${call.groupId ?? "leader"}]`,
      ),
    ).toEqual([
      "POST /system/outputs [default]",
      "POST /version/commit [default]",
      "PATCH /master/groups/default/deploy [leader]",
      "GET /system/outputs/MS-Sentinel-SecurityEvent-dest [default]",
    ]);
    const destinationBody = ports.cribl.calls[0]!.body as {
      id: string;
      secret: string;
      client_id: string;
      dcrID: string;
      streamName: string;
    };
    expect(destinationBody.id).toBe("MS-Sentinel-SecurityEvent-dest");
    expect(destinationBody.secret).toBe("live-secret");
    expect(destinationBody.client_id).toBe(
      "'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'",
    );
    expect(destinationBody.dcrID).toBe(IMMUTABLE_ID);
    expect(destinationBody.streamName).toBe("Custom-SecurityEvent");
    expect(ports.cribl.calls[2]!.body).toEqual({ version: "abc123" });

    // The persisted job input never carries the secret value.
    expect(JSON.stringify(job.input)).not.toContain("live-secret");
    expect(job.input).toMatchObject({ ingestionClientSecretProvided: true });

    // onProgress saw running -> succeeded for every step, in order.
    expect(progress).toEqual(
      ONBOARD_TABLE_STEPS.flatMap((name) => [
        `${name}:running`,
        `${name}:succeeded`,
      ]),
    );
  });
});

describe("onboardTable failures", () => {
  it("fails the job at fetch-table-schema when the table does not exist", async () => {
    const ports = makePorts();
    ports.azure.respondWith(WORKSPACE_RESPONSE, {
      status: 404,
      body: { error: { code: "NotFound", message: "Table not found" } },
    });

    const job = await onboardTable(ports, baseInput());

    expect(job.status).toBe("failed");
    const failedStep = stepByName(job.steps, "fetch-table-schema");
    expect(failedStep.status).toBe("failed");
    expect(failedStep.detail).toContain("HTTP 404");
    expect(failedStep.detail).toContain("NotFound");
    expect(job.error).toContain("HTTP 404");
    // Nothing after the failure ran.
    expect(stepByName(job.steps, "generate-dcr-name").status).toBe("pending");
    expect(stepByName(job.steps, "deploy-dcr").status).toBe("pending");
    expect(ports.azure.calls).toHaveLength(2);
    expect(ports.cribl.calls).toHaveLength(0);
  });

  it("refuses _CL tables in native mode without calling the tables API", async () => {
    const ports = makePorts();
    ports.azure.respondWith(WORKSPACE_RESPONSE);

    const job = await onboardTable(ports, baseInput({ table: "CloudFlare_CL" }));

    expect(job.status).toBe("failed");
    expect(job.error).toContain("_CL");
    expect(stepByName(job.steps, "fetch-table-schema").status).toBe("failed");
    expect(ports.azure.calls).toHaveLength(1); // workspace GET only
    expect(ports.cribl.calls).toHaveLength(0);
  });

  it("fails the job when DCR provisioning ends in state Failed", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      TABLE_SCHEMA_RESPONSE,
      { status: 201, body: { properties: { provisioningState: "Creating" } } },
      { status: 200, body: { properties: { provisioningState: "Failed" } } },
    );

    const job = await onboardTable(ports, baseInput());

    expect(job.status).toBe("failed");
    const failedStep = stepByName(job.steps, "deploy-dcr");
    expect(failedStep.status).toBe("failed");
    expect(failedStep.detail).toContain("provisioning ended in state 'Failed'");
    expect(ports.cribl.calls).toHaveLength(0);
  });

  it("bounds provisioning polling by attempt count, never wall-clock", async () => {
    const ports = makePorts();
    const creating = {
      status: 200,
      body: { properties: { provisioningState: "Creating" } },
    };
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      TABLE_SCHEMA_RESPONSE,
      { status: 201, body: { properties: { provisioningState: "Creating" } } },
      creating,
      creating,
    );

    const job = await onboardTable(ports, baseInput({ maxDcrPollAttempts: 2 }));

    expect(job.status).toBe("failed");
    expect(job.error).toContain("within 2 poll attempts");
    // workspace + table + PUT + exactly 2 poll GETs
    expect(ports.azure.calls).toHaveLength(5);
  });

  it("ships the placeholder secret and treats a commit 4xx as reported-but-nonfatal", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      TABLE_SCHEMA_RESPONSE,
      // PUT reaches Succeeded immediately: no poll GETs
      { status: 200, body: DCR_SUCCEEDED_BODY },
      { status: 200, body: DCR_SUCCEEDED_BODY }, // verify
    );
    ports.cribl.respondWith(
      { status: 200, body: { items: [{ id: "MS-Sentinel-SecurityEvent-dest" }] } },
      { status: 403, body: { message: "git is not available on this instance" } },
      { status: 200, body: { items: [{ id: "MS-Sentinel-SecurityEvent-dest" }] } },
    );

    const job = await onboardTable(ports, baseInput()); // no secret provided

    expect(job.status).toBe("succeeded");
    const commitStep = stepByName(job.steps, "commit-and-deploy");
    expect(commitStep.status).toBe("failed"); // recorded honestly...
    expect(commitStep.detail).toContain("nonfatal");
    expect(commitStep.detail).toContain("HTTP 403");
    // ...but the job completed and verified.
    expect(stepByName(job.steps, "verify").status).toBe("succeeded");

    const outcome = job.result as OnboardTableOutcome;
    expect(outcome.commitVersion).toBeNull();

    const destinationBody = ports.cribl.calls[0]!.body as { secret: string };
    expect(destinationBody.secret).toBe("<replace me>");
    expect(job.input).toMatchObject({ ingestionClientSecretProvided: false });
    // The deploy PATCH was never attempted after the failed commit.
    expect(ports.cribl.calls.map((call) => call.path)).toEqual([
      "/system/outputs",
      "/version/commit",
      "/system/outputs/MS-Sentinel-SecurityEvent-dest",
    ]);
  });
});
