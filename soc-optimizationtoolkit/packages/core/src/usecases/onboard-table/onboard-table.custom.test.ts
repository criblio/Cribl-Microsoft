/**
 * onboardTable CUSTOM (_CL) path - porting-plan Unit 5 (ENG-34, custom path
 * of ENG-33). Custom table + DCR run as ONE pipelined job (the catalog
 * decision; the legacy PS engine needed a double run). The create-custom-table
 * step mirrors Process-CustomTable in Create-TableDCRs.ps1: GET first
 * (existing table wins - skip create), otherwise create from the supplied
 * schema and read the created table back, then everything downstream flows
 * through the SAME schema-mapping/dcr-request modules as native tables.
 */
import { describe, expect, it } from "vitest";
import {
  onboardTable,
  ONBOARD_TABLE_STEPS,
} from "./onboard-table";
import type { OnboardTableInput, OnboardTableOutcome } from "./onboard-table";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { FakeJobStore } from "../../testing/fake-job-store";
import type { JobStep } from "../../ports/job-store";
import type { CustomSchemaFileColumn } from "../../domain/schema-mapping";

const WORKSPACE_ID =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.OperationalInsights/workspaces/law-prod";

const TABLE_PATH = `${WORKSPACE_ID}/tables/CloudFlare_CL`;

const DCR_PATH =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.Insights/dataCollectionRules/dcr-CloudFlare-eastus";
const DCR_LIST_PATH = DCR_PATH.slice(0, DCR_PATH.lastIndexOf("/"));

const IMMUTABLE_ID = "dcr-fedcba9876543210fedcba9876543210";
const INGESTION_ENDPOINT =
  "https://dcr-cloudflare-eastus-a1b2.eastus-1.ingest.monitor.azure.com";

const WORKSPACE_RESPONSE = {
  status: 200,
  body: { id: WORKSPACE_ID, name: "law-prod", location: "eastus" },
};

const NOT_FOUND_RESPONSE = {
  status: 404,
  body: { error: { code: "NotFound", message: "Table not found" } },
};

/** What the created/existing custom table GETs back as (DCR-based table). */
const TABLE_SUCCEEDED_RESPONSE = {
  status: 200,
  body: {
    properties: {
      provisioningState: "Succeeded",
      schema: {
        columns: [
          { name: "TimeGenerated", type: "dateTime" },
          { name: "ClientIP", type: "string" },
          { name: "EdgeResponseStatus", type: "int" },
        ],
        standardColumns: [{ name: "TenantId", type: "string" }],
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

/** Schema WITHOUT TimeGenerated (pins injection) and WITH a reserved name. */
const CUSTOM_SCHEMA: CustomSchemaFileColumn[] = [
  { name: "ClientIP", type: "string", description: "Client IP address" },
  { name: "EdgeResponseStatus", type: "int" },
  { name: "Computer", type: "string", description: "Reserved - stripped" },
];

function makePorts() {
  return {
    azure: new FakeAzureManagement({ dataCollectionRulesList: [] }),
    cribl: new FakeCriblClient({ outputsList: [] }),
    jobs: new FakeJobStore(),
  };
}

function baseInput(overrides: Partial<OnboardTableInput> = {}): OnboardTableInput {
  return {
    table: "CloudFlare_CL",
    customSchema: CUSTOM_SCHEMA,
    subscriptionId: "sub-123",
    resourceGroup: "rg-sec",
    workspaceName: "law-prod",
    groupId: "default",
    tenantId: "11111111-2222-3333-4444-555555555555",
    ingestionClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    ...overrides,
  };
}

function scriptCriblHappyPath(cribl: FakeCriblClient): void {
  cribl.respondWith(
    { status: 201, body: { items: [{ id: "MS-Sentinel-CloudFlare-dest" }] } },
    { status: 200, body: { items: [{ commit: "abc123" }] } },
    { status: 200, body: { items: [{ id: "default" }] } },
    { status: 200, body: { items: [{ id: "MS-Sentinel-CloudFlare-dest" }] } },
  );
}

function stepByName(steps: JobStep[], name: string): JobStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`step '${name}' missing from job record`);
  }
  return step;
}

describe("onboardTable custom (_CL) happy path", () => {
  it("creates the table (PUT + bounded readback), deploys the DCR, and wires Cribl - one job", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      NOT_FOUND_RESPONSE, // existence GET: table missing
      { status: 200, body: {} }, // tables PUT
      {
        // first readback: still provisioning -> retry
        status: 200,
        body: { properties: { provisioningState: "Updating" } },
      },
      TABLE_SUCCEEDED_RESPONSE, // second readback: ready, schema used
      { status: 200, body: DCR_SUCCEEDED_BODY }, // DCR PUT (no poll needed)
      { status: 200, body: DCR_SUCCEEDED_BODY }, // verify GET
    );
    scriptCriblHappyPath(ports.cribl);

    const job = await onboardTable(ports, baseInput());

    expect(job.status).toBe("succeeded");
    // The custom job carries the FULL step list, every step succeeded.
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual(
      ONBOARD_TABLE_STEPS.map((name) => `${name}:succeeded`),
    );

    // Exact Azure call sequence: ONE pipelined job, never two runs.
    expect(
      ports.azure.calls.map((call) => `${call.method} ${call.path}`),
    ).toEqual([
      `GET ${WORKSPACE_ID}`,
      `GET ${TABLE_PATH}`, // existence check
      `PUT ${TABLE_PATH}`, // create
      `GET ${TABLE_PATH}`, // readback 1 (Updating)
      `GET ${TABLE_PATH}`, // readback 2 (Succeeded)
      // Collision/reuse scan (2026-07-12) lists the RG's DCRs first.
      `GET ${DCR_LIST_PATH}`,
      `PUT ${DCR_PATH}`,
      `GET ${DCR_PATH}`, // verify
    ]);

    // The tables PUT: New-LogAnalyticsCustomTable's body VERBATIM -
    // plan Analytics, 30/90 retention defaults, api-version 2022-10-01,
    // TimeGenerated injected at the end, reserved 'Computer' stripped.
    const tablePut = ports.azure.calls[2]!;
    expect(tablePut.apiVersion).toBe("2022-10-01");
    expect(tablePut.body).toEqual({
      properties: {
        plan: "Analytics",
        retentionInDays: 30,
        totalRetentionInDays: 90,
        schema: {
          name: "CloudFlare_CL",
          columns: [
            {
              name: "ClientIP",
              type: "string",
              description: "Client IP address",
            },
            { name: "EdgeResponseStatus", type: "int", description: "" },
            {
              name: "TimeGenerated",
              type: "datetime",
              description: "Timestamp when the record was generated",
            },
          ],
        },
      },
    });

    // The DCR PUT: custom mode - Custom-{table} for BOTH input and output
    // stream (native emits Microsoft-{table} output).
    const dcrPut = ports.azure.calls[6]!.body as {
      kind: string;
      properties: {
        streamDeclarations: Record<string, { columns: unknown[] }>;
        dataFlows: Array<{ streams: string[]; outputStream: string }>;
      };
    };
    expect(dcrPut.kind).toBe("Direct");
    expect(Object.keys(dcrPut.properties.streamDeclarations)).toEqual([
      "Custom-CloudFlare_CL",
    ]);
    expect(dcrPut.properties.streamDeclarations["Custom-CloudFlare_CL"]).toEqual(
      {
        columns: [
          { name: "TimeGenerated", type: "datetime" },
          { name: "ClientIP", type: "string" },
          { name: "EdgeResponseStatus", type: "int" },
        ],
      },
    );
    expect(dcrPut.properties.dataFlows).toEqual([
      {
        streams: ["Custom-CloudFlare_CL"],
        destinations: ["logAnalyticsWorkspace"],
        transformKql: "source",
        outputStream: "Custom-CloudFlare_CL",
      },
    ]);

    // dcr-naming stripped _CL (legacy contract); destination id likewise.
    const outcome = job.result as OnboardTableOutcome;
    expect(outcome.dcrName).toBe("dcr-CloudFlare-eastus");
    expect(outcome.streamName).toBe("Custom-CloudFlare_CL");
    expect(outcome.destinationId).toBe("MS-Sentinel-CloudFlare-dest");
    expect(outcome.commitVersion).toBe("abc123");

    // The Cribl destination points at the DCR's ACTUAL declared stream.
    const destinationBody = ports.cribl.calls[1]!.body as {
      id: string;
      streamName: string;
      dcrID: string;
    };
    expect(destinationBody.id).toBe("MS-Sentinel-CloudFlare-dest");
    expect(destinationBody.streamName).toBe("Custom-CloudFlare_CL");
    expect(destinationBody.dcrID).toBe(IMMUTABLE_ID);

    // Job input records the custom-path facts (never the schema itself).
    expect(job.input).toMatchObject({
      table: "CloudFlare_CL",
      customSchemaProvided: true,
      customTableRetentionDays: 30,
    });

    // Step detail pins the created/retention story for the UI step line.
    const createStep = stepByName(job.steps, "create-custom-table");
    expect(createStep.detail).toContain("created 'CloudFlare_CL'");
    expect(createStep.detail).toContain("retention 30/90 days");
  });

  it("pins retention 90: customTableRetentionDays flows into the PUT body (90/90)", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      NOT_FOUND_RESPONSE,
      { status: 200, body: {} },
      TABLE_SUCCEEDED_RESPONSE,
      { status: 200, body: DCR_SUCCEEDED_BODY },
      { status: 200, body: DCR_SUCCEEDED_BODY },
    );
    scriptCriblHappyPath(ports.cribl);

    const job = await onboardTable(
      ports,
      baseInput({ customTableRetentionDays: 90 }),
    );

    expect(job.status).toBe("succeeded");
    const tablePut = ports.azure.calls[2]!.body as {
      properties: { retentionInDays: number; totalRetentionInDays: number };
    };
    expect(tablePut.properties.retentionInDays).toBe(90);
    expect(tablePut.properties.totalRetentionInDays).toBe(90);
    expect(job.input).toMatchObject({ customTableRetentionDays: 90 });
  });
});

describe("onboardTable custom (_CL) idempotency", () => {
  it("skips creation when the table exists: no PUT, the EXISTING Azure schema wins", async () => {
    const ports = makePorts();
    const existingTable = {
      status: 200,
      body: {
        properties: {
          provisioningState: "Succeeded",
          schema: {
            columns: [
              { name: "TimeGenerated", type: "dateTime" },
              { name: "ClientIP", type: "string" },
              // NOT in the supplied customSchema: proves Azure schema won.
              { name: "CacheCacheStatus", type: "string" },
            ],
          },
        },
      },
    };
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      existingTable, // existence GET: hit
      { status: 200, body: DCR_SUCCEEDED_BODY }, // DCR PUT
      { status: 200, body: DCR_SUCCEEDED_BODY }, // verify GET
    );
    scriptCriblHappyPath(ports.cribl);

    const job = await onboardTable(ports, baseInput());

    expect(job.status).toBe("succeeded");
    const createStep = stepByName(job.steps, "create-custom-table");
    expect(createStep.status).toBe("succeeded");
    expect(createStep.detail).toContain("already exists - creation skipped");

    // CALL-COUNT PIN: exactly one tables GET, ZERO tables PUTs, and no
    // second schema GET (the existence lookup's body is reused).
    const tableCalls = ports.azure.calls.filter((call) =>
      call.path.includes("/tables/"),
    );
    expect(tableCalls).toHaveLength(1);
    expect(tableCalls[0]!.method).toBe("GET");
    expect(ports.azure.calls).toHaveLength(5);

    // The DCR declaration came from the EXISTING table's schema.
    const dcrPut = ports.azure.calls[3]!.body as {
      properties: {
        streamDeclarations: Record<string, { columns: Array<{ name: string }> }>;
      };
    };
    expect(
      dcrPut.properties.streamDeclarations["Custom-CloudFlare_CL"]!.columns.map(
        (column) => column.name,
      ),
    ).toEqual(["TimeGenerated", "ClientIP", "CacheCacheStatus"]);
  });
});

describe("onboardTable custom (_CL) failures", () => {
  it("rejects an invalid schema (TimeGenerated not datetime) before any PUT", async () => {
    const ports = makePorts();
    ports.azure.respondWith(WORKSPACE_RESPONSE, NOT_FOUND_RESPONSE);

    const job = await onboardTable(
      ports,
      baseInput({
        customSchema: [
          { name: "TimeGenerated", type: "string" },
          { name: "ClientIP", type: "string" },
        ],
      }),
    );

    expect(job.status).toBe("failed");
    expect(job.error).toContain("TimeGenerated must be a datetime column");
    expect(stepByName(job.steps, "create-custom-table").status).toBe("failed");
    expect(ports.azure.calls).toHaveLength(2); // workspace GET + table GET
    expect(ports.cribl.calls).toHaveLength(0);
  });

  it("bounds the created-table readback by attempt count, never wall-clock", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      NOT_FOUND_RESPONSE,
      { status: 200, body: {} }, // PUT accepted
      NOT_FOUND_RESPONSE, // readback 1: not replicated yet
      NOT_FOUND_RESPONSE, // readback 2: still nothing
    );

    const job = await onboardTable(
      ports,
      baseInput({ maxTablePollAttempts: 2 }),
    );

    expect(job.status).toBe("failed");
    expect(job.error).toContain("within 2 poll attempts");
    // workspace + existence GET + PUT + exactly 2 readback GETs.
    expect(ports.azure.calls).toHaveLength(5);
    expect(ports.cribl.calls).toHaveLength(0);
  });

  it("fails the job when table provisioning ends in state Failed", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      NOT_FOUND_RESPONSE,
      { status: 200, body: {} },
      { status: 200, body: { properties: { provisioningState: "Failed" } } },
    );

    const job = await onboardTable(ports, baseInput());

    expect(job.status).toBe("failed");
    expect(job.error).toContain("provisioning ended in state 'Failed'");
    expect(ports.cribl.calls).toHaveLength(0);
  });

  it("surfaces a non-404 existence-check error verbatim (raw, greppable)", async () => {
    const ports = makePorts();
    ports.azure.respondWith(WORKSPACE_RESPONSE, {
      status: 403,
      body: { error: { code: "AuthorizationFailed" } },
    });

    const job = await onboardTable(ports, baseInput());

    expect(job.status).toBe("failed");
    expect(job.error).toContain("HTTP 403");
    expect(job.error).toContain("AuthorizationFailed");
    expect(stepByName(job.steps, "create-custom-table").status).toBe("failed");
  });
});
