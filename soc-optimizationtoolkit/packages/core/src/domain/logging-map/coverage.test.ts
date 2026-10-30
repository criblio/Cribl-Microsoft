// Pins for coverage.ts (AZR-19 U1c): inheritance, gaps, and the honest
// unknown. Every pin asserts an exact state map or exact counts, so a rule
// that stops firing changes a value the test names.

import { describe, expect, it } from "vitest";
import { readRefused, readRows, type ListRead } from "./list-read";
import type { PolicyAssignment, PolicyExemption, ScopeEntry, ScopeRead } from "./logging-map-types";
import { buildScopeTree, ensureOriginScopes, managementGroupId, PARENT_UNKNOWN_ID } from "./scope-tree";
import { coverageOf, isExpired, placementsFor, traceSummary, type AssignmentCoverage } from "./coverage";

const TENANT = "tenant-0000";
const mg = (name: string): string => managementGroupId(name);
const sub = (name: string): string => `/subscriptions/${name}`;
const lc = (s: string): string => s.toLowerCase();

/**
 * 4 levels: Tenant Root -> mg-a -> mg-b -> sub-1, sub-2, sub-3
 *                                -> mg-c -> sub-4
 */
function fourLevelEntries(): ScopeEntry[] {
  return [
    { id: mg(TENANT), name: TENANT, displayName: "Tenant Root Group", parentId: null },
    { id: mg("mg-a"), name: "mg-a", displayName: "A", parentId: mg(TENANT) },
    { id: mg("mg-b"), name: "mg-b", displayName: "B", parentId: mg("mg-a") },
    { id: mg("mg-c"), name: "mg-c", displayName: "C", parentId: mg("mg-a") },
    { id: sub("sub-1"), name: "sub-1", displayName: "S1", parentId: mg("mg-b") },
    { id: sub("sub-2"), name: "sub-2", displayName: "S2", parentId: mg("mg-b") },
    { id: sub("sub-3"), name: "sub-3", displayName: "S3", parentId: mg("mg-b") },
    { id: sub("sub-4"), name: "sub-4", displayName: "S4", parentId: mg("mg-c") },
  ];
}

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

function exemptionAt(
  scope: string,
  assignmentId: string,
  extra: Partial<PolicyExemption> = {},
): PolicyExemption {
  return {
    id: `${scope}/providers/Microsoft.Authorization/policyExemptions/ex-${scope.length}`,
    name: "ex",
    scope,
    policyAssignmentId: assignmentId,
    category: "Waiver",
    expiresOn: null,
    policyDefinitionReferenceIds: [],
    ...extra,
  };
}

const REFUSED = { request: "GET x", status: 403, code: "AuthorizationFailed", text: "denied", reason: "http" } as const;

/**
 * Every listed scope read, with `a` visible at every scope its atScope() read
 * would return it from (the origin and beneath), unless overridden.
 */
function reads(
  a: PolicyAssignment,
  over: Record<string, { assignments?: ListRead<PolicyAssignment>; exemptions?: ListRead<PolicyExemption> }> = {},
): ScopeRead[] {
  const tree = buildScopeTree({ tenantId: TENANT, entries: fourLevelEntries() });
  const origin = lc(a.scope);
  return tree.nodes.filter((n) => n.kind !== "placeholder").map((n) => {
    let beneath = n.id === origin;
    let p = n.parentId;
    while (!beneath && p !== null) {
      if (p === origin) beneath = true;
      p = tree.byId.get(p)?.parentId ?? null;
    }
    const o = over[n.id] ?? {};
    return {
      scopeId: n.id,
      assignments: o.assignments ?? readRows(beneath ? [a] : []),
      exemptions: o.exemptions ?? readRows<PolicyExemption>([]),
    };
  });
}

function states(cov: AssignmentCoverage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, sc] of cov.byScope) out[id] = sc.coverage.state;
  return out;
}

const NOW = "2026-10-26T12:00:00Z";
const tree = (): ReturnType<typeof buildScopeTree> =>
  buildScopeTree({ tenantId: TENANT, entries: fourLevelEntries() });

describe("coverageOf: inheritance and notScopes", () => {
  it("a sub notScope excludes exactly that sub; its siblings are covered; above the origin is not reached", () => {
    const a = assignmentAt(mg("mg-a"), "Cribl-AL-A", { notScopes: [sub("sub-2")] });
    const cov = coverageOf(tree(), a, reads(a), NOW);
    expect(states(cov)).toEqual({
      [lc(mg(TENANT))]: "not-reached",
      [lc(mg("mg-a"))]: "covered",
      [lc(mg("mg-b"))]: "covered",
      [lc(mg("mg-c"))]: "covered",
      [lc(sub("sub-1"))]: "covered",
      [lc(sub("sub-2"))]: "excluded",
      [lc(sub("sub-3"))]: "covered",
      [lc(sub("sub-4"))]: "covered",
    });
    expect(cov.byScope.get(lc(mg("mg-a")))?.isOrigin).toBe(true);
    expect(traceSummary(cov)).toEqual({
      subscriptionsCovered: 3,
      coveredExemptionsUnknown: 0,
      excluded: 1,
      exempt: 0,
      partial: 0,
      conditional: 0,
      unknown: 0,
      notReached: 0,
    });
  });

  it("an MG notScope excludes every descendant subscription, counted", () => {
    const a = assignmentAt(mg("mg-a"), "Cribl-AL-A", { notScopes: [mg("MG-B")] });
    const cov = coverageOf(tree(), a, reads(a), NOW);
    expect(cov.byScope.get(lc(mg("mg-b")))?.coverage).toEqual({ state: "excluded", by: lc(mg("mg-b")) });
    expect(cov.byScope.get(lc(sub("sub-3")))?.coverage).toEqual({ state: "excluded", by: lc(mg("mg-b")) });
    expect(traceSummary(cov).excluded).toBe(3);
    expect(traceSummary(cov).subscriptionsCovered).toBe(1);
  });

  it("an RG notScope beneath a subscription makes it partial with count 1", () => {
    const a = assignmentAt(mg("mg-a"), "Cribl-AL-A", { notScopes: [`${sub("sub-1")}/resourceGroups/rg-x`] });
    const cov = coverageOf(tree(), a, reads(a), NOW);
    expect(cov.byScope.get(lc(sub("sub-1")))?.coverage).toEqual({ state: "partial", belowCount: 1 });
    // The MG above is not partial: partial is a subscription-level fact.
    expect(cov.byScope.get(lc(mg("mg-b")))?.coverage.state).toBe("covered");
    expect(traceSummary(cov).partial).toBe(1);
  });

  it("resourceSelectors make coverage conditional, with regions from the selectors", () => {
    const a = assignmentAt(mg("mg-a"), "Cribl-AL-westeurope", {
      resourceSelectors: [{ name: "r", selectors: [{ kind: "resourceLocation", in: ["eastus", "eastus2"], notIn: [] }] }],
    });
    const cov = coverageOf(tree(), a, reads(a), NOW);
    // The region in the assignment NAME is never used.
    expect(cov.byScope.get(lc(sub("sub-4")))?.coverage).toEqual({ state: "conditional", regions: ["eastus", "eastus2"] });
    expect(traceSummary(cov).conditional).toBe(4);
  });
});

describe("coverageOf: exemptions and expiry", () => {
  const a = assignmentAt(mg("mg-a"), "Cribl-AL-A");

  it("an exemption expired before now: covered, with the exemption as info", () => {
    const ex = exemptionAt(sub("sub-1"), a.id, { expiresOn: "2026-10-01T00:00:00Z" });
    const cov = coverageOf(tree(), a, reads(a, { [lc(sub("sub-1"))]: { exemptions: readRows([ex]) } }), NOW);
    const sc = cov.byScope.get(lc(sub("sub-1")));
    expect(sc?.coverage.state).toBe("covered");
    expect(sc?.expiredExemptions.map((e) => e.id)).toEqual([ex.id]);
  });

  it("the same exemption expiring in the future: exempt", () => {
    const ex = exemptionAt(sub("sub-1"), a.id, { expiresOn: "2027-01-01T00:00:00Z" });
    const cov = coverageOf(tree(), a, reads(a, { [lc(sub("sub-1"))]: { exemptions: readRows([ex]) } }), NOW);
    expect(cov.byScope.get(lc(sub("sub-1")))?.coverage).toEqual({ state: "exempt", exemptionIds: [ex.id] });
    expect(cov.byScope.get(lc(sub("sub-1")))?.expiredExemptions).toEqual([]);
    expect(traceSummary(cov).exempt).toBe(1);
  });

  it("an exemption naming reference ids is partially-exempt", () => {
    const ex = exemptionAt(sub("sub-2"), a.id, { policyDefinitionReferenceIds: ["kv-diag"] });
    const cov = coverageOf(tree(), a, reads(a, { [lc(sub("sub-2"))]: { exemptions: readRows([ex]) } }), NOW);
    expect(cov.byScope.get(lc(sub("sub-2")))?.coverage).toEqual({
      state: "partially-exempt",
      exemptionIds: [ex.id],
      referenceIds: ["kv-diag"],
    });
  });

  it("a mixed-case policyAssignmentId still matches", () => {
    const ex = exemptionAt(sub("sub-1"), a.id.toUpperCase());
    const cov = coverageOf(tree(), a, reads(a, { [lc(sub("sub-1"))]: { exemptions: readRows([ex]) } }), NOW);
    expect(cov.byScope.get(lc(sub("sub-1")))?.coverage.state).toBe("exempt");
  });

  it("an exemption on an RG beneath a subscription makes it partial", () => {
    const ex = exemptionAt(`${sub("sub-3")}/resourceGroups/rg-y`, a.id);
    const cov = coverageOf(tree(), a, reads(a, { [lc(sub("sub-3"))]: { exemptions: readRows([ex]) } }), NOW);
    expect(cov.byScope.get(lc(sub("sub-3")))?.coverage).toEqual({ state: "partial", belowCount: 1 });
  });

  it("an MG-level exemption found in the MG's read exempts the subs beneath it", () => {
    const ex = exemptionAt(lc(mg("mg-c")), a.id);
    const cov = coverageOf(tree(), a, reads(a, { [lc(mg("mg-c"))]: { exemptions: readRows([ex]) } }), NOW);
    expect(cov.byScope.get(lc(sub("sub-4")))?.coverage.state).toBe("exempt");
  });

  it("a refused exemptions read is 'covered-exemptions-unknown', never plain covered", () => {
    const cov = coverageOf(tree(), a, reads(a, { [lc(sub("sub-1"))]: { exemptions: readRefused(REFUSED) } }), NOW);
    expect(cov.byScope.get(lc(sub("sub-1")))?.coverage).toEqual({ state: "covered-exemptions-unknown" });
    const s = traceSummary(cov);
    expect(s.coveredExemptionsUnknown).toBe(1);
    expect(s.subscriptionsCovered).toBe(3);
  });

  it("isExpired: at or before now is expired; null and unparseable are not", () => {
    expect(isExpired("2026-10-26T12:00:00Z", NOW)).toBe(true);
    expect(isExpired("2026-10-26T12:00:01Z", NOW)).toBe(false);
    expect(isExpired(null, NOW)).toBe(false);
    expect(isExpired("not a date", NOW)).toBe(false);
  });
});

describe("coverageOf: unknown is honest and never folded into notReached", () => {
  it("a refused assignments read on a sub, with nothing on the path proving coverage, is unknown", () => {
    // The origin mg-b's own read was refused too, so the only proof is a
    // sibling's read - which is not on sub-3's path.
    const a = assignmentAt(mg("mg-b"), "Cribl-AL-B");
    const scopeReads = reads(a, {
      [lc(mg("mg-b"))]: { assignments: readRefused(REFUSED) },
      [lc(sub("sub-3"))]: { assignments: readRefused(REFUSED), exemptions: readRefused(REFUSED) },
    });
    const cov = coverageOf(tree(), a, scopeReads, NOW);
    expect(cov.byScope.get(lc(sub("sub-3")))?.coverage).toEqual({ state: "unknown", why: "assignments-unread" });
    expect(cov.byScope.get(lc(sub("sub-1")))?.coverage.state).toBe("covered");
    expect(traceSummary(cov)).toEqual({
      subscriptionsCovered: 2,
      coveredExemptionsUnknown: 0,
      excluded: 0,
      exempt: 0,
      partial: 0,
      conditional: 0,
      unknown: 1,
      // sub-4 is under mg-c, ancestry complete to the Tenant Root: a known no.
      notReached: 1,
    });
  });

  it("a refused sub whose origin read listed the assignment is still covered (exemptions unknown)", () => {
    const a = assignmentAt(mg("mg-b"), "Cribl-AL-B");
    const scopeReads = reads(a, {
      [lc(sub("sub-3"))]: { assignments: readRefused(REFUSED), exemptions: readRefused(REFUSED) },
    });
    const cov = coverageOf(tree(), a, scopeReads, NOW);
    expect(cov.byScope.get(lc(sub("sub-3")))?.coverage.state).toBe("covered-exemptions-unknown");
  });

  it("an orphan sub with a refused read is unknown (ancestry-unknown), not 'not reached'", () => {
    const entries = [
      ...fourLevelEntries(),
      { id: sub("sub-9"), name: "sub-9", displayName: "S9", parentId: null },
    ];
    const t = buildScopeTree({ tenantId: TENANT, entries });
    expect(t.byId.get(lc(sub("sub-9")))?.parentId).toBe(PARENT_UNKNOWN_ID);
    const a = assignmentAt(mg("mg-b"), "Cribl-AL-B");
    const scopeReads: ScopeRead[] = [
      ...reads(a),
      { scopeId: lc(sub("sub-9")), assignments: readRefused(REFUSED), exemptions: readRefused(REFUSED) },
    ];
    const cov = coverageOf(t, a, scopeReads, NOW);
    expect(cov.byScope.get(lc(sub("sub-9")))?.coverage).toEqual({ state: "unknown", why: "ancestry-unknown" });
    expect(cov.byScope.has(PARENT_UNKNOWN_ID)).toBe(false);
    const s = traceSummary(cov);
    expect(s.unknown).toBe(1);
    expect(s.notReached).toBe(1);
  });

  it("an orphan sub whose own read lists the inherited assignment is covered by that evidence", () => {
    const entries = [
      ...fourLevelEntries(),
      { id: sub("sub-9"), name: "sub-9", displayName: "S9", parentId: null },
    ];
    const t = buildScopeTree({ tenantId: TENANT, entries });
    const a = assignmentAt(mg("mg-b"), "Cribl-AL-B");
    const scopeReads: ScopeRead[] = [
      ...reads(a),
      { scopeId: lc(sub("sub-9")), assignments: readRows([a]), exemptions: readRows<PolicyExemption>([]) },
    ];
    expect(coverageOf(t, a, scopeReads, NOW).byScope.get(lc(sub("sub-9")))?.coverage.state).toBe("covered");
  });
});

describe("coverageOf: an unread origin above the readable tree (fallback start)", () => {
  // The Tenant Root could not be read, so the tree starts at mg-a:
  //   mg-a -> mg-b -> sub-1
  //        -> sub-2
  // The assignment is set at the Tenant Root, which exists only as an
  // unread-origin placeholder; every readable atScope() read lists it.
  const fallbackEntries: ScopeEntry[] = [
    { id: mg("mg-a"), name: "mg-a", displayName: "A", parentId: null },
    { id: mg("mg-b"), name: "mg-b", displayName: "B", parentId: mg("mg-a") },
    { id: sub("sub-1"), name: "sub-1", displayName: "S1", parentId: mg("mg-b") },
    { id: sub("sub-2"), name: "sub-2", displayName: "S2", parentId: mg("mg-a") },
  ];
  const fallbackTree = (): ReturnType<typeof buildScopeTree> =>
    ensureOriginScopes(buildScopeTree({ tenantId: TENANT, entries: fallbackEntries }), [mg(TENANT)]);
  const listing = (a: PolicyAssignment, ids: string[], over: Record<string, Partial<ScopeRead>> = {}): ScopeRead[] =>
    ids.map((id) => ({
      scopeId: lc(id),
      assignments: readRows([a]),
      exemptions: readRows<PolicyExemption>([]),
      ...(over[lc(id)] ?? {}),
    }));

  it("a notScope on a visible MG excludes the subscription beneath it, though the origin is not linked", () => {
    const a = assignmentAt(mg(TENANT), "Root-Diag", { notScopes: [mg("mg-b")] });
    const t = fallbackTree();
    // The origin is in the tree, but nothing is linked under it.
    expect(t.byId.get(lc(mg(TENANT)))?.treeRole).toBe("unread-origin");
    expect(t.byId.get(lc(mg("mg-a")))?.parentId).not.toBe(lc(mg(TENANT)));
    const cov = coverageOf(t, a, listing(a, [mg("mg-a"), mg("mg-b"), sub("sub-1"), sub("sub-2")]), NOW);
    expect(cov.byScope.get(lc(mg("mg-b")))?.coverage).toEqual({ state: "excluded", by: lc(mg("mg-b")) });
    expect(cov.byScope.get(lc(sub("sub-1")))?.coverage).toEqual({ state: "excluded", by: lc(mg("mg-b")) });
    expect(cov.byScope.get(lc(sub("sub-2")))?.coverage).toEqual({ state: "covered" });
    const s = traceSummary(cov);
    expect(s.excluded).toBe(1);
    expect(s.subscriptionsCovered).toBe(1);
  });

  it("a refused sub under a readable MG that lists the assignment is covered-exemptions-unknown, not ancestry-unknown", () => {
    const a = assignmentAt(mg(TENANT), "Root-Diag");
    const scopeReads = listing(a, [mg("mg-a"), mg("mg-b"), sub("sub-1"), sub("sub-2")], {
      [lc(sub("sub-2"))]: { assignments: readRefused(REFUSED), exemptions: readRefused(REFUSED) },
    });
    const cov = coverageOf(fallbackTree(), a, scopeReads, NOW);
    expect(cov.byScope.get(lc(sub("sub-2")))?.coverage).toEqual({ state: "covered-exemptions-unknown" });
    // The unread origin itself has no read: honestly unknown.
    expect(cov.byScope.get(lc(mg(TENANT)))?.coverage).toEqual({ state: "unknown", why: "assignments-unread" });
    expect(traceSummary(cov).coveredExemptionsUnknown).toBe(1);
    expect(traceSummary(cov).unknown).toBe(0);
  });
});

describe("coverageOf: secondary gap facts and expired info beneath a subscription", () => {
  it("an RG notScope survives a refused exemptions read as belowCount", () => {
    const a = assignmentAt(mg("mg-a"), "Cribl-AL-A", { notScopes: [`${sub("sub-1")}/resourceGroups/rg-x`] });
    const cov = coverageOf(tree(), a, reads(a, { [lc(sub("sub-1"))]: { exemptions: readRefused(REFUSED) } }), NOW);
    expect(cov.byScope.get(lc(sub("sub-1")))?.coverage).toEqual({ state: "covered-exemptions-unknown", belowCount: 1 });
  });

  it("selectors survive a refused exemptions read as regions", () => {
    const a = assignmentAt(mg("mg-a"), "Cribl-AL-A", {
      resourceSelectors: [{ name: "r", selectors: [{ kind: "resourceLocation", in: ["eastus"], notIn: [] }] }],
    });
    const cov = coverageOf(tree(), a, reads(a, { [lc(sub("sub-1"))]: { exemptions: readRefused(REFUSED) } }), NOW);
    expect(cov.byScope.get(lc(sub("sub-1")))?.coverage).toEqual({ state: "covered-exemptions-unknown", regions: ["eastus"] });
  });

  it("partial keeps the regions when selectors are also present", () => {
    const a = assignmentAt(mg("mg-a"), "Cribl-AL-A", {
      notScopes: [`${sub("sub-1")}/resourceGroups/rg-x`],
      resourceSelectors: [{ name: "r", selectors: [{ kind: "resourceLocation", in: ["eastus"], notIn: [] }] }],
    });
    const cov = coverageOf(tree(), a, reads(a), NOW);
    expect(cov.byScope.get(lc(sub("sub-1")))?.coverage).toEqual({ state: "partial", belowCount: 1, regions: ["eastus"] });
    expect(cov.byScope.get(lc(sub("sub-2")))?.coverage).toEqual({ state: "conditional", regions: ["eastus"] });
  });

  it("an expired RG-level exemption beneath a subscription is reported as info, not dropped", () => {
    const a = assignmentAt(mg("mg-a"), "Cribl-AL-A");
    const ex = exemptionAt(`${sub("sub-1")}/resourceGroups/rg-y`, a.id, { expiresOn: "2026-01-01T00:00:00Z" });
    const cov = coverageOf(tree(), a, reads(a, { [lc(sub("sub-1"))]: { exemptions: readRows([ex]) } }), NOW);
    const sc = cov.byScope.get(lc(sub("sub-1")));
    expect(sc?.coverage).toEqual({ state: "covered" });
    expect(sc?.expiredExemptions.map((e) => e.id)).toEqual([ex.id]);
  });
});

describe("placementsFor", () => {
  it("dedupes an assignment returned by several scope reads, case-insensitively", () => {
    const a = assignmentAt(mg("mg-b"), "Cribl-AL-B");
    const upper = { ...a, id: a.id.toUpperCase() };
    const p = placementsFor([
      { scopeId: mg("mg-b"), assignments: readRows([a]), exemptions: readRows<PolicyExemption>([]) },
      { scopeId: sub("sub-1"), assignments: readRows([upper]), exemptions: readRows<PolicyExemption>([]) },
      { scopeId: sub("sub-2"), assignments: readRefused(REFUSED), exemptions: readRows<PolicyExemption>([]) },
    ]);
    expect(p).toHaveLength(1);
    expect(p[0]?.originId).toBe(lc(mg("mg-b")));
    expect(p[0]?.seenAt).toEqual([lc(mg("mg-b")), lc(sub("sub-1"))]);
  });
});
