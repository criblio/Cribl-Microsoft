import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { checkLabPermissions } from "./check-lab-permissions";
import { labDeploymentConfig } from "../../domain/labs";

const SUB = "11111111-2222-3333-4444-555555555555";
const RA_WRITE = "Microsoft.Authorization/roleAssignments/write";

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

    expect(outcome.roleAssignmentGrant.kind).toBe("conditional-blocks-contributor");
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
