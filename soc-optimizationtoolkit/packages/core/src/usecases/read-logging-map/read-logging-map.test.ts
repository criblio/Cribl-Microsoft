/**
 * Pins for readLoggingMap (AZR-19). A PATH-ROUTED stub is used rather than
 * FakeAzureManagement, whose single FIFO queue (fake-azure-management.ts)
 * would make every case depend on the exact call order of reads it is not
 * about. Routes are keyed by `describeRequest` of the SAME builders the
 * usecase uses, plus nextLink URLs.
 */

import { describe, expect, it } from "vitest";
import type {
  AzureManagement,
  AzureManagementRequest,
  AzureManagementUrlRequest,
} from "../../ports/azure-management";
import type { PortHttpResponse } from "../../ports/http";
import {
  assignmentsAtScopeRequest,
  definitionRequest,
  descendantsRequest,
  exemptionsRequest,
  listManagementGroupsRequest,
  listSubscriptionsRequest,
  managementGroupRequest,
  roleAssignmentsForPrincipalRequest,
  roleDefinitionRequest,
} from "../../domain/logging-map/logging-map-requests";
import { normaliseScopeId, PARENT_UNKNOWN_ID } from "../../domain/logging-map/scope-tree";
import { describeRequest } from "./arm-pager";
import { LEGACY_GRANTED_ROLES_TEXT, readLoggingMap, type LoggingMapProgress } from "./read-logging-map";

type Answer = PortHttpResponse | Error;

class RoutedAzure implements AzureManagement {
  readonly calls: string[] = [];
  readonly unscripted: string[] = [];
  readonly routes: Map<string, Answer[]>;
  private readonly onCall: ((key: string) => void) | undefined;
  constructor(routes: Map<string, Answer[]>, onCall?: (key: string) => void) {
    this.routes = routes;
    this.onCall = onCall;
  }
  private answer(key: string): Promise<PortHttpResponse> {
    this.calls.push(key);
    this.onCall?.(key);
    const list = this.routes.get(key);
    const next = list === undefined ? undefined : list.length > 1 ? list.shift() : list[0];
    if (next === undefined) {
      this.unscripted.push(key);
      return Promise.resolve({ status: 599, body: { error: { code: "Unscripted" } } });
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
  request(opts: AzureManagementRequest): Promise<PortHttpResponse> {
    return this.answer(describeRequest(opts));
  }
  requestUrl(opts: AzureManagementUrlRequest): Promise<PortHttpResponse> {
    return this.answer(opts.url);
  }
}

const TID = "tid";
const MG = (n: string): string => `/providers/Microsoft.Management/managementGroups/${n}`;
const ROOT = MG(TID);
const MG_A = MG("mg-a");
const MG_B = MG("mg-b");
const SUB = (n: number): string => `/subscriptions/sub${n}`;
const ALL_LOGS_SET =
  "/providers/Microsoft.Authorization/policySetDefinitions/85175a36-2f12-419a-96b4-18d5b0096531";
const MON_CONTRIB = "/providers/Microsoft.Authorization/roleDefinitions/749f88d5-cbae-40b8-bcfc-e573ddc772fa";
const EH_OWNER = "/providers/Microsoft.Authorization/roleDefinitions/f526a384-b230-433a-b45c-95f59c4a2dec";

const ok = (body: unknown): PortHttpResponse => ({ status: 200, body });
const list = (value: unknown[], nextLink?: string): PortHttpResponse => ok(nextLink ? { value, nextLink } : { value });
const forbidden: PortHttpResponse = { status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } };

function assignment(opts: {
  scope: string;
  name: string;
  def: string;
  principalId?: string;
}): Record<string, unknown> {
  return {
    id: `${opts.scope}/providers/Microsoft.Authorization/policyAssignments/${opts.name}`,
    name: opts.name,
    ...(opts.principalId !== undefined
      ? { identity: { type: "SystemAssigned", principalId: opts.principalId } }
      : {}),
    properties: { scope: opts.scope, policyDefinitionId: opts.def, displayName: opts.name },
  };
}

const A1 = assignment({ scope: MG_A, name: "Cribl-AL-Central", def: ALL_LOGS_SET, principalId: "p1" });
const A1_KEY = normaliseScopeId(String(A1["id"]));

function customDef(n: number, detailsType = "Microsoft.Insights/diagnosticSettings"): Record<string, unknown> {
  return {
    id: `${SUB(1)}/providers/Microsoft.Authorization/policyDefinitions/d${n}`,
    name: `d${n}`,
    properties: {
      parameters: { eventHubName: { type: "String" } },
      policyRule: { if: {}, then: { effect: "DeployIfNotExists", details: { type: detailsType } } },
    },
  };
}

const key = (r: AzureManagementRequest): string => describeRequest(r);

/**
 * The happy fixture: Tenant Root > mg-a > { sub1, mg-b > { sub2, sub3 } }, one
 * legacy AllLogs assignment set at mg-a (short-circuited: no definition read)
 * with a system-assigned principal holding one role.
 */
function fixture(): Map<string, Answer[]> {
  const routes = new Map<string, Answer[]>();
  const set = (r: AzureManagementRequest, ...answers: Answer[]): void => {
    routes.set(key(r), answers);
  };
  set(
    descendantsRequest(TID),
    list([
      { id: MG_A, name: "mg-a", properties: { displayName: "A", parent: { id: ROOT } } },
      { id: MG_B, name: "mg-b", properties: { displayName: "B", parent: { id: MG_A } } },
      { id: SUB(1), name: "sub1", properties: { displayName: "S1", parent: { id: MG_A } } },
      { id: SUB(2), name: "sub2", properties: { displayName: "S2", parent: { id: MG_B } } },
      { id: SUB(3), name: "sub3", properties: { displayName: "S3", parent: { id: MG_B } } },
    ]),
  );
  set(
    listSubscriptionsRequest(),
    list([1, 2, 3].map((n) => ({ id: SUB(n), subscriptionId: `sub${n}`, displayName: `S${n}`, state: "Enabled" }))),
  );
  set(assignmentsAtScopeRequest(ROOT), list([]));
  for (const s of [MG_A, MG_B, SUB(1), SUB(2), SUB(3)]) set(assignmentsAtScopeRequest(s), list([A1]));
  for (const s of [ROOT, MG_A, MG_B, SUB(1), SUB(2), SUB(3)]) set(exemptionsRequest(s), list([]));
  set(
    roleAssignmentsForPrincipalRequest(MG_A, "p1"),
    list([{ properties: { scope: MG_A, roleDefinitionId: `${MG_A}${MON_CONTRIB}`, principalId: "p1" } }]),
  );
  set(roleDefinitionRequest(`${MG_A}${MON_CONTRIB}`), ok({ id: MON_CONTRIB, properties: { roleName: "Monitoring Contributor" } }));
  return routes;
}

const NOW = "2026-10-26T00:00:00Z";

describe("readLoggingMap", () => {
  it("(1) happy path: the exact call list for root, 2 MGs and 3 subscriptions", async () => {
    const azure = new RoutedAzure(fixture());
    const result = await readLoggingMap({ azure, tenantId: TID, now: NOW });
    const scopes = [ROOT, MG_A, MG_B, SUB(1), SUB(2), SUB(3)];
    expect(azure.calls).toEqual([
      key(descendantsRequest(TID)),
      key(listSubscriptionsRequest()),
      ...scopes.flatMap((s) => [key(assignmentsAtScopeRequest(s)), key(exemptionsRequest(s))]),
      key(roleAssignmentsForPrincipalRequest(MG_A, "p1")),
      key(roleDefinitionRequest(`${MG_A}${MON_CONTRIB}`)),
    ]);
    expect(azure.unscripted).toEqual([]);
    expect(result.start).toEqual({ kind: "tenant-root", notRead: [] });
    expect(result.refusals).toEqual([]);
    expect(result.requests).toBe(16);
    expect(result.subscriptions.kind).toBe("rows");
    expect(result.map.counts.scopes).toBe(6);
    expect(result.map.tree.roots).toEqual([normaliseScopeId(ROOT)]);
    expect(result.map.assignments.map((a) => a.assignmentKey)).toEqual([A1_KEY]);
    // Set once at mg-a, inherited by the four scopes beneath it.
    expect(result.map.nodesById.get(normaliseScopeId(MG_A))?.setHere).toEqual([A1_KEY]);
    for (const s of [MG_B, SUB(1), SUB(2), SUB(3)]) {
      expect(result.map.nodesById.get(normaliseScopeId(s))?.inherited.map((i) => i.assignmentKey)).toEqual([A1_KEY]);
    }
    // A read of zero exemptions is a stated none.
    expect(result.map.nodesById.get(normaliseScopeId(SUB(1)))?.exemptions).toEqual({ kind: "none" });
    const a1 = result.map.assignmentsByKey.get(A1_KEY);
    expect(a1?.classification?.verdict).toBe("yes");
    expect(a1?.ownership?.strength).toBe("legacy-strong");
    expect(a1?.legacyGrantedRoles).toEqual(LEGACY_GRANTED_ROLES_TEXT);
    expect(LEGACY_GRANTED_ROLES_TEXT.map((r) => r.roleName)).toEqual([
      "Monitoring Contributor",
      "Azure Event Hubs Data Owner",
    ]);
    expect(a1?.roles).toEqual({
      state: "read",
      rows: [{ scope: MG_A, roleDefinitionId: `${MG_A}${MON_CONTRIB}`, roleName: "Monitoring Contributor" }],
    });
  });

  it("(2) a Tenant Root 403 falls back to the highest readable groups and names the root as not read", async () => {
    const routes = fixture();
    routes.set(key(descendantsRequest(TID)), [forbidden]);
    routes.set(
      key(listManagementGroupsRequest()),
      [list([{ id: MG_A, name: "mg-a", properties: { displayName: "A" } }, { id: MG_B, name: "mg-b", properties: { displayName: "B" } }])],
    );
    routes.set(
      key(managementGroupRequest("mg-a", true)),
      [ok({ id: MG_A, name: "mg-a", properties: { displayName: "A", details: { parent: { id: ROOT } } } })],
    );
    routes.set(
      key(managementGroupRequest("mg-b", true)),
      [ok({ id: MG_B, name: "mg-b", properties: { displayName: "B", details: { parent: { id: MG_A } } } })],
    );
    // mg-a is the one highest-readable root; its OWN descendants place the subscriptions.
    routes.set(
      key(descendantsRequest("mg-a")),
      [
        list([
          { id: MG_B, name: "mg-b", properties: { displayName: "B", parent: { id: MG_A } } },
          { id: SUB(1), name: "sub1", properties: { displayName: "S1", parent: { id: MG_A } } },
          { id: SUB(2), name: "sub2", properties: { displayName: "S2", parent: { id: MG_B } } },
          { id: SUB(3), name: "sub3", properties: { displayName: "S3", parent: { id: MG_B } } },
        ]),
      ],
    );
    const azure = new RoutedAzure(routes);
    const result = await readLoggingMap({ azure, tenantId: TID, now: NOW });
    expect(result.start).toEqual({ kind: "highest-readable", notRead: [normaliseScopeId(ROOT)] });
    expect(result.map.tree.roots).toEqual([normaliseScopeId(MG_A)]);
    const parentOf = (id: string): string | null | undefined => result.map.tree.byId.get(normaliseScopeId(id))?.parentId;
    expect(parentOf(MG_B)).toBe(normaliseScopeId(MG_A));
    expect(parentOf(SUB(1))).toBe(normaliseScopeId(MG_A));
    expect(parentOf(SUB(2))).toBe(normaliseScopeId(MG_B));
    expect(parentOf(SUB(3))).toBe(normaliseScopeId(MG_B));
    expect(result.map.counts.parentUnknown).toBe(0);
    expect(result.map.tree.byId.has(PARENT_UNKNOWN_ID)).toBe(false);
    expect(result.refusals.map((r) => [r.request, r.status])).toEqual([[key(descendantsRequest(TID)), 403]]);
    // Only the root's descendants are read, not mg-b's (it is beneath mg-a).
    expect(azure.calls.filter((c) => c.endsWith("/descendants") || c.includes("/descendants?"))).toEqual([
      key(descendantsRequest(TID)),
      key(descendantsRequest("mg-a")),
    ]);
    expect(azure.unscripted).toEqual([]);
    // The root was never read per scope.
    expect(azure.calls).not.toContain(key(assignmentsAtScopeRequest(ROOT)));
  });

  it("(2c) fallback: one root's descendants refused orphans only ITS subscriptions", async () => {
    const routes = fixture();
    routes.set(key(descendantsRequest(TID)), [forbidden]);
    // Two highest-readable roots: mg-a and mg-b (whose parent, the root, is not visible).
    routes.set(
      key(listManagementGroupsRequest()),
      [list([{ id: MG_A, name: "mg-a", properties: { displayName: "A" } }, { id: MG_B, name: "mg-b", properties: { displayName: "B" } }])],
    );
    routes.set(
      key(managementGroupRequest("mg-a", true)),
      [ok({ id: MG_A, name: "mg-a", properties: { displayName: "A", details: { parent: { id: ROOT } } } })],
    );
    routes.set(
      key(managementGroupRequest("mg-b", true)),
      [ok({ id: MG_B, name: "mg-b", properties: { displayName: "B", details: { parent: { id: ROOT } } } })],
    );
    routes.set(
      key(descendantsRequest("mg-a")),
      [list([{ id: SUB(1), name: "sub1", properties: { displayName: "S1", parent: { id: MG_A } } }])],
    );
    routes.set(key(descendantsRequest("mg-b")), [forbidden]);
    const azure = new RoutedAzure(routes);
    const result = await readLoggingMap({ azure, tenantId: TID, now: NOW });
    expect(result.map.tree.roots).toEqual([normaliseScopeId(MG_A), normaliseScopeId(MG_B), PARENT_UNKNOWN_ID]);
    expect(result.map.tree.byId.get(normaliseScopeId(SUB(1)))?.parentId).toBe(normaliseScopeId(MG_A));
    expect(result.map.tree.childrenOf.get(PARENT_UNKNOWN_ID)).toEqual([normaliseScopeId(SUB(2)), normaliseScopeId(SUB(3))]);
    expect(result.map.counts.parentUnknown).toBe(2);
    expect(result.refusals.map((r) => [r.request, r.status])).toEqual([
      [key(descendantsRequest(TID)), 403],
      [key(descendantsRequest("mg-b")), 403],
    ]);
    expect(azure.unscripted).toEqual([]);
  });

  it("(2b) no management group readable at all: subscriptions-only", async () => {
    const routes = fixture();
    routes.set(key(descendantsRequest(TID)), [forbidden]);
    routes.set(key(listManagementGroupsRequest()), [forbidden]);
    const result = await readLoggingMap({ azure: new RoutedAzure(routes), tenantId: TID, now: NOW });
    expect(result.start.kind).toBe("subscriptions-only");
    expect(result.refusals.length).toBe(2);
    expect(result.map.counts.parentUnknown).toBe(3);
  });

  it("(3) one subscription's assignments 403: only that list is refused", async () => {
    const routes = fixture();
    routes.set(key(assignmentsAtScopeRequest(SUB(2))), [forbidden]);
    const result = await readLoggingMap({ azure: new RoutedAzure(routes), tenantId: TID, now: NOW });
    expect(result.map.counts.assignmentsRefused).toBe(1);
    const sub2 = result.map.nodesById.get(normaliseScopeId(SUB(2)));
    expect(sub2?.assignments).toEqual({ kind: "empty" });
    expect(sub2?.assignmentCount).toBeNull();
    expect(result.map.nodesById.get(normaliseScopeId(SUB(3)))?.assignmentCount).toBe(1);
    expect(result.refusals.map((r) => r.request)).toEqual([key(assignmentsAtScopeRequest(SUB(2)))]);
  });

  it("(4) a 2xx exemptions body without `value` is unknown, not none", async () => {
    const routes = fixture();
    routes.set(key(exemptionsRequest(SUB(1))), [ok({})]);
    const result = await readLoggingMap({ azure: new RoutedAzure(routes), tenantId: TID, now: NOW });
    const sub1 = result.map.nodesById.get(normaliseScopeId(SUB(1)));
    expect(sub1?.exemptions).toEqual({ kind: "empty" });
    expect(sub1?.exemptionCount).toBeNull();
    expect(result.map.counts.exemptionsRefused).toBe(1);
    expect(result.refusals.map((r) => r.reason)).toEqual(["unexpected-shape"]);
  });

  it("(5) a nextLink is followed and the second page's rows count", async () => {
    const routes = fixture();
    const next = "https://management.azure.com/next/sub3";
    const a2 = assignment({ scope: SUB(3), name: "Other-Diag", def: ALL_LOGS_SET });
    routes.set(key(assignmentsAtScopeRequest(SUB(3))), [list([A1], next)]);
    routes.set(next, [list([a2])]);
    const azure = new RoutedAzure(routes);
    const result = await readLoggingMap({ azure, tenantId: TID, now: NOW });
    expect(azure.calls).toContain(next);
    const sub3 = result.map.nodesById.get(normaliseScopeId(SUB(3)));
    expect(sub3?.assignmentCount).toBe(2);
    expect(sub3?.setHere).toEqual([normaliseScopeId(String(a2["id"]))]);
    expect(result.map.assignments.length).toBe(2);
  });

  it("(6) maxDefinitionReads=1 with 3 custom definitions: one GET, two unclassified", async () => {
    const routes = fixture();
    const customs = [1, 2, 3].map((n) =>
      assignment({ scope: SUB(1), name: `Custom-${n}`, def: String(customDef(n)["id"]) }),
    );
    routes.set(key(assignmentsAtScopeRequest(SUB(1))), [list([A1, ...customs])]);
    for (const n of [1, 2, 3]) routes.set(key(definitionRequest(String(customDef(n)["id"]))), [ok(customDef(n))]);
    const azure = new RoutedAzure(routes);
    const result = await readLoggingMap({ azure, tenantId: TID, now: NOW, maxDefinitionReads: 1 });
    const defCalls = azure.calls.filter((c) => c.includes("/policyDefinitions/"));
    expect(defCalls).toEqual([key(definitionRequest(String(customDef(1)["id"])))]);
    expect(result.map.counts.assignmentsUnclassified).toBe(2);
    expect(result.definitionsSkipped).toBe(2);
    const c1 = result.map.assignments.find((a) => a.assignment.name === "Custom-1");
    expect(c1?.classification?.verdict).toBe("yes");
  });

  it("(6b) a set's members are read within the cap; an unread member leaves the set unknown", async () => {
    const routes = fixture();
    const setId = `${MG_A}/providers/Microsoft.Authorization/policySetDefinitions/my-set`;
    const member = (n: number): string => String(customDef(n)["id"]);
    const s = assignment({ scope: SUB(1), name: "Set-Assign", def: setId });
    routes.set(key(assignmentsAtScopeRequest(SUB(1))), [list([A1, s])]);
    routes.set(
      key(definitionRequest(setId)),
      [ok({ id: setId, name: "my-set", properties: { policyDefinitions: [{ policyDefinitionId: member(1) }, { policyDefinitionId: member(2) }] } })],
    );
    routes.set(key(definitionRequest(member(1))), [ok(customDef(1))]);
    routes.set(key(definitionRequest(member(2))), [ok(customDef(2))]);
    const full = await readLoggingMap({ azure: new RoutedAzure(routes), tenantId: TID, now: NOW });
    expect(full.map.assignments.find((a) => a.assignment.name === "Set-Assign")?.classification?.verdict).toBe("yes");

    const capped = await readLoggingMap({ azure: new RoutedAzure(routes), tenantId: TID, now: NOW, maxDefinitionReads: 2 });
    const cls = capped.map.assignments.find((a) => a.assignment.name === "Set-Assign")?.classification;
    expect(cls?.verdict).toBe("unknown");
    expect(capped.definitionsSkipped).toBe(1);
  });

  it("(7) pacing at 2/min makes the third request sleep once, before it is sent", async () => {
    let clock = 0;
    const events: string[] = [];
    const azure = new RoutedAzure(fixture(), () => events.push("call"));
    const result = await readLoggingMap({
      azure,
      tenantId: TID,
      now: NOW,
      pacing: {
        maxRequestsPerMinute: 2,
        now: () => clock,
        sleep: async (ms) => {
          events.push(`sleep ${ms}`);
          clock += ms;
        },
      },
    });
    expect(events.slice(0, 4)).toEqual(["call", "call", "sleep 60000", "call"]);
    expect(events.filter((e) => e.startsWith("sleep")).length).toBe(7);
    expect(result.requests).toBe(16);
  });

  it("(8) a transport rejection on exemptions still lets the read resolve", async () => {
    const routes = fixture();
    routes.set(key(exemptionsRequest(MG_B)), [new Error("ECONNRESET")]);
    const result = await readLoggingMap({ azure: new RoutedAzure(routes), tenantId: TID, now: NOW });
    expect(result.refusals.map((r) => r.reason)).toEqual(["transport"]);
    expect(result.map.nodesById.get(normaliseScopeId(MG_B))?.exemptions).toEqual({ kind: "empty" });
    expect(result.map.counts.exemptionsRefused).toBe(1);
  });

  it("(8b) every request rejecting still resolves, with every scope unknown", async () => {
    const azure: AzureManagement = { request: () => Promise.reject(new Error("offline")) };
    const result = await readLoggingMap({ azure, tenantId: TID, now: NOW });
    expect(result.start.kind).toBe("subscriptions-only");
    expect(result.refusals.every((r) => r.reason === "transport")).toBe(true);
    expect(result.subscriptions).toEqual({ kind: "empty" });
  });

  it("(9) roles: one assignedTo() read per principal, one role-definition GET per distinct role", async () => {
    const routes = fixture();
    routes.set(
      key(roleAssignmentsForPrincipalRequest(MG_A, "p1")),
      [
        list([
          { properties: { scope: MG_A, roleDefinitionId: `${MG_A}${MON_CONTRIB}` } },
          { properties: { scope: `${SUB(1)}/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns`, roleDefinitionId: `${SUB(1)}${EH_OWNER}` } },
          { properties: { scope: MG_B, roleDefinitionId: `${MG_B}${MON_CONTRIB}` } },
        ]),
      ],
    );
    routes.set(key(roleDefinitionRequest(`${SUB(1)}${EH_OWNER}`)), [ok({ id: EH_OWNER, properties: { roleName: "Azure Event Hubs Data Owner" } })]);
    const azure = new RoutedAzure(routes);
    const result = await readLoggingMap({ azure, tenantId: TID, now: NOW });
    const roleCalls = azure.calls.filter((c) => c.includes("/roleAssignments"));
    expect(roleCalls).toEqual([key(roleAssignmentsForPrincipalRequest(MG_A, "p1"))]);
    expect(roleCalls[0]).toContain("assignedTo('p1')");
    expect(azure.calls.filter((c) => c.includes("/roleDefinitions/")).length).toBe(2);
    const roles = result.map.assignmentsByKey.get(A1_KEY)?.roles;
    expect(roles?.state).toBe("read");
    if (roles?.state === "read") {
      expect(roles.rows.map((r) => r.roleName)).toEqual([
        "Monitoring Contributor",
        "Azure Event Hubs Data Owner",
        "Monitoring Contributor",
      ]);
    }
  });

  it("(9b) a refused role read stays refused, never []", async () => {
    const routes = fixture();
    routes.set(key(roleAssignmentsForPrincipalRequest(MG_A, "p1")), [forbidden]);
    const result = await readLoggingMap({ azure: new RoutedAzure(routes), tenantId: TID, now: NOW });
    const roles = result.map.assignmentsByKey.get(A1_KEY)?.roles;
    expect(roles?.state).toBe("refused");
    expect(result.map.counts.rolesUnread).toBe(1);
  });

  it("(9c) maxRoleReads: 0 refuses the role read as cap reached; 1 reads grants but skips their names", async () => {
    const none = await readLoggingMap({ azure: new RoutedAzure(fixture()), tenantId: TID, now: NOW, maxRoleReads: 0 });
    const r0 = none.map.assignmentsByKey.get(A1_KEY)?.roles;
    expect(r0?.state === "refused" && r0.refusal.text).toContain("role read cap reached");
    expect(none.map.counts.rolesUnread).toBe(1);

    const azure = new RoutedAzure(fixture());
    const one = await readLoggingMap({ azure, tenantId: TID, now: NOW, maxRoleReads: 1 });
    expect(azure.calls.some((c) => c.includes("/roleDefinitions/"))).toBe(false);
    expect(one.roleDefinitionsSkipped).toBe(1);
    const r1 = one.map.assignmentsByKey.get(A1_KEY)?.roles;
    expect(r1?.state === "read" && r1.rows.map((r) => r.roleName)).toEqual([null]);
    // One grant whose name was not read: one unread, not 0.
    expect(one.map.counts.rolesUnread).toBe(1);
    expect(one.roleNamesUnread).toBe(1);
    expect(one.refusals.map((r) => [r.reason, r.text.includes("role read cap reached")])).toEqual([["too-many-pages", true]]);
  });

  it("(9e) a refused role-definition GET leaves the grant unnamed and counts it unread", async () => {
    const routes = fixture();
    routes.set(key(roleDefinitionRequest(`${MG_A}${MON_CONTRIB}`)), [forbidden]);
    const result = await readLoggingMap({ azure: new RoutedAzure(routes), tenantId: TID, now: NOW });
    const roles = result.map.assignmentsByKey.get(A1_KEY)?.roles;
    expect(roles?.state === "read" && roles.rows.map((r) => r.roleName)).toEqual([null]);
    expect(result.map.counts.rolesUnread).toBe(1);
    expect(result.roleNamesUnread).toBe(1);
    expect(result.refusals.map((r) => r.status)).toEqual([403]);
  });

  it("(9d) another owner's non-logging assignment gets no role read (default-shown rule)", async () => {
    const routes = fixture();
    const audit = assignment({ scope: SUB(1), name: "Tag-Policy", def: String(customDef(7)["id"]), principalId: "p7" });
    routes.set(key(assignmentsAtScopeRequest(SUB(1))), [list([A1, audit])]);
    routes.set(key(definitionRequest(String(customDef(7)["id"]))), [ok(customDef(7, "Microsoft.Resources/tags"))]);
    const azure = new RoutedAzure(routes);
    const result = await readLoggingMap({ azure, tenantId: TID, now: NOW });
    expect(result.map.assignments.find((a) => a.assignment.name === "Tag-Policy")?.classification?.verdict).toBe("no");
    expect(azure.calls.some((c) => c.includes("assignedTo('p7')"))).toBe(false);
  });

  it("reports progress after every request; done reaches the request count and total never trails it", async () => {
    const seen: LoggingMapProgress[] = [];
    const result = await readLoggingMap({
      azure: new RoutedAzure(fixture()),
      tenantId: TID,
      now: NOW,
      onProgress: (p) => seen.push(p),
    });
    expect(seen.map((p) => p.done)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(seen.every((p) => p.total >= p.done)).toBe(true);
    expect(seen.at(-1)?.phase).toBe("roles");
    expect(result.requests).toBe(16);
  });
});
