import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { checkLabPermissions } from "./check-lab-permissions";
import { labDeploymentConfig } from "../../domain/labs";

const SUB = "11111111-2222-3333-4444-555555555555";
const RA_WRITE = "Microsoft.Authorization/roleAssignments/write";

const ALL = { status: 200, body: { value: [{ actions: ["*"], notActions: [] }] } };
const REGISTERED = { status: 200, body: { registrationState: "Registered" } };
const NOT_REGISTERED = { status: 200, body: { registrationState: "NotRegistered" } };
const NOTHING = { status: 200, body: { value: [{ actions: [], notActions: [] }] } };

describe("checkLabPermissions", () => {
  it("evaluates the profile's actions at the subscription in create-new mode", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: { value: [{ actions: ["*"], notActions: [] }] },
    });

    const outcome = await checkLabPermissions(azure, {
      subscriptionId: SUB,
      resourceGroupName: "rg-lab-SentinelLab",
      rgMode: "create-new",
      flags: labDeploymentConfig("SentinelLab", "public"),
    });

    expect(azure.calls[0].path).toBe(
      `/subscriptions/${SUB}/providers/Microsoft.Authorization/permissions`,
    );
    expect(outcome.scope).toBe(`/subscriptions/${SUB}`);
    expect(outcome.checks.every((c) => c.granted)).toBe(true);
    expect(outcome.roleAssignmentGrant.kind).toBe("unconditional");
    expect(outcome.roleConditionRemediation).toBeUndefined();
  });

  it("flags the Contributor-blocking ABAC condition and downgrades the check row", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          // Contributor-like grant for the resource writes (denies auth writes).
          { actions: ["*"], notActions: ["Microsoft.Authorization/*/Write"] },
          // Constrained RBAC Administrator allowing ONLY Monitoring Metrics
          // Publisher - the live AuthorizationFailed("ABAC condition") case.
          {
            actions: [RA_WRITE],
            notActions: [],
            condition:
              "(@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] " +
              "ForAnyOfAnyValues:GuidEquals {3913510d-42f4-4e42-8a64-420c390055eb})",
          },
        ],
      },
    });

    const outcome = await checkLabPermissions(azure, {
      subscriptionId: SUB,
      resourceGroupName: "rg-lab-FlowLogLab",
      rgMode: "create-new",
      flags: labDeploymentConfig("FlowLogLab", "public"),
    });

    expect(outcome.roleAssignmentGrant.kind).toBe("conditional-blocks-ttl-role");
    expect(outcome.roleConditionRemediation).toContain("Contributor");
    const row = outcome.checks.find((c) => c.action === RA_WRITE);
    expect(row?.granted).toBe(false);
    // The plain resource writes still read as granted.
    expect(
      outcome.checks.find((c) => c.action === "Microsoft.Storage/storageAccounts/write")
        ?.granted,
    ).toBe(true);
  });

  it("bring-your-own queries the RG scope, falling back to the subscription with a note", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} }, // RG-scope permissions - group missing
      { status: 200, body: { value: [{ actions: ["*"], notActions: [] }] } },
    );

    const outcome = await checkLabPermissions(azure, {
      subscriptionId: SUB,
      resourceGroupName: "rg-preapproved",
      rgMode: "bring-your-own",
      flags: labDeploymentConfig("SentinelLab", "public"),
    });

    expect(azure.calls[0].path).toContain("/resourceGroups/rg-preapproved/");
    expect(outcome.scope).toBe(`/subscriptions/${SUB}`);
    expect(outcome.notes[0]).toContain("evaluated at the subscription instead");
  });

  it("throws on a failed permissions fetch (rendered as unavailable, not denied)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 500, body: { error: { code: "Boom" } } });
    await expect(
      checkLabPermissions(azure, {
        subscriptionId: SUB,
        resourceGroupName: "rg-x",
        rgMode: "create-new",
        flags: labDeploymentConfig("SentinelLab", "public"),
      }),
    ).rejects.toThrow("fetch RBAC permissions");
  });
});

describe("checkLabPermissions - bring-your-own scopes outside the lab group (AZR-81)", () => {
  const RG = "rg-preapproved";
  const run = (azure: FakeAzureManagement) =>
    checkLabPermissions(azure, {
      subscriptionId: SUB,
      resourceGroupName: RG,
      rgMode: "bring-your-own",
      flags: labDeploymentConfig("CompleteLab", "public"),
    });

  it("reads each scope once and evaluates each row at its own scope", async () => {
    const azure = new FakeAzureManagement();
    // Lab group: everything. Subscription and NetworkWatcherRG: nothing. The
    // provider is not registered, so the register row is a real gap.
    azure.respondWith(ALL, NOTHING, NOTHING, NOT_REGISTERED);
    const outcome = await run(azure);
    expect(azure.calls.map((c) => c.path)).toEqual([
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Authorization/permissions`,
      `/subscriptions/${SUB}/providers/Microsoft.Authorization/permissions`,
      `/subscriptions/${SUB}/resourceGroups/NetworkWatcherRG/providers/Microsoft.Authorization/permissions`,
      `/subscriptions/${SUB}/providers/Microsoft.EventGrid`,
    ]);
    const granted = (action: string) => outcome.checks.find((c) => c.action === action)?.granted;
    expect(granted("Microsoft.EventGrid/register/action")).toBe(false);
    expect(granted("Microsoft.Network/networkWatchers/read")).toBe(false);
    expect(granted("Microsoft.Network/networkWatchers/flowLogs/write")).toBe(false);
    // The lab-group rows still pass on the lab group's own answer.
    expect(granted("Microsoft.Network/networkWatchers/write")).toBe(true);
    expect(outcome.unmeasured).toEqual([]);
  });

  it("reports an unreadable scope as unknown, never as denied", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ALL, { status: 403, body: {} }, { status: 403, body: {} }, { status: 403, body: {} });
    const outcome = await run(azure);
    for (const action of [
      "Microsoft.EventGrid/register/action",
      "Microsoft.Network/networkWatchers/read",
      "Microsoft.Network/networkWatchers/flowLogs/write",
    ]) {
      expect(outcome.checks.some((c) => c.action === action), action).toBe(false);
    }
    expect(outcome.unmeasured.map((u) => [u.action, u.scope, u.reason])).toEqual([
      ["Microsoft.EventGrid/register/action", `/subscriptions/${SUB}`, "the provider's registration could not be read (HTTP 403)"],
      ["Microsoft.Network/networkWatchers/read", `/subscriptions/${SUB}/resourceGroups/NetworkWatcherRG`, "permissions at this scope could not be read (HTTP 403)"],
      ["Microsoft.Network/networkWatchers/flowLogs/write", `/subscriptions/${SUB}/resourceGroups/NetworkWatcherRG`, "permissions at this scope could not be read (HTTP 403)"],
    ]);
  });

  it("reuses the subscription answer when the lab group fell back to it", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 404, body: {} }, ALL, NOTHING);
    const outcome = await run(azure);
    // RG (404), subscription fallback, NetworkWatcherRG - no second subscription read.
    expect(azure.calls).toHaveLength(3);
    expect(outcome.checks.find((c) => c.action === "Microsoft.EventGrid/register/action")?.granted).toBe(true);
  });
});

describe("checkLabPermissions - the Event Grid registration row reads the provider (AZR-81 review)", () => {
  const register = "Microsoft.EventGrid/register/action";
  const run = (azure: FakeAzureManagement) =>
    checkLabPermissions(azure, {
      subscriptionId: SUB,
      resourceGroupName: "rg-preapproved",
      rgMode: "bring-your-own",
      flags: labDeploymentConfig("CompleteLab", "public"),
    });

  it("is satisfied when an admin already registered the provider, though the app cannot register", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ALL, NOTHING, ALL, REGISTERED);
    const outcome = await run(azure);
    expect(outcome.checks.find((c) => c.action === register)?.granted).toBe(true);
    expect(outcome.unmeasured).toEqual([]);
  });

  it("is missing when the provider is not registered and the app cannot register it", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ALL, NOTHING, ALL, NOT_REGISTERED);
    const outcome = await run(azure);
    expect(outcome.checks.find((c) => c.action === register)?.granted).toBe(false);
  });

  it("is unknown when the provider's state cannot be read", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ALL, NOTHING, ALL, { status: 403, body: {} });
    const outcome = await run(azure);
    expect(outcome.checks.some((c) => c.action === register)).toBe(false);
    expect(outcome.unmeasured.map((u) => [u.action, u.reason])).toEqual([
      [register, "the provider's registration could not be read (HTTP 403)"],
    ]);
  });

  it("does not read the provider when the app holds the register right", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ALL, ALL, ALL);
    const outcome = await run(azure);
    expect(azure.calls).toHaveLength(3);
    expect(outcome.checks.find((c) => c.action === register)?.granted).toBe(true);
  });

  it("marks the NetworkWatcherRG rows feature, as the role plan asks for them", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ALL, ALL, NOTHING);
    const outcome = await run(azure);
    for (const action of ["Microsoft.Network/networkWatchers/read", "Microsoft.Network/networkWatchers/flowLogs/write"]) {
      expect(outcome.checks.find((c) => c.action === action)?.necessity, action).toBe("feature");
    }
  });
});
