/**
 * onboardBatch budget pacing and resumability (porting-plan Unit 6).
 *
 * PACING: at most maxRequestsPerMinute ARM calls per ROLLING minute, driven
 * entirely by the INJECTED now()/sleep() hooks - core never reads a clock;
 * these tests advance a fake tick counter through sleep.
 *
 * RESUMABILITY: the parent record persists per-table progress after every
 * table, so a re-run with the same input skips completed tables; a re-run of
 * a FULLY completed batch is a no-op (zero ARM calls, zero Cribl calls,
 * parent record 'skipped' - first-class status, user decision).
 */
import { describe, expect, it } from "vitest";
import {
  onboardBatch,
  paceAzureManagement,
  DEFAULT_BATCH_MAX_REQUESTS_PER_MINUTE,
} from "./onboard-batch";
import type {
  BatchPacing,
  OnboardBatchInput,
  OnboardBatchOutcome,
} from "./onboard-batch";
import { ONBOARD_TABLE_JOB_KIND } from "../onboard-table";
import { DEFAULT_OPERATION_OPTIONS } from "../../domain/option-forms";
import type { AzureManagement } from "../../ports/azure-management";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { FakeJobStore } from "../../testing/fake-job-store";

const WORKSPACE_ID =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.OperationalInsights/workspaces/law-prod";

const DCR_BASE =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.Insights/dataCollectionRules";

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
        ],
      },
    },
  },
};

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

/** Fake tick clock: now() reads t, sleep(ms) advances t and records the ms. */
function fakeClock(maxRequestsPerMinute?: number) {
  const state = { t: 0 };
  const sleeps: number[] = [];
  const pacing: BatchPacing = {
    ...(maxRequestsPerMinute !== undefined ? { maxRequestsPerMinute } : {}),
    now: () => state.t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      state.t += ms;
    },
  };
  return { state, sleeps, pacing };
}

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

function baseInput(
  pacing: BatchPacing,
  overrides: Partial<OnboardBatchInput> = {},
): OnboardBatchInput {
  return {
    tables: [{ table: "SecurityEvent" }],
    subscriptionId: "sub-123",
    resourceGroup: "rg-sec",
    workspaceName: "law-prod",
    groupId: "default",
    tenantId: "11111111-2222-3333-4444-555555555555",
    ingestionClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    options: { ...DEFAULT_OPERATION_OPTIONS, skipExistingDCRs: false },
    pacing,
    ...overrides,
  };
}

describe("paceAzureManagement", () => {
  it("allows maxRequestsPerMinute per rolling minute, sleeping until the window opens", async () => {
    const { state, sleeps, pacing } = fakeClock(2);
    const issuedAt: number[] = [];
    const inner: AzureManagement = {
      request: async () => {
        issuedAt.push(state.t);
        return { status: 200, body: {} };
      },
    };
    const paced = paceAzureManagement(inner, pacing);

    for (let i = 0; i < 5; i++) {
      await paced.request({ method: "GET", path: "/x", apiVersion: "v" });
    }

    // 2 immediately, then each further pair waits for the rolling window.
    expect(issuedAt).toEqual([0, 0, 60_000, 60_000, 120_000]);
    expect(sleeps).toEqual([60_000, 60_000]);
  });

  it("uses the 80-request default (headroom under the cloud 100/min budget)", () => {
    expect(DEFAULT_BATCH_MAX_REQUESTS_PER_MINUTE).toBe(80);
    const { pacing } = fakeClock();
    // Constructing with the default budget must not throw.
    expect(() =>
      paceAzureManagement(new FakeAzureManagement({ dataCollectionRulesList: [] }), pacing),
    ).not.toThrow();
  });

  it("rejects a non-positive budget instead of stalling forever", () => {
    const { pacing } = fakeClock(0);
    expect(() => paceAzureManagement(new FakeAzureManagement({ dataCollectionRulesList: [] }), pacing)).toThrow(
      RangeError,
    );
  });
});

describe("onboardBatch budget pacing", () => {
  it("never issues more than maxRequestsPerMinute ARM calls in any rolling minute (fake ticks)", async () => {
    const { state, sleeps, pacing } = fakeClock(2);
    const fake = new FakeAzureManagement({ dataCollectionRulesList: [] });
    fake.respondWith(
      WORKSPACE_RESPONSE, // prologue
      WORKSPACE_RESPONSE, // child fetch-workspace
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: directDcrBody("immutable-1") },
      { status: 200, body: directDcrBody("immutable-1") },
    );
    // Record the fake-clock time each ARM call actually ISSUES at.
    const issuedAt: number[] = [];
    const recordingAzure: AzureManagement = {
      request: async (opts) => {
        issuedAt.push(state.t);
        return fake.request(opts);
      },
    };
    const cribl = new FakeCriblClient({ outputsList: [] });
    scriptCriblHappyPath(cribl, 1);
    const jobs = new FakeJobStore();

    const job = await onboardBatch(
      { azure: recordingAzure, cribl, jobs },
      baseInput(pacing),
    );

    expect(job.status).toBe("succeeded");
    // 5 ARM calls under a 2/min budget: 2 at t=0, 2 after one window, 1
    // after two.
    expect(issuedAt).toEqual([0, 0, 60_000, 60_000, 120_000]);
    expect(sleeps).toEqual([60_000, 60_000]);

    // Rolling-window invariant: no minute-wide window contains more than 2.
    for (const at of issuedAt) {
      const inWindow = issuedAt.filter((t) => t <= at && at - t < 60_000);
      expect(inWindow.length).toBeLessThanOrEqual(2);
    }

    // Cribl calls are NOT paced (only ARM crosses the proxied budget).
    expect(cribl.calls.length).toBe(4);
  });
});

describe("onboardBatch resumability", () => {
  it("re-running a fully completed batch is a NO-OP: zero calls, parent record 'skipped'", async () => {
    const jobs = new FakeJobStore();

    // Run 1: complete the batch.
    const azure1 = new FakeAzureManagement({ dataCollectionRulesList: [] });
    azure1.respondWith(
      WORKSPACE_RESPONSE,
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: directDcrBody("immutable-1") },
      { status: 200, body: directDcrBody("immutable-1") },
    );
    const cribl1 = new FakeCriblClient({ outputsList: [] });
    scriptCriblHappyPath(cribl1, 1);
    const run1 = await onboardBatch(
      { azure: azure1, cribl: cribl1, jobs },
      baseInput(fakeClock().pacing),
    );
    expect(run1.status).toBe("succeeded");

    // Run 2: same input, FRESH transports with NO scripted responses - any
    // call would throw, so green means genuinely zero calls.
    const azure2 = new FakeAzureManagement({ dataCollectionRulesList: [] });
    const cribl2 = new FakeCriblClient({ outputsList: [] });
    const run2 = await onboardBatch(
      { azure: azure2, cribl: cribl2, jobs },
      baseInput(fakeClock().pacing),
    );

    expect(run2.id).not.toBe(run1.id);
    expect(run2.status).toBe("skipped");
    expect(run2.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:skipped",
      "table:SecurityEvent:skipped",
    ]);
    expect(azure2.calls.length).toBe(0);
    expect(cribl2.calls.length).toBe(0);
    // No new child jobs either.
    expect((await jobs.list(ONBOARD_TABLE_JOB_KIND)).length).toBe(1);

    const outcome = run2.result as OnboardBatchOutcome;
    expect(outcome.tables[0]).toMatchObject({
      table: "SecurityEvent",
      status: "skipped",
      reason: "already-completed",
      detail: `already completed by batch job '${run1.id}' - skipped`,
    });
    expect(outcome.skipped).toBe(1);
  });

  it("resumes a partially completed batch: completed tables skip, failed tables retry", async () => {
    const jobs = new FakeJobStore();
    const input = (pacing: BatchPacing) =>
      baseInput(pacing, {
        tables: [{ table: "SecurityEvent" }, { table: "Syslog" }],
      });

    // Run 1: SecurityEvent succeeds, Syslog fails at the DCR PUT. The parent
    // persisted SecurityEvent's result BEFORE Syslog ran (progress after
    // every table), which is what run 2 resumes from.
    const azure1 = new FakeAzureManagement({ dataCollectionRulesList: [] });
    azure1.respondWith(
      WORKSPACE_RESPONSE,
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: directDcrBody("immutable-1") },
      { status: 200, body: directDcrBody("immutable-1") },
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 500, body: { error: { code: "InternalServerError" } } },
    );
    const cribl1 = new FakeCriblClient({ outputsList: [] });
    scriptCriblHappyPath(cribl1, 1);
    const run1 = await onboardBatch(
      { azure: azure1, cribl: cribl1, jobs },
      input(fakeClock().pacing),
    );
    expect(run1.status).toBe("failed");
    expect(run1.error).toBe("1 of 2 table(s) failed");

    // Run 2: only Syslog's work is scripted - SecurityEvent must not touch
    // the transports again.
    const azure2 = new FakeAzureManagement({ dataCollectionRulesList: [] });
    azure2.respondWith(
      WORKSPACE_RESPONSE, // prologue (tables remain, so the prologue runs)
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: directDcrBody("immutable-2") },
      { status: 200, body: directDcrBody("immutable-2") },
    );
    const cribl2 = new FakeCriblClient({ outputsList: [] });
    scriptCriblHappyPath(cribl2, 1);
    const run2 = await onboardBatch(
      { azure: azure2, cribl: cribl2, jobs },
      input(fakeClock().pacing),
    );

    expect(run2.status).toBe("succeeded");
    expect(run2.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "fetch-workspace:succeeded",
      "table:SecurityEvent:skipped",
      "table:Syslog:succeeded",
    ]);
    expect(
      azure2.calls.map((call) => `${call.method} ${call.path}`),
    ).toEqual([
      `GET ${WORKSPACE_ID}`,
      `GET ${WORKSPACE_ID}`,
      `GET ${WORKSPACE_ID}/tables/Syslog`,
      `PUT ${DCR_BASE}/dcr-Syslog-eastus`,
      `GET ${DCR_BASE}/dcr-Syslog-eastus`,
    ]);

    const outcome = run2.result as OnboardBatchOutcome;
    expect(outcome.tables[0]).toMatchObject({
      table: "SecurityEvent",
      status: "skipped",
      reason: "already-completed",
    });
    expect(outcome.tables[1]).toMatchObject({
      table: "Syslog",
      status: "succeeded",
    });
  });

  it("templateOnly runs always regenerate - they neither consume nor produce resume state", async () => {
    const jobs = new FakeJobStore();
    const templateInput = (pacing: BatchPacing) =>
      baseInput(pacing, {
        options: {
          ...DEFAULT_OPERATION_OPTIONS,
          skipExistingDCRs: false,
          templateOnly: true,
        },
      });

    const azure1 = new FakeAzureManagement({ dataCollectionRulesList: [] });
    azure1.respondWith(WORKSPACE_RESPONSE, NATIVE_SCHEMA_RESPONSE);
    const run1 = await onboardBatch(
      { azure: azure1, cribl: new FakeCriblClient({ outputsList: [] }), jobs },
      templateInput(fakeClock().pacing),
    );
    expect(run1.status).toBe("succeeded");

    // The re-run regenerates (deterministic artifacts) instead of skipping.
    const azure2 = new FakeAzureManagement({ dataCollectionRulesList: [] });
    azure2.respondWith(WORKSPACE_RESPONSE, NATIVE_SCHEMA_RESPONSE);
    const run2 = await onboardBatch(
      { azure: azure2, cribl: new FakeCriblClient({ outputsList: [] }), jobs },
      templateInput(fakeClock().pacing),
    );
    expect(run2.status).toBe("succeeded");
    expect(azure2.calls.length).toBe(2);
    expect((run2.result as OnboardBatchOutcome).templates.length).toBe(1);

    // And a LATER DEPLOY run must not mistake the templateOnly runs'
    // "succeeded" table entries for actual completion - it deploys.
    const azure3 = new FakeAzureManagement({ dataCollectionRulesList: [] });
    azure3.respondWith(
      WORKSPACE_RESPONSE,
      WORKSPACE_RESPONSE,
      NATIVE_SCHEMA_RESPONSE,
      { status: 200, body: directDcrBody("immutable-1") },
      { status: 200, body: directDcrBody("immutable-1") },
    );
    const cribl3 = new FakeCriblClient({ outputsList: [] });
    scriptCriblHappyPath(cribl3, 1);
    const run3 = await onboardBatch(
      { azure: azure3, cribl: cribl3, jobs },
      baseInput(fakeClock().pacing),
    );
    expect(run3.status).toBe("succeeded");
    expect(
      run3.steps.find((s) => s.name === "table:SecurityEvent")!.status,
    ).toBe("succeeded");
    expect(azure3.calls.length).toBe(5);
  });
});
