/**
 * logging-map-state pins (AZR-19). The overview (collapse / fold) and trace
 * pins run on the REAL core tree builder and map builder over ListRead
 * fixtures. The selector pins (shown, chips, outline, counts) use a small
 * hand-built map from core TYPES, because they only read fields core passes
 * through. Ids are synthetic ARM-shaped strings, lower-case as core keeps them.
 */

import { describe, expect, it } from "vitest";
import { buildLoggingMap, buildScopeTree, readRefused, readRows } from "@soc/core";
import type {
  CoverageState,
  Listing,
  ListRead,
  LoggingClass,
  MapNode,
  Ownership,
  PolicyAssignment,
  PolicyExemption,
  Refusal,
  ScopeCoverage,
  ScopeEntry,
  ScopeKind,
  ScopeNode,
  ScopeRead,
} from "@soc/core";

import {
  COUNT_CARD_PREFIX,
  MAX_VISIBLE_SCOPES,
  UNKNOWN_COUNT,
  diagramGraph,
  expandPathTo,
  formatCount,
  hiddenLabel,
  initialCollapsed,
  initialState,
  loggingMapReducer,
  outlineKey,
  scopeChips,
  searchMatches,
  shownAssignments,
  toolbarCounts,
  traceView,
  visibleScopes,
  type UiLoggingMap,
  type UiMapAssignment,
} from "./logging-map-state";

// ================================================================ fixture
const TENANT = "00000000-0000-0000-0000-00000000aaaa";
const PARENT_UNKNOWN = "placeholder:parent-unknown";

const mg = (name: string): string => `/providers/microsoft.management/managementgroups/${name}`;
const sub = (n: number | string): string => `/subscriptions/${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;

function scope(
  id: string,
  kind: ScopeKind,
  parentId: string | null,
  extra: Partial<ScopeNode> = {},
): ScopeNode {
  const name = id.split("/").pop() ?? id;
  return { id, kind, name, displayName: name, parentId, treeRole: "listed", ...extra };
}

interface AssignmentSpec {
  readonly key: string;
  readonly origin: string;
  readonly name?: string;
  /** null means no classification was supplied (unclassified). */
  readonly verdict: "yes" | "no" | "unknown" | null;
  readonly owner: "ours" | "other";
  /** Coverage per scope id; the origin entry is added automatically as covered + isOrigin. */
  readonly coverage?: Readonly<Record<string, CoverageState>>;
}

function classOf(v: AssignmentSpec["verdict"]): LoggingClass | null {
  if (v === "yes") return { verdict: "yes", destinations: ["event-hub"], basis: "definition" };
  if (v === "no") return { verdict: "no", reason: "not-diagnostic-settings", effect: null };
  if (v === "unknown") {
    return { verdict: "unknown", reason: "definition-not-read", unread: ["/x"], knownDestinations: [] };
  }
  return null;
}

function ownerOf(o: AssignmentSpec["owner"]): Ownership {
  return o === "ours"
    ? { owner: "ours", strength: "legacy-strong", evidence: [] }
    : { owner: "other", strength: "none", evidence: [] };
}

function assignmentOf(spec: AssignmentSpec): PolicyAssignment {
  return {
    id: spec.key,
    name: spec.name ?? spec.key.split("/").pop() ?? spec.key,
    displayName: spec.name ?? "",
    scope: spec.origin,
    policyDefinitionId: "/providers/microsoft.authorization/policydefinitions/x",
    definitionKind: "policy",
    notScopes: [],
    parameters: {},
    metadata: {},
    identity: { type: "None", principalId: null, userAssigned: [] },
    enforcementMode: "Default",
    resourceSelectors: [],
  };
}

const EMPTY_SUMMARY = {
  subscriptionsCovered: 0,
  coveredExemptionsUnknown: 0,
  excluded: 0,
  exempt: 0,
  partial: 0,
  conditional: 0,
  unknown: 0,
  notReached: 0,
};

interface MapOptions {
  /** Scopes whose assignments list was refused (Listing kind `empty`, null count). */
  readonly refused?: readonly string[];
}

/** Assemble a map from scope nodes (tree order) and assignment specs. */
function makeMap(
  nodes: readonly ScopeNode[],
  specs: readonly AssignmentSpec[] = [],
  options: MapOptions = {},
): UiLoggingMap {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of nodes) {
    if (n.parentId === null || !byId.has(n.parentId)) {
      roots.push(n.id);
      continue;
    }
    const kids = childrenOf.get(n.parentId) ?? [];
    kids.push(n.id);
    childrenOf.set(n.parentId, kids);
  }
  const assignments: UiMapAssignment[] = specs.map((spec) => {
    const byScope = new Map<string, ScopeCoverage>();
    byScope.set(spec.origin, {
      scopeId: spec.origin,
      kind: byId.get(spec.origin)?.kind ?? "management-group",
      coverage: { state: "covered" },
      isOrigin: true,
      expiredExemptions: [],
    });
    for (const [id, coverage] of Object.entries(spec.coverage ?? {})) {
      if (id === spec.origin) continue;
      byScope.set(id, {
        scopeId: id,
        kind: byId.get(id)?.kind ?? "subscription",
        coverage,
        isOrigin: false,
        expiredExemptions: [],
      });
    }
    const classification = classOf(spec.verdict);
    return {
      assignment: assignmentOf(spec),
      assignmentKey: spec.key,
      originId: spec.origin,
      classification,
      unclassified: classification === null || classification.verdict === "unknown",
      ownership: ownerOf(spec.owner),
      identity: { type: "None", principalId: null, userAssigned: [] },
      principalIds: [],
      roles: null,
      rolesNote: "no-identity",
      principalsNotRead: [],
      legacyGrantedRoles: [],
      coverage: { assignmentKey: spec.key, originId: spec.origin, byScope },
      summary: EMPTY_SUMMARY,
    };
  });
  const refused = new Set(options.refused ?? []);
  const mapNodes: MapNode[] = nodes.map((node) => {
    const setHere = assignments.filter((a) => a.originId === node.id).map((a) => a.assignmentKey);
    const inherited = assignments.flatMap((a) => {
      const sc = a.coverage.byScope.get(node.id);
      if (sc === undefined || sc.isOrigin) return [];
      const s = sc.coverage.state;
      if (s === "not-reached" || s === "excluded" || s === "unknown") return [];
      return [{ assignmentKey: a.assignmentKey, originId: a.originId, coverage: sc.coverage }];
    });
    const isRefused = refused.has(node.id);
    const listing: Listing<PolicyAssignment> = isRefused
      ? { kind: "empty" }
      : setHere.length === 0
        ? { kind: "none" }
        : {
            kind: "rows",
            rows: assignments
              .filter((a) => a.originId === node.id)
              .map((a) => a.assignment) as unknown as readonly [PolicyAssignment, ...PolicyAssignment[]],
          };
    const exemptions: Listing<PolicyExemption> = isRefused ? { kind: "empty" } : { kind: "none" };
    return {
      node,
      setHere,
      inherited,
      gaps: [],
      assignments: listing,
      exemptions,
      assignmentCount: isRefused ? null : setHere.length,
      exemptionCount: isRefused ? null : 0,
    };
  });
  return {
    tree: { tenantId: TENANT, nodes, byId, childrenOf, roots },
    nodes: mapNodes,
    nodesById: new Map(mapNodes.map((n) => [n.node.id, n])),
    assignments,
    assignmentsByKey: new Map(assignments.map((a) => [a.assignmentKey, a])),
    counts: {
      scopes: nodes.filter((n) => n.kind !== "placeholder").length,
      assignmentsRefused: refused.size,
      exemptionsRefused: refused.size,
      unreadOrigin: nodes.filter((n) => n.treeRole === "unread-origin").length,
      parentUnknown: childrenOf.get(PARENT_UNKNOWN)?.length ?? 0,
      assignmentsUnclassified: assignments.filter((a) => a.unclassified).length,
      rolesUnread: 0,
      malformedRows: 0,
    },
  };
}

/**
 * A four-level tree:
 *   root (tenant-root, d1)
 *     grp-a (d2)
 *       grp-a1 (d3, MG with 1 sub)  - sub 1
 *     grp-b (d2)
 *       grp-b1 (d3, MG with 2 subs)         - sub 2, sub 3
 *       grp-b2 (d3, MG, no children)
 *     sub 4 (d2, directly under root)
 */
function fourLevelNodes(): ScopeNode[] {
  const root = mg(TENANT);
  return [
    scope(root, "tenant-root", null, { displayName: "Tenant Root Group" }),
    scope(mg("grp-a"), "management-group", root),
    scope(mg("grp-a1"), "management-group", mg("grp-a")),
    scope(sub(1), "subscription", mg("grp-a1")),
    scope(mg("grp-b"), "management-group", root),
    scope(mg("grp-b1"), "management-group", mg("grp-b")),
    scope(sub(2), "subscription", mg("grp-b1")),
    scope(sub(3), "subscription", mg("grp-b1")),
    scope(mg("grp-b2"), "management-group", mg("grp-b")),
    scope(sub(4), "subscription", root),
  ];
}

// ================================================================ pins

const ROOT = mg(TENANT);
const ids = (set: ReadonlySet<string>): string[] => [...set].sort();

// ================================================================ real core
// The overview and trace pins below run on the REAL core: buildScopeTree +
// buildLoggingMap over ListRead fixtures, so they see exactly the coverage
// and tree shapes core produces (a hand-assembled map hid an origin-precedence
// defect once).

const NOW = "2026-10-26T12:00:00Z";
const REFUSED: Refusal = { request: "GET x", status: 403, code: "AuthorizationFailed", text: "denied", reason: "http" };
const refusedRead = <T>(): ListRead<T> => readRefused<T>(REFUSED);

function entriesOf(nodes: readonly ScopeNode[]): ScopeEntry[] {
  return nodes
    .filter((n) => n.kind !== "placeholder")
    .map((n) => ({
      id: n.id,
      name: n.name,
      displayName: n.displayName,
      parentId: n.parentId === PARENT_UNKNOWN ? null : n.parentId,
    }));
}

function realMap(entries: readonly ScopeEntry[], reads: readonly ScopeRead[] = []): UiLoggingMap {
  const tree = buildScopeTree({ tenantId: TENANT, entries });
  return buildLoggingMap<LoggingClass, Ownership>(tree, reads, new Map(), new Map(), new Map(), NOW);
}

function realAssignment(scopeId: string, name: string, extra: Partial<PolicyAssignment> = {}): PolicyAssignment {
  return {
    ...assignmentOf({ key: `${scopeId}/providers/microsoft.authorization/policyassignments/${name}`, origin: scopeId, verdict: null, owner: "other" }),
    name,
    displayName: name,
    ...extra,
  };
}

const keyOf = (a: PolicyAssignment): string => a.id.toLowerCase();

describe("initialCollapsed and initialFolded (real core): overview and scale rule", () => {
  it("collapses exactly the depth-3 management groups that have children", () => {
    const map = realMap(entriesOf(fourLevelNodes()));
    // grp-b2 is depth 3 but has no children: nothing to collapse.
    expect(ids(initialCollapsed(map))).toEqual([mg("grp-a1"), mg("grp-b1")].sort());
    expect(ids(initialState(map).folded)).toEqual([]);
  });

  it("collapses a depth-3 group and every deeper group with children, not depth-2 ones", () => {
    const nodes = [
      ...fourLevelNodes(),
      scope(mg("grp-b1x"), "management-group", mg("grp-b1")),
      scope(sub(9), "subscription", mg("grp-b1x")),
    ];
    expect(ids(initialCollapsed(realMap(entriesOf(nodes))))).toEqual(
      [mg("grp-a1"), mg("grp-b1"), mg("grp-b1x")].sort(),
    );
  });

  function flat(count: number): UiLoggingMap {
    const entries: ScopeEntry[] = [];
    // No parent given: core hangs them all under the parent-unknown holder.
    for (let i = 1; i <= count; i++) entries.push({ id: sub(i), name: `s${i}`, displayName: `S${i}`, parentId: null });
    return realMap(entries);
  }

  it(`keeps ${MAX_VISIBLE_SCOPES} visible subscriptions unfolded (the holder is not a scope)`, () => {
    const map = flat(MAX_VISIBLE_SCOPES);
    expect(map.tree.roots).toEqual([PARENT_UNKNOWN]);
    expect(ids(initialState(map).folded)).toEqual([]);
  });

  it(`folds subscriptions into their parent's count at ${MAX_VISIBLE_SCOPES + 1}`, () => {
    const map = flat(MAX_VISIBLE_SCOPES + 1);
    const s = initialState(map);
    expect(ids(s.collapsed)).toEqual([]);
    expect(ids(s.folded)).toEqual([PARENT_UNKNOWN]);
    const rows = visibleScopes(map, s.collapsed, s.folded);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.foldedSubscriptions).toBe(MAX_VISIBLE_SCOPES + 1);
  });

  it("a big tenant keeps the Tenant Root AND its child group drawn; only subscriptions fold", () => {
    // Tenant Root holds one subscription directly (Azure's default home for
    // new subscriptions) and a child group holding 70.
    const entries: ScopeEntry[] = [
      { id: ROOT, name: TENANT, displayName: "Tenant Root Group", parentId: null },
      { id: sub(1), name: "s1", displayName: "S1", parentId: ROOT },
      { id: mg("big"), name: "big", displayName: "Big", parentId: ROOT },
    ];
    for (let i = 100; i < 170; i++) entries.push({ id: sub(i), name: `s${i}`, displayName: `S${i}`, parentId: mg("big") });
    const map = realMap(entries);
    const s = initialState(map);
    expect(ids(s.collapsed)).toEqual([]);
    expect(ids(s.folded)).toEqual([ROOT, mg("big")].sort());

    const rows = visibleScopes(map, s.collapsed, s.folded);
    expect(rows.map((r) => [r.id, r.collapsed, r.foldedSubscriptions])).toEqual([
      [ROOT, false, 1],
      [mg("big"), false, 70],
    ]);

    const g = diagramGraph(map, s);
    expect(g.cards.map((c) => [c.id, c.kind, c.countOf, c.title])).toEqual([
      [ROOT, "scope", null, "Tenant Root Group"],
      [`${COUNT_CARD_PREFIX}${ROOT}`, "count", "folded", "1 subscription"],
      [mg("big"), "scope", null, "Big"],
      [`${COUNT_CARD_PREFIX}${mg("big")}`, "count", "folded", "70 subscriptions"],
    ]);
  });

  it("toggle-folded reveals a group's subscriptions; search unfolds just the match's parent", () => {
    const entries: ScopeEntry[] = [
      { id: ROOT, name: TENANT, displayName: "Tenant Root Group", parentId: null },
      { id: mg("big"), name: "big", displayName: "Big", parentId: ROOT },
      { id: mg("other"), name: "other", displayName: "Other", parentId: ROOT },
    ];
    for (let i = 100; i < 140; i++) entries.push({ id: sub(i), name: `s${i}`, displayName: `S${i}`, parentId: mg("big") });
    for (let i = 200; i < 230; i++) entries.push({ id: sub(i), name: `t${i}`, displayName: `T${i}`, parentId: mg("other") });
    const map = realMap(entries);
    const s0 = initialState(map);
    expect(ids(s0.folded)).toEqual([mg("big"), mg("other")].sort());

    const s1 = loggingMapReducer(s0, { type: "search", query: "T215", map });
    expect(s1.selectedScope).toBe(sub(215));
    expect(ids(s1.folded)).toEqual([mg("big")]);

    const s2 = loggingMapReducer(s0, { type: "toggle-folded", scopeId: mg("big"), map });
    expect(visibleScopes(map, s2.collapsed, s2.folded).filter((r) => r.parentId === mg("big"))).toHaveLength(40);
    // Nothing to fold under the root (no subscription children): no-op.
    expect(loggingMapReducer(s0, { type: "toggle-folded", scopeId: ROOT, map })).toBe(s0);
  });

  it("outline ArrowRight on a folded group unfolds it, then enters its first visible child", () => {
    const entries: ScopeEntry[] = [{ id: ROOT, name: TENANT, displayName: "Tenant Root Group", parentId: null }];
    for (let i = 1; i <= MAX_VISIBLE_SCOPES + 5; i++) entries.push({ id: sub(i), name: `s${i}`, displayName: `S${i}`, parentId: ROOT });
    const map = realMap(entries);
    const s0 = initialState(map);
    expect(s0.folded.has(ROOT)).toBe(true);
    const s1 = outlineKey(map, s0, "ArrowRight");
    expect(s1.folded.has(ROOT)).toBe(false);
    expect(s1.selectedScope).toBe(ROOT);
    expect(outlineKey(map, s1, "ArrowRight").selectedScope).toBe(sub(1));
  });

  it("initialState: inherited on, all-policy off, root selected, nothing traced", () => {
    const s = initialState(realMap(entriesOf(fourLevelNodes())));
    expect(s.showInherited).toBe(true);
    expect(s.showAll).toBe(false);
    expect(s.selectedScope).toBe(ROOT);
    expect(s.tracedAssignment).toBeNull();
  });
});

describe("traceView (real core): the coverage state decides the mark", () => {
  /*
   * root (read) -> mg-a (assignments REFUSED) -> sub 1 (read), sub 2 (all REFUSED)
   *             -> mg-b (read, whole exemption for X at mg-b) -> sub 3 (read)
   *             -> mg-c (assignments read, exemptions REFUSED)
   *             -> sub 4 (read)
   * plus sub 5 with no parent (the parent-unknown holder), and mg "hidden",
   * seen only as the origin of Z in sub 1's read (an unread-origin node).
   */
  const W = realAssignment(mg("mg-a"), "W");
  const X = realAssignment(mg("mg-b"), "X");
  const Y = realAssignment(mg("mg-c"), "Y");
  const Z = realAssignment(mg("hidden"), "Z");
  const V = realAssignment(ROOT, "V", {
    resourceSelectors: [{ name: "r", selectors: [{ kind: "resourceLocation", in: ["westeurope"], notIn: [] }] }],
  });
  const Q = realAssignment(sub(4), "Q");
  const exX: PolicyExemption = {
    id: `${mg("mg-b")}/providers/microsoft.authorization/policyexemptions/ex-x`,
    name: "ex-x",
    scope: mg("mg-b"),
    policyAssignmentId: X.id,
    category: "Waiver",
    expiresOn: null,
    policyDefinitionReferenceIds: [],
  };
  const entries: ScopeEntry[] = [
    { id: ROOT, name: TENANT, displayName: "Tenant Root Group", parentId: null },
    { id: mg("mg-a"), name: "mg-a", displayName: "A", parentId: ROOT },
    { id: sub(1), name: "s1", displayName: "S1", parentId: mg("mg-a") },
    { id: sub(2), name: "s2", displayName: "S2", parentId: mg("mg-a") },
    { id: mg("mg-b"), name: "mg-b", displayName: "B", parentId: ROOT },
    { id: sub(3), name: "s3", displayName: "S3", parentId: mg("mg-b") },
    { id: mg("mg-c"), name: "mg-c", displayName: "C", parentId: ROOT },
    { id: sub(4), name: "s4", displayName: "S4", parentId: ROOT },
    { id: sub(5), name: "s5", displayName: "S5", parentId: null },
  ];
  const none = <T>(): ListRead<T> => readRows<T>([]);
  const reads: ScopeRead[] = [
    { scopeId: ROOT, assignments: readRows([V]), exemptions: none() },
    { scopeId: mg("mg-a"), assignments: refusedRead(), exemptions: none() },
    { scopeId: sub(1), assignments: readRows([W, Z, V]), exemptions: none() },
    { scopeId: sub(2), assignments: refusedRead(), exemptions: refusedRead() },
    { scopeId: mg("mg-b"), assignments: readRows([X, V]), exemptions: readRows([exX]) },
    { scopeId: sub(3), assignments: readRows([X, V]), exemptions: none() },
    { scopeId: mg("mg-c"), assignments: readRows([Y, V]), exemptions: refusedRead() },
    { scopeId: sub(4), assignments: readRows([Q, V]), exemptions: none() },
    { scopeId: sub(5), assignments: none(), exemptions: none() },
  ];
  const map = realMap(entries, reads);
  const mark = (a: PolicyAssignment, scopeId: string): string | undefined =>
    traceView(map, { tracedAssignment: keyOf(a) })?.get(scopeId);
  const coreState = (a: PolicyAssignment, scopeId: string): string | undefined =>
    map.assignmentsByKey.get(keyOf(a))?.coverage.byScope.get(scopeId)?.coverage.state;

  it("an exempt origin is gap-exempt, not a plain origin", () => {
    expect(coreState(X, mg("mg-b"))).toBe("exempt");
    expect(mark(X, mg("mg-b"))).toBe("gap-exempt");
    expect(mark(X, sub(3))).toBe("gap-exempt");
  });

  it("an origin whose exemptions read was refused is covered-exemptions-unknown", () => {
    expect(coreState(Y, mg("mg-c"))).toBe("covered-exemptions-unknown");
    expect(mark(Y, mg("mg-c"))).toBe("covered-exemptions-unknown");
  });

  it("an unread-origin management group is unknown", () => {
    const hidden = map.tree.byId.get(mg("hidden"));
    expect(hidden?.treeRole).toBe("unread-origin");
    expect(coreState(Z, mg("hidden"))).toBe("unknown");
    expect(mark(Z, mg("hidden"))).toBe("unknown");
  });

  it("a refused assignments read gives core unknown and the unknown mark, never dimmed", () => {
    // W is set at mg-a, whose list was refused; sub 2's list was refused too.
    expect(coreState(W, mg("mg-a"))).toBe("unknown");
    expect(mark(W, mg("mg-a"))).toBe("unknown");
    expect(coreState(W, sub(2))).toBe("unknown");
    expect(mark(W, sub(2))).toBe("unknown");
    expect(mark(W, sub(1))).toBe("covered");
  });

  it("resourceSelectors at the origin give conditional; a clean origin is origin", () => {
    expect(mark(V, ROOT)).toBe("conditional");
    expect(coreState(Q, sub(4))).toBe("covered");
    expect(mark(Q, sub(4))).toBe("origin");
  });

  it("a read scope the assignment does not reach is dimmed; so is the parent-unknown holder", () => {
    expect(coreState(W, sub(4))).toBe("not-reached");
    expect(mark(W, sub(4))).toBe("dimmed");
    expect(map.tree.byId.get(PARENT_UNKNOWN)?.kind).toBe("placeholder");
    expect(mark(W, PARENT_UNKNOWN)).toBe("dimmed");
  });

  it("nothing traced, or an unknown key, gives null", () => {
    expect(traceView(map, { tracedAssignment: null })).toBeNull();
    expect(traceView(map, { tracedAssignment: "nope" })).toBeNull();
  });
});

describe("visibleScopes and diagramGraph", () => {
  it("skips the children of a collapsed node and reports what it hides", () => {
    const map = makeMap(fourLevelNodes());
    const rows = visibleScopes(map, new Set([mg("grp-b")]));
    expect(rows.map((r) => r.id)).toEqual([ROOT, mg("grp-a"), mg("grp-a1"), sub(1), mg("grp-b"), sub(4)]);
    const groupB = rows.find((r) => r.id === mg("grp-b"));
    expect(groupB?.hidden).toEqual({ managementGroups: 2, subscriptions: 2 });
    expect(rows.map((r) => r.depth)).toEqual([1, 2, 3, 4, 2, 2]);
  });

  it("turns a collapsed group into ONE count card with an edge from its parent", () => {
    const map = makeMap(fourLevelNodes());
    const state = { ...initialState(map), collapsed: new Set([mg("grp-b1")]) };
    const g = diagramGraph(map, state);
    const counts = g.cards.filter((c) => c.kind === "count");
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ id: `${COUNT_CARD_PREFIX}${mg("grp-b1")}`, title: "2 subscriptions" });
    expect(g.edges).toContainEqual({ from: mg("grp-b1"), to: `${COUNT_CARD_PREFIX}${mg("grp-b1")}` });
    expect(g.cards.some((c) => c.id === sub(2) || c.id === sub(3))).toBe(false);
    // One edge per visible non-root card.
    expect(g.edges).toHaveLength(g.cards.length - 1);
  });

  it("hiddenLabel pluralises and names both kinds", () => {
    expect(hiddenLabel({ managementGroups: 1, subscriptions: 4 })).toBe("1 management group, 4 subscriptions");
    expect(hiddenLabel({ managementGroups: 0, subscriptions: 1 })).toBe("1 subscription");
  });
});

describe("shown: ours plus logging-related, unclassified always", () => {
  const specs: AssignmentSpec[] = [
    { key: "a-ours-no", origin: ROOT, verdict: "no", owner: "ours" },
    { key: "a-other-yes", origin: ROOT, verdict: "yes", owner: "other" },
    { key: "a-other-no", origin: ROOT, verdict: "no", owner: "other" },
    { key: "a-other-unread", origin: ROOT, verdict: "unknown", owner: "other" },
    { key: "a-other-null", origin: ROOT, verdict: null, owner: "other" },
  ];
  const map = makeMap(fourLevelNodes(), specs);

  it("hides only the other owner's non-logging assignment by default", () => {
    expect(shownAssignments(map, { showAll: false }).map((a) => a.assignmentKey)).toEqual([
      "a-ours-no",
      "a-other-yes",
      "a-other-unread",
      "a-other-null",
    ]);
  });

  it("All policy reveals it", () => {
    expect(shownAssignments(map, { showAll: true })).toHaveLength(5);
  });

  it("toolbar counts what the view shows", () => {
    expect(toolbarCounts(map, { showAll: false, selectedScope: ROOT }).shown).toBe(4);
  });
});

describe("scopeChips: set here and inherited", () => {
  const specs: AssignmentSpec[] = [
    { key: "a-root", origin: ROOT, verdict: "yes", owner: "ours", coverage: { [mg("grp-a")]: { state: "covered" } } },
    { key: "a-plat", origin: mg("grp-a"), verdict: "yes", owner: "other" },
  ];
  const map = makeMap(fourLevelNodes(), specs);

  it("shows set-here first, then inherited with its origin", () => {
    const chips = scopeChips(map, { showAll: false, showInherited: true }, mg("grp-a"));
    expect(chips.map((c) => [c.entry.assignmentKey, c.inherited, c.originId])).toEqual([
      ["a-plat", false, mg("grp-a")],
      ["a-root", true, ROOT],
    ]);
  });

  it("showInherited=false keeps the set-here chips and drops only inherited", () => {
    const chips = scopeChips(map, { showAll: false, showInherited: false }, mg("grp-a"));
    expect(chips.map((c) => c.entry.assignmentKey)).toEqual(["a-plat"]);
  });
});


describe("expandPathTo, trace and search", () => {
  it("uncollapses exactly the ancestors of the target", () => {
    const nodes = [
      ...fourLevelNodes(),
      scope(mg("grp-b1x"), "management-group", mg("grp-b1")),
      scope(sub(9), "subscription", mg("grp-b1x")),
    ];
    const map = makeMap(nodes);
    const collapsed = new Set([mg("grp-b"), mg("grp-b1"), mg("grp-b1x"), mg("grp-a1")]);
    const next = expandPathTo(map, collapsed, mg("grp-b1x"));
    // grp-b and grp-b1 are ancestors; grp-b1x itself and grp-a1 (a cousin) stay collapsed.
    expect(ids(next)).toEqual([mg("grp-a1"), mg("grp-b1x")].sort());
  });

  it("trace selects the origin and opens the path to it", () => {
    const map = makeMap(fourLevelNodes(), [{ key: "a-grp-b1", origin: mg("grp-b1"), verdict: "yes", owner: "ours" }]);
    const s0 = { ...initialState(map), collapsed: new Set([mg("grp-b")]) };
    const s1 = loggingMapReducer(s0, { type: "trace", assignmentKey: "a-grp-b1", map });
    expect(s1.tracedAssignment).toBe("a-grp-b1");
    expect(s1.selectedScope).toBe(mg("grp-b1"));
    expect(ids(s1.collapsed)).toEqual([]);
  });

  it("search expands the path to every match and selects the first", () => {
    const map = makeMap(fourLevelNodes(), [
      { key: "a-x", origin: sub(3), name: "Needle-Policy", verdict: "yes", owner: "ours" },
    ]);
    const s0 = initialState(map);
    expect(s0.collapsed.has(mg("grp-b1"))).toBe(true);
    const s1 = loggingMapReducer(s0, { type: "search", query: "needle", map });
    expect(s1.selectedScope).toBe(sub(3));
    expect(s1.collapsed.has(mg("grp-b1"))).toBe(false);
    expect(s1.collapsed.has(mg("grp-a1"))).toBe(true);
    expect(searchMatches(map, "   ")).toEqual([]);
  });
});

describe("outline navigation", () => {
  const map = makeMap(fourLevelNodes());
  const open = { ...initialState(map), collapsed: new Set<string>() };

  it("ArrowLeft on a subscription moves to its management group", () => {
    const s = outlineKey(map, { ...open, selectedScope: sub(2) }, "ArrowLeft");
    expect(s.selectedScope).toBe(mg("grp-b1"));
  });

  it("collapse on a leaf is a no-op (same state object)", () => {
    const s0 = { ...open, selectedScope: sub(2) };
    expect(loggingMapReducer(s0, { type: "toggle-collapsed", scopeId: sub(2), map })).toBe(s0);
  });

  it("ArrowLeft collapses an expanded group; ArrowRight re-expands, then enters it", () => {
    const s0 = { ...open, selectedScope: mg("grp-b1") };
    const s1 = outlineKey(map, s0, "ArrowLeft");
    expect(s1.collapsed.has(mg("grp-b1"))).toBe(true);
    expect(s1.selectedScope).toBe(mg("grp-b1"));
    const s2 = outlineKey(map, s1, "ArrowRight");
    expect(s2.collapsed.has(mg("grp-b1"))).toBe(false);
    expect(outlineKey(map, s2, "ArrowRight").selectedScope).toBe(sub(2));
  });

  it("ArrowDown and ArrowUp follow visible rows; Home and End jump", () => {
    const collapsed = { ...open, collapsed: new Set([mg("grp-b")]), selectedScope: sub(1) };
    // grp-b is collapsed, so after sub 1 comes grp-b, then sub 4.
    const down = outlineKey(map, collapsed, "ArrowDown");
    expect(down.selectedScope).toBe(mg("grp-b"));
    expect(outlineKey(map, down, "ArrowDown").selectedScope).toBe(sub(4));
    expect(outlineKey(map, down, "ArrowUp").selectedScope).toBe(sub(1));
    expect(outlineKey(map, down, "Home").selectedScope).toBe(ROOT);
    expect(outlineKey(map, down, "End").selectedScope).toBe(sub(4));
  });

  it("ArrowLeft at a collapsed root and an unrelated key do nothing", () => {
    const s0 = { ...open, collapsed: new Set([ROOT]), selectedScope: ROOT };
    expect(outlineKey(map, s0, "ArrowLeft")).toBe(s0);
    expect(outlineKey(map, s0, "q")).toBe(s0);
  });
});

describe("counts: a figure not read is unknown, never 0", () => {
  it("formatCount renders null as the unknown token", () => {
    expect(formatCount(null)).toBe(UNKNOWN_COUNT);
    expect(formatCount(null)).not.toBe("0");
    expect(formatCount(0)).toBe("0");
  });

  it("a refused scope's assignment count stays null through the toolbar", () => {
    const map = makeMap(fourLevelNodes(), [], { refused: [sub(2)] });
    const c = toolbarCounts(map, { showAll: false, selectedScope: sub(2) });
    expect(c.selectedAssignments).toBeNull();
    expect(formatCount(c.selectedAssignments)).toBe(UNKNOWN_COUNT);
    // A read scope with nothing set is a real zero.
    expect(toolbarCounts(map, { showAll: false, selectedScope: sub(3) }).selectedAssignments).toBe(0);
  });

  it("could-not-read uses the usecase's refusal list when given", () => {
    const map = makeMap(fourLevelNodes(), [], { refused: [sub(2)] });
    expect(toolbarCounts(map, { showAll: false, selectedScope: null }).couldNotRead).toBe(2);
    expect(toolbarCounts(map, { showAll: false, selectedScope: null }, [{}, {}, {}]).couldNotRead).toBe(3);
    expect(toolbarCounts(map, { showAll: false, selectedScope: null }).scopes).toBe(10);
  });
});
