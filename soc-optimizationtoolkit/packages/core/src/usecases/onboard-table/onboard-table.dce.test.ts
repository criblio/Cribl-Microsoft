/**
 * onboardTable with a PRERESOLVED DCE (porting-plan Unit 6): the additive
 * input.dce switches the job to DCE-based deployment - dcr-naming mode "dce"
 * (64-char limit), buildDceDcrRequest body (dataCollectionEndpointId, NO
 * kind), and the Cribl destination pointed at the DCE's ingestion endpoint
 * (DCE-based DCRs expose no endpoints.logsIngestion of their own). Without
 * input.dce the Direct behavior stays byte-identical - pinned by the
 * untouched onboard-table.test.ts / onboard-table.custom.test.ts suites.
 */
import { describe, expect, it } from "vitest";
import { onboardTable } from "./onboard-table";
import type { OnboardTableInput, OnboardTableOutcome } from "./onboard-table";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { FakeJobStore } from "../../testing/fake-job-store";

const WORKSPACE_ID =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.OperationalInsights/workspaces/law-prod";

// 26-char table: "dcr-MicrosoftGraphActivityLogs-eastus" is 37 chars - OVER
// the 30-char Direct limit (Direct mode would abbreviate to
// "dcr-Micros-eastus") but WITHIN the 64-char DCE limit, so the full name
// surviving pins that input.dce selects dcr-naming mode "dce".
const TABLE = "MicrosoftGraphActivityLogs";
const DCR_NAME = "dcr-MicrosoftGraphActivityLogs-eastus";
const DCR_PATH =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  `Microsoft.Insights/dataCollectionRules/${DCR_NAME}`;

const DCE_RESOURCE_ID =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.Insights/dataCollectionEndpoints/dce-law-prod-eastus";
const DCE_ENDPOINT =
  "https://dce-law-prod-eastus-a1b2.eastus-1.ingest.monitor.azure.com";

const IMMUTABLE_ID = "dcr-00112233445566778899aabbccddeeff";

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
          { name: "UserId", type: "string" },
        ],
      },
    },
  },
};

// REALISTIC DCE-based DCR body: immutableId + provisioningState but NO
// endpoints.logsIngestion (only Kind:Direct DCRs expose one).
const DCE_DCR_SUCCEEDED_BODY = {
  properties: {
    immutableId: IMMUTABLE_ID,
    provisioningState: "Succeeded",
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
    table: TABLE,
    subscriptionId: "sub-123",
    resourceGroup: "rg-sec",
    workspaceName: "law-prod",
    groupId: "default",
    tenantId: "11111111-2222-3333-4444-555555555555",
    ingestionClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    dce: {
      resourceId: DCE_RESOURCE_ID,
      logsIngestionEndpoint: DCE_ENDPOINT,
    },
    ...overrides,
  };
}

describe("onboardTable with a preresolved DCE", () => {
  it("deploys a DCE-based DCR (64-char name, dataCollectionEndpointId, no kind) and wires the DCE endpoint into Cribl", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      TABLE_SCHEMA_RESPONSE,
      { status: 200, body: DCE_DCR_SUCCEEDED_BODY }, // DCR PUT
      { status: 200, body: DCE_DCR_SUCCEEDED_BODY }, // verify GET
    );
    ports.cribl.respondWith(
      { status: 201, body: { items: [{ id: "MS-Sentinel-dest" }] } },
      { status: 200, body: { items: [{ commit: "abc123" }] } },
      { status: 200, body: { items: [{ id: "default" }] } },
      { status: 200, body: { items: [{ id: "MS-Sentinel-dest" }] } },
    );

    const job = await onboardTable(ports, baseInput());

    expect(job.status).toBe("succeeded");

    // The DCR name kept its FULL 37 characters: mode "dce", not "direct".
    expect(
      ports.azure.calls.map((call) => `${call.method} ${call.path}`),
    ).toEqual([
      `GET ${WORKSPACE_ID}`,
      `GET ${WORKSPACE_ID}/tables/${TABLE}`,
      `PUT ${DCR_PATH}`,
      `GET ${DCR_PATH}`,
    ]);

    // The PUT body is the DCE-based shape: dataCollectionEndpointId wired,
    // NO kind property (DCE-based DCRs are NOT Kind:Direct).
    const putBody = ports.azure.calls[2]!.body as {
      kind?: string;
      properties: { dataCollectionEndpointId: string };
    };
    expect(putBody.properties.dataCollectionEndpointId).toBe(DCE_RESOURCE_ID);
    expect("kind" in putBody).toBe(false);

    // The Cribl destination ingests through the DCE's endpoint - the DCR
    // response carried none, and none was required.
    const destinationBody = ports.cribl.calls[0]!.body as {
      dceEndpoint: string;
      dcrID: string;
    };
    expect(destinationBody.dceEndpoint).toBe(DCE_ENDPOINT);
    expect(destinationBody.dcrID).toBe(IMMUTABLE_ID);

    const outcome = job.result as OnboardTableOutcome;
    expect(outcome.dcrName).toBe(DCR_NAME);
    expect(outcome.logsIngestionEndpoint).toBe(DCE_ENDPOINT);

    // The persisted job input records the DCE (id only) - Direct-mode job
    // records never carry this key.
    expect(job.input).toMatchObject({ dceResourceId: DCE_RESOURCE_ID });
  });

  it("without input.dce the persisted input carries no DCE key (Direct contract untouched)", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      { status: 500, body: { error: "boom" } }, // fail fast after input persisted
    );

    const job = await onboardTable(ports, {
      ...baseInput({ table: "SecurityEvent" }),
      dce: undefined,
    });

    expect(job.status).toBe("failed");
    expect(Object.keys(job.input as Record<string, unknown>)).not.toContain(
      "dceResourceId",
    );
  });
});
