import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { defaultPlanValues, type PlanValues } from "../../domain/onboarding-howto/plan-values";
import type { GraphDirectory, ServicePrincipalRef } from "../../ports/graph-directory";
import {
  RECEIVER_GRANT_ROLE,
  receiverGrantAssignmentName,
  receiverGrantDescription,
} from "../../domain/eventhub-receiver-grant/receiver-grant";
import { applyReceiverGrant, planReceiverGrant } from "./eventhub-receiver-grant";
import type { PlanReceiverGrantInput, ReadyReceiverGrant } from "./eventhub-receiver-grant";

const SUB = "sub-1";
const NS_SCOPE = `/subscriptions/${SUB}/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns1`;
const HUB_SCOPE = `${NS_SCOPE}/eventhubs/hub1`;
const PRINCIPAL = "0f1e2d3c-4b5a-4968-8776-655443322110";
const CRIBL_CLIENT = "c0c0c0c0-1111-4222-8333-444444444444";
const APP_CLIENT = "a0a0a0a0-1111-4222-8333-444444444444";
const APP_SP = "a1a1a1a1-1111-4222-8333-444444444444";
const RECEIVER_DEF = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${RECEIVER_GRANT_ROLE.guid}`;
const OWNER_DEF = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/f526a384-b230-433a-b45c-95f59c4a2dec`;

function values(over: Partial<Record<keyof PlanValues, string>> = {}): PlanValues {
  return {
    ...defaultPlanValues({ subscriptionId: SUB, resourceGroup: "rg-eh" }),
    namespace: "ns1",
    hubName: "hub1",
    criblPrincipalObjectId: PRINCIPAL,
    criblClientId: CRIBL_CLIENT,
    ...over,
  } as PlanValues;
}

function input(over: Partial<PlanReceiverGrantInput> = {}): PlanReceiverGrantInput {
  return { values: values(), scope: "hub", appClientId: APP_CLIENT, connectionTenantId: "tenant-1", ...over };
}

function graphOf(sps: ServicePrincipalRef[] | Error): GraphDirectory & { calls: number } {
  const g = {
    calls: 0,
    readSubscribedSkus: async () => ({ kind: "denied" as const, status: 403, detail: "unused" }),
    listServicePrincipals: () => {
      g.calls += 1;
      return sps instanceof Error ? Promise.reject(sps) : Promise.resolve(sps);
    },
  };
  return g;
}

const CRIBL_SP: ServicePrincipalRef = { id: PRINCIPAL, appId: CRIBL_CLIENT, displayName: "cribl-reader" };
const APP_SP_REF: ServicePrincipalRef = { id: APP_SP, appId: APP_CLIENT, displayName: "soc-toolkit" };

const list = (...items: unknown[]) => ({ status: 200, body: { value: items } });
const forbidden = { status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } };

function assignment(opts: { scope: string; role?: string; name?: string; description?: string; principal?: string }): unknown {
  const name = opts.name ?? "11111111-2222-4333-8444-555555555555";
  return {
    id: `${opts.scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
    name,
    properties: {
      scope: opts.scope,
      roleDefinitionId: opts.role ?? RECEIVER_DEF,
      principalId: opts.principal ?? PRINCIPAL,
      ...(opts.description === undefined ? {} : { description: opts.description }),
    },
  };
}

describe("planReceiverGrant - the scope", () => {
  it("is the hub by default, and reads the principal's assignments there (one GET)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list());
    const result = await planReceiverGrant({ azure, graph: graphOf([CRIBL_SP]) }, input());
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.ready).toEqual({
      scopeChoice: "hub",
      scopeId: HUB_SCOPE,
      namespace: { subscriptionId: SUB, resourceGroup: "rg-eh", name: "ns1" },
      hubName: "hub1",
      principal: { objectId: PRINCIPAL, source: "typed-matched", displayName: "cribl-reader", clientId: CRIBL_CLIENT },
      roleName: "Azure Event Hubs Data Receiver",
      roleDefinitionGuid: "a638d3c7-ab3a-418d-83e6-5f17a39d4fde",
      assignmentName: receiverGrantAssignmentName(HUB_SCOPE, PRINCIPAL),
      description: receiverGrantDescription(),
      existing: { kind: "read" },
      notes: [],
    });
    expect(azure.calls).toEqual([
      {
        method: "GET",
        path: `${HUB_SCOPE}/providers/Microsoft.Authorization/roleAssignments`,
        apiVersion: "2022-04-01",
        query: { $filter: `assignedTo('${PRINCIPAL}')` },
      },
    ]);
  });

  it("is the namespace only when chosen, and needs no hub then", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list());
    const result = await planReceiverGrant({ azure }, input({ scope: "namespace", values: values({ hubName: "" }) }));
    expect(result.kind === "ready" && result.ready.scopeId).toBe(NS_SCOPE);
    expect(result.kind === "ready" && result.ready.hubName).toBe("");
    expect(azure.calls[0]?.path).toBe(`${NS_SCOPE}/providers/Microsoft.Authorization/roleAssignments`);
  });

  it("refuses the hub scope when the plan names no hub, and reads nothing", async () => {
    const azure = new FakeAzureManagement();
    const result = await planReceiverGrant({ azure }, input({ values: values({ hubName: " " }) }));
    expect(result).toEqual({
      kind: "refused",
      reason: "no-hub",
      detail:
        "The plan names no hub, so the role cannot be granted on a hub. Name the hub first, or choose the namespace " +
        "(it covers every hub in it, including the hubs Azure creates itself).",
    });
    expect(azure.calls).toEqual([]);
  });

  it("refuses when the namespace is not named", async () => {
    const azure = new FakeAzureManagement();
    const result = await planReceiverGrant({ azure }, input({ values: values({ namespace: "" }) }));
    expect(result.kind === "refused" && result.reason).toBe("missing-value");
    expect(azure.calls).toEqual([]);
  });

  it("uses the namespace's own subscription and resource group when the plan names them", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list());
    const result = await planReceiverGrant(
      { azure },
      input({ values: values({ eventHubSubscriptionId: "sub-2", eventHubResourceGroup: "rg-other" }) }),
    );
    expect(result.kind === "ready" && result.ready.scopeId).toBe(
      "/subscriptions/sub-2/resourceGroups/rg-other/providers/Microsoft.EventHub/namespaces/ns1/eventhubs/hub1",
    );
  });
});

describe("planReceiverGrant - the principal is resolved, never guessed", () => {
  it("looks a blank object id up by client id when the directory lists exactly one", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list());
    const result = await planReceiverGrant(
      { azure, graph: graphOf([CRIBL_SP, APP_SP_REF]) },
      input({ values: values({ criblPrincipalObjectId: "" }) }),
    );
    expect(result.kind === "ready" && result.ready.principal).toEqual({
      objectId: PRINCIPAL,
      source: "directory",
      displayName: "cribl-reader",
      clientId: CRIBL_CLIENT,
    });
  });

  it("refuses unresolved when the object id is blank and the directory cannot be read", async () => {
    const azure = new FakeAzureManagement();
    const result = await planReceiverGrant(
      { azure, graph: graphOf(new Error("Graph 403")) },
      input({ values: values({ criblPrincipalObjectId: "" }) }),
    );
    expect(result).toEqual({
      kind: "refused",
      reason: "principal-unresolved",
      detail:
        `The object ID of client ID ${CRIBL_CLIENT} could not be looked up: the directory read was refused or failed (Graph 403). ` +
        "Enter it as the Cribl service principal object ID in the plan values (Microsoft Entra ID, Enterprise applications, the Cribl application, Object ID).",
    });
    expect(azure.calls).toEqual([]);
  });

  it("refuses unresolved when no directory is bound", async () => {
    const result = await planReceiverGrant(
      { azure: new FakeAzureManagement() },
      input({ values: values({ criblPrincipalObjectId: "" }) }),
    );
    expect(result.kind === "refused" && result.reason).toBe("principal-unresolved");
    expect(result.kind === "refused" && result.detail).toContain("the directory cannot be read from this app");
  });

  it("refuses unresolved when the listing has no principal for the client id", async () => {
    const result = await planReceiverGrant(
      { azure: new FakeAzureManagement(), graph: graphOf([APP_SP_REF]) },
      input({ values: values({ criblPrincipalObjectId: "" }) }),
    );
    expect(result.kind === "refused" && result.detail).toContain(
      `The directory listing holds no service principal for client ID ${CRIBL_CLIENT}`,
    );
  });

  it("refuses when both ids are blank", async () => {
    const result = await planReceiverGrant(
      { azure: new FakeAzureManagement(), graph: graphOf([CRIBL_SP]) },
      input({ values: values({ criblPrincipalObjectId: "", criblClientId: "" }) }),
    );
    expect(result.kind === "refused" && result.reason).toBe("principal-unresolved");
  });

  it("keeps a typed object id the directory cannot confirm, and says so", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list());
    const result = await planReceiverGrant({ azure, graph: graphOf(new Error("Graph 403")) }, input());
    expect(result.kind === "ready" && result.ready.principal.source).toBe("typed-not-cross-checked");
  });

  it("refuses a typed object id that is not a GUID", async () => {
    const result = await planReceiverGrant(
      { azure: new FakeAzureManagement() },
      input({ values: values({ criblPrincipalObjectId: "cribl-reader" }) }),
    );
    expect(result.kind === "refused" && result.reason).toBe("principal-invalid");
  });

  it("refuses an object id the directory ties to another client id", async () => {
    const result = await planReceiverGrant(
      { azure: new FakeAzureManagement(), graph: graphOf([{ ...CRIBL_SP, id: "99999999-2222-4333-8444-555555555555" }]) },
      input(),
    );
    expect(result.kind === "refused" && result.reason).toBe("principal-mismatch");
  });

  it("refuses this app's own registration by client id, before any read", async () => {
    const graph = graphOf([CRIBL_SP]);
    const result = await planReceiverGrant(
      { azure: new FakeAzureManagement(), graph },
      input({ values: values({ criblClientId: APP_CLIENT.toUpperCase() }) }),
    );
    expect(result.kind === "refused" && result.reason).toBe("app-principal");
    expect(graph.calls).toBe(0);
  });

  it("refuses this app's own principal by object id when the directory lists it", async () => {
    const result = await planReceiverGrant(
      { azure: new FakeAzureManagement(), graph: graphOf([APP_SP_REF]) },
      input({ values: values({ criblPrincipalObjectId: APP_SP, criblClientId: "" }) }),
    );
    expect(result.kind === "refused" && result.reason).toBe("app-principal");
  });
});

describe("planReceiverGrant - an existing assignment", () => {
  it("reads a Data Receiver grant at the hub as already granted, made by this app when its name and stamp match", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      list(
        assignment({
          scope: HUB_SCOPE,
          name: receiverGrantAssignmentName(HUB_SCOPE, PRINCIPAL),
          description: receiverGrantDescription(),
        }),
      ),
    );
    const result = await planReceiverGrant({ azure }, input());
    expect(result.kind).toBe("already-granted");
    if (result.kind !== "already-granted") return;
    expect(result.existing).toEqual({
      roleName: "Azure Event Hubs Data Receiver",
      scope: HUB_SCOPE,
      assignmentName: receiverGrantAssignmentName(HUB_SCOPE, PRINCIPAL),
      madeByThisApp: true,
    });
  });

  it("reads a namespace grant as covering the hub, not made by this app", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(assignment({ scope: NS_SCOPE })));
    const result = await planReceiverGrant({ azure }, input());
    expect(result.kind === "already-granted" && result.existing).toEqual({
      roleName: "Azure Event Hubs Data Receiver",
      scope: NS_SCOPE,
      assignmentName: "11111111-2222-4333-8444-555555555555",
      madeByThisApp: false,
    });
  });

  it("does not count a grant on another hub, nor one with the app's name but no stamp as the app's", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(assignment({ scope: `${NS_SCOPE}/eventhubs/hub10` })));
    expect((await planReceiverGrant({ azure }, input())).kind).toBe("ready");

    const azure2 = new FakeAzureManagement();
    azure2.respondWith(list(assignment({ scope: HUB_SCOPE, name: receiverGrantAssignmentName(HUB_SCOPE, PRINCIPAL) })));
    const result = await planReceiverGrant({ azure: azure2 }, input());
    expect(result.kind === "already-granted" && result.existing.madeByThisApp).toBe(false);
  });

  it("does not count a hub-only grant when the namespace is chosen", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(assignment({ scope: HUB_SCOPE })));
    const result = await planReceiverGrant({ azure }, input({ scope: "namespace" }));
    expect(result.kind).toBe("ready");
  });

  it("notes Data Owner held as well, and still plans the grant", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(assignment({ scope: NS_SCOPE, role: OWNER_DEF })));
    const result = await planReceiverGrant({ azure }, input());
    expect(result.kind === "ready" && result.ready.notes).toEqual([
      `The principal also holds Azure Event Hubs Data Owner at ${NS_SCOPE}. That role can read every shared access key of the namespace, ` +
        "so the Cribl source refuses this principal until it is removed; granting Data Receiver does not change that.",
    ]);
  });

  it("plans the grant when the assignments cannot be read, and says why", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(forbidden);
    const result = await planReceiverGrant({ azure }, input());
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.ready.existing.kind).toBe("unread");
    expect(result.ready.existing.kind === "unread" && result.ready.existing.message).toContain("403");
  });

  it("notes a Cribl principal of another tenant", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list());
    const result = await planReceiverGrant({ azure }, input({ values: values({ criblTenantId: "tenant-2" }) }));
    expect(result.kind === "ready" && result.ready.notes).toEqual([
      "The Cribl principal signs in to tenant tenant-2, but this connection is tenant tenant-1. " +
        "A role here can only be assigned to a principal of this tenant, so the object ID must be the Cribl principal's object ID in this tenant.",
    ]);
  });
});

describe("applyReceiverGrant", () => {
  async function ready(): Promise<ReadyReceiverGrant> {
    const azure = new FakeAzureManagement();
    azure.respondWith(list());
    const result = await planReceiverGrant({ azure }, input());
    if (result.kind !== "ready") throw new Error("plan not ready");
    return result.ready;
  }
  const NAME = receiverGrantAssignmentName(HUB_SCOPE, PRINCIPAL);
  const PUT_PATH = `${HUB_SCOPE}/providers/Microsoft.Authorization/roleAssignments/${NAME}`;
  const written = {
    status: 200,
    body: assignment({ scope: HUB_SCOPE, name: NAME, description: receiverGrantDescription() }),
  };

  it("PUTs exactly the grant the confirm quotes, reads it back, and returns the record", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 201, body: {} }, written);
    const outcome = await applyReceiverGrant({ azure }, await ready());
    expect(outcome).toEqual({
      kind: "granted",
      record: { scopeId: HUB_SCOPE, principalId: PRINCIPAL, assignmentName: NAME },
    });
    expect(azure.calls).toEqual([
      {
        method: "PUT",
        path: PUT_PATH,
        apiVersion: "2022-04-01",
        body: {
          properties: {
            roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/a638d3c7-ab3a-418d-83e6-5f17a39d4fde`,
            principalId: PRINCIPAL,
            principalType: "ServicePrincipal",
            description: receiverGrantDescription(),
          },
        },
      },
      { method: "GET", path: PUT_PATH, apiVersion: "2022-04-01" },
    ]);
  });

  it("is accepted-not-verified, still with the record, when the read-back differs or fails", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 201, body: {} }, { status: 200, body: assignment({ scope: HUB_SCOPE, name: NAME, principal: "someone" }) });
    const outcome = await applyReceiverGrant({ azure }, await ready());
    expect(outcome).toEqual({
      kind: "accepted-not-verified",
      record: { scopeId: HUB_SCOPE, principalId: PRINCIPAL, assignmentName: NAME },
      reasons: [`It is assigned to someone, not ${PRINCIPAL}.`],
    });

    const azure2 = new FakeAzureManagement();
    azure2.respondWith({ status: 201, body: {} }, forbidden);
    const outcome2 = await applyReceiverGrant({ azure: azure2 }, await ready());
    expect(outcome2.kind).toBe("accepted-not-verified");
  });

  it("reads 409 RoleAssignmentExists as already granted, with no record", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 409, body: { error: { code: "RoleAssignmentExists", message: "exists" } } });
    const outcome = await applyReceiverGrant({ azure }, await ready());
    expect(outcome.kind).toBe("already-granted");
    expect("record" in outcome).toBe(false);
    expect(azure.calls.map((c) => c.method)).toEqual(["PUT"]);
  });

  it("says when Azure does not know the principal", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 400, body: { error: { code: "PrincipalNotFound", message: "no such principal" } } });
    const outcome = await applyReceiverGrant({ azure }, await ready());
    expect(outcome.kind).toBe("principal-not-found");
    expect(azure.calls.map((c) => c.method)).toEqual(["PUT"]);
  });

  it("names the role an administrator grants when Azure refuses the write", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(forbidden);
    const outcome = await applyReceiverGrant({ azure }, await ready());
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") return;
    expect(outcome.step).toBe("assignment-put");
    expect(outcome.message).toBe(
      `Assign Azure Event Hubs Data Receiver at ${HUB_SCOPE}: HTTP 403 - no. Your Azure identity cannot create role assignments there ` +
        "(Microsoft.Authorization/roleAssignments/write). An administrator can grant RBAC Administrator on the hub or namespace, " +
        "narrowed with the condition: Constrain roles and principal types: only Azure Event Hubs Data Receiver, only to service principals. " +
        "Or they can follow the How-to step for this grant.",
    );
  });

  it("never throws when the transport rejects", async () => {
    const azure = { request: () => Promise.reject(new Error("socket hang up")) };
    const outcome = await applyReceiverGrant({ azure }, await ready());
    expect(outcome).toEqual({
      kind: "failed",
      step: "assignment-put",
      status: null,
      code: "",
      message: `Assign Azure Event Hubs Data Receiver at ${HUB_SCOPE}: socket hang up`,
    });
  });
});
