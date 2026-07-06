import { describe, expect, it, vi } from "vitest";

import {
  assignDcrRoles,
  assignDcrRoleStepName,
  buildRoleAssignmentRequest,
  matchDcrsToTables,
  ASSIGN_DCR_ROLE_JOB_KIND,
  DEFAULT_PRINCIPAL_NOT_FOUND_ATTEMPTS,
  MONITORING_METRICS_PUBLISHER_ROLE_ID,
  PRINCIPAL_NOT_FOUND_ERROR_CODE,
  ROLE_ASSIGNMENT_EXISTS_ERROR_CODE,
  ROLE_ASSIGNMENTS_API_VERSION,
} from "./assign-dcr-role";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeJobStore } from "../../testing/fake-job-store";
import type { PortHttpResponse } from "../../ports/http";

const SUB = "11111111-1111-1111-1111-111111111111";
const RG = "rg-sentinel";
const PRINCIPAL = "22222222-2222-2222-2222-222222222222";

/** Build the full ARM resource id of a DCR by name (RG-scoped). */
function dcrId(name: string): string {
  return (
    `/subscriptions/${SUB}/resourceGroups/${RG}` +
    `/providers/Microsoft.Insights/dataCollectionRules/${name}`
  );
}

/** A deterministic GUID minter for tests (shell-side in production). */
function guidMinter(): () => string {
  let n = 0;
  return () => {
    n++;
    return `00000000-0000-0000-0000-00000000000${n}`;
  };
}

/** An ARM error response with a given code. */
function armError(status: number, code: string): PortHttpResponse {
  return { status, body: { error: { code, message: `${code} occurred` } } };
}

describe("MONITORING_METRICS_PUBLISHER_ROLE_ID constant", () => {
  it("is the verbatim legacy GUID", () => {
    expect(MONITORING_METRICS_PUBLISHER_ROLE_ID).toBe(
      "3913510d-42f4-4e42-8a64-420c390055eb",
    );
  });
});

describe("buildRoleAssignmentRequest", () => {
  it("is a pure PUT scoped to the DCR with the MMP role and ServicePrincipal type", () => {
    const request = buildRoleAssignmentRequest({
      dcrResourceId: dcrId("dcr-SecurityEvent-eastus"),
      assignmentName: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      principalId: PRINCIPAL,
    });

    expect(request.method).toBe("PUT");
    expect(request.apiVersion).toBe(ROLE_ASSIGNMENTS_API_VERSION);
    expect(request.path).toBe(
      `${dcrId("dcr-SecurityEvent-eastus")}` +
        "/providers/Microsoft.Authorization/roleAssignments/" +
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(request.body.properties).toEqual({
      roleDefinitionId:
        `/subscriptions/${SUB}` +
        `/providers/Microsoft.Authorization/roleDefinitions/${MONITORING_METRICS_PUBLISHER_ROLE_ID}`,
      principalId: PRINCIPAL,
      principalType: "ServicePrincipal",
    });
  });

  it("honors an explicit role definition GUID and strips a trailing slash on the scope", () => {
    const request = buildRoleAssignmentRequest({
      dcrResourceId: dcrId("dcr-Syslog-eastus") + "/",
      assignmentName: "name-1",
      principalId: PRINCIPAL,
      roleDefinitionId: "ffffffff-0000-0000-0000-000000000000",
    });
    expect(request.path).toBe(
      `${dcrId("dcr-Syslog-eastus")}` +
        "/providers/Microsoft.Authorization/roleAssignments/name-1",
    );
    expect(request.body.properties.roleDefinitionId).toContain(
      "ffffffff-0000-0000-0000-000000000000",
    );
  });
});

describe("assignDcrRoles - idempotency (409 RoleAssignmentExists is success)", () => {
  it("treats HTTP 409 RoleAssignmentExists as an already-assigned success, not a failure", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(armError(409, ROLE_ASSIGNMENT_EXISTS_ERROR_CODE));

    const outcome = await assignDcrRoles(
      { azure },
      {
        principalId: PRINCIPAL,
        targets: [{ dcrResourceId: dcrId("dcr-SecurityEvent-eastus"), table: "SecurityEvent" }],
        mintAssignmentName: guidMinter(),
      },
    );

    expect(outcome.assigned).toBe(1);
    expect(outcome.total).toBe(1);
    expect(outcome.results[0].success).toBe(true);
    expect(outcome.results[0].alreadyAssigned).toBe(true);
    expect(outcome.results[0].error).toBeUndefined();
    // Exactly one PUT - no pre-check GET, no retry.
    expect(azure.calls).toHaveLength(1);
    expect(azure.calls[0].method).toBe("PUT");
  });

  it("does NOT treat a 409 with a different error code as success", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(armError(409, "AnotherConflict"));

    const outcome = await assignDcrRoles(
      { azure },
      {
        principalId: PRINCIPAL,
        targets: [{ dcrResourceId: dcrId("dcr-X-eastus") }],
        mintAssignmentName: guidMinter(),
      },
    );
    expect(outcome.assigned).toBe(0);
    expect(outcome.results[0].success).toBe(false);
    expect(outcome.results[0].error).toContain("HTTP 409");
  });

  it("counts a fresh 201 as a (not-already) assignment", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 201, body: { id: "ra-1" } });
    const outcome = await assignDcrRoles(
      { azure },
      {
        principalId: PRINCIPAL,
        targets: [{ dcrResourceId: dcrId("dcr-Y-eastus") }],
        mintAssignmentName: guidMinter(),
      },
    );
    expect(outcome.assigned).toBe(1);
    expect(outcome.results[0].alreadyAssigned).toBe(false);
  });
});

describe("assignDcrRoles - PrincipalNotFound retry (Graph replication lag)", () => {
  it("retries a PrincipalNotFound and succeeds when it clears within the budget", async () => {
    const azure = new FakeAzureManagement();
    // Two lag failures, then success on the third attempt.
    azure.respondWith(
      armError(400, PRINCIPAL_NOT_FOUND_ERROR_CODE),
      armError(400, PRINCIPAL_NOT_FOUND_ERROR_CODE),
      { status: 201, body: { id: "ra-ok" } },
    );
    const sleep = vi.fn(async () => {});

    const outcome = await assignDcrRoles(
      { azure },
      {
        principalId: PRINCIPAL,
        targets: [{ dcrResourceId: dcrId("dcr-SecurityEvent-eastus"), table: "SecurityEvent" }],
        mintAssignmentName: guidMinter(),
        retry: { maxAttempts: 5, delayMs: 1000, sleep },
      },
    );

    expect(outcome.assigned).toBe(1);
    expect(outcome.results[0].success).toBe(true);
    expect(azure.calls).toHaveLength(3);
    // Slept between the two failed attempts (not after the final success).
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("reuses the SAME shell-minted assignment name across a target's retries (idempotent PUT)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      armError(400, PRINCIPAL_NOT_FOUND_ERROR_CODE),
      { status: 201, body: {} },
    );
    await assignDcrRoles(
      { azure },
      {
        principalId: PRINCIPAL,
        targets: [{ dcrResourceId: dcrId("dcr-Z-eastus") }],
        mintAssignmentName: guidMinter(),
        retry: { maxAttempts: 3, sleep: async () => {} },
      },
    );
    expect(azure.calls).toHaveLength(2);
    expect(azure.calls[0].path).toBe(azure.calls[1].path);
  });

  it("fails cleanly when PrincipalNotFound persists past the attempt budget", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      armError(400, PRINCIPAL_NOT_FOUND_ERROR_CODE),
      armError(400, PRINCIPAL_NOT_FOUND_ERROR_CODE),
      armError(400, PRINCIPAL_NOT_FOUND_ERROR_CODE),
    );
    const sleep = vi.fn(async () => {});

    const outcome = await assignDcrRoles(
      { azure },
      {
        principalId: PRINCIPAL,
        targets: [{ dcrResourceId: dcrId("dcr-SecurityEvent-eastus"), table: "SecurityEvent" }],
        mintAssignmentName: guidMinter(),
        retry: { maxAttempts: 3, delayMs: 500, sleep },
      },
    );

    expect(outcome.assigned).toBe(0);
    expect(outcome.total).toBe(1);
    expect(outcome.results[0].success).toBe(false);
    expect(outcome.results[0].error).toContain("not found after 3 attempt");
    // Three PUT attempts, two sleeps (never after the final, exhausted try).
    expect(azure.calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry when maxAttempts is 1 (retry disabled)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(armError(400, PRINCIPAL_NOT_FOUND_ERROR_CODE));
    const sleep = vi.fn(async () => {});
    const outcome = await assignDcrRoles(
      { azure },
      {
        principalId: PRINCIPAL,
        targets: [{ dcrResourceId: dcrId("dcr-Q-eastus") }],
        mintAssignmentName: guidMinter(),
        retry: { maxAttempts: 1, sleep },
      },
    );
    expect(outcome.results[0].success).toBe(false);
    expect(azure.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("defaults the attempt budget to DEFAULT_PRINCIPAL_NOT_FOUND_ATTEMPTS", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...Array.from({ length: DEFAULT_PRINCIPAL_NOT_FOUND_ATTEMPTS }, () =>
        armError(400, PRINCIPAL_NOT_FOUND_ERROR_CODE),
      ),
    );
    const outcome = await assignDcrRoles(
      { azure },
      {
        principalId: PRINCIPAL,
        targets: [{ dcrResourceId: dcrId("dcr-R-eastus") }],
        mintAssignmentName: guidMinter(),
        // No sleep hook: retries fire immediately (default no-op).
      },
    );
    expect(outcome.results[0].success).toBe(false);
    expect(azure.calls).toHaveLength(DEFAULT_PRINCIPAL_NOT_FOUND_ATTEMPTS);
  });
});

describe("assignDcrRoles - result aggregation across a DCR set", () => {
  it("aggregates {results, assigned, total} with per-DCR isolation", async () => {
    const azure = new FakeAzureManagement();
    // DCR1 fresh assign; DCR2 already assigned (409); DCR3 hard failure.
    azure.respondWith(
      { status: 201, body: {} },
      armError(409, ROLE_ASSIGNMENT_EXISTS_ERROR_CODE),
      armError(403, "AuthorizationFailed"),
    );

    const outcome = await assignDcrRoles(
      { azure },
      {
        principalId: PRINCIPAL,
        targets: [
          { dcrResourceId: dcrId("dcr-A-eastus"), table: "A" },
          { dcrResourceId: dcrId("dcr-B-eastus"), table: "B" },
          { dcrResourceId: dcrId("dcr-C-eastus"), table: "C" },
        ],
        mintAssignmentName: guidMinter(),
      },
    );

    expect(outcome.total).toBe(3);
    expect(outcome.assigned).toBe(2);
    expect(outcome.results.map((r) => r.success)).toEqual([true, true, false]);
    expect(outcome.results.map((r) => r.dcr)).toEqual(["A", "B", "C"]);
    // A third failure never stopped the earlier two (isolation).
    expect(azure.calls).toHaveLength(3);
    expect(outcome.results[2].error).toContain("HTTP 403");
  });

  it("records a job with one step per DCR (onboard-batch step conventions)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 201, body: {} },
      armError(403, "AuthorizationFailed"),
    );
    const jobs = new FakeJobStore();
    const progress: string[] = [];

    const outcome = await assignDcrRoles(
      { azure, jobs },
      {
        principalId: PRINCIPAL,
        targets: [
          { dcrResourceId: dcrId("dcr-A-eastus"), table: "A" },
          { dcrResourceId: dcrId("dcr-B-eastus"), table: "B" },
        ],
        mintAssignmentName: guidMinter(),
        onProgress: (step) => progress.push(`${step.name}:${step.status}`),
      },
    );

    const records = await jobs.list(ASSIGN_DCR_ROLE_JOB_KIND);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.status).toBe("failed");
    expect(record.error).toContain("1 of 2");
    expect(record.steps.map((s) => s.name)).toEqual([
      assignDcrRoleStepName("A"),
      assignDcrRoleStepName("B"),
    ]);
    expect(record.steps.map((s) => s.status)).toEqual(["succeeded", "failed"]);
    expect(record.result).toEqual(outcome);
    // onProgress fired running->terminal for each step.
    expect(progress).toContain(`${assignDcrRoleStepName("A")}:running`);
    expect(progress).toContain(`${assignDcrRoleStepName("A")}:succeeded`);
    expect(progress).toContain(`${assignDcrRoleStepName("B")}:failed`);
  });

  it("marks the job succeeded when every DCR is assigned", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 201, body: {} }, { status: 200, body: {} });
    const jobs = new FakeJobStore();
    await assignDcrRoles(
      { azure, jobs },
      {
        principalId: PRINCIPAL,
        targets: [
          { dcrResourceId: dcrId("dcr-A-eastus") },
          { dcrResourceId: dcrId("dcr-B-eastus") },
        ],
        mintAssignmentName: guidMinter(),
      },
    );
    const record = (await jobs.list(ASSIGN_DCR_ROLE_JOB_KIND))[0];
    expect(record.status).toBe("succeeded");
    expect(record.error).toBeUndefined();
  });

  it("handles an empty target set as a vacuous success", async () => {
    const azure = new FakeAzureManagement();
    const outcome = await assignDcrRoles(
      { azure },
      { principalId: PRINCIPAL, targets: [], mintAssignmentName: guidMinter() },
    );
    expect(outcome).toEqual({ results: [], assigned: 0, total: 0 });
    expect(azure.calls).toHaveLength(0);
  });
});

describe("matchDcrsToTables - dcr-naming-based matching (no substring cross-match)", () => {
  it("maps each table to its EXACT dcr-naming-predicted DCR, never a substring", async () => {
    const azure = new FakeAzureManagement();
    // Both DCRs live in the RG. Cloudflare's predicted name is a strict prefix
    // of CloudflareAudit's - the legacy substring matcher would cross-match.
    azure.respondWith({
      status: 200,
      body: {
        value: [
          { name: "dcr-Cloudflare-eastus", id: dcrId("dcr-Cloudflare-eastus") },
          { name: "dcr-CloudflareAudit-eastus", id: dcrId("dcr-CloudflareAudit-eastus") },
        ],
      },
    });

    const matches = await matchDcrsToTables(
      azure,
      { subscriptionId: SUB, resourceGroup: RG },
      ["Cloudflare_CL", "CloudflareAudit_CL"],
      { mode: "direct", location: "eastus" },
    );

    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({
      table: "Cloudflare_CL",
      dcrName: "dcr-Cloudflare-eastus",
      matched: true,
      dcrResourceId: dcrId("dcr-Cloudflare-eastus"),
    });
    expect(matches[1]).toEqual({
      table: "CloudflareAudit_CL",
      dcrName: "dcr-CloudflareAudit-eastus",
      matched: true,
      dcrResourceId: dcrId("dcr-CloudflareAudit-eastus"),
    });
    // No cross-match: each table resolved to ITS OWN DCR id.
    expect(matches[0].dcrResourceId).not.toBe(matches[1].dcrResourceId);
  });

  it("reports matched:false for a table whose predicted DCR is absent", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          { name: "dcr-CloudflareAudit-eastus", id: dcrId("dcr-CloudflareAudit-eastus") },
        ],
      },
    });
    const matches = await matchDcrsToTables(
      azure,
      { subscriptionId: SUB, resourceGroup: RG },
      ["Cloudflare_CL"],
      { mode: "direct", location: "eastus" },
    );
    // The Audit DCR must NOT satisfy the plain Cloudflare table.
    expect(matches[0]).toEqual({
      table: "Cloudflare_CL",
      dcrName: "dcr-Cloudflare-eastus",
      matched: false,
    });
  });

  it("matches case-insensitively but only on the whole name", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          { name: "DCR-SecurityEvent-EastUS", id: dcrId("DCR-SecurityEvent-EastUS") },
        ],
      },
    });
    const matches = await matchDcrsToTables(
      azure,
      { subscriptionId: SUB, resourceGroup: RG },
      ["SecurityEvent"],
      { mode: "direct", location: "eastus" },
    );
    expect(matches[0].matched).toBe(true);
    expect(matches[0].dcrResourceId).toBe(dcrId("DCR-SecurityEvent-EastUS"));
  });

  it("returns [] and issues no request for an empty table set", async () => {
    const azure = new FakeAzureManagement();
    const matches = await matchDcrsToTables(
      azure,
      { subscriptionId: SUB, resourceGroup: RG },
      [],
      { mode: "direct", location: "eastus" },
    );
    expect(matches).toEqual([]);
    expect(azure.calls).toHaveLength(0);
  });

  it("feeds matched DCRs straight into assignDcrRoles", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [{ name: "dcr-SecurityEvent-eastus", id: dcrId("dcr-SecurityEvent-eastus") }],
      },
    });
    const matches = await matchDcrsToTables(
      azure,
      { subscriptionId: SUB, resourceGroup: RG },
      ["SecurityEvent"],
      { mode: "direct", location: "eastus" },
    );
    const targets = matches
      .filter((m) => m.matched)
      .map((m) => ({ dcrResourceId: m.dcrResourceId as string, table: m.table }));

    azure.respondWith({ status: 201, body: {} });
    const outcome = await assignDcrRoles(
      { azure },
      { principalId: PRINCIPAL, targets, mintAssignmentName: guidMinter() },
    );
    expect(outcome.assigned).toBe(1);
    expect(outcome.results[0].dcr).toBe("SecurityEvent");
  });
});
