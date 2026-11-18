import { describe, expect, it } from "vitest";
import {
  TTL_ROLE_DEFINITION_ID,
  TTL_ROLE_NAME,
  LAB_LOGIC_APP_API_VERSION,
  LAB_RESOURCE_GROUPS_API_VERSION,
  buildResourceGroupGetRequest,
  buildResourceGroupPatchTagsRequest,
  buildResourceGroupPutRequest,
  buildRgTtlRoleAssignmentRequest,
  buildTtlLogicAppPutRequest,
  buildTtlWorkflowDefinition,
  labFoundationTags,
  labTtlInstants,
  ttlLogicAppName,
} from "./lab-foundation";

const SUB = "11111111-2222-3333-4444-555555555555";
const RG = "rg-lab-SentinelLab";
const NOW = "2026-07-16T12:00:00.000Z";
const TTL = { hours: 72, warningHours: 24, userEmail: "user@example.com" };

describe("labTtlInstants", () => {
  it("computes expiration and warning in REAL UTC (legacy local-time bug fixed)", () => {
    const instants = labTtlInstants(TTL, NOW);
    expect(instants.expirationTime).toBe("2026-07-19T12:00:00Z");
    expect(instants.warningTime).toBe("2026-07-18T12:00:00Z");
  });
});

describe("labFoundationTags", () => {
  it("carries the legacy tag names verbatim - the Logic App reads them", () => {
    const tags = labFoundationTags(TTL, NOW);
    expect(tags["TTL_Enabled"]).toBe("true");
    expect(tags["TTL_ExpirationTime"]).toBe("2026-07-19T12:00:00Z");
    expect(tags["TTL_WarningTime"]).toBe("2026-07-18T12:00:00Z");
    expect(tags["TTL_UserEmail"]).toBe("user@example.com");
    expect(tags["TTL_Hours"]).toBe("72");
    expect(tags["Environment"]).toBe("Lab");
    expect(tags["CreatedDate"]).toBe("2026-07-16T12:00:00Z");
  });

  it("always includes TTL tags - the in-app mandatory-TTL policy", () => {
    const tags = labFoundationTags(TTL, NOW);
    expect(Object.keys(tags)).toContain("TTL_Enabled");
    expect(Object.keys(tags)).toContain("TTL_ExpirationTime");
  });
});

describe("resource group requests", () => {
  it("GET/PUT/PATCH target the resource group path with one api-version", () => {
    const get = buildResourceGroupGetRequest(SUB, RG);
    expect(get.method).toBe("GET");
    expect(get.path).toBe(`/subscriptions/${SUB}/resourceGroups/${RG}`);
    expect(get.apiVersion).toBe(LAB_RESOURCE_GROUPS_API_VERSION);

    const put = buildResourceGroupPutRequest(SUB, RG, "eastus", { a: "b" });
    expect(put.method).toBe("PUT");
    expect(put.body).toEqual({ location: "eastus", tags: { a: "b" } });

    const patch = buildResourceGroupPatchTagsRequest(SUB, RG, { a: "b" });
    expect(patch.method).toBe("PATCH");
    expect(patch.body).toEqual({ tags: { a: "b" } });
  });
});

describe("buildTtlWorkflowDefinition", () => {
  const definition = buildTtlWorkflowDefinition(SUB, RG) as Record<string, any>;

  it("recurs hourly (legacy watchdog cadence)", () => {
    expect(definition.triggers.Recurrence.recurrence).toEqual({
      frequency: "Hour",
      interval: 1,
    });
  });

  it("reads and deletes its OWN resource group via managed identity", () => {
    const getUri = definition.actions.Get_Resource_Group.inputs.uri as string;
    expect(getUri).toContain(`/subscriptions/${SUB}/resourceGroups/${RG}`);
    expect(definition.actions.Get_Resource_Group.inputs.authentication.type).toBe(
      "ManagedServiceIdentity",
    );
    const deleteAction =
      definition.actions.Check_TTL_Enabled.actions.Check_Expiration.actions
        .Delete_Resource_Group;
    expect(deleteAction.inputs.method).toBe("DELETE");
    expect(deleteAction.inputs.uri).toBe(getUri);
  });

  it("gates deletion on TTL_Enabled and a past TTL_ExpirationTime (verbatim expressions)", () => {
    const enabledCheck = definition.actions.Check_TTL_Enabled.expression.and[0];
    expect(enabledCheck.equals).toEqual([
      "@body('Parse_Resource_Group')?['tags']?['TTL_Enabled']",
      "true",
    ]);
    const expiryCheck =
      definition.actions.Check_TTL_Enabled.actions.Check_Expiration.expression.and[0];
    expect(expiryCheck.less).toEqual([
      "@body('Parse_Resource_Group')?['tags']?['TTL_ExpirationTime']",
      "@utcNow()",
    ]);
  });
});

describe("buildTtlLogicAppPutRequest", () => {
  const request = buildTtlLogicAppPutRequest(SUB, RG, "eastus", "cribllab");

  it("PUTs the legacy-named workflow with a system-assigned identity", () => {
    expect(ttlLogicAppName("cribllab")).toBe("la-ttl-cleanup-cribllab");
    expect(request.method).toBe("PUT");
    expect(request.path).toBe(
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Logic/workflows/la-ttl-cleanup-cribllab`,
    );
    expect(request.apiVersion).toBe(LAB_LOGIC_APP_API_VERSION);
    const body = request.body as Record<string, any>;
    expect(body.identity).toEqual({ type: "SystemAssigned" });
    expect(body.properties.state).toBe("Enabled");
    expect(body.tags.Purpose).toBe("TTL Cleanup");
    expect(body.tags.TargetResourceGroup).toBe(RG);
  });
});

describe("buildRgTtlRoleAssignmentRequest", () => {
  it("PUTs the TTL role for the identity at resource-group scope (AZR-89)", () => {
    const request = buildRgTtlRoleAssignmentRequest({
      subscriptionId: SUB,
      resourceGroup: RG,
      assignmentName: "aaaa-bbbb",
      principalId: "pppp-qqqq",
    });
    expect(request.method).toBe("PUT");
    expect(request.path).toBe(
      `/subscriptions/${SUB}/resourceGroups/${RG}` +
        "/providers/Microsoft.Authorization/roleAssignments/aaaa-bbbb",
    );
    const body = request.body as Record<string, any>;
    expect(body.properties.roleDefinitionId).toBe(
      `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/641177b8-a67a-45b9-a033-47bc880bb21e`,
    );
    expect(body.properties.principalId).toBe("pppp-qqqq");
    expect(body.properties.principalType).toBe("ServicePrincipal");
  });

  it("names Managed Application Contributor Role by its built-in GUID, never Contributor (AZR-89)", () => {
    // Learn built-in-roles/management-and-governance: the GUID and name of
    // the least built-in role that can read and delete a resource group.
    expect(TTL_ROLE_DEFINITION_ID).toBe("641177b8-a67a-45b9-a033-47bc880bb21e");
    expect(TTL_ROLE_NAME).toBe("Managed Application Contributor Role");
    expect(TTL_ROLE_DEFINITION_ID).not.toBe("b24988ac-6180-42a0-ab88-20f7382dd24c");
  });
});
