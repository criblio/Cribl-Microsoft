import { describe, expect, it } from "vitest";
import {
  CONTRIBUTOR_ROLE_DEFINITION_ID,
  analyzeRoleAssignmentGrant,
  buildLabPermissionsGetRequest,
  labRequiredActions,
  parseLabPermissionsResponse,
} from "./index";
import { labDeploymentConfig } from "./lab-profiles";

describe("labRequiredActions", () => {
  it("always includes the foundation actions; RG create only in create-new mode", () => {
    const flags = labDeploymentConfig("SentinelLab", "public");
    const createNew = labRequiredActions(flags, "create-new").map((a) => a.action);
    expect(createNew).toContain("Microsoft.Resources/subscriptions/resourceGroups/write");
    expect(createNew).toContain("Microsoft.Logic/workflows/write");
    expect(createNew).toContain("Microsoft.Authorization/roleAssignments/write");

    const byo = labRequiredActions(flags, "bring-your-own").map((a) => a.action);
    expect(byo).not.toContain("Microsoft.Resources/subscriptions/resourceGroups/write");
    expect(byo).toContain("Microsoft.Authorization/roleAssignments/write");
  });

  it("derives the action list from the profile's phases (no drift from the deploy)", () => {
    const sentinel = labRequiredActions(
      labDeploymentConfig("SentinelLab", "public"),
      "create-new",
    ).map((a) => a.action);
    expect(sentinel).toContain("Microsoft.OperationalInsights/workspaces/write");
    expect(sentinel).toContain("Microsoft.OperationsManagement/solutions/write");
    expect(sentinel).toContain("Microsoft.Insights/dataCollectionRules/write");
    expect(sentinel).not.toContain("Microsoft.Storage/storageAccounts/write");
    expect(sentinel).not.toContain("Microsoft.Kusto/clusters/write");

    const flowlog = labRequiredActions(
      labDeploymentConfig("FlowLogLab", "public"),
      "create-new",
    ).map((a) => a.action);
    expect(flowlog).toContain("Microsoft.Storage/storageAccounts/write");
    expect(flowlog).toContain("Microsoft.Network/virtualNetworks/write");
    expect(flowlog).toContain("Microsoft.Network/networkWatchers/write");
    expect(flowlog).toContain("Microsoft.Compute/virtualMachines/write");
    expect(flowlog).not.toContain("Microsoft.EventGrid/systemTopics/write");

    const complete = labRequiredActions(
      labDeploymentConfig("CompleteLab", "private"),
      "create-new",
    ).map((a) => a.action);
    expect(complete).toContain("Microsoft.EventGrid/systemTopics/write");
    expect(complete).toContain("Microsoft.Insights/privateLinkScopes/write");
    expect(complete).toContain("Microsoft.Kusto/clusters/write");
    expect(complete).toContain("Microsoft.Network/virtualNetworkGateways/write");
  });
});

describe("buildLabPermissionsGetRequest", () => {
  it("GETs the permissions API at the given scope", () => {
    const request = buildLabPermissionsGetRequest("/subscriptions/sub-1");
    expect(request.method).toBe("GET");
    expect(request.path).toBe(
      "/subscriptions/sub-1/providers/Microsoft.Authorization/permissions",
    );
  });
});

describe("parseLabPermissionsResponse", () => {
  it("parses tolerantly, dropping junk", () => {
    const parsed = parseLabPermissionsResponse({
      value: [
        { actions: ["*"], notActions: [] },
        "junk",
        { actions: 42 },
      ],
    });
    expect(parsed.value).toHaveLength(3);
    expect(parsed.value[0].actions).toEqual(["*"]);
    expect(parsed.value[1].actions).toEqual([]);
    expect(parsed.value[2].actions).toEqual([]);
    expect(parseLabPermissionsResponse(null).value).toEqual([]);
  });
});

describe("analyzeRoleAssignmentGrant (the ABAC condition analysis)", () => {
  const RA_WRITE = "Microsoft.Authorization/roleAssignments/write";

  it("unconditional when any granting element has no condition", () => {
    const analysis = analyzeRoleAssignmentGrant({
      value: [{ actions: ["*"], notActions: [] }],
    });
    expect(analysis.kind).toBe("unconditional");
  });

  it("conditional-allows when the condition names the Contributor GUID", () => {
    const analysis = analyzeRoleAssignmentGrant({
      value: [
        {
          actions: [RA_WRITE],
          notActions: [],
          condition:
            "((!(ActionMatches{'Microsoft.Authorization/roleAssignments:RoleDefinitionId'})) OR " +
            `(@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${CONTRIBUTOR_ROLE_DEFINITION_ID}, 3913510d-42f4-4e42-8a64-420c390055eb}))`,
        },
      ],
    });
    expect(analysis.kind).toBe("conditional-allows-contributor");
  });

  it("conditional-blocks when no condition mentions Contributor - the live 403 case", () => {
    const analysis = analyzeRoleAssignmentGrant({
      value: [
        {
          actions: [RA_WRITE],
          notActions: [],
          condition:
            "(@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] " +
            "ForAnyOfAnyValues:GuidEquals {3913510d-42f4-4e42-8a64-420c390055eb})",
        },
        // An unrelated Contributor element that does NOT grant roleAssignments/write.
        {
          actions: ["*"],
          notActions: ["Microsoft.Authorization/*/Write"],
        },
      ],
    });
    expect(analysis.kind).toBe("conditional-blocks-contributor");
    expect(analysis.conditions).toHaveLength(1);
  });

  it("not-granted when nothing grants the action (Contributor's notActions deny it)", () => {
    const analysis = analyzeRoleAssignmentGrant({
      value: [{ actions: ["*"], notActions: ["Microsoft.Authorization/*/Write"] }],
    });
    expect(analysis.kind).toBe("not-granted");
  });
});
