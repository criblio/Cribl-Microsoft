/**
 * onboardBatch (porting-plan Unit 6) - the batch deployment queue: one parent
 * job, a step per table, per-table child results embedded in the parent
 * result. Pins the DO-NOT-PORT defect fixes: templateOnly ACTUALLY works
 * (zero ARM writes, bodies collected), downstream steps of a failed
 * prerequisite SKIP (first-class 'skipped', never the legacy error cascade),
 * one table's failure never stops the others, and there is exactly ONE
 * deploy implementation (the onboardTable child).
 */
import { describe, expect, it } from "vitest";
import {
  onboardBatch,
  onboardBatchStepsFor,
  pollAttemptsForTimeout,
  safeAzureManagement,
  ONBOARD_BATCH_JOB_KIND,
} from "./onboard-batch";
import type {
  BatchPacing,
  OnboardBatchInput,
  OnboardBatchOutcome,
} from "./onboard-batch";
import { ONBOARD_TABLE_JOB_KIND } from "../onboard-table";
import { DEFAULT_OPERATION_OPTIONS } from "../../domain/option-forms";
import type { OperationOptions } from "../../domain/option-forms";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { FakeJobStore } from "../../testing/fake-job-store";
import type { CustomSchemaFileColumn } from "../../domain/schema-mapping";
import type { AzureManagement } from "../../ports/azure-management";
import type { JobStore } from "../../ports/job-store";

const WORKSPACE_ID =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.OperationalInsights/workspaces/law-prod";

const DCR_BASE =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.Insights/dataCollectionRules";

const DCE_PATH =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.Insights/dataCollectionEndpoints/dce-law-prod-eastus";

const DCE_ENDPOINT =
  "https://dce-law-prod-eastus-a1b2.eastus-1.ingest.monitor.azure.com";

const AMPLS_ID =
  "/subscriptions/sub-net/resourceGroups/rg-net/providers/" +
  "Microsoft.Insights/privateLinkScopes/ampls-prod";

const WORKSPACE_RESPONSE = {
  status: 200,
  body: { id: WORKSPACE_ID, name: "law-prod", location: "eastus" },
};

const NATIVE_SCHEMA_RESPONSE = {
  status: 200,
  body: {
    properties: {
      schema: {
        standardColumns: [
          { name: "TimeGenerated", type: "dateTime" },
          { name: "Computer", type: "string" },
          { name: "EventID", type: "int" },
        ],
      },
    },
  },
};

const NOT_FOUND_RESPONSE = {
  status: 404,
  body: { error: { code: "NotFound", message: "not found" } },
};

const CUSTOM_TABLE_SUCCEEDED_RESPONSE = {
  status: 200,
  body: {
    properties: {
      provisioningState: "Succeeded",
      schema: {
        columns: [
          { name: "TimeGenerated", type: "dateTime" },
          { name: "ClientIP", type: "string" },
        ],
      },
    },
  },
};

/** Direct-DCR succeeded body (endpoints.logsIngestion present). */
function directDcrBody(immutableId: string): unknown {
  return {
    properties: {
      immutableId,
      provisioningState: "Succeeded",
      endpoints: {
        logsIngestion: "https://direct.eastus-1.ingest.monitor.azure.com",
      },
    },
  };
}

/** DCE-based-DCR succeeded body (NO endpoints.logsIngestion - realistic). */
function dceDcrBody(immutableId: string): unknown {
  return { properties: { immutableId, provisioningState: "Succeeded" } };
}

const DCE_SUCCEEDED_RESPONSE = {
  status: 200,
  body: {
    id: DCE_PATH,
    properties: {
      provisioningState: "Succeeded",
      logsIngestion: { endpoint: DCE_ENDPOINT },
    },
  },
};

const CUSTOM_SCHEMA: CustomSchemaFileColumn[] = [
  { name: "ClientIP", type: "string", description: "Client IP address" },
  { name: "EdgeResponseStatus", type: "int" },
];

function makePorts() {
  return {
    azure: new FakeAzureManagement({ dataCollectionRulesList: [] }),
    cribl: new FakeCriblClient({ outputsList: [] }),
    jobs: new FakeJobStore(),
  };
}

/** Injected pacing with a huge budget: pacing is exercised in its own file. */
function immediatePacing(): BatchPacing {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function makeOptions(overrides: Partial<OperationOptions> = {}): OperationOptions {
  return { ...DEFAULT_OPERATION_OPTIONS, skipExistingDCRs: false, ...overrides };
}

function baseInput(overrides: Partial<OnboardBatchInput> = {}): OnboardBatchInput {
  return {
    tables: [{ table: "SecurityEvent" }],
    subscriptionId: "sub-123",
    resourceGroup: "rg-sec",
    workspaceName: "law-prod",
    groupId: "default",
    tenantId: "11111111-2222-3333-4444-555555555555",
    ingestionClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    options: makeOptions(),
    pacing: immediatePacing(),
    ...overrides,
  };
}

/** One child job's happy-path Cribl responses (create/commit/deploy/verify). */
function scriptCriblHappyPath(cribl: FakeCriblClient, times = 1): void {
  for (let i = 0; i < times; i++) {
    cribl.respondWith(
      { status: 201, body: { items: [{ id: "dest" }] } },
      { status: 200, body: { items: [{ commit: "abc123" }] } },
      { status: 200, body: { items: [{ id: "default" }] } },
      { status: 200, body: { items: [{ id: "dest" }] } },
    );
  }
}

function callSequence(azure: FakeAzureManagement): string[] {
  return azure.calls.map((call) => `${call.method} ${call.path}`);
}

/**
 * An AzureManagement whose transport REJECTS rather than answering: a dropped
 * socket, DNS failure or throwing proxy - what an unreachable ARM looks like
 * from inside the usecase (DBT-48).
 */
function rejectingAzure(message: string): AzureManagement {
  return {
    request: async () => {
      throw new Error(message);
    },
  };
}

/**
 * An AzureManagement that answers from `inner` until call `rejectOnCall`
 * (1-based), which REJECTS instead.
 *
 * {@link rejectingAzure} can only ever exercise the batch's FIRST ARM call:
 * a transport that rejects on everything fails fetch-workspace, and every
 * later call site is then skipped as a failed prerequisite. That is why the
 * DBT-48 pin above cannot say anything about the other six call sites, and
 * why the never-rejects contract there was carried by hand until DBT-56.
 */
function azureRejectingOnCall(
  inner: FakeAzureManagement,
  rejectOnCall: number,
  message: string,
): AzureManagement {
  let seen = 0;
  return {
    request: async (opts) => {
      seen += 1;
      if (seen === rejectOnCall) {
        throw new Error(message);
      }
      return inner.request(opts);
    },
  };
}

/**
 * A JobStore that fails exactly ONE parent-record write - the first carrying a
 * per-table result, i.e. the one right after a table finished deploying - and
 * works before and after it. A transient kvstore blip, NOT a total outage:
 * the case where blaming the table is provably a lie, because the deploy the
 * write was reporting had already succeeded (DBT-49).
 */
function storeThatBlipsOnTheFirstTableResult(inner: FakeJobStore): JobStore {
  let parentId: string | null = null;
  let fired = false;
  const store: JobStore = {
    create: async (kind, input) => {
      const record = await inner.create(kind, input);
      if (kind === ONBOARD_BATCH_JOB_KIND && parentId === null) {
        parentId = record.id;
      }
      return record;
    },
    update: async (id, patch) => {
      const result = patch.result as OnboardBatchOutcome | undefined;
      const carriesTableResult =
        id === parentId && result !== undefined && result.tables.length > 0;
      if (!fired && carriesTableResult) {
        fired = true;
        throw new Error("kvstore PATCH failed: 503 Service Unavailable");
      }
      await inner.update(id, patch);
    },
    get: (id) => inner.get(id),
    list: (kind) => inner.list(kind),
  };
  return store;
}

/**
 * A JobStore that fails exactly ONE write - the CHILD onboardTable job's final
 * `{status:"succeeded"}` - and works before and after it. That write runs after
 * the child's DCR deployed and its Cribl destination was created and verified,
 * so the table is provably not at fault; and it is raised inside the child, so
 * it reaches the batch's per-table catch wearing the CHILD module's
 * JobStoreFailure (DBT-60). Nothing here can raise the batch's OWN signal - the
 * blip never fires on a parent write - so the pin below cannot pass on the
 * strength of the DBT-49 wiring.
 */
function storeThatBlipsOnTheChildSuccessWrite(inner: FakeJobStore): JobStore {
  const childIds = new Set<string>();
  let fired = false;
  return {
    create: async (kind, input) => {
      const record = await inner.create(kind, input);
      if (kind === ONBOARD_TABLE_JOB_KIND) {
        childIds.add(record.id);
      }
      return record;
    },
    update: async (id, patch) => {
      if (!fired && childIds.has(id) && patch.status === "succeeded") {
        fired = true;
        throw new Error("kvstore PATCH failed: 503 Service Unavailable");
      }
      await inner.update(id, patch);
    },
    get: (id) => inner.get(id),
    list: (kind) => inner.list(kind),
  };
}

describe("onboardBatchStepsFor", () => {
  it("composes prologue steps from the options and one step per table", () => {
    const tables = [{ table: "A" }, { table: "B_CL" }];
    expect(
      onboardBatchStepsFor(tables, { createDCE: false, dcePublicNetworkAccess: true }),
    ).toEqual(["fetch-workspace", "table:A", "table:B_CL"]);
    expect(
      onboardBatchStepsFor(tables, { createDCE: true, dcePublicNetworkAccess: true }),
    ).toEqual(["fetch-workspace", "ensure-dce", "table:A", "table:B_CL"]);
    expect(
      onboardBatchStepsFor(tables, { createDCE: true, dcePublicNetworkAccess: false }),
    ).toEqual([
      "fetch-workspace",
      "ensure-dce",
      "associate-ampls",
      "table:A",
      "table:B_CL",
    ]);
  });
});

describe("pollAttemptsForTimeout", () => {
  it("maps the legacy deploymentTimeoutSeconds onto attempt bounds (10s per attempt, min 1)", () => {
    expect(pollAttemptsForTimeout(600)).toBe(60); // legacy default
    expect(pollAttemptsForTimeout(45)).toBe(4);
    expect(pollAttemptsForTimeout(10)).toBe(1);
    expect(pollAttemptsForTimeout(5)).toBe(1);
    expect(pollAttemptsForTimeout(0)).toBe(1);
  });
});

describe("onboardBatch mixed native+custom happy path (Direct mode)", () => {
  it("runs one parent job with a step per table and the exact ARM call sequence", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE, // prologue fetch-workspace
      // child 1: SecurityEvent (native)
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: directDcrBody("dcr-native-immutable") },
      { status: 200, body: directDcrBody("dcr-native-immutable") },
      // child 2: CloudFlare_CL (custom, created)
      WORKSPACE_RESPONSE,
      NOT_FOUND_RESPONSE,
      { status: 200, body: {} },
      CUSTOM_TABLE_SUCCEEDED_RESPONSE,
      { status: 200, body: directDcrBody("dcr-custom-immutable") },
      { status: 200, body: directDcrBody("dcr-custom-immutable") },
    );
    scriptCriblHappyPath(ports.cribl, 2);

    const progress: string[] = [];
    const job = await onboardBatch(ports, {
      ...baseInput({
        tables: [
          { table: "SecurityEvent" },
          { table: "CloudFlare_CL", customSchema: CUSTOM_SCHEMA },
        ],
      }),
      onProgress: (step) => progress.push(`${step.name}:${step.status}`),
    });

    expect(job.kind).toBe(ONBOARD_BATCH_JOB_KIND);
    expect(job.status).toBe("succeeded");
    expect(job.error).toBeUndefined();
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:succeeded",
      "table:SecurityEvent:succeeded",
      "table:CloudFlare_CL:succeeded",
    ]);

    // Exact ARM sequence: ONE prologue GET, then the two children in input
    // order - the single onboardTable deploy path both times.
    expect(callSequence(ports.azure)).toEqual([
      `GET ${WORKSPACE_ID}`,
      `GET ${WORKSPACE_ID}`,
      `GET ${WORKSPACE_ID}/tables/SecurityEvent`,
      `PUT ${DCR_BASE}/dcr-SecurityEvent-eastus`,
      `GET ${DCR_BASE}/dcr-SecurityEvent-eastus`,
      `GET ${WORKSPACE_ID}`,
      `GET ${WORKSPACE_ID}/tables/CloudFlare_CL`,
      `PUT ${WORKSPACE_ID}/tables/CloudFlare_CL`,
      `GET ${WORKSPACE_ID}/tables/CloudFlare_CL`,
      `PUT ${DCR_BASE}/dcr-CloudFlare-eastus`,
      `GET ${DCR_BASE}/dcr-CloudFlare-eastus`,
    ]);
    expect(ports.cribl.calls.length).toBe(8);

    // Per-table child results embedded in the parent result.
    const outcome = job.result as OnboardBatchOutcome;
    expect(outcome.succeeded).toBe(2);
    expect(outcome.failed).toBe(0);
    expect(outcome.skipped).toBe(0);
    expect(outcome.dce).toBeNull();
    expect(outcome.templates).toEqual([]);
    expect(outcome.tables.map((t) => `${t.table}:${t.status}`)).toEqual([
      "SecurityEvent:succeeded",
      "CloudFlare_CL:succeeded",
    ]);
    expect(outcome.tables[0]!.outcome!.dcrName).toBe("dcr-SecurityEvent-eastus");
    expect(outcome.tables[1]!.outcome!.dcrName).toBe("dcr-CloudFlare-eastus");
    expect(outcome.tables[0]!.jobId).toBeDefined();

    // One CHILD job per table exists alongside the parent.
    const children = await ports.jobs.list(ONBOARD_TABLE_JOB_KIND);
    expect(children.length).toBe(2);
    expect(children.every((child) => child.status === "succeeded")).toBe(true);

    // Parent progress fired for parent steps only (3 steps x running+final).
    expect(progress).toEqual([
      "fetch-workspace:running",
      "fetch-workspace:succeeded",
      "table:SecurityEvent:running",
      "table:SecurityEvent:succeeded",
      "table:CloudFlare_CL:running",
      "table:CloudFlare_CL:succeeded",
    ]);
  });
});

describe("onboardBatch skip-existing (user decision: first-class 'skipped')", () => {
  it("GETs the DCR first; a hit skips the table with ZERO deploy calls", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      { status: 200, body: { name: "dcr-SecurityEvent-eastus" } }, // exists
      NOT_FOUND_RESPONSE, // Syslog DCR missing -> deploy
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: directDcrBody("dcr-syslog-immutable") },
      { status: 200, body: directDcrBody("dcr-syslog-immutable") },
    );
    scriptCriblHappyPath(ports.cribl, 1);

    const job = await onboardBatch(
      ports,
      baseInput({
        tables: [{ table: "SecurityEvent" }, { table: "Syslog" }],
        options: makeOptions({ skipExistingDCRs: true }),
      }),
    );

    expect(job.status).toBe("succeeded");
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:succeeded",
      "table:SecurityEvent:skipped",
      "table:Syslog:succeeded",
    ]);
    const skippedStep = job.steps.find((s) => s.name === "table:SecurityEvent")!;
    expect(skippedStep.detail).toBe(
      "DCR 'dcr-SecurityEvent-eastus' already exists - skipped (skipExistingDCRs)",
    );

    // ZERO deploy calls for the skipped table: its only ARM call is the
    // existence GET (call-count pinned by the exact sequence).
    expect(callSequence(ports.azure)).toEqual([
      `GET ${WORKSPACE_ID}`,
      `GET ${DCR_BASE}/dcr-SecurityEvent-eastus`,
      `GET ${DCR_BASE}/dcr-Syslog-eastus`,
      `GET ${WORKSPACE_ID}`,
      `GET ${WORKSPACE_ID}/tables/Syslog`,
      `PUT ${DCR_BASE}/dcr-Syslog-eastus`,
      `GET ${DCR_BASE}/dcr-Syslog-eastus`,
    ]);
    expect(ports.cribl.calls.length).toBe(4); // Syslog only
    expect((await ports.jobs.list(ONBOARD_TABLE_JOB_KIND)).length).toBe(1);

    const outcome = job.result as OnboardBatchOutcome;
    expect(outcome.tables[0]).toMatchObject({
      table: "SecurityEvent",
      status: "skipped",
      reason: "already-exists",
    });
    expect(outcome.skipped).toBe(1);
    expect(outcome.succeeded).toBe(1);
  });
});

describe("onboardBatch templateOnly (legacy defect FIXED: the flag now works)", () => {
  it("issues ZERO ARM writes and collects every request body into the parent result", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE, // prologue
      NATIVE_SCHEMA_RESPONSE, // SecurityEvent schema (read-only)
      NOT_FOUND_RESPONSE, // CloudFlare_CL does not exist
    );

    const job = await onboardBatch(
      ports,
      baseInput({
        tables: [
          { table: "SecurityEvent" },
          { table: "CloudFlare_CL", customSchema: CUSTOM_SCHEMA },
        ],
        // skipExistingDCRs deliberately ON: template mode ignores it (no
        // existence GETs appear in the pinned call count below).
        options: makeOptions({
          templateOnly: true,
          createDCE: true,
          skipExistingDCRs: true,
        }),
      }),
    );

    expect(job.status).toBe("succeeded");
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:succeeded",
      "ensure-dce:succeeded",
      "table:SecurityEvent:succeeded",
      "table:CloudFlare_CL:succeeded",
    ]);

    // ZERO-WRITE PIN: exactly three ARM calls, every one a GET; zero Cribl
    // calls; zero child jobs.
    expect(ports.azure.calls.length).toBe(3);
    expect(ports.azure.calls.every((call) => call.method === "GET")).toBe(true);
    expect(ports.cribl.calls.length).toBe(0);
    expect((await ports.jobs.list(ONBOARD_TABLE_JOB_KIND)).length).toBe(0);

    // Collected bodies: DCE first, then per table (table PUT only for the
    // not-yet-existing custom table, then its DCR).
    const outcome = job.result as OnboardBatchOutcome;
    expect(
      outcome.templates.map((t) => `${t.kind}:${t.artifactName}`),
    ).toEqual([
      "dce:dce-law-prod-eastus.json",
      "dcr:dcr-SecurityEvent-eastus.json",
      "custom-table:CloudFlare_CL.json",
      "dcr:dcr-CloudFlare-eastus.json",
    ]);

    const dceTemplate = outcome.templates[0]!;
    expect(dceTemplate.method).toBe("PUT");
    expect(dceTemplate.path).toBe(DCE_PATH);
    expect(dceTemplate.body).toEqual({
      location: "eastus",
      properties: { networkAcls: { publicNetworkAccess: "Enabled" } },
    });

    // The predicted DCE resource id (its REAL ARM path, not the legacy
    // zeroed placeholder) is wired into both DCE-based DCR bodies.
    for (const index of [1, 3]) {
      const dcrTemplate = outcome.templates[index]!;
      const body = dcrTemplate.body as {
        kind?: string;
        properties: { dataCollectionEndpointId: string };
      };
      expect(body.properties.dataCollectionEndpointId).toBe(DCE_PATH);
      expect("kind" in body).toBe(false);
    }

    const tablePut = outcome.templates[2]!;
    expect(tablePut.apiVersion).toBe("2022-10-01");
    const tableBody = tablePut.body as {
      properties: {
        plan: string;
        retentionInDays: number;
        totalRetentionInDays: number;
        schema: { name: string };
      };
    };
    expect(tableBody.properties.plan).toBe("Analytics");
    expect(tableBody.properties.retentionInDays).toBe(30);
    expect(tableBody.properties.totalRetentionInDays).toBe(90);
    expect(tableBody.properties.schema.name).toBe("CloudFlare_CL");

    expect(outcome.dce).toBeNull(); // nothing deployed
  });
});

describe("onboardBatch DCE mode (deploy)", () => {
  it("ensures the DCE ONCE for the batch and wires it into every table", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      NOT_FOUND_RESPONSE, // DCE existence GET -> create
      DCE_SUCCEEDED_RESPONSE, // DCE PUT
      // child 1: MicrosoftGraphActivityLogs
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: dceDcrBody("immutable-1") },
      { status: 200, body: dceDcrBody("immutable-1") },
      // child 2: Syslog
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: dceDcrBody("immutable-2") },
      { status: 200, body: dceDcrBody("immutable-2") },
    );
    scriptCriblHappyPath(ports.cribl, 2);

    const job = await onboardBatch(
      ports,
      baseInput({
        tables: [{ table: "MicrosoftGraphActivityLogs" }, { table: "Syslog" }],
        options: makeOptions({ createDCE: true }),
      }),
    );

    expect(job.status).toBe("succeeded");
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:succeeded",
      "ensure-dce:succeeded",
      "table:MicrosoftGraphActivityLogs:succeeded",
      "table:Syslog:succeeded",
    ]);

    // ensure-DCE happened ONCE: exactly one GET + one PUT on the DCE path
    // across the whole batch.
    const dceCalls = ports.azure.calls.filter((call) =>
      call.path.includes("/dataCollectionEndpoints/"),
    );
    expect(dceCalls.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(dceCalls[1]!.apiVersion).toBe("2023-03-11");

    // The 37-char DCR name survived unabbreviated: the children ran in
    // dcr-naming mode "dce" (64-char limit), not "direct" (30).
    expect(callSequence(ports.azure)).toContain(
      `PUT ${DCR_BASE}/dcr-MicrosoftGraphActivityLogs-eastus`,
    );

    // Every DCR body carries the shared DCE id and no kind.
    const dcrPuts = ports.azure.calls.filter(
      (call) => call.method === "PUT" && call.path.includes("/dataCollectionRules/"),
    );
    expect(dcrPuts.length).toBe(2);
    for (const put of dcrPuts) {
      const body = put.body as {
        kind?: string;
        properties: { dataCollectionEndpointId: string };
      };
      expect(body.properties.dataCollectionEndpointId).toBe(DCE_PATH);
      expect("kind" in body).toBe(false);
    }

    // Both Cribl destinations ingest through the DCE endpoint.
    const destinationBodies = ports.cribl.calls
      .filter((call) => call.method === "POST" && call.path === "/system/outputs")
      .map((call) => call.body as { dceEndpoint: string });
    expect(destinationBodies.length).toBe(2);
    for (const body of destinationBodies) {
      expect(body.dceEndpoint).toBe(DCE_ENDPOINT);
    }

    const outcome = job.result as OnboardBatchOutcome;
    expect(outcome.dce).toEqual({
      name: "dce-law-prod-eastus",
      resourceId: DCE_PATH,
      logsIngestionEndpoint: DCE_ENDPOINT,
      reused: false,
      amplsAssociated: false,
    });
  });

  it("reuses an existing DCE by name (GET hit -> no PUT)", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      DCE_SUCCEEDED_RESPONSE, // DCE existence GET hits
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: dceDcrBody("immutable-1") },
      { status: 200, body: dceDcrBody("immutable-1") },
    );
    scriptCriblHappyPath(ports.cribl, 1);

    const job = await onboardBatch(
      ports,
      baseInput({
        tables: [{ table: "Syslog" }],
        options: makeOptions({ createDCE: true }),
      }),
    );

    expect(job.status).toBe("succeeded");
    const dceCalls = ports.azure.calls.filter((call) =>
      call.path.includes("/dataCollectionEndpoints/"),
    );
    expect(dceCalls.map((call) => call.method)).toEqual(["GET"]);
    expect((job.result as OnboardBatchOutcome).dce).toMatchObject({
      reused: true,
    });
  });

  it("associates the DCE with the AMPLS when public network access is disabled", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      NOT_FOUND_RESPONSE,
      DCE_SUCCEEDED_RESPONSE,
      { status: 200, body: {} }, // AMPLS association PUT
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: dceDcrBody("immutable-1") },
      { status: 200, body: dceDcrBody("immutable-1") },
    );
    scriptCriblHappyPath(ports.cribl, 1);

    const job = await onboardBatch(
      ports,
      baseInput({
        tables: [{ table: "Syslog" }],
        options: makeOptions({
          createDCE: true,
          dcePublicNetworkAccess: false,
          amplsResourceId: AMPLS_ID,
        }),
      }),
    );

    expect(job.status).toBe("succeeded");
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:succeeded",
      "ensure-dce:succeeded",
      "associate-ampls:succeeded",
      "table:Syslog:succeeded",
    ]);

    // The DCE was created private-only.
    const dcePut = ports.azure.calls.find(
      (call) => call.method === "PUT" && call.path === DCE_PATH,
    )!;
    expect(dcePut.body).toEqual({
      location: "eastus",
      properties: { networkAcls: { publicNetworkAccess: "Disabled" } },
    });

    // The association is a scopedResources child of the AMPLS, linking the
    // DCE (the legacy Add-DCEToAMPLS contract via dce-request).
    const association = ports.azure.calls.find((call) =>
      call.path.includes("/scopedResources/"),
    )!;
    expect(association.method).toBe("PUT");
    expect(association.path).toBe(
      `${AMPLS_ID}/scopedResources/dce-law-prod-eastus-ampls-connection`,
    );
    expect(association.apiVersion).toBe("2021-07-01-preview");
    expect(association.body).toEqual({
      properties: { linkedResourceId: DCE_PATH },
    });

    expect((job.result as OnboardBatchOutcome).dce).toMatchObject({
      amplsAssociated: true,
    });
  });

  it("refuses a private-only DCE without an AMPLS (Unit 6 cross-field rule at the usecase)", async () => {
    const ports = makePorts();
    ports.azure.respondWith(WORKSPACE_RESPONSE);

    const job = await onboardBatch(
      ports,
      baseInput({
        tables: [{ table: "Syslog" }],
        options: makeOptions({
          createDCE: true,
          dcePublicNetworkAccess: false,
          amplsResourceId: "",
        }),
      }),
    );

    expect(job.status).toBe("failed");
    expect(ports.azure.calls.length).toBe(1); // the workspace GET only
    const ensureStep = job.steps.find((s) => s.name === "ensure-dce")!;
    expect(ensureStep.status).toBe("failed");
    expect(ensureStep.detail).toContain("amplsResourceId");
    // Downstream steps SKIP, referencing the prerequisite.
    expect(job.steps.find((s) => s.name === "associate-ampls")!.status).toBe(
      "skipped",
    );
    expect(job.steps.find((s) => s.name === "table:Syslog")!.status).toBe(
      "skipped",
    );
  });
});

describe("onboardBatch failed-prerequisite semantics (legacy cascade fixed)", () => {
  it("a failed ensure-dce SKIPS every table with a detail referencing the prerequisite", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      { status: 500, body: { error: { code: "InternalServerError" } } }, // DCE GET
    );

    const job = await onboardBatch(
      ports,
      baseInput({
        tables: [{ table: "SecurityEvent" }, { table: "Syslog" }],
        options: makeOptions({ createDCE: true }),
      }),
    );

    expect(job.status).toBe("failed");
    expect(job.error).toContain("prerequisite step 'ensure-dce' failed");
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:succeeded",
      "ensure-dce:failed",
      "table:SecurityEvent:skipped",
      "table:Syslog:skipped",
    ]);
    for (const name of ["table:SecurityEvent", "table:Syslog"]) {
      expect(job.steps.find((s) => s.name === name)!.detail).toBe(
        "skipped: prerequisite step 'ensure-dce' failed",
      );
    }

    // NOTHING ran downstream: no further ARM calls, no Cribl calls, no
    // child jobs - never the legacy cascade of confusing per-table errors.
    expect(ports.azure.calls.length).toBe(2);
    expect(ports.cribl.calls.length).toBe(0);
    expect((await ports.jobs.list(ONBOARD_TABLE_JOB_KIND)).length).toBe(0);

    const outcome = job.result as OnboardBatchOutcome;
    expect(outcome.tables.every((t) => t.reason === "prerequisite-failed")).toBe(
      true,
    );
    expect(outcome.skipped).toBe(2);
  });

  it("a failed fetch-workspace skips everything downstream the same way", async () => {
    const ports = makePorts();
    ports.azure.respondWith({ status: 403, body: { error: "denied" } });

    const job = await onboardBatch(
      ports,
      baseInput({ tables: [{ table: "SecurityEvent" }] }),
    );

    expect(job.status).toBe("failed");
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:failed",
      "table:SecurityEvent:skipped",
    ]);
    expect(ports.azure.calls.length).toBe(1);
  });
});

describe("onboardBatch per-table isolation", () => {
  it("one table's failure never stops the others (partial results, never all-or-nothing)", async () => {
    const ports = makePorts();
    ports.azure.respondWith(
      WORKSPACE_RESPONSE,
      // child 1: SecurityEvent fails at the DCR PUT
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 403, body: { error: { code: "AuthorizationFailed" } } },
      // child 2: Syslog succeeds
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: directDcrBody("immutable-2") },
      { status: 200, body: directDcrBody("immutable-2") },
    );
    scriptCriblHappyPath(ports.cribl, 1);

    const job = await onboardBatch(
      ports,
      baseInput({ tables: [{ table: "SecurityEvent" }, { table: "Syslog" }] }),
    );

    expect(job.status).toBe("failed");
    expect(job.error).toBe("1 of 2 table(s) failed");
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:succeeded",
      "table:SecurityEvent:failed",
      "table:Syslog:succeeded",
    ]);

    const outcome = job.result as OnboardBatchOutcome;
    expect(outcome.tables[0]!.status).toBe("failed");
    expect(outcome.tables[0]!.error).toContain("HTTP 403");
    expect(outcome.tables[0]!.jobId).toBeDefined();
    expect(outcome.tables[1]!.status).toBe("succeeded");
    expect(outcome.failed).toBe(1);
    expect(outcome.succeeded).toBe(1);

    // The second table's full deploy actually happened.
    expect(callSequence(ports.azure)).toContain(
      `PUT ${DCR_BASE}/dcr-Syslog-eastus`,
    );
    expect(ports.cribl.calls.length).toBe(4);
  });
});

describe("onboardBatch transport rejections still finish the record (DBT-48)", () => {
  it("a REJECTING fetch-workspace fails the step instead of escaping the batch", async () => {
    const ports = {
      azure: rejectingAzure("connect ECONNRESET 20.150.34.1:443"),
      cribl: new FakeCriblClient({ outputsList: [] }),
      jobs: new FakeJobStore(),
    };

    // Resolves - the never-rejects contract covers a transport that throws,
    // not only one that answers non-2xx.
    const job = await onboardBatch(
      ports,
      baseInput({ tables: [{ table: "SecurityEvent" }, { table: "Syslog" }] }),
    );

    expect(job.status).toBe("failed");
    expect(job.error).toBe(
      "prerequisite step 'fetch-workspace' failed - 2 table(s) skipped",
    );
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:failed",
      "table:SecurityEvent:skipped",
      "table:Syslog:skipped",
    ]);
    // The transport error text reaches the operator, not a generic message.
    expect(job.steps.find((s) => s.name === "fetch-workspace")!.detail).toContain(
      "ECONNRESET",
    );

    // NOTHING is left running: the defect stranded the record at 'running'
    // with fetch-workspace stuck 'running' - a batch that never finished and
    // never failed.
    const stored = await ports.jobs.list(ONBOARD_BATCH_JOB_KIND);
    expect(stored.map((record) => record.status)).toEqual(["failed"]);
    expect(stored[0]!.steps.some((step) => step.status === "running")).toBe(false);

    // Every table skipped with the prerequisite reason; no Cribl work.
    const outcome = job.result as OnboardBatchOutcome;
    expect(outcome.skipped).toBe(2);
    expect(outcome.failed).toBe(0);
    expect(outcome.tables.every((t) => t.reason === "prerequisite-failed")).toBe(
      true,
    );
    expect(ports.cribl.calls.length).toBe(0);
  });

  it("a REJECTING ensure-dce fails that step, and the tables skip (DBT-56)", async () => {
    const inner = new FakeAzureManagement({ dataCollectionRulesList: [] });
    // Only the prologue GET is scripted: the DCE existence GET is call 2 and
    // never reaches the fake.
    inner.respondWith(WORKSPACE_RESPONSE);
    const cribl = new FakeCriblClient({ outputsList: [] });
    const jobs = new FakeJobStore();
    const ports = {
      azure: azureRejectingOnCall(inner, 2, "connect ETIMEDOUT 20.150.34.1:443"),
      cribl,
      jobs,
    };

    // Resolves. Before DBT-56 this held because of a hand-written try block
    // around the DCE calls, and nothing in the suite noticed when that block
    // was made transparent - the measured gap the safe view closes.
    const job = await onboardBatch(
      ports,
      baseInput({
        tables: [{ table: "Syslog" }],
        options: makeOptions({ createDCE: true }),
      }),
    );

    expect(job.status).toBe("failed");
    expect(job.error).toBe(
      "prerequisite step 'ensure-dce' failed - 1 table(s) skipped",
    );
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:succeeded",
      "ensure-dce:failed",
      "table:Syslog:skipped",
    ]);
    // The transport's own text, not a generic message.
    expect(job.steps.find((step) => step.name === "ensure-dce")!.detail).toContain(
      "ETIMEDOUT",
    );

    // Nothing stranded at 'running', and the table was never deployed.
    const stored = await jobs.list(ONBOARD_BATCH_JOB_KIND);
    expect(stored.map((record) => record.status)).toEqual(["failed"]);
    expect(stored[0]!.steps.some((step) => step.status === "running")).toBe(false);
    expect(cribl.calls.length).toBe(0);

    const outcome = job.result as OnboardBatchOutcome;
    expect(outcome.skipped).toBe(1);
    expect(outcome.failed).toBe(0);
    expect(outcome.tables[0]!.reason).toBe("prerequisite-failed");
  });

  it("a REJECTING skip-existing check fails ONE table and the next still deploys (DBT-56)", async () => {
    const inner = new FakeAzureManagement({ dataCollectionRulesList: [] });
    inner.respondWith(
      WORKSPACE_RESPONSE, // 1 prologue fetch-workspace
      // 2 = the skip-existing GET for SecurityEvent, REJECTED before the fake
      NOT_FOUND_RESPONSE, // 3 skip-existing GET for Syslog: no such DCR
      WORKSPACE_RESPONSE, // 4 child
      NATIVE_SCHEMA_RESPONSE, // 5
      { status: 200, body: directDcrBody("immutable-syslog") }, // 6 PUT
      { status: 200, body: directDcrBody("immutable-syslog") }, // 7 readback
    );
    const cribl = new FakeCriblClient({ outputsList: [] });
    scriptCriblHappyPath(cribl, 1);
    const jobs = new FakeJobStore();
    const ports = {
      azure: azureRejectingOnCall(inner, 2, "connect ECONNRESET 20.150.34.1:443"),
      cribl,
      jobs,
    };

    const job = await onboardBatch(
      ports,
      baseInput({
        tables: [{ table: "SecurityEvent" }, { table: "Syslog" }],
        options: makeOptions({ skipExistingDCRs: true }),
      }),
    );

    expect(job.status).toBe("failed");
    expect(job.error).toBe("1 of 2 table(s) failed");
    expect(job.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:succeeded",
      "table:SecurityEvent:failed",
      "table:Syslog:succeeded",
    ]);

    const outcome = job.result as OnboardBatchOutcome;
    expect(outcome.failed).toBe(1);
    expect(outcome.succeeded).toBe(1);
    expect(outcome.tables[0]!.error).toContain("ECONNRESET");

    // ISOLATION survives a transport rejection, not only an HTTP error: the
    // second table's DCR was deployed and its destination created.
    expect(callSequence(inner)).toContain(`PUT ${DCR_BASE}/dcr-Syslog-eastus`);
    expect(cribl.calls.length).toBe(4);
  });
});

describe("safeAzureManagement: the never-rejects contract as a type (DBT-56)", () => {
  const PROBE = { method: "GET" as const, path: "/probe", apiVersion: "2023-09-01" };

  it("turns a REJECTING transport into ok:false carrying its text", async () => {
    const safe = safeAzureManagement(
      rejectingAzure("connect ECONNRESET 20.150.34.1:443"),
    );

    // The whole point: this AWAIT does not throw. A call site cannot forget a
    // guard it is not allowed to write.
    const attempt = await safe.request(PROBE);

    expect(attempt).toEqual({
      ok: false,
      error: "connect ECONNRESET 20.150.34.1:443",
    });
  });

  it("leaves a non-2xx ANSWER as ok:true - ARM refusing is not ARM unreachable", async () => {
    const inner = new FakeAzureManagement({ dataCollectionRulesList: [] });
    const forbidden = {
      status: 403,
      body: { error: { code: "AuthorizationFailed", message: "no" } },
    };
    inner.respondWith(forbidden);

    const attempt = await safeAzureManagement(inner).request(PROBE);

    // Collapsing these two into one failure shape would be worse than the
    // convention this replaces: "ARM said no" and "ARM was never reached" are
    // different operator actions, and every caller below still branches on
    // status to build its own error text.
    expect(attempt).toEqual({ ok: true, response: forbidden });
    // Pass-through, not a rewrite: the request reaches the port verbatim.
    expect(inner.calls).toEqual([PROBE]);
  });

  it("renders a non-Error rejection as text rather than dropping it", async () => {
    const throwsAString: AzureManagement = {
      request: async () => {
        throw "socket hang up";
      },
    };

    expect(await safeAzureManagement(throwsAString).request(PROBE)).toEqual({
      ok: false,
      error: "socket hang up",
    });
  });
});

describe("onboardBatch JobStore outages are not table failures (DBT-49)", () => {
  it("re-raises a store blip instead of blaming the table that deployed fine", async () => {
    const inner = new FakeJobStore();
    const azure = new FakeAzureManagement({ dataCollectionRulesList: [] });
    const cribl = new FakeCriblClient({ outputsList: [] });
    azure.respondWith(
      WORKSPACE_RESPONSE, // prologue fetch-workspace
      WORKSPACE_RESPONSE, // child
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: directDcrBody("immutable-1") },
      { status: 200, body: directDcrBody("immutable-1") },
    );
    scriptCriblHappyPath(cribl, 1);
    const ports = {
      azure,
      cribl,
      jobs: storeThatBlipsOnTheFirstTableResult(inner),
    };

    // A JobStore failure is outside the never-rejects promise (the UI reads a
    // rejection as exactly that), so it comes out as itself.
    await expect(
      onboardBatch(ports, baseInput({ tables: [{ table: "SecurityEvent" }] })),
    ).rejects.toThrow(/job store update failed: kvstore PATCH failed/);

    // The TABLE was fine: its DCR was deployed and its Cribl destination
    // created before the store blipped on the write reporting it.
    expect(callSequence(azure)).toContain(
      `PUT ${DCR_BASE}/dcr-SecurityEvent-eastus`,
    );
    expect(cribl.calls.length).toBe(4);

    // So the record says nothing bad about it. The defect wrote the store's
    // error back as the TABLE's failure - and because recordTable had already
    // pushed the succeeded entry before its write threw, one table ended up
    // counted once as a success and once as a failure.
    const parent = (await inner.list(ONBOARD_BATCH_JOB_KIND))[0]!;
    const entries = (parent.result as OnboardBatchOutcome | undefined)?.tables ?? [];
    expect(entries.filter((entry) => entry.status === "failed")).toEqual([]);
    expect(
      entries.filter((entry) => entry.table === "SecurityEvent").length,
    ).toBeLessThanOrEqual(1);
    const tableStep = parent.steps.find((s) => s.name === "table:SecurityEvent")!;
    expect(tableStep.status).not.toBe("failed");
  });

  it("re-raises a store blip raised inside the CHILD, instead of recording a failed table (DBT-60)", async () => {
    const inner = new FakeJobStore();
    const azure = new FakeAzureManagement({ dataCollectionRulesList: [] });
    const cribl = new FakeCriblClient({ outputsList: [] });
    azure.respondWith(
      WORKSPACE_RESPONSE, // prologue fetch-workspace
      WORKSPACE_RESPONSE, // child
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: directDcrBody("immutable-1") },
      { status: 200, body: directDcrBody("immutable-1") },
    );
    scriptCriblHappyPath(cribl, 1);
    const ports = {
      azure,
      cribl,
      jobs: storeThatBlipsOnTheChildSuccessWrite(inner),
    };

    // FIRST, because it is the assertion the defect breaks. The child re-raises
    // the store outage as its own JobStoreFailure (DBT-55); the batch used to
    // test `instanceof` against its OWN class, which across a module boundary
    // matches nothing, so the signal was raised and then silently dropped and
    // the batch RESOLVED with an ordinary failed table.
    await expect(
      onboardBatch(ports, baseInput({ tables: [{ table: "SecurityEvent" }] })),
    ).rejects.toThrow(/job store update failed: kvstore PATCH failed/);

    // The TABLE was fine: its DCR deployed and its Cribl destination was
    // created and verified before the store blipped on the write reporting it.
    expect(callSequence(azure)).toContain(
      `PUT ${DCR_BASE}/dcr-SecurityEvent-eastus`,
    );
    expect(cribl.calls.length).toBe(4);

    // So the parent record says nothing bad about it. The defect recorded a
    // failed table whose error text was the STORE's, carrying a "job store
    // update failed:" prefix - and retrying that table, the operator's obvious
    // next move, was the wrong action.
    const parent = (await inner.list(ONBOARD_BATCH_JOB_KIND))[0]!;
    const entries = (parent.result as OnboardBatchOutcome | undefined)?.tables ?? [];
    expect(entries.filter((entry) => entry.status === "failed")).toEqual([]);
    const tableStep = parent.steps.find((s) => s.name === "table:SecurityEvent")!;
    expect(tableStep.status).not.toBe("failed");
    expect(tableStep.detail ?? "").not.toContain("job store update failed");
  });
});
