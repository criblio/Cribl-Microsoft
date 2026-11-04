import { describe, expect, it } from "vitest";
import {
  CONTRIBUTOR_ROLE_DEFINITION_ID,
  analyzeRoleAssignmentGrant,
  buildLabPermissionsGetRequest,
  labRequiredActions,
  parseLabPermissionsResponse,
} from "./index";
import { labDeploymentConfig } from "./lab-profiles";
import { LEAST_PRIVILEGE_OPERATIONS, operationAction } from "../least-privilege";

describe("labRequiredActions", () => {
  it("checks only actions the least-privilege registry names (none restated by hand)", () => {
    // Found by review (AZR-61): some 18 actions here were literals, so a
    // registry correction would have left the lab preflight checking the old
    // string. CompleteLab in private mode turns every component on.
    const registry = new Set(Object.values(LEAST_PRIVILEGE_OPERATIONS).map((op) => op.operation));
    const flags = labDeploymentConfig("CompleteLab", "private");
    for (const mode of ["create-new", "bring-your-own"] as const) {
      const strays = labRequiredActions(flags, mode)
        .map((a) => a.action)
        .filter((action) => !registry.has(action));
      expect(strays, mode).toEqual([]);
    }
  });

  it("always includes the foundation actions; RG create only in create-new mode", () => {
    const flags = labDeploymentConfig("SentinelLab", "public");
    const createNew = labRequiredActions(flags, "create-new").map((a) => a.action);
    expect(createNew).toContain("Microsoft.Resources/subscriptions/resourceGroups/write");
    expect(createNew).toContain("Microsoft.Logic/workflows/write");
    expect(createNew).toContain("Microsoft.Authorization/roleAssignments/write");

    const byo = labRequiredActions(flags, "bring-your-own");
    expect(byo.map((a) => a.action)).toContain("Microsoft.Authorization/roleAssignments/write");
    // RE-PINNED (AZR-61 audit, medium): bring-your-own PATCHes the existing
    // group's TTL tags (foundation-phase.ts), which needs resourceGroups/write
    // too. The preflight used to check it only in create-new mode, so a
    // principal without it passed and then failed at the first step.
    const tag = byo.find((a) => a.action === operationAction("resourceGroup.tag"));
    expect(tag?.label).toBe("Tag the lab resource group with its TTL");
    expect(byo.filter((a) => a.action === operationAction("resourceGroup.tag"))).toHaveLength(1);
  });

  it("checks resourceGroups/write once in create-new mode, where one grant covers create and tag", () => {
    const flags = labDeploymentConfig("SentinelLab", "public");
    const createNew = labRequiredActions(flags, "create-new").map((a) => a.action);
    expect(createNew.filter((a) => a === operationAction("resourceGroup.create"))).toHaveLength(1);
    expect(operationAction("resourceGroup.create")).toBe(operationAction("resourceGroup.tag"));
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

  it("conditional-constrains-principals when the condition pins principal ids", () => {
    const analysis = analyzeRoleAssignmentGrant({
      value: [
        {
          actions: [RA_WRITE],
          notActions: [],
          // "Constrain roles and principals": role list even INCLUDES
          // Contributor, but the pinned principal ids can never match the
          // deploy-time TTL identity - still blocked.
          condition:
            `(@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${CONTRIBUTOR_ROLE_DEFINITION_ID}}) AND ` +
            "(@Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {00000000-0000-0000-0000-000000000001})",
        },
      ],
    });
    expect(analysis.kind).toBe("conditional-constrains-principals");
  });

  it("a principal-TYPE constraint does not count as principal pinning", () => {
    const analysis = analyzeRoleAssignmentGrant({
      value: [
        {
          actions: [RA_WRITE],
          notActions: [],
          condition:
            `(@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${CONTRIBUTOR_ROLE_DEFINITION_ID}}) AND ` +
            "(@Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'})",
        },
      ],
    });
    expect(analysis.kind).toBe("conditional-allows-contributor");
  });

  it("not-granted when nothing grants the action (Contributor's notActions deny it)", () => {
    const analysis = analyzeRoleAssignmentGrant({
      value: [{ actions: ["*"], notActions: ["Microsoft.Authorization/*/Write"] }],
    });
    expect(analysis.kind).toBe("not-granted");
  });
});
