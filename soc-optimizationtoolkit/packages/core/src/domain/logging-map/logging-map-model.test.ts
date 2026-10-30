// Pins for logging-map-model.ts (AZR-19 U1c): one assignment once, honest
// per-scope listings (verified zero vs unknown), roles that stay refused, and
// counts derived from the reads.

import { describe, expect, it } from "vitest";
import { readRefused, readRows, refusalsOf, type ListRead } from "./list-read";
import type { PolicyAssignment, PolicyExemption, RoleGrant, ScopeEntry, ScopeRead } from "./logging-map-types";
import { buildScopeTree, managementGroupId } from "./scope-tree";
import { buildLoggingMap, principalIdsOf, principalKey } from "./logging-map-model";

const TENANT = "tenant-0000";
const mg = (name: string): string => managementGroupId(name);
const sub = (name: string): string => `/subscriptions/${name}`;
const lc = (s: string): string => s.toLowerCase();
const NOW = "2026-10-26T12:00:00Z";
const REFUSED = { request: "GET x", status: 403, code: "AuthorizationFailed", text: "denied", reason: "http" } as const;
const NO_EX = (): ListRead<PolicyExemption> => readRows<PolicyExemption>([]);

// Tenant Root -> mg-a -> sub-1, sub-2
const entries: ScopeEntry[] = [
  { id: mg(TENANT), name: TENANT, displayName: "Tenant Root Group", parentId: null },
  { id: mg("mg-a"), name: "mg-a", displayName: "A", parentId: mg(TENANT) },
  { id: sub("sub-1"), name: "sub-1", displayName: "S1", parentId: mg("mg-a") },
  { id: sub("sub-2"), name: "sub-2", displayName: "S2", parentId: mg("mg-a") },
];
const tree = (): ReturnType<typeof buildScopeTree> => buildScopeTree({ tenantId: TENANT, entries });

function assignmentAt(scope: string, name: string, extra: Partial<PolicyAssignment> = {}): PolicyAssignment {
  return {
    id: `${scope}/providers/Microsoft.Authorization/policyAssignments/${name}`,
    name,
    displayName: name,
    scope,
    policyDefinitionId: "/providers/Microsoft.Authorization/policySetDefinitions/set-1",
    definitionKind: "set",
    notScopes: [],
    parameters: {},
    metadata: {},
    identity: { type: "None", principalId: null, userAssigned: [] },
    enforcementMode: "Default",
    resourceSelectors: [],
    ...extra,
  };
}

const SYS = { type: "SystemAssigned", principalId: "PID-1", userAssigned: [] };
const a = assignmentAt(mg("mg-a"), "Cribl-AL-A", { identity: SYS });

function standardReads(over: Partial<Record<string, Partial<ScopeRead>>> = {}): ScopeRead[] {
  const base: ScopeRead[] = [
    { scopeId: lc(mg(TENANT)), assignments: readRows<PolicyAssignment>([]), exemptions: NO_EX() },
    { scopeId: lc(mg("mg-a")), assignments: readRows([a]), exemptions: NO_EX() },
    { scopeId: lc(sub("sub-1")), assignments: readRows([a]), exemptions: NO_EX() },
    { scopeId: lc(sub("sub-2")), assignments: readRows([a]), exemptions: NO_EX() },
  ];
  return base.map((r) => ({ ...r, ...(over[r.scopeId] ?? {}) }));
}

const grant = (scope: string): RoleGrant => ({
  scope,
  roleDefinitionId: "/providers/Microsoft.Authorization/roleDefinitions/r1",
  roleName: "Monitoring Contributor",
});

describe("buildLoggingMap: placement", () => {
  it("an assignment returned by three scope reads is set once and inherited once per descendant", () => {
    const map = buildLoggingMap(tree(), standardReads(), new Map(), new Map(), new Map(), NOW);
    expect(map.assignments).toHaveLength(1);
    const key = lc(a.id);
    expect(map.nodesById.get(lc(mg("mg-a")))?.setHere).toEqual([key]);
    expect(map.nodesById.get(lc(mg("mg-a")))?.inherited).toEqual([]);
    for (const s of ["sub-1", "sub-2"]) {
      const n = map.nodesById.get(lc(sub(s)));
      expect(n?.setHere).toEqual([]);
      expect(n?.inherited.map((i) => [i.assignmentKey, i.originId, i.coverage.state])).toEqual([
        [key, lc(mg("mg-a")), "covered"],
      ]);
    }
    expect(map.nodesById.get(lc(mg(TENANT)))?.inherited).toEqual([]);
    expect(map.assignments[0]?.summary.subscriptionsCovered).toBe(2);
  });

  it("an excluded sub carries a gap, not an inherited entry", () => {
    const ex = assignmentAt(mg("mg-a"), "Cribl-AL-A", { notScopes: [sub("sub-2")] });
    const reads: ScopeRead[] = standardReads().map((r) =>
      r.scopeId === lc(mg(TENANT)) ? r : { ...r, assignments: readRows([ex]) });
    const map = buildLoggingMap(tree(), reads, new Map(), new Map(), new Map(), NOW);
    const n = map.nodesById.get(lc(sub("sub-2")));
    expect(n?.inherited).toEqual([]);
    expect(n?.gaps.map((g) => g.coverage.state)).toEqual(["excluded"]);
  });

  it("an inherited origin the tree never listed is materialised as unread-origin and never drawn covered", () => {
    const fromUnread = assignmentAt(mg("mg-hidden"), "Other-Policy");
    const reads = standardReads({
      [lc(sub("sub-1"))]: { assignments: readRows([a, fromUnread]) },
    });
    const map = buildLoggingMap(tree(), reads, new Map(), new Map(), new Map(), NOW);
    const hidden = map.nodesById.get(lc(mg("mg-hidden")));
    expect(hidden?.node.treeRole).toBe("unread-origin");
    expect(hidden?.assignments).toEqual({ kind: "empty" });
    expect(hidden?.assignmentCount).toBeNull();
    const entry = map.assignmentsByKey.get(lc(fromUnread.id));
    expect(entry?.coverage.byScope.get(lc(mg("mg-hidden")))?.coverage.state).toBe("unknown");
    expect(entry?.coverage.byScope.get(lc(sub("sub-1")))?.coverage.state).toBe("covered");
    expect(map.counts.unreadOrigin).toBe(1);
  });
});

describe("buildLoggingMap: per-scope listings", () => {
  it("a 'read' exemptions list with 0 rows is Listing 'none' with count 0", () => {
    const map = buildLoggingMap(tree(), standardReads(), new Map(), new Map(), new Map(), NOW);
    const n = map.nodesById.get(lc(sub("sub-1")));
    expect(n?.exemptions).toEqual({ kind: "none" });
    expect(n?.exemptionCount).toBe(0);
  });

  it("a 'refused' exemptions list is Listing 'empty' with a NULL count, never 0", () => {
    const map = buildLoggingMap(
      tree(),
      standardReads({ [lc(sub("sub-1"))]: { exemptions: readRefused(REFUSED) } }),
      new Map(),
      new Map(),
      new Map(),
      NOW,
    );
    const n = map.nodesById.get(lc(sub("sub-1")));
    expect(n?.exemptions).toEqual({ kind: "empty" });
    expect(n?.exemptionCount).toBeNull();
    expect(n?.gaps.map((g) => g.coverage.state)).toEqual(["covered-exemptions-unknown"]);
    expect(map.counts.exemptionsRefused).toBe(1);
  });

  it("counts.assignmentsRefused equals refusalsOf over the assignment reads", () => {
    const reads = standardReads({
      [lc(sub("sub-1"))]: { assignments: readRefused(REFUSED) },
      [lc(sub("sub-2"))]: { assignments: readRefused(REFUSED) },
    });
    const map = buildLoggingMap(tree(), reads, new Map(), new Map(), new Map(), NOW);
    expect(map.counts.assignmentsRefused).toBe(refusalsOf(reads.map((r) => r.assignments)).length);
    expect(map.counts.assignmentsRefused).toBe(2);
    expect(map.counts.exemptionsRefused).toBe(0);
    expect(map.nodesById.get(lc(sub("sub-1")))?.assignmentCount).toBeNull();
    expect(map.nodesById.get(lc(sub("sub-1")))?.assignments).toEqual({ kind: "empty" });
  });

  it("counts scopes without placeholders, orphans under parent-unknown, and malformed rows", () => {
    const withOrphans = buildScopeTree({
      tenantId: TENANT,
      entries: [
        ...entries,
        { id: sub("sub-8"), name: "sub-8", displayName: "S8", parentId: null },
        { id: sub("sub-9"), name: "sub-9", displayName: "S9", parentId: mg("mg-gone") },
      ],
    });
    const map = buildLoggingMap(withOrphans, standardReads(), new Map(), new Map(), new Map(), NOW, { malformedRows: 3 });
    expect(map.counts.scopes).toBe(6);
    expect(map.counts.parentUnknown).toBe(2);
    expect(map.counts.malformedRows).toBe(3);
  });
});

describe("buildLoggingMap: classification, owner, roles", () => {
  it("a missing or 'unknown' classification counts as unclassified", () => {
    const b = assignmentAt(mg("mg-a"), "Other-B");
    const reads = standardReads({ [lc(mg("mg-a"))]: { assignments: readRows([a, b]) } });
    const map = buildLoggingMap(
      tree(),
      reads,
      new Map<string, { logging: string }>([[lc(a.id), { logging: "unknown" }]]),
      new Map(),
      new Map(),
      NOW,
      { isUnclassified: (c) => c.logging === "unknown" },
    );
    expect(map.counts.assignmentsUnclassified).toBe(2);
    const yes = buildLoggingMap(
      tree(),
      reads,
      new Map<string, { logging: string }>([[lc(a.id), { logging: "yes" }]]),
      new Map(),
      new Map(),
      NOW,
      { isUnclassified: (c) => c.logging === "unknown" },
    );
    expect(yes.counts.assignmentsUnclassified).toBe(1);
    expect(yes.assignmentsByKey.get(lc(a.id))?.classification).toEqual({ logging: "yes" });
  });

  it("a refused role read stays refused and is counted in rolesUnread", () => {
    const roles = new Map<string, ListRead<RoleGrant>>([[principalKey(a.scope, "PID-1"), readRefused(REFUSED)]]);
    const map = buildLoggingMap(tree(), standardReads(), new Map(), new Map(), roles, NOW);
    const entry = map.assignmentsByKey.get(lc(a.id));
    expect(entry?.roles?.state).toBe("refused");
    expect(entry?.rolesNote).toBeNull();
    expect(map.counts.rolesUnread).toBe(1);
  });

  it("a read role list keeps its grants; no read made is 'not-read', uncounted", () => {
    const key = principalKey(lc(a.scope), "pid-1");
    const roles = new Map<string, ListRead<RoleGrant>>([[key, readRows([grant(a.scope), grant(sub("sub-1"))])]]);
    const map = buildLoggingMap(tree(), standardReads(), new Map(), new Map(), roles, NOW);
    const entry = map.assignmentsByKey.get(lc(a.id));
    expect(entry?.roles).toEqual({ state: "read", rows: [grant(a.scope), grant(sub("sub-1"))] });
    expect(map.counts.rolesUnread).toBe(0);
    const none = buildLoggingMap(tree(), standardReads(), new Map(), new Map(), new Map(), NOW);
    expect(none.assignmentsByKey.get(lc(a.id))?.roles).toBeNull();
    expect(none.assignmentsByKey.get(lc(a.id))?.rolesNote).toBe("not-read");
    expect(none.counts.rolesUnread).toBe(0);
  });

  it("two principals with only one read is 'some-not-read', naming the unread one", () => {
    const both = assignmentAt(mg("mg-a"), "Both", {
      identity: {
        type: "SystemAssigned, UserAssigned",
        principalId: "PID-SYS",
        userAssigned: [{ id: "/x/cribl-diag-policy-identity", principalId: "PID-UA" }],
      },
    });
    const reads = standardReads({ [lc(mg("mg-a"))]: { assignments: readRows([both]) } });
    const roles = new Map<string, ListRead<RoleGrant>>([[principalKey(both.scope, "PID-SYS"), readRows([grant(both.scope)])]]);
    const entry = buildLoggingMap(tree(), reads, new Map(), new Map(), roles, NOW).assignmentsByKey.get(lc(both.id));
    expect(entry?.roles).toEqual({ state: "read", rows: [grant(both.scope)] });
    expect(entry?.rolesNote).toBe("some-not-read");
    expect(entry?.principalsNotRead).toEqual(["PID-UA"]);
  });

  it("a shared identity's one refused read counts once in rolesUnread, though two assignments show it", () => {
    const ua = { type: "UserAssigned", principalId: null, userAssigned: [{ id: "/x/cribl-diag-policy-identity", principalId: "PID-SHARED" }] };
    const al = assignmentAt(mg("mg-a"), "Cribl-AL-A", { identity: ua });
    const au = assignmentAt(mg("mg-a"), "Cribl-AU-A", { identity: ua });
    const reads = standardReads({ [lc(mg("mg-a"))]: { assignments: readRows([al, au]) } });
    const roles = new Map<string, ListRead<RoleGrant>>([[principalKey(mg("mg-a"), "PID-SHARED"), readRefused(REFUSED)]]);
    const map = buildLoggingMap(tree(), reads, new Map(), new Map(), roles, NOW);
    expect(map.assignmentsByKey.get(lc(al.id))?.roles?.state).toBe("refused");
    expect(map.assignmentsByKey.get(lc(au.id))?.roles?.state).toBe("refused");
    expect(map.counts.rolesUnread).toBe(1);
  });

  it("an identity with no principal id is 'principal-not-given'; no identity is 'no-identity'", () => {
    const ua = assignmentAt(mg("mg-a"), "UA", {
      identity: { type: "UserAssigned", principalId: null, userAssigned: [{ id: "/x/cribl-diag-policy-identity", principalId: null }] },
    });
    const plain = assignmentAt(mg("mg-a"), "Plain");
    const reads = standardReads({ [lc(mg("mg-a"))]: { assignments: readRows([ua, plain]) } });
    const map = buildLoggingMap(tree(), reads, new Map(), new Map(), new Map(), NOW);
    expect(map.assignmentsByKey.get(lc(ua.id))?.rolesNote).toBe("principal-not-given");
    expect(map.assignmentsByKey.get(lc(plain.id))?.rolesNote).toBe("no-identity");
  });

  it("legacyGrantedRoles is attached only when the owner is legacy", () => {
    const legacyRoles = [{ roleName: "Monitoring Contributor", at: "management group" }];
    const b = assignmentAt(mg("mg-a"), "Other-B");
    const reads = standardReads({ [lc(mg("mg-a"))]: { assignments: readRows([a, b]) } });
    const owners = new Map<string, { owner: string }>([
      [lc(a.id), { owner: "legacy" }],
      [lc(b.id), { owner: "other" }],
    ]);
    const map = buildLoggingMap(tree(), reads, new Map(), owners, new Map(), NOW, {
      isLegacyOwner: (o) => o.owner === "legacy",
      legacyGrantedRoles: legacyRoles,
    });
    expect(map.assignmentsByKey.get(lc(a.id))?.legacyGrantedRoles).toEqual(legacyRoles);
    expect(map.assignmentsByKey.get(lc(b.id))?.legacyGrantedRoles).toEqual([]);
    expect(map.assignmentsByKey.get(lc(b.id))?.ownership).toEqual({ owner: "other" });
  });

  it("principalIdsOf lists system then user-assigned principals, each once", () => {
    expect(principalIdsOf({
      type: "SystemAssigned, UserAssigned",
      principalId: "P1",
      userAssigned: [{ id: "u1", principalId: "p1" }, { id: "u2", principalId: "P2" }, { id: "u3", principalId: null }],
    })).toEqual(["P1", "P2"]);
  });
});
