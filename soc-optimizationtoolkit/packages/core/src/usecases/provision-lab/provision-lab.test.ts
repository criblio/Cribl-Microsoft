import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeJobStore } from "../../testing/fake-job-store";
import {
  PROVISION_LAB_JOB_KIND,
  manualLabRoleCommand,
  provisionLabFoundation,
  type ProvisionLabInput,
} from "./provision-lab";

const SUB = "11111111-2222-3333-4444-555555555555";
const RG = "rg-lab-SentinelLab";
const NOW = "2026-07-16T12:00:00.000Z";

function input(overrides?: Partial<ProvisionLabInput>): ProvisionLabInput {
  return {
    subscriptionId: SUB,
    resourceGroupName: RG,
    location: "eastus",
    baseObjectName: "cribllab",
    rgMode: "create-new",
    ttl: { hours: 72, warningHours: 24, userEmail: "user@example.com" },
    nowIso: NOW,
    mintAssignmentName: () => "guid-1",
    retry: { maxAttempts: 3, delayMs: 1 },
    ...overrides,
  };
}

const LOGIC_APP_OK = {
  status: 200,
  body: { identity: { principalId: "principal-1" } },
};

describe("provisionLabFoundation - create-new happy path", () => {
  it("creates the RG with TTL tags, the watchdog, and the role grant", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} }, // GET RG - missing
      { status: 201, body: {} }, // PUT RG
      { status: 404, body: {} }, // GET Logic App - missing
      { status: 201, body: { identity: { principalId: "principal-1" } } }, // PUT Logic App
      { status: 201, body: {} }, // PUT role assignment
    );
    const jobs = new FakeJobStore();

    const result = await provisionLabFoundation({ azure, jobs }, input());

    expect(result.ok).toBe(true);
    expect(result.resourceGroupCreated).toBe(true);
    expect(result.logicAppCreated).toBe(true);
    expect(result.principalId).toBe("principal-1");
    expect(result.roleAssigned).toBe(true);
    expect(result.roleAlreadyAssigned).toBe(false);
    expect(result.ttlExpiresAt).toBe("2026-07-19T12:00:00Z");

    // The RG PUT carries the mandatory TTL tag set.
    const rgPut = azure.calls[1];
    expect(rgPut.method).toBe("PUT");
    const tags = (rgPut.body as { tags: Record<string, string> }).tags;
    expect(tags["TTL_Enabled"]).toBe("true");
    expect(tags["TTL_ExpirationTime"]).toBe("2026-07-19T12:00:00Z");

    // The job record finished 'succeeded' with the result embedded.
    const records = await jobs.list(PROVISION_LAB_JOB_KIND);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("succeeded");
    expect(records[0].steps.map((s) => s.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect((records[0].result as { ok: boolean }).ok).toBe(true);
  });
});

describe("provisionLabFoundation - existing resource group", () => {
  it("merges existing tags with the TTL tags and PATCHes (TTL extended)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: { Owner: "team-x", TTL_Hours: "24" } } }, // GET RG
      { status: 200, body: {} }, // PATCH tags
      LOGIC_APP_OK, // GET Logic App - exists
      { status: 201, body: {} }, // PUT role assignment
    );

    const result = await provisionLabFoundation({ azure }, input());

    expect(result.ok).toBe(true);
    expect(result.resourceGroupCreated).toBe(false);
    expect(result.logicAppCreated).toBe(false);
    const patch = azure.calls[1];
    expect(patch.method).toBe("PATCH");
    const tags = (patch.body as { tags: Record<string, string> }).tags;
    expect(tags["Owner"]).toBe("team-x"); // preserved
    expect(tags["TTL_Hours"]).toBe("72"); // foundation wins
    expect(tags["TTL_ExpirationTime"]).toBe("2026-07-19T12:00:00Z");
  });
});

describe("provisionLabFoundation - bring-your-own resource group", () => {
  it("fails cleanly when the group does not exist (never silently creates)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 404, body: {} }); // GET RG - missing
    const jobs = new FakeJobStore();

    const result = await provisionLabFoundation(
      { azure, jobs },
      input({ rgMode: "bring-your-own" }),
    );

    expect(result.ok).toBe(false);
    expect(azure.calls).toHaveLength(1); // no PUT was attempted
    const record = (await jobs.list())[0];
    expect(record.status).toBe("failed");
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[1].status).toBe("skipped");
    expect(record.steps[2].status).toBe("skipped");
    expect(record.steps[1].detail).toBe("prerequisite-failed");
  });

  it("surfaces the manual az command when the role grant is denied (403)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: {} } }, // GET RG
      { status: 200, body: {} }, // PATCH tags
      LOGIC_APP_OK, // GET Logic App
      {
        status: 403,
        body: { error: { code: "AuthorizationFailed", message: "denied" } },
      }, // PUT role assignment
    );

    const result = await provisionLabFoundation(
      { azure },
      input({ rgMode: "bring-your-own" }),
    );

    expect(result.ok).toBe(false);
    expect(result.principalId).toBe("principal-1");
    expect(result.manualRoleAssignmentCommand).toBe(
      manualLabRoleCommand(SUB, RG, "principal-1"),
    );
    expect(result.manualRoleAssignmentCommand).toContain("--assignee-object-id principal-1");
  });
});

describe("provisionLabFoundation - role assignment semantics", () => {
  it("treats 409 RoleAssignmentExists as success (idempotent re-run)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      {
        status: 409,
        body: { error: { code: "RoleAssignmentExists", message: "exists" } },
      },
    );

    const result = await provisionLabFoundation({ azure }, input());
    expect(result.ok).toBe(true);
    expect(result.roleAssigned).toBe(true);
    expect(result.roleAlreadyAssigned).toBe(true);
  });

  it("retries PrincipalNotFound within the attempt budget", async () => {
    const azure = new FakeAzureManagement();
    const sleeps: number[] = [];
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      { status: 400, body: { error: { code: "PrincipalNotFound", message: "lag" } } },
      { status: 201, body: {} },
    );

    const result = await provisionLabFoundation(
      { azure },
      input({
        retry: {
          maxAttempts: 3,
          delayMs: 10,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([10]);
  });

  it("fails after the attempt budget is exhausted", async () => {
    const azure = new FakeAzureManagement();
    const pnf = {
      status: 400,
      body: { error: { code: "PrincipalNotFound", message: "lag" } },
    };
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      pnf,
      pnf,
      pnf,
    );

    const result = await provisionLabFoundation(
      { azure },
      input({ retry: { maxAttempts: 3, delayMs: 1 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.manualRoleAssignmentCommand).toBeDefined();
  });
});

describe("provisionLabFoundation - identity readback", () => {
  it("re-GETs the Logic App until the identity principal appears", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} }, // GET RG
      { status: 201, body: {} }, // PUT RG
      { status: 404, body: {} }, // GET Logic App
      { status: 201, body: {} }, // PUT Logic App - identity not yet populated
      { status: 200, body: {} }, // re-GET 1 - still empty
      LOGIC_APP_OK, // re-GET 2 - identity present
      { status: 201, body: {} }, // PUT role assignment
    );

    const result = await provisionLabFoundation({ azure }, input());
    expect(result.ok).toBe(true);
    expect(result.principalId).toBe("principal-1");
  });

  it("fails honestly when the identity never appears", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} }, // PUT - no identity
      { status: 200, body: {} }, // re-GET 1
      { status: 200, body: {} }, // re-GET 2
    );

    const result = await provisionLabFoundation({ azure }, input());
    expect(result.ok).toBe(false);
    expect(result.principalId).toBe("");
  });
});

describe("provisionLabFoundation - progress reporting", () => {
  it("fires onProgress for every step transition", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      { status: 201, body: {} },
    );
    const seen: string[] = [];

    await provisionLabFoundation(
      { azure },
      input({
        onProgress: (step) => {
          seen.push(`${step.name}:${step.status}`);
        },
      }),
    );

    expect(seen).toEqual([
      "resource-group:running",
      "resource-group:succeeded",
      "ttl-logic-app:running",
      "ttl-logic-app:succeeded",
      "ttl-role-assignment:running",
      "ttl-role-assignment:succeeded",
    ]);
  });
});
